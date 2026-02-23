/**
 * xiaozhi-esp32 WebSocket Tasker
 * 实现 78/xiaozhi-esp32 官方 WebSocket 协议，小智固件连接 XRK-AGT 后走 ASR→LLM→TTS 工作流
 * Opus 全部由 Python (opuslib_next) 子进程处理：TTS PCM→Opus，ASR Opus→PCM；Node 不做编解码。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import fetch from 'node-fetch';
import { ulid } from 'ulid';
import BotUtil from '../../../src/utils/botutil.js';
import ASRFactory from '../../../src/factory/asr/ASRFactory.js';
import TTSFactory from '../../../src/factory/tts/TTSFactory.js';
import StreamLoader from '../../../src/infrastructure/aistream/loader.js';
import { getAsrConfig, getTtsConfig, getLLMSettings } from '../../../src/utils/aistream-config.js';
import { normalizeEmotionToDevice } from '../../../src/utils/emotion-utils.js';
import XiaozhiConfig from '../commonconfig/xiaozhi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');
const PCM_TO_OPUS_SCRIPT = path.join(SCRIPTS_DIR, 'pcm_to_opus_stream.py');
const OPUS_TO_PCM_SCRIPT = path.join(SCRIPTS_DIR, 'opus_to_pcm_stream.py');

const TASKER_ID = 'xiaozhi-esp32';
const TASKER_NAME = 'Xiaozhi ESP32';
/** 主路径，与设备/文档常用一致 */
const WS_PATH = 'xiaozhi-esp32';

/** 点歌防抖：同一设备同一 URL 在短时间内只执行一次（秒） */
const PLAY_AUDIO_DEBOUNCE_SEC = 15;
const playAudioLast = new Map();

const MUSIC_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com/'
};

/** 用 Node fetch 拉取完整音频，校验 Content-Type 后返回 Buffer，避免把 HTML/JSON 当音频喂给 ffmpeg。返回 { buffer, contentType } 或 null。 */
async function fetchMusicBuffer(url) {
  if (!url || !url.startsWith('http')) return null;
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: MUSIC_FETCH_HEADERS });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) return null;
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    if (buffer.length < 1024) return null;
    const ctOk = /audio|mpeg|m4a|octet-stream|stream/.test(contentType);
    const id3 = buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33;
    const mp3Sync = buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
    const flac = buffer.slice(0, 4).toString() === 'fLaC';
    if (!ctOk && !id3 && !mp3Sync && !flac) return null;
    return { buffer, contentType };
  } catch {
    return null;
  }
}
/** 官方示例 server 公布的路径，同端口下多路径挂载以便设备不改配置即可连 AGT */
const WS_PATH_LEGACY = 'xiaozhi/v1';

/** 对齐 xiaozhi-esp32-server：协议、Listen、TTS 流控、ASR 连接保持 */
const PRE_BUFFER_COUNT = 5;
/** 点歌预缓冲（官方 5，略放大以减 underrun，过大易造成首包 burst 卡顿） */
const PRE_BUFFER_COUNT_MUSIC = 8;
const AUDIO_FRAME_DURATION_MS = 60;
const TTS_STOP_BUFFER_DRAIN_MS = (PRE_BUFFER_COUNT + 2) * AUDIO_FRAME_DURATION_MS;
/** 服务端静音门限：PCM RMS 低于此值视为静音，不送 ASR（对齐官方 VAD，设备端也有 VAD/降噪） */
const VAD_SILENCE_RMS_THRESHOLD = 280;
/** 服务端 VAD 结束：连续静音超过此值触发 endUtterance（对齐官方 Silero min_silence_duration_ms≈1000，auto 模式下设备不发 listen stop） */
const SILENCE_END_MS = 900;
/** 轮询间隔（ms）：TTS 排空、listen 前 drain 等，取小值以降低延迟、秒回应 */
const DRAIN_POLL_MS = 10;

/**
 * 状态机（对齐 xiaozhi-esp32-server ConnectionHandler）：
 * - conn.deviceState: 'idle' | 'listening' | 'speaking'，与设备端 Idle/Listening/Speaking 一致，在 listen/tts/abort/timeout 全路径同步。
 * - conn.clientAbort: 用户打断为 true，listen start 时置 false；runLLMAndTTS 入口及 LLM 完成后发 TTS 前检查，避免打断后仍下发 TTS。
 */

