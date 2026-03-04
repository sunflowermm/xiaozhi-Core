import AIStream from '../../../src/infrastructure/aistream/aistream.js';
import BotUtil from '../../../src/utils/botutil.js';
import { SUPPORTED_EMOTIONS, parseEmotion } from '../../../src/utils/emotion-utils.js';
import { searchFirstSong } from '../utils/music.js';

/**
 * xiaozhi 自带工作流
 * 提供设备控制 MCP 工具：音量调节、点歌（163 搜索首条→mp3 转 opus 流下发设备）
 */
export default class XiaozhiStream extends AIStream {
  constructor() {
    super({
      name: 'xiaozhi',
      description: '小智设备自带工作流（音量控制、表情等）',
      version: '1.0.0',
      author: 'XRK',
      priority: 1,
      config: {
        enabled: true,
        temperature: 0.7,
        maxTokens: 4000,
        topP: 0.9,
        presencePenalty: 0.3,
        frequencyPenalty: 0.3
      },
      embedding: {
        enabled: false
      }
    });
  }

  /** 最近记忆轮数（user+assistant 一轮） */
  static MAX_TURNS = 10;
  /** Redis key 前缀：xiaozhi:conv:${deviceId} */
  static REDIS_KEY_PREFIX = 'xiaozhi:conv:';

  /**
   * 获取 Redis 客户端（直接使用全局 redis），获取失败时返回 null。
   */
  async _getRedis() {
    const client = global.redis;
    if (client && client.isOpen) {
      return client;
    }
    return null;
  }

  _historyKey(deviceId) {
    return `${XiaozhiStream.REDIS_KEY_PREFIX}${deviceId}`;
  }

