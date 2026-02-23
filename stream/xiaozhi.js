import AIStream from '../../../src/infrastructure/aistream/aistream.js';
import BotUtil from '../../../src/utils/botutil.js';
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
        
        try {
          const Bot = global.Bot;
          if (!Bot) {
            return this.errorResponse('BOT_NOT_INITIALIZED', 'Bot 未初始化');
          }
          
          const bot = Bot[deviceId] || Bot[`xiaozhi-${deviceId}`];
          if (!bot || typeof bot.sendCommand !== 'function') {
            return this.errorResponse('DEVICE_NOT_FOUND', `设备 ${deviceId} 未找到`);
          }
          
          await bot.sendCommand('set_volume', { volume }, 0);
          return this.successResponse({ 
            message: `音量已设置为 ${volume}`,
            volume
          });
        } catch (err) {
          BotUtil.makeLog('error', `[Xiaozhi] 音量控制失败: ${err.message}`, deviceId);
          return this.errorResponse('VOLUME_SET_FAILED', err.message);
        }
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
        try {
          const song = await searchFirstSong(songName);
          if (!song?.url) {
            return this.errorResponse('NOT_FOUND', `未找到歌曲：${songName}`);
          }
          const Bot = global.Bot;
          if (!Bot) {
            return this.errorResponse('BOT_NOT_INITIALIZED', 'Bot 未初始化');
          }
          const bot = Bot[deviceId] || Bot[`xiaozhi-${deviceId}`];
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
        } catch (err) {
          BotUtil.makeLog('error', `[Xiaozhi] 点歌失败: ${err.message}`, deviceId);
          return this.errorResponse('PLAY_FAILED', err.message);
        }
      },
      enabled: true
    });
  }

  buildSystemPrompt(context) {
    const persona = context?.persona || '你是一个简洁友好的设备语音助手，以地道中文回答。';
    return `【人设】
${persona}

【规则】
1. 尽量简洁，优先中文
2. 用户要点歌时，使用 play_music 工具传入歌名，自动播放搜索列表第一首；若工具返回「正在播放中」则勿再调用
3. 不要输出多余解释`;
  }

  async buildChatContext(e, question) {
    const text = typeof question === 'string' ? question : (question?.text || question?.content || '');
    const messages = [
      { role: 'system', content: this.buildSystemPrompt({ persona: question?.persona }) },
      { role: 'user', content: text || '你好' }
    ];
    return messages;
  }

  async execute(deviceId, question, apiConfig, persona = '') {
    try {
      this._currentDeviceId = deviceId;
      try {
        const messages = await this.buildChatContext(null, { text: question, persona });
        const response = await this.callAI(messages, apiConfig);
        if (!response) {
          return null;
        }
        const text = (response?.content ?? response ?? '').toString().trim();
        return { text };
      } finally {
        this._currentDeviceId = undefined;
      }
    } catch (err) {
      BotUtil.makeLog('error', `小智工作流失败: ${err.message}`, 'XiaozhiStream');
      return null;
    }
  }
}