function createXiaozhiTasker() {
    const connections = new Map(); // sessionId -> { ws, req, deviceId, ..., asrDecoderProcess?, opusTtsProcess? }
    const deviceBots = new Map();  // deviceId -> bot

    function getReqMeta(req) {
        const h = req?.headers || {};
        let q = {};
        try {
            const i = req?.url?.indexOf('?');
            if (i !== -1) q = Object.fromEntries(new URLSearchParams(req.url.slice(i)));
        } catch {}
        const pick = (...keys) => keys.map(k => h[k] || q[k]).find(Boolean) || '';
        return {
            deviceId: (pick('device-id', 'Device-Id', 'x-device-id') || 'xiaozhi-' + ulid().toLowerCase().slice(-8)).trim(),
            clientId: (pick('client-id', 'Client-Id', 'x-client-id') || ulid()).trim()
        };
    }

    /** 16bit PCM RMS，用于服务端静音门限（对齐官方 receiveAudioHandle + VAD） */
    function pcmRms(pcm) {
        if (!pcm?.length || pcm.length < 2) return 0;
        const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
        let sum = 0;
        const n = (buf.length >> 1) || 1;
        for (let i = 0; i < buf.length - 1; i += 2) {
            const s = buf.readInt16LE(i);
            sum += s * s;
        }
        return Math.sqrt(sum / n) | 0;
    }

    /**
     * 修复设备唤醒词/首句文本编码：设备/中间层可能误解码导致乱码（如「你好葵子」→「浣犲ソ钁靛瓙」）
     */
    function fixListenTextEncoding(text) {
        if (!text || typeof text !== 'string') return text;
        const t = text.trim();
        if (t === '浣犲ソ钁靛瓙') return '你好葵子';
        try {
            const recovered = Buffer.from(text, 'latin1').toString('utf8');
            if (recovered !== text && /[\u4e00-\u9fff]/.test(recovered)) return recovered;
        } catch (_) { /* ignore */ }
        return text;
    }

    function spawnPy(script, args = []) {
        const cmd = process.platform === 'win32' ? 'python' : 'python3';
        return spawn(cmd, [script, ...args], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });
    }

    function startAsrOpusProcess(conn) {
        if (conn.asrDecoderProcess) return;
        const sampleRate = conn.audioParams?.deviceSampleRate || 16000;
        try {
            const py = spawnPy(OPUS_TO_PCM_SCRIPT, [String(sampleRate)]);
            conn.asrDecoderProcess = py;
            conn.asrDecoderStdin = py.stdin;
            conn.asrDecoderCbQueue = [];
            let stdoutBuf = Buffer.alloc(0);
            py.stdout.on('data', (chunk) => {
                stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
                while (stdoutBuf.length >= 2) {
                    const plen = stdoutBuf.readUInt16LE(0);
                    if (plen === 0 || stdoutBuf.length < 2 + plen) break;
                    const pcm = Buffer.from(stdoutBuf.subarray(2, 2 + plen));
                    stdoutBuf = Buffer.from(stdoutBuf.subarray(2 + plen));
                    const cb = conn.asrDecoderCbQueue?.shift();
                    if (typeof cb === 'function') cb(pcm);
                }
            });
            py.stderr.on('data', (d) => BotUtil.makeLog('warn', `[Xiaozhi] ASR Opus py: ${d.toString().trim()}`, conn.deviceId));
            py.on('error', (e) => BotUtil.makeLog('warn', `[Xiaozhi] ASR Opus 进程: ${e.message}`, conn.deviceId));
            py.on('exit', (code) => {
                conn.asrDecoderProcess = null;
                conn.asrDecoderStdin = null;
                if (code != null && code !== 0) BotUtil.makeLog('warn', `[Xiaozhi] ASR Opus 进程退出 code=${code}`, conn.deviceId);
            });
        } catch (e) {
            BotUtil.makeLog('warn', `[Xiaozhi] ASR Opus 启动失败: ${e.message}`, conn.deviceId);
        }
    }

    function createBot(deviceId) {
        if (deviceBots.has(deviceId)) return deviceBots.get(deviceId);
        const botId = `xiaozhi-${deviceId}`;
        if (!Bot.uin?.includes(botId)) Bot.uin.push(botId);

        const bot = {
            uin: botId,
            self_id: botId,
            nickname: `Xiaozhi-${deviceId}`,
            tasker: { id: TASKER_ID, name: TASKER_NAME },
            tasker_type: TASKER_ID,
            device_id: deviceId,
            sendMsg: async (msg, target, extraData) => sendJsonToDevice(deviceId, { type: 'custom', payload: { message: msg, target, ...extraData } }),
            sendAudioChunk: null, // 由当前连接的 conn 在 hello 后绑定
            emotion: async (code) => sendJsonToDevice(deviceId, { type: 'llm', emotion: code || 'neutral', text: '' }),
            display: async (text, opts) => sendJsonToDevice(deviceId, { type: 'tts', state: 'sentence_start', text: text || '' }),
            sendCommand: async (cmd, params, priority) => {
                if (cmd === 'set_volume') {
                    const vol = params?.volume;
                    if (vol !== undefined && vol >= 0 && vol <= 100) {
                        return sendMcpToolCall(deviceId, 'self.audio_speaker.set_volume', { volume: Number(vol) });
                    }
                    return false;
                }
                return sendJsonToDevice(deviceId, { type: 'command', command: { command: cmd, parameters: params || {}, priority: priority ?? 0 } });
            }
        };
        Bot[botId] = bot;
        Bot[deviceId] = bot; // ASR/TTS 通过 Bot[deviceId] 查找 deviceBot
        deviceBots.set(deviceId, bot);
        return bot;
    }

    function getConnByDevice(deviceId) {
        for (const [sid, c] of connections.entries()) {
            if (c.deviceId === deviceId && c.ws?.readyState === 1) return { sessionId: sid, conn: c };
        }
        return null;
    }

    /** 与官方 server 一致：tts start 置为 speaking，tts stop 置为 idle（对应 clearSpeakStatus）。用 ttsSource 区分回复 TTS 与点歌，避免回复 TTS 被自己拦截。 */
    function sendJsonToDevice(deviceId, obj) {
        const hit = getConnByDevice(deviceId);
        if (!hit?.conn?.helloDone) return false;
        const { sessionId, conn } = hit;
        const source = obj._source; // 'tts' | 'play_music'，仅内部用，不发给设备
        if (obj.type === 'tts' && obj.state === 'start') {
            conn.clientIsSpeaking = true;
            conn.ttsSource = source || 'tts';
            conn.ttsSendPacketCount = 0;
            conn._ttsPaceStartTime = null;
            conn.deviceState = 'speaking';
            BotUtil.makeLog('debug', `[Xiaozhi] sendJson tts start → clientIsSpeaking=true ttsSource=${conn.ttsSource} deviceState=speaking`, deviceId);
        }
        if (obj.type === 'tts' && obj.state === 'stop') {
            conn.clientIsSpeaking = false;
            conn.ttsSource = null;
            conn.deviceState = 'idle';
            BotUtil.makeLog('debug', `[Xiaozhi] sendJson tts stop → clientIsSpeaking=false deviceState=idle`, deviceId);
        }
        if (obj.type === 'listen' && obj.state === 'stop') {
            conn.deviceState = 'idle';
            BotUtil.makeLog('debug', `[Xiaozhi] sendJson listen stop → deviceState=idle`, deviceId);
        }
        const { _source, ...rest } = obj;
        const msg = { ...rest, session_id: sessionId };
        try {
            conn.ws.send(JSON.stringify(msg));
            return true;
        } catch (e) {
            BotUtil.makeLog('error', `[Xiaozhi] 发送 JSON 失败: ${e.message}`, deviceId);
            return false;
        }
    }

    /**
     * 统一「用户打断」状态同步（对齐 xiaozhi-esp32-server abortHandle + clearSpeakStatus + clear_queues）。
     * 置 idle、清 TTS 队列、停推流、通知设备 tts stop、结束当前 ASR。
     */
    function clearSpeakingState(deviceId, conn) {
        if (!conn) return;
        conn.clientIsSpeaking = false;
        conn.ttsSource = null;
        conn.deviceState = 'idle';
        conn._ttsPaceStartTime = null;
        if (conn.ttsOpusQueue?.length) conn.ttsOpusQueue.length = 0;
        if (conn.opusTtsStdin?.writable) {
            try { conn.opusTtsStdin.end(); } catch (_) {}
        }
        sendJsonToDevice(deviceId, { type: 'tts', state: 'stop' });
        conn.asrClient?.endUtterance().catch(() => {});
    }

    /** 发送 MCP tools/call 到设备（与 xiaozhi-esp32 固件 MCP 协议一致） */
    function sendMcpToolCall(deviceId, toolName, args) {
        const payload = {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: toolName, arguments: args || {} }
        };
        return sendJsonToDevice(deviceId, { type: 'mcp', payload });
    }

    async function handleHello(sessionId, message, conn) {
        const { ws, deviceId, bot } = conn;
        if (message.transport !== 'websocket') {
            ws.close(1008, 'Unsupported transport');
            return;
        }
        const audioParams = message.audio_params || {};
        conn.audioParams = {
            deviceSampleRate: audioParams.sample_rate || 16000,
            serverSampleRate: 24000,
            format: audioParams.format || 'opus',
            channels: audioParams.channels || 1,
            frameDuration: audioParams.frame_duration || 60
        };
        if (message.features && typeof message.features === 'object') conn.features = message.features;
        conn.helloDone = true;

        const response = {
            type: 'hello',
            transport: 'websocket',
            session_id: sessionId,
            audio_params: {
                format: 'opus',
                sample_rate: 24000,
                channels: 1,
                frame_duration: 60
            }
        };
        ws.send(JSON.stringify(response));

        // 设备端收裸 Opus 二进制，24kHz/60ms；TTS 由 Python (opuslib_next) 编码，流控前 5 包立即发，其后 60ms/包
        if (!conn.ttsOpusQueue) conn.ttsOpusQueue = [];
        conn.ttsSendPacketCount = 0;
        conn.ttsLastSendTime = 0;
        conn.ttsSending = false;

        // 流控对齐 xiaozhi-esp32-server：前 N 包立即发，之后按「起始时间 + 帧序号*60ms」节流，避免「上次发送+60ms」带来的漂移与卡顿
        async function drainTtsQueue() {
            const q = conn.ttsOpusQueue;
            if (conn.ttsSending || !Array.isArray(q) || q.length === 0) return;
            conn.ttsSending = true;
            const preBuffer = (conn.ttsSource === 'play_music' ? PRE_BUFFER_COUNT_MUSIC : PRE_BUFFER_COUNT);
            if (!conn._ttsOpusBytesSent) conn._ttsOpusBytesSent = 0;
            while (conn.ws?.readyState === 1) {
                let frame = Array.isArray(conn.ttsOpusQueue) ? conn.ttsOpusQueue.shift() : undefined;
                if (frame == null || (Buffer.isBuffer(frame) && frame.length === 0)) {
                    if (conn.ttsSource === 'play_music' && Array.isArray(conn.ttsOpusQueue) && conn.ttsOpusQueue.length === 0) {
                        await new Promise(r => setImmediate(r));
                        frame = conn.ttsOpusQueue.shift();
                    }
                    if (frame == null || (Buffer.isBuffer(frame) && frame.length === 0)) break;
                }
                const count = conn.ttsSendPacketCount;
                if (count >= preBuffer) {
                    if (conn._ttsPaceStartTime == null) conn._ttsPaceStartTime = Date.now();
                    const slot = count - preBuffer;
                    const due = conn._ttsPaceStartTime + slot * AUDIO_FRAME_DURATION_MS;
                    const wait = Math.max(0, due - Date.now());
                    if (wait > 0) await new Promise(r => setTimeout(r, wait));
                }
                conn.ws.send(Buffer.isBuffer(frame) ? frame : Buffer.from(frame), { binary: true });
                conn._ttsOpusBytesSent += Buffer.isBuffer(frame) ? frame.length : (frame?.length ?? 0);
                conn.ttsSendPacketCount++;
                conn.ttsLastSendTime = Date.now();
            }
            conn.ttsSending = false;
        }

        function startTtsOpusProcess() {
            if (conn.opusTtsProcess) return;
            try {
                const py = spawnPy(PCM_TO_OPUS_SCRIPT);
                conn.opusTtsProcess = py;
                conn.opusTtsStdin = py.stdin;
                let stdoutBuf = Buffer.alloc(0);
                py.stdout.on('data', (chunk) => {
                    stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
                    while (stdoutBuf.length >= 2) {
                        const len = stdoutBuf.readUInt16LE(0);
                        if (len === 0 || stdoutBuf.length < 2 + len) break;
                        const frame = stdoutBuf.subarray(2, 2 + len);
                        stdoutBuf = Buffer.from(stdoutBuf.subarray(2 + len));
                        if (!conn.ttsOpusQueue) conn.ttsOpusQueue = [];
                        conn.ttsOpusQueue.push(Buffer.from(frame));
                        if (conn._ttsOpusPushedCount != null) conn._ttsOpusPushedCount++;
                        drainTtsQueue();
                    }
                });
                py.stderr.on('data', (d) => BotUtil.makeLog('warn', `[Xiaozhi] TTS Opus py: ${d.toString().trim()}`, deviceId));
                py.on('error', (e) => BotUtil.makeLog('warn', `[Xiaozhi] TTS Opus 进程: ${e.message}`, deviceId));
                py.on('exit', (code, sig) => {
                    conn.opusTtsProcess = null;
                    conn.opusTtsStdin = null;
                    if (code != null && code !== 0) BotUtil.makeLog('warn', `[Xiaozhi] TTS Opus 进程退出 code=${code}`, deviceId);
                });
            } catch (e) {
                BotUtil.makeLog('warn', `[Xiaozhi] TTS Opus 启动失败: ${e.message}`, deviceId);
            }
        }

        /** 将 PCM(hex) 写入 Opus 编码管道并进队发送；点歌与 TTS 共用，仅 TTS 入口做 clientIsSpeaking 拦截 */
        function pushPcmToOpus(hex) {
            if (!hex || typeof hex !== 'string' || conn.ws?.readyState !== 1) return;
            const pcm = Buffer.from(hex, 'hex');
            if (pcm.length === 0) return;
            if (!conn._ttsPcmChunkCount) conn._ttsPcmChunkCount = 0;
            conn._ttsPcmChunkCount++;
            startTtsOpusProcess();
            if (conn.opusTtsStdin?.writable) {
                try {
                    conn.opusTtsStdin.write(pcm, (err) => { if (err) BotUtil.makeLog('warn', `[Xiaozhi] TTS Opus write: ${err.message}`, deviceId); });
                } catch (e) {
                    BotUtil.makeLog('warn', `[Xiaozhi] TTS Opus 编码: ${e.message}`, deviceId);
                }
            }
        }
        bot.sendAudioChunk = async (hex) => {
            // 仅当点歌占用管道时跳过；回复 TTS 自己发的 tts start 时 ttsSource==='tts'，需正常送
            if (conn.clientIsSpeaking && conn.ttsSource === 'play_music') return;
            pushPcmToOpus(hex);
        };
        bot.flushTtsOpus = async () => {
            if (conn.ws?.readyState !== 1) return;
            BotUtil.makeLog('info', `[Xiaozhi] TTS flush 开始`, deviceId);
            if (conn.opusTtsStdin?.writable) {
                try {
                    conn.opusTtsStdin.end();
                } catch (_) {}
            }
            const deadline = Date.now() + 5000;
            while (conn.opusTtsProcess && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
            }
            while (conn.ttsOpusQueue?.length > 0 || conn.ttsSending) await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
            BotUtil.makeLog('info', `[Xiaozhi] TTS 队列已排空 入队=${conn._ttsOpusPushedCount ?? '-'} 已发=${conn.ttsSendPacketCount || 0}包 等${TTS_STOP_BUFFER_DRAIN_MS}ms`, deviceId);
            await new Promise(r => setTimeout(r, TTS_STOP_BUFFER_DRAIN_MS));
            BotUtil.makeLog('info', `[Xiaozhi] TTS flush 完成`, deviceId);
        };

        /** 点歌：url（mp3/mp4）转 24k PCM → Opus 流下发设备（与 TTS 同管道）。需本机已安装 ffmpeg 并加入 PATH。 */
        bot.playAudioUrl = (url) => {
            if (!url || conn.ws?.readyState !== 1) return Promise.resolve();
            (async () => {
                const now = Date.now();
                const last = playAudioLast.get(deviceId);
                if (last && last.url === url && (now - last.time) / 1000 < PLAY_AUDIO_DEBOUNCE_SEC) {
                    return;
                }
                playAudioLast.set(deviceId, { url, time: now });

                try {
                    const data = await fetchMusicBuffer(url);
                    const usePipe = !!(data?.buffer && data.buffer.length > 0);
                    const opts = {
                        stdio: usePipe ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
                        windowsHide: true
                    };
                    // URL 含 ?、& 时不能用 shell，否则 Windows 会把 & 当命令分隔符，导致 ffmpeg 把 https://music.163.com/ 当输出文件
                    if (process.platform === 'win32' && usePipe) opts.shell = true;
                    conn.ttsOpusQueue = [];
                    conn.ttsSendPacketCount = 0;
                    conn.ttsLastSendTime = 0;
                    conn._ttsOpusBytesSent = 0;
                    conn._ttsPcmChunkCount = 0;
                    conn._ttsOpusPushedCount = 0;
                    if (conn.opusTtsStdin?.writable) {
                        try { conn.opusTtsStdin.end(); } catch (_) {}
                    }
                    conn.opusTtsProcess = null;
                    conn.opusTtsStdin = null;
                    sendJsonToDevice(deviceId, { type: 'tts', state: 'start', _source: 'play_music' });
                    startTtsOpusProcess();

                    const headers = Object.entries(MUSIC_FETCH_HEADERS).map(([k, v]) => `${k}: ${v}`).join('\r\n');
                    const ffmpegArgs = usePipe
                        ? ['-i', 'pipe:0', '-f', 's16le', '-ar', '24000', '-ac', '1', '-']
                        : ['-headers', headers, '-i', url, '-f', 's16le', '-ar', '24000', '-ac', '1', '-'];
                    const ffmpeg = spawn('ffmpeg', ffmpegArgs, opts);
                    let didError = false;
                    const stderrChunks = [];
                    if (usePipe) {
                        const input = Readable.from([data.buffer]);
                        input.on('error', (e) => {
                            if (!didError) { didError = true; BotUtil.makeLog('warn', `[Xiaozhi] 点歌输入: ${e.message}`, deviceId); }
                        });
                        input.pipe(ffmpeg.stdin, { end: true });
                    }
                    ffmpeg.stdout.on('data', (chunk) => {
                        pushPcmToOpus(chunk.toString('hex'));
                    });
                    ffmpeg.stderr.on('data', (d) => {
                        stderrChunks.push(d);
                        if (stderrChunks.length > 50) stderrChunks.shift();
                    });
                    ffmpeg.on('error', (e) => {
                        if (didError) return;
                        didError = true;
                        if (e.code === 'ENOENT') {
                            BotUtil.makeLog('warn', '[Xiaozhi] 点歌需要本机安装 ffmpeg 并加入系统 PATH', deviceId);
                        } else {
                            BotUtil.makeLog('warn', `[Xiaozhi] 点歌 ffmpeg: ${e.message}`, deviceId);
                        }
                    });
                    ffmpeg.on('close', async (code) => {
                        if (conn.bot?.flushTtsOpus) await conn.bot.flushTtsOpus();
                        sendJsonToDevice(deviceId, { type: 'tts', state: 'stop' });
                        if (code !== 0 && !didError) {
                            const errText = Buffer.concat(stderrChunks).toString('utf8').trim();
                            const lastLines = errText.split(/\r?\n/).filter(Boolean).slice(-6).join(' ');
                            BotUtil.makeLog('warn', `[Xiaozhi] 点歌 ffmpeg 退出 code=${code}${lastLines ? ` | ${lastLines}` : ''}`, deviceId);
                        }
                    });
                } catch (e) {
                    BotUtil.makeLog('error', `[Xiaozhi] 点歌失败: ${e.message}`, deviceId);
                    sendJsonToDevice(deviceId, { type: 'tts', state: 'stop' });
                }
            })();
            return Promise.resolve();
        };

        Bot.em('xiaozhi.device.connected', {
            self_id: bot.self_id,
            tasker: TASKER_ID,
            tasker_id: TASKER_ID,
            tasker_name: TASKER_NAME,
            event_id: `xiaozhi_connected_${Date.now()}`,
            time: Date.now(),
            bot,
            device_id: deviceId,
            session_id: sessionId,
            audio_params: conn.audioParams
        });
        BotUtil.makeLog('info', `[Xiaozhi] 设备已握手: ${deviceId}`, deviceId);
    }

    async function handleListen(sessionId, message, conn) {
        const { deviceId, bot } = conn;
        const state = message.state || '';
        const mode = message.mode || 'auto';
        BotUtil.makeLog('debug', `[Xiaozhi] handleListen state=${state} mode=${mode}`, deviceId);

        Bot.em('xiaozhi.device.listen', {
            self_id: bot.self_id,
            tasker: TASKER_ID,
            tasker_id: TASKER_ID,
            tasker_name: TASKER_NAME,
            event_id: `xiaozhi_listen_${Date.now()}`,
            time: Date.now(),
            bot,
            device_id: deviceId,
            session_id: sessionId,
            state,
            mode,
            text: message.text || ''
        });

        if (mode) conn.clientListenMode = mode;

        // listen start：先同步后端状态（对齐官方 reset_audio_states + 清队列）；若 TTS 仍在排空则短暂等待再开 ASR
        if (state === 'start') {
            conn.clientAbort = false;
            clearSpeakingState(deviceId, conn);
            const drainDeadline = Date.now() + 3000;
            while ((conn.ttsOpusQueue?.length > 0 || conn.ttsSending) && Date.now() < drainDeadline) {
                await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
            }
            conn.deviceState = 'listening';
        }

        if (state === 'detect') {
            // 对齐 xiaozhi-esp32-server：唤醒词（detect）直接当用户首句送入 LLM，保证对话连续
            const rawText = (message.text || '').trim();
            const wakeText = fixListenTextEncoding(rawText);
            if (wakeText) {
                BotUtil.makeLog('info', `[Xiaozhi] 唤醒词触发首句: "${wakeText}"`, deviceId);
                runLLMAndTTS(deviceId, sessionId, wakeText, conn).catch(e =>
                    BotUtil.makeLog('error', `[Xiaozhi] 唤醒词 LLM/TTS 失败: ${e.message}`, deviceId)
                );
            }
        }
        if (state === 'start') {
            conn.asrSessionId = sessionId;
            conn.pcmBuffer = [];
            conn._vadLastVoiceTime = null;
            conn._vadSilenceStartTime = null;
            const asrConfig = getAsrConfig();
            if (asrConfig.enabled) {
                try {
                    const config = { ...asrConfig, idleCloseMs: 0 };
                    const client = conn.asrClient || ASRFactory.createClient(deviceId, config, Bot);
                    if (!conn.asrClient) conn.asrClient = client;
                    await client.beginUtterance(sessionId, {
                        sample_rate: conn.audioParams?.deviceSampleRate || 16000,
                        channels: 1,
                        format: 'pcm',
                        codec: 'pcm'
                    });
                } catch (e) {
                    BotUtil.makeLog('error', `[Xiaozhi] ASR 启动失败: ${e.message}`, deviceId);
                }
            }
        } else if (state === 'stop' && conn.asrClient) {
            BotUtil.makeLog('debug', `[Xiaozhi] handleListen 收到 stop 结束 ASR`, deviceId);
            conn.asrClient.endUtterance().catch(e => BotUtil.makeLog('warn', `[Xiaozhi] ASR 结束: ${e.message}`, deviceId));
        }
    }

    /** 在设备仍处于 listening 时开启新一轮 ASR 会话，避免“会话结束但设备还在监听”导致后续语音无法识别 */
    async function startAsrSessionIfListening(deviceId, conn) {
        if (conn.deviceState !== 'listening' || conn.asrSessionId != null) return;
        const asrConfig = getAsrConfig();
        if (!asrConfig?.enabled) return;
        try {
            const newSessionId = ulid();
            conn.asrSessionId = newSessionId;
            conn.pcmBuffer = [];
            conn._vadLastVoiceTime = null;
            conn._vadSilenceStartTime = null;
            const client = conn.asrClient || ASRFactory.createClient(deviceId, { ...asrConfig, idleCloseMs: 0 }, Bot);
            if (!conn.asrClient) conn.asrClient = client;
            await client.beginUtterance(newSessionId, {
                sample_rate: conn.audioParams?.deviceSampleRate || 16000,
                channels: 1,
                format: 'pcm',
                codec: 'pcm'
            });
            BotUtil.makeLog('debug', `[Xiaozhi] 续接 ASR 会话（设备仍在监听）: ${newSessionId}`, deviceId);
        } catch (e) {
            BotUtil.makeLog('warn', `[Xiaozhi] 续接 ASR 失败: ${e.message}`, deviceId);
            conn.asrSessionId = null;
        }
    }

    async function runLLMAndTTS(deviceId, sessionId, text, conn) {
        if (!text?.trim()) return;
        if (conn.clientAbort) {
            BotUtil.makeLog('debug', `[Xiaozhi] runLLMAndTTS 跳过 已打断 sessionId=${sessionId}`, deviceId);
            return;
        }
        if (conn._runLLMAndTTSLock) {
            BotUtil.makeLog('debug', `[Xiaozhi] runLLMAndTTS 跳过 上一轮未结束 sessionId=${sessionId}`, deviceId);
            return;
        }
        conn._runLLMAndTTSLock = true;
        BotUtil.makeLog('debug', `[Xiaozhi] runLLMAndTTS 入口 sessionId=${sessionId} textLen=${text?.length ?? 0}`, deviceId);

        try {
        // 读取 xiaozhi 配置
        let xiaozhiCfg;
        try {
            const xiaozhiConfig = new XiaozhiConfig();
            xiaozhiCfg = await xiaozhiConfig.read();
        } catch (e) {
            BotUtil.makeLog('warn', `[Xiaozhi] 读取配置失败，使用默认: ${e.message}`, deviceId);
            xiaozhiCfg = { workflows: ['xiaozhi'], persona: '你是一个简洁友好的设备语音助手，以地道中文回答。' };
        }
        
        const workflows = xiaozhiCfg?.workflows || ['xiaozhi'];
        const persona = xiaozhiCfg?.persona || '你是一个简洁友好的设备语音助手，以地道中文回答。';
        
        // 获取主工作流（第一个）
        const mainWorkflow = workflows[0] || 'xiaozhi';
        let stream = StreamLoader.getStream(mainWorkflow);
        
        // 如果配置了多个工作流，合并它们
        if (workflows.length > 1) {
            const secondary = workflows.slice(1);
            const mergedName = `xiaozhi-${workflows.join('-')}`;
            stream = StreamLoader.getStream(mergedName) || StreamLoader.mergeStreams({
                name: mergedName,
                main: mainWorkflow,
                secondary,
                prefixSecondary: false
            });
        }
        
        if (!stream) {
            BotUtil.makeLog('warn', `[Xiaozhi] 工作流未加载: ${mainWorkflow}`, deviceId);
            return;
        }
        
        const streamConfig = getLLMSettings({ workflow: mainWorkflow });
        if (!streamConfig?.enabled) {
            BotUtil.makeLog('warn', '[Xiaozhi] 工作流未启用', deviceId);
            return;
        }
        // 合并多工作流时传入 streams，供 LLM 工具白名单使用（如 xiaozhi + desktop 同时可用）
        if (workflows.length > 1) {
            streamConfig.streams = workflows;
        }

        const deviceInfo = { device_id: deviceId, device_type: 'xiaozhi' };
        let aiResult;
        try {
            // 传递 deviceId 到工作流上下文，供 MCP 工具使用
            const executeContext = { deviceId, device_id: deviceId, ...deviceInfo };
            aiResult = await stream.execute(deviceId, text, { ...streamConfig, persona, context: executeContext }, deviceInfo, persona);
        } catch (e) {
            BotUtil.makeLog('error', `[Xiaozhi] LLM 执行失败: ${e.message}`, deviceId);
            return;
        }
        BotUtil.makeLog('debug', `[Xiaozhi] runLLMAndTTS LLM 完成 有文本=${!!aiResult?.text}`, deviceId);
        if (!aiResult?.text) return;
        if (conn.clientAbort) {
            BotUtil.makeLog('debug', `[Xiaozhi] runLLMAndTTS 打断后跳过 TTS sessionId=${sessionId}`, deviceId);
            return;
        }
        if (conn.asrClient) {
            BotUtil.makeLog('debug', `[Xiaozhi] runLLMAndTTS 结束 ASR utterance 准备播 TTS`, deviceId);
            conn.asrClient.endUtterance().catch(() => {});
        }
        const emotion = normalizeEmotionToDevice(aiResult.emotion);
        sendJsonToDevice(deviceId, { type: 'llm', session_id: sessionId, emotion: emotion || 'neutral', text: aiResult.text });
        const ttsConfig = getTtsConfig();
        // 仅当点歌占用管道时跳过回复 TTS，避免截断点歌；回复 TTS 的 clientIsSpeaking 会带 ttsSource='tts'
        if (conn.clientIsSpeaking && conn.ttsSource === 'play_music') {
            BotUtil.makeLog('info', `[Xiaozhi] 点歌播放中，跳过回复 TTS 与 flush，由点歌自行发 tts stop`, deviceId);
            return;
        }
        if (ttsConfig.enabled) {
            conn.ttsOpusQueue = [];
            conn.ttsSendPacketCount = 0;
            conn.ttsLastSendTime = 0;
            conn._ttsOpusBytesSent = 0;
            conn._ttsPcmChunkCount = 0;
            conn._ttsOpusPushedCount = 0;
            conn.opusTtsProcess = null;
            conn.opusTtsStdin = null;
            BotUtil.makeLog('info', `[Xiaozhi] TTS 开始 文本=${aiResult.text?.length || 0}字 24k/60ms (Python Opus)`, deviceId);
            sendJsonToDevice(deviceId, { type: 'tts', state: 'start' });
            sendJsonToDevice(deviceId, { type: 'tts', state: 'sentence_start', text: aiResult.text });
            try {
                const xiaozhiTtsConfig = { ...ttsConfig, sampleRate: 24000, chunkMs: 60, encoding: 'pcm' };
                const ttsClient = TTSFactory.createClient(deviceId, xiaozhiTtsConfig, Bot);
                await ttsClient.synthesize(aiResult.text, { sampleRate: 24000 });
                if (typeof ttsClient.waitAudioSent === 'function') await ttsClient.waitAudioSent();
                if (typeof conn.bot?.flushTtsOpus === 'function') await conn.bot.flushTtsOpus();
            } catch (e) {
                BotUtil.makeLog('error', `[Xiaozhi] TTS 失败: ${e.message}`, deviceId);
            }
            sendJsonToDevice(deviceId, { type: 'tts', state: 'stop' });
            BotUtil.makeLog('debug', `[Xiaozhi] runLLMAndTTS 已发 tts stop，流程结束`, deviceId);
        }
        } finally {
            conn._runLLMAndTTSLock = false;
        }
    }

    function handleAbort(sessionId, message, conn) {
        const { deviceId, bot } = conn;
        conn.clientAbort = true;
        clearSpeakingState(deviceId, conn);
        Bot.em('xiaozhi.device.abort', {
            self_id: bot.self_id,
            tasker: TASKER_ID,
            event_id: `xiaozhi_abort_${Date.now()}`,
            time: Date.now(),
            bot,
            device_id: deviceId,
            session_id: sessionId,
            reason: message.reason || ''
        });
    }

    function handleMCP(sessionId, message, conn) {
        const { deviceId, bot } = conn;
        Bot.em('xiaozhi.device.mcp', {
            self_id: bot.self_id,
            tasker: TASKER_ID,
            event_id: `xiaozhi_mcp_${Date.now()}`,
            time: Date.now(),
            bot,
            device_id: deviceId,
            session_id: sessionId,
            payload: message.payload
        });
    }

    function handleBinary(sessionId, data, conn) {
        const { asrClient, audioParams } = conn;
        if (!asrClient || !data?.length) return;
        const opusBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        startAsrOpusProcess(conn);
        if (!conn.asrDecoderStdin?.writable) return;
        if (!conn.asrDecoderCbQueue) conn.asrDecoderCbQueue = [];
        conn.asrDecoderCbQueue.push((pcm) => {
            if (!pcm?.length) return;
            if (conn.clientIsSpeaking) {
                BotUtil.makeLog('debug', `[Xiaozhi] 二进制PCM 因 clientIsSpeaking 跳过送 ASR`, conn.deviceId);
                return;
            }
            const rms = pcmRms(pcm);
            const isVoice = rms >= VAD_SILENCE_RMS_THRESHOLD;
            if (!isVoice) {
                if (conn.clientListenMode !== 'manual' && conn._vadLastVoiceTime != null) {
                    conn._vadSilenceStartTime = conn._vadSilenceStartTime ?? Date.now();
                    if (Date.now() - conn._vadSilenceStartTime >= SILENCE_END_MS) {
                        conn._vadLastVoiceTime = null;
                        conn._vadSilenceStartTime = null;
                        conn.asrClient?.endUtterance().catch(() => {});
                    }
                }
                return;
            }
            conn._vadLastVoiceTime = Date.now();
            conn._vadSilenceStartTime = null;
            while (conn.pcmBuffer?.length > 0) {
                const b = conn.pcmBuffer.shift();
                if (b?.length) asrClient.sendAudio(b);
            }
            if (!asrClient.sendAudio(pcm)) {
                if (!conn.pcmBuffer) conn.pcmBuffer = [];
                const maxBytes = (audioParams?.deviceSampleRate || 16000) * 2 * 5;
                const total = conn.pcmBuffer.reduce((s, b) => s + b.length, 0);
                if (total + pcm.length <= maxBytes) conn.pcmBuffer.push(pcm);
            }
        });
        const lenBuf = Buffer.allocUnsafe(2);
        lenBuf.writeUInt16LE(Math.min(opusBuf.length, 0xFFFF), 0);
        conn.asrDecoderStdin.write(Buffer.concat([lenBuf, opusBuf]), (err) => {
            if (err) BotUtil.makeLog('warn', `[Xiaozhi] ASR Opus write: ${err.message}`, conn.deviceId);
        });
    }

    async function onAsrResult(event) {
        if (event?.event_type !== 'asr_result') return;
        const deviceId = event.device_id;
        const sessionId = event.session_id;
        const text = event.text || '';
        const isFinal = !!event.is_final;
        const connByDevice = getConnByDevice(deviceId);
        if (!connByDevice || connByDevice.conn.asrSessionId !== sessionId) return;

        const conn = connByDevice.conn;
        if (text) conn.lastAsrText = text;

        sendJsonToDevice(deviceId, { type: 'stt', session_id: sessionId, text });

        if (!isFinal) return;

        conn.asrSessionId = null;
        await runLLMAndTTS(deviceId, sessionId, text, conn);
        await startAsrSessionIfListening(deviceId, conn);
    }

    /** ASR 超时时通知设备退出监听并同步服务端状态，避免指示灯卡在“监听”需按两次/唤醒词无效 */
    function onAsrTimeout(event) {
        if (event?.event_type !== 'asr_timeout') return;
        const deviceId = event.device_id;
        const hit = getConnByDevice(deviceId);
        if (!hit?.conn?.helloDone) return;
        const conn = hit.conn;
        conn.deviceState = 'idle';
        conn.asrSessionId = null;
        sendJsonToDevice(deviceId, { type: 'listen', state: 'stop' });
        BotUtil.makeLog('debug', `[Xiaozhi] ASR 超时，已通知设备 listen stop，deviceState=idle`, deviceId);
    }

    function cleanupConn(conn) {
        if (!conn) return;
        try { conn.asrClient?.endUtterance(); } catch (_) {}
        try { conn.asrDecoderStdin?.destroy(); } catch (_) {}
        try { conn.asrDecoderProcess?.kill(); } catch (_) {}
        try { conn.opusTtsStdin?.destroy(); } catch (_) {}
        try { conn.opusTtsProcess?.kill(); } catch (_) {}
    }

    function handleDisconnect(sessionId) {
        const conn = connections.get(sessionId);
        if (!conn) return;
        const { deviceId, bot } = conn;
        cleanupConn(conn);
        connections.delete(sessionId);
        Bot.em('xiaozhi.device.disconnected', {
            self_id: bot?.self_id,
            tasker: TASKER_ID,
            event_id: `xiaozhi_disconnected_${Date.now()}`,
            time: Date.now(),
            bot,
            device_id: deviceId,
            session_id: sessionId
        });
        BotUtil.makeLog('info', `[Xiaozhi] 设备断开: ${deviceId}`, deviceId);
    }

    function handleMessage(ws, req, data) {
        const sessionId = req?.sessionId || ws.sessionId;
        const conn = connections.get(sessionId);
        if (!conn) return;

        // 设备端 hello 等 JSON 在部分环境下会以 Buffer 形式到达，需先按文本解析
        let raw = data;
        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const str = buf.toString('utf8');
            if (str.trim().startsWith('{')) {
                raw = str;
            } else {
                try { handleBinary(sessionId, data, conn); } catch (e) { BotUtil.makeLog('error', `[Xiaozhi] 二进制处理: ${e.message}`, conn.deviceId); }
                return;
            }
        }

        let message;
        try {
            message = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
            BotUtil.makeLog('warn', `[Xiaozhi] JSON 解析失败: ${e.message}`, conn.deviceId);
            return;
        }

        const type = message.type;
        if (!type) return;

        switch (type) {
            case 'hello':
                handleHello(sessionId, message, conn);
                break;
            case 'listen':
                handleListen(sessionId, message, conn);
                break;
            case 'abort':
                handleAbort(sessionId, message, conn);
                break;
            case 'mcp':
                handleMCP(sessionId, message, conn);
                break;
            case 'system':
                if (message.command === 'reboot') {
                    BotUtil.makeLog('info', '[Xiaozhi] 设备请求重启（仅记录）', conn.deviceId);
                }
                break;
            default:
                BotUtil.makeLog('debug', `[Xiaozhi] 未知 type: ${type}`, conn.deviceId);
        }
    }

    function handleConnection(ws, req, socket, head) {
        const { deviceId, clientId } = getReqMeta(req);
        const sessionId = ulid();
        ws.sessionId = sessionId;
        if (!req.sessionId) req.sessionId = sessionId;

        const bot = createBot(deviceId);
        const conn = {
            ws, req, deviceId, clientId, bot,
            audioParams: null, helloDone: false,
            asrClient: null, asrSessionId: null,
            pcmBuffer: [], ttsOpusQueue: [], ttsSendPacketCount: 0, ttsLastSendTime: 0, ttsSending: false,
            clientIsSpeaking: false,
            ttsSource: null,
            clientListenMode: 'auto',
            connectedAt: Date.now(),
            deviceState: 'idle',
            clientAbort: false
        };
        connections.set(sessionId, conn);

        ws.on('message', (data) => handleMessage(ws, req, data));
        ws.on('close', () => handleDisconnect(sessionId));
        ws.on('error', (e) => BotUtil.makeLog('error', `[Xiaozhi] WS 错误: ${e.message}`, deviceId));

        BotUtil.makeLog('info', `[Xiaozhi] 新连接: ${deviceId} (${sessionId})`, deviceId);
    }

    const tasker = {
        id: TASKER_ID,
        name: TASKER_NAME,
        path: WS_PATH,

        getConnectionCount: () => connections.size,
        getConnections: () => Array.from(connections.entries()).map(([sid, c]) => ({
            session_id: sid,
            device_id: c.deviceId,
            client_id: c.clientId,
            connected_at: c.connectedAt
        })),

        load() {
            const mount = (pathKey) => {
                if (!Array.isArray(Bot.wsf[pathKey])) Bot.wsf[pathKey] = [];
                Bot.wsf[pathKey].push((conn, req, socket, head) => handleConnection(conn, req, socket, head));
            };
            mount(WS_PATH);
            if (WS_PATH_LEGACY && WS_PATH_LEGACY !== WS_PATH) mount(WS_PATH_LEGACY);
            if (typeof Bot.on === 'function') {
                Bot.on('device.asr_result', onAsrResult);
                Bot.on('device.asr_timeout', onAsrTimeout);
            }
            const paths = WS_PATH_LEGACY && WS_PATH_LEGACY !== WS_PATH ? [WS_PATH, WS_PATH_LEGACY] : [WS_PATH];
            BotUtil.makeLog('info', `[Xiaozhi] Tasker 已加载，路径: ${paths.map(p => '/' + p).join(', ')}`, 'XiaozhiEsp32');
        }
    };

    return tasker;
}

const taskerInstance = createXiaozhiTasker();
Bot.tasker.push(taskerInstance);