  /**
   * 从 Redis 加载最近若干轮对话历史（按设备维度），返回 [{ role, content }, ...]
   */
  async loadHistory(deviceId, maxTurns = XiaozhiStream.MAX_TURNS) {
    if (!deviceId) return [];
    const client = await this._getRedis();
    if (!client) return [];

    try {
      const raw = await client.get(this._historyKey(deviceId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      const maxMessages = Math.max(1, maxTurns * 2);
      return parsed
        .filter(item => item && typeof item.content === 'string' && (item.role === 'user' || item.role === 'assistant'))
        .slice(-maxMessages)
        .map(item => ({
          role: item.role,
          content: item.content
        }));
    } catch (e) {
      BotUtil.makeLog('warn', `[Xiaozhi] 读取对话历史失败: ${e.message}`, 'XiaozhiStream');
      return [];
    }
  }

  /**
   * 将本轮对话写入 Redis 历史（user + assistant），并裁剪为最近 maxTurns 轮。
   */
  async saveTurn(deviceId, userText, assistantText, maxTurns = XiaozhiStream.MAX_TURNS) {
    if (!deviceId) return;
    const client = await this._getRedis();
    if (!client) return;

    try {
      const key = this._historyKey(deviceId);
      let history = [];
      const raw = await client.get(key);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) history = parsed;
        } catch {
          history = [];
        }
      }

      const now = Date.now();
      const pushSafe = (role, content) => {
        if (!content) return;
        const text = String(content).trim();
        if (!text) return;
        history.push({
          role,
          content: text.length > 4000 ? text.slice(0, 4000) : text,
          ts: now
        });
      };

      pushSafe('user', userText);
      pushSafe('assistant', assistantText);

      const maxMessages = Math.max(1, maxTurns * 2);
      if (history.length > maxMessages) {
        history = history.slice(-maxMessages);
      }

      await client.set(key, JSON.stringify(history), { EX: 60 * 60 });
    } catch (e) {
      BotUtil.makeLog('warn', `[Xiaozhi] 写入对话历史失败: ${e.message}`, 'XiaozhiStream');
    }
  }

  async init() {
    await super.init();
    /** 记录每个设备最近一次点歌，避免在已播放时频繁重复调用工具 */
    this._lastPlay = new Map();
    // 与 xiaozhi-esp32 固件 MCP 工具 self.audio_speaker.set_volume 对接，tasker 会转为 type:mcp + tools/call 下发给设备
    this.registerMCPTool('set_volume', {
      description: '设置设备音量（0-100）。用于调节小智设备的播放音量。对应设备端 MCP 工具 self.audio_speaker.set_volume。',
      inputSchema: {
        type: 'object',
        properties: {
          volume: {
            type: 'number',
            description: '音量值，范围 0-100',
            minimum: 0,
            maximum: 100
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['volume']
      },
      handler: async (args = {}, ctx) => {
        const volume = args.volume;
        if (volume === undefined || volume < 0 || volume > 100) {
          return this.errorResponse('INVALID_PARAM', '音量值必须在 0-100 之间');
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.sendCommand !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未找到`);
        }
        await bot.sendCommand('set_volume', { volume }, 0);
        return this.successResponse({
          message: `音量已设置为 ${volume}`,
          volume
        });
      },
      enabled: true
    });

    // 设备状态：通过小智固件自带 MCP 工具 self.get_device_status 获取当前音量、电量、网络等信息
    this.registerMCPTool('get_device_status', {
      description: '获取当前设备状态信息（音量、电量、屏幕亮度、网络等），底层调用小智固件 MCP 工具 self.get_device_status。',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        }
      },
      handler: async (args = {}, ctx) => {
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持 MCP 工具`);
        }
        const parseMcpText = (raw) => {
          if (raw == null) return null;
          if (typeof raw === 'object') return raw;
          const text = String(raw).trim();
          if (!text) return null;
          try {
            return JSON.parse(text);
          } catch {
            return { text };
          }
        };

        const unwrapResult = (result) => {
          // 兼容 jsonrpc result: { content: [{ type:'text', text:'...' }], isError:false }
          if (result && typeof result === 'object') {
            if (Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
              return result.content[0].text;
            }
            if (typeof result.text === 'string') return result.text;
          }
          return result;
        };

        // 等待设备回包（若设备/固件不回包，则回退到缓存）
        try {
          const result = await bot.callMcpTool('self.get_device_status', {}, { awaitResult: true, timeoutMs: 3000 });
          const data = parseMcpText(unwrapResult(result));
          return this.successResponse({
            message: '已获取设备状态',
            deviceId,
            data: data ?? result
          });
        } catch (e) {
          const cached = bot?._mcpCache?.deviceStatus;
          if (cached?.payload) {
            return this.successResponse({
              message: '设备未及时回包，已返回最近一次缓存状态',
              deviceId,
              cachedAt: cached.ts,
              data: cached.payload
            });
          }
          return this.errorResponse('TIMEOUT', `获取设备状态超时：${e.message}`);
        }
      },
      enabled: true
    });

    // 切换表情：显式控制设备表情，而不仅依赖 LLM 自动情绪
    this.registerMCPTool('set_emotion', {
      description: `切换设备表情，支持的表情代码包括：${SUPPORTED_EMOTIONS.join(', ')}。`,
      inputSchema: {
        type: 'object',
        properties: {
          emotionCode: {
            type: 'string',
            description: '表情代码，如 happy、sad、neutral 等'
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['emotionCode']
      },
      handler: async (args = {}, ctx) => {
        const code = (args.emotionCode || '').toString().trim();
        if (!code) {
          return this.errorResponse('INVALID_PARAM', '请提供表情代码');
        }
        if (!SUPPORTED_EMOTIONS.includes(code)) {
          return this.errorResponse(
            'INVALID_PARAM',
            `不支持的表情代码：${code}，可选值：${SUPPORTED_EMOTIONS.join(', ')}`
          );
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.emotion !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持表情`);
        }
        await bot.emotion(code);
        return this.successResponse({
          message: `表情已切换为 ${code}`,
          emotion: code
        });
      },
      enabled: true
    });

    // 屏幕亮度：映射到 self.screen.set_brightness
    this.registerMCPTool('set_screen_brightness', {
      description: '设置设备屏幕亮度（0-100），底层调用小智固件 MCP 工具 self.screen.set_brightness。',
      inputSchema: {
        type: 'object',
        properties: {
          brightness: {
            type: 'number',
            description: '亮度值，范围 0-100',
            minimum: 0,
            maximum: 100
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['brightness']
      },
      handler: async (args = {}, ctx) => {
        const brightness = args.brightness;
        if (brightness === undefined || brightness < 0 || brightness > 100) {
          return this.errorResponse('INVALID_PARAM', '亮度值必须在 0-100 之间');
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持屏幕亮度控制`);
        }
        await bot.callMcpTool('self.screen.set_brightness', { brightness: Number(brightness) });
        return this.successResponse({
          message: `屏幕亮度已设置为 ${brightness}`,
          brightness
        });
      },
      enabled: true
    });

    // 屏幕主题：映射到 self.screen.set_theme（light/dark）
    this.registerMCPTool('set_screen_theme', {
      description: '设置设备屏幕主题，通常为 light 或 dark。底层调用小智固件 MCP 工具 self.screen.set_theme。',
      inputSchema: {
        type: 'object',
        properties: {
          theme: {
            type: 'string',
            description: '主题名称，如 light 或 dark'
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['theme']
      },
      handler: async (args = {}, ctx) => {
        const theme = (args.theme || '').toString().trim();
        if (!theme) {
          return this.errorResponse('INVALID_PARAM', '请提供主题名称（如 light 或 dark）');
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持主题切换`);
        }
        await bot.callMcpTool('self.screen.set_theme', { theme });
        return this.successResponse({
          message: `屏幕主题已切换为 ${theme}`,
          theme
        });
      },
      enabled: true
    });

    // 主动切回待命状态：结束当前聆听/说话，让设备回到 Idle
    this.registerMCPTool('set_idle', {
      description: '让设备主动回到待命（Idle）状态，结束当前聆听/说话。',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        }
      },
      handler: async (args = {}, ctx) => {
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.setIdle !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持待命控制`);
        }
        await bot.setIdle();
        return this.successResponse({
          message: '设备已切回待命状态',
          deviceId
        });
      },
      enabled: true
    });

    // 设备系统信息：映射到 self.get_system_info
    this.registerMCPTool('get_system_info', {
      description: '获取设备系统信息（固件版本、板卡信息等），底层调用小智固件 MCP 工具 self.get_system_info。',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        }
      },
      handler: async (args = {}, ctx) => {
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持 MCP 工具`);
        }
        await bot.callMcpTool('self.get_system_info', {});
        return this.successResponse({
          message: '已请求设备上报系统信息。'
        });
      },
      enabled: true
    });

    // 设备重启：映射到 self.reboot
    this.registerMCPTool('reboot', {
      description: '重启小智设备，底层调用小智固件 MCP 工具 self.reboot。',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        }
      },
      handler: async (args = {}, ctx) => {
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持重启`);
        }
        await bot.callMcpTool('self.reboot', {});
        return this.successResponse({
          message: '重启指令已发送给设备。'
        });
      },
      enabled: true
    });

    // 固件升级：映射到 self.upgrade_firmware
    this.registerMCPTool('upgrade_firmware', {
      description: '从指定 URL 升级设备固件，底层调用小智固件 MCP 工具 self.upgrade_firmware。',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '固件二进制文件下载 URL'
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['url']
      },
      handler: async (args = {}, ctx) => {
        const url = (args.url || '').toString().trim();
        if (!url) {
          return this.errorResponse('INVALID_PARAM', '请提供固件下载 URL');
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持固件升级`);
        }
        await bot.callMcpTool('self.upgrade_firmware', { url });
        return this.successResponse({
          message: `已请求设备从 ${url} 升级固件，请勿中断供电。`,
          url
        });
      },
      enabled: true
    });

    this.registerMCPTool('play_music', {
      description: '点歌：根据歌名或关键词搜索网易云音乐，自动播放列表第一首。若返回 message 为「正在播放中，请稍候再点播」则切勿重复调用，直接回复用户正在播放即可。',
      inputSchema: {
        type: 'object',
        properties: {
          songName: {
            type: 'string',
            description: '歌名或关键词，如「青花瓷」「周杰伦」'
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['songName']
      },
      handler: async (args = {}, ctx) => {
        const songName = args?.songName?.trim();
        if (!songName) {
          return this.errorResponse('INVALID_PARAM', '请提供歌名或关键词');
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const now = Date.now();
        const last = this._lastPlay.get(deviceId);
        if (last && (now - last.time) < 15000) {
          return this.successResponse({
            message: '正在播放中，请稍候再点播',
            alreadyPlaying: true
          });
        }
        const song = await searchFirstSong(songName);
        if (!song?.url) {
          return this.errorResponse('NOT_FOUND', `未找到歌曲：${songName}`);
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.playAudioUrl !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持点歌`);
        }
        this._lastPlay.set(deviceId, { url: song.url, time: now, songName: song.name });
        bot.playAudioUrl(song.url);
        return this.successResponse({
          message: `已开始播放：${song.name}${song.artists ? ` - ${song.artists}` : ''}`,
          name: song.name,
          artists: song.artists,
          url: song.url
        });
      },
      enabled: true
    });

    // 资源下载配置：映射到 self.assets.set_download_url
    this.registerMCPTool('set_assets_download_url', {
      description: '设置设备资源（assets）下载地址，用于设备在空闲时自动拉取新的表情/字体等资源。底层调用 self.assets.set_download_url。',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '资源下载 URL'
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['url']
      },
      handler: async (args = {}, ctx) => {
        const url = (args.url || '').toString().trim();
        if (!url) {
          return this.errorResponse('INVALID_PARAM', '请提供资源下载 URL');
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持资源更新`);
        }
        await bot.callMcpTool('self.assets.set_download_url', { url });
        return this.successResponse({
          message: `已为设备配置资源下载地址：${url}`,
          url
        });
      },
      enabled: true
    });

    // 摄像头拍照：映射到 self.camera.take_photo（若设备无摄像头则工具在设备侧不会注册）
    this.registerMCPTool('take_photo', {
      description: '使用设备摄像头拍照并让设备端解释图片内容，底层调用小智固件 MCP 工具 self.camera.take_photo。',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '你想让设备针对照片回答的问题，如「看看屏幕上显示什么」'
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['question']
      },
      handler: async (args = {}, ctx) => {
        const question = (args.question || '').toString().trim();
        if (!question) {
          return this.errorResponse('INVALID_PARAM', '请提供问题文本');
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持摄像头`);
        }
        await bot.callMcpTool('self.camera.take_photo', { question });
        return this.successResponse({
          message: '已请求设备拍照并分析图片。'
        });
      },
      enabled: true
    });

    // 屏幕信息：映射到 self.screen.get_info
    this.registerMCPTool('get_screen_info', {
      description: '获取屏幕宽高等信息，底层调用小智固件 MCP 工具 self.screen.get_info。',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        }
      },
      handler: async (args = {}, ctx) => {
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const bot = global.Bot && (global.Bot[deviceId] || global.Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持屏幕信息查询`);
        }
        await bot.callMcpTool('self.screen.get_info', {});
        return this.successResponse({
          message: '已请求设备上报屏幕信息。'
        });
      },
      enabled: true
    });

    // 屏幕截图上传：映射到 self.screen.snapshot
    this.registerMCPTool('screen_snapshot', {
      description: '截取屏幕快照并上传到指定 URL，底层调用小智固件 MCP 工具 self.screen.snapshot。',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '接收截图的服务端 URL'
          },
          quality: {
            type: 'number',
            description: 'JPEG 质量（1-100，可选，默认80）',
            minimum: 1,
            maximum: 100
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['url']
      },
      handler: async (args = {}, ctx) => {
        const url = (args.url || '').toString().trim();
        if (!url) {
          return this.errorResponse('INVALID_PARAM', '请提供截图上传 URL');
        }
        const quality = typeof args.quality === 'number' ? args.quality : 80;
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const Bot = global.Bot;
        const bot = Bot && (Bot[deviceId] || Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持截图`);
        }
        await bot.callMcpTool('self.screen.snapshot', { url, quality: Number(quality) });
        return this.successResponse({
          message: `已请求设备截屏并上传到：${url}`,
          url,
          quality: Number(quality)
        });
      },
      enabled: true
    });

    // 屏幕预览图片：映射到 self.screen.preview_image
    this.registerMCPTool('preview_image', {
      description: '在设备屏幕上预览指定 URL 的图片，底层调用小智固件 MCP 工具 self.screen.preview_image。',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '图片 URL（支持 JPG/PNG 等）'
          },
          deviceId: {
            type: 'string',
            description: '设备ID（可选，从上下文获取）'
          }
        },
        required: ['url']
      },
      handler: async (args = {}, ctx) => {
        const url = (args.url || '').toString().trim();
        if (!url) {
          return this.errorResponse('INVALID_PARAM', '请提供图片 URL');
        }
        const deviceId = args.deviceId || ctx?.stream?._currentDeviceId || this._currentDeviceId;
        if (!deviceId) {
          return this.errorResponse('DEVICE_NOT_FOUND', '未找到设备ID');
        }
        const Bot = global.Bot;
        const bot = Bot && (Bot[deviceId] || Bot[`xiaozhi-${deviceId}`]);
        if (!bot || typeof bot.callMcpTool !== 'function') {
          return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未连接或不支持图片预览`);
        }
        await bot.callMcpTool('self.screen.preview_image', { url });
        return this.successResponse({
          message: `已请求设备预览图片：${url}`,
          url
        });
      },
      enabled: true
    });
  }

  buildSystemPrompt(context) {
    const persona = context?.persona || '你叫葵子，是一个简洁友好的设备语音助手，以地道中文回答。';
    return `【人设】
${persona}

【规则】
1. 尽量简洁，优先中文
2. 用户要点歌时，使用 play_music 工具传入歌名，自动播放搜索列表第一首；若工具返回「正在播放中」则勿再调用
3. 需要查询设备状态时，使用 get_device_status 工具并等待结果；同一问题只调用一次，拿到结果后直接回答，不要循环调用
4. 不要输出多余解释`;
  }

  async buildChatContext(e, question) {
    const text = typeof question === 'string' ? question : (question?.text || question?.content || '');
    const persona = question?.persona;
    const history = Array.isArray(question?.history) ? question.history : [];

    const messages = [
      { role: 'system', content: this.buildSystemPrompt({ persona }) }
    ];

    for (const item of history) {
      if (!item || typeof item.content !== 'string') continue;
      if (item.role !== 'user' && item.role !== 'assistant') continue;
      messages.push({
        role: item.role,
        content: item.content
      });
    }

    messages.push({ role: 'user', content: text || '你好' });

    return messages;
  }

  async execute(deviceId, question, apiConfig, persona = '') {
    try {
      this._currentDeviceId = deviceId;
      try {
        const userText = typeof question === 'string' ? question : (question?.text || question?.content || '');
        const history = await this.loadHistory(deviceId, XiaozhiStream.MAX_TURNS);
        const messages = await this.buildChatContext(null, { text: userText, persona, history });
        const response = await this.callAI(messages, apiConfig);
        if (!response) {
          return null;
        }
        const rawText = (response?.content ?? response ?? '').toString().trim();
        const { emotion, cleanText } = parseEmotion(rawText || '');

        await this.saveTurn(deviceId, userText, cleanText, XiaozhiStream.MAX_TURNS);

        return { text: cleanText, emotion };
      } finally {
        this._currentDeviceId = undefined;
      }
    } catch (err) {
      BotUtil.makeLog('error', `小智工作流失败: ${err.message}`, 'XiaozhiStream');
      return null;
    }
  }
}
