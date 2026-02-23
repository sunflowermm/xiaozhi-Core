# xiaozhi-Core

XRK-AGT 的 **xiaozhi-esp32** 对接模块，实现 [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) WebSocket 协议，小智固件直连本服务走 ASR→LLM→TTS。

## 连接

- **路径**：`/xiaozhi-esp32`（主）、`/xiaozhi/v1`（兼容官方）
- **URL**：`ws://<服务器>:<端口>/xiaozhi-esp32`
- **device-id**：请求头 `Device-Id` 或 URL query
- **请求头**：`Device-Id`、`Client-Id`、`Authorization: Bearer <token>`、`Protocol-Version`

## 协议要点

- **hello** → 服务端回 **hello**（`session_id`、`audio_params`）
- **listen**（`state: start/stop/detect`）+ 可选二进制 Opus
- **Opus**：由 Python (opuslib_next) 子进程编解码，Node 做管道与流控；支持 **abort**、**mcp**、**system**

## 目录

| 目录/文件 | 说明 |
|-----------|------|
| `tasker/xiaozhi-esp32.js` | WebSocket Tasker，ASR/TTS/LLM 串联，暴露 `getConnectionCount()` / `getConnections()` |
| `stream/xiaozhi.js` | 工作流（音量、点歌等），见 [aistream](../../../docs/aistream.md) |
| `http/xiaozhi.js` | HTTP：`/api/xiaozhi/config`、`/api/xiaozhi/status`，OTA `/xiaozhi/ota` |
| `events/xiaozhi.js` | 事件 `xiaozhi.device.*` → `PluginsLoader.deal` |
| `commonconfig/xiaozhi.js` | 配置 schema；配置文件为同目录下 `xiaozhi.yaml`（可由 index 生成默认） |
| `scripts/pcm_to_opus_stream.py` | TTS：PCM → Opus 流 |
| `scripts/opus_to_pcm_stream.py` | ASR：Opus → PCM 流 |
| `scripts/requirements.txt` | Python：opuslib_next；Windows 可 `pip install PyOgg` |
| `scripts/test-xiaozhi-tasker.js` | Tasker 自测 |

## 使用

- **自测**（项目根）：`node core/xiaozhi-Core/scripts/test-xiaozhi-tasker.js` 或 `cd core/xiaozhi-Core && pnpm run test:tasker`
- **Python 依赖**：`pip install -r core/xiaozhi-Core/scripts/requirements.txt`

## 依赖说明

- ASR/TTS/LLM 与 `/device` 共用；工作流优先 `xiaozhi` 再 `device`。
- 事件 `Bot.em('xiaozhi.device.*')` 由 `events/xiaozhi.js` 接收。
- 未实现官方的 wakeup_words、need_bind、max_output_size、intent、manual 等；协议与消息顺序已对齐。

## 文档

- 协议：[78/xiaozhi-esp32 WebSocket](https://github.com/78/xiaozhi-esp32/blob/main/docs/websocket.md)
- 框架：[tasker-base-spec](../../../docs/tasker-base-spec.md)、[aistream](../../../docs/aistream.md)、[plugin-base](../../../docs/plugin-base.md)
- 官方行为：`xiaozhi-esp32-server/docs/SERVER_BEHAVIOR_REFERENCE.md`
