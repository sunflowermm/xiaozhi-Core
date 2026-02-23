/**
 * xiaozhi-esp32 HTTP API
 * 提供配置管理、设备列表、OTA/激活接口（与官方 server 一致）、WS 路径健康响应
 */
import { HttpResponse } from '../../../src/utils/http-utils.js';
import { getXiaozhiConfig } from '../utils/config.js';

/** 与 xiaozhi-esp32-server 一致：非 WebSocket 的 GET 请求返回端口正常 */
const wsPathHealth = (req, res) => {
  res.status(200).set('Content-Type', 'text/plain; charset=utf-8').send('端口正常，如需测试连接，请使用 WebSocket 协议。\n');
};

/** 构造当前请求对应的 WebSocket 地址（与官方 OTA 下发的 url 格式一致） */
function getWebSocketUrl(req, path = '/xiaozhi-esp32') {
  const host = req.get('host') || req.headers?.host || 'localhost';
  const proto = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
  return `${proto}://${host}${path.startsWith('/') ? path : '/' + path}`;
}

/** 与 xiaozhi-esp32-server 一致：GET /xiaozhi/ota/ 返回说明文案 */
const otaGet = (req, res) => {
  const wsUrl = getWebSocketUrl(req, '/xiaozhi-esp32');
  res.status(200).set('Content-Type', 'text/plain; charset=utf-8')
    .send(`OTA接口运行正常，向设备发送的websocket地址是：${wsUrl}\n`);
};

/** 与 xiaozhi-esp32-server 一致：POST /xiaozhi/ota/ 或 /xiaozhi/ota/activate 返回 JSON（含 websocket/server_time/firmware），设备解析后写入 NVS */
const otaPost = (req, res) => {
  const wsUrl = getWebSocketUrl(req, '/xiaozhi-esp32');
  const payload = {
    server_time: {
      timestamp: Math.round(Date.now()),
      timezone_offset: 8 * 60
    },
    firmware: {
      version: '0.0.0',
      url: ''
    },
    websocket: {
      url: wsUrl,
      token: '',
      version: 1
    }
  };
  res.status(200).set('Content-Type', 'application/json').send(JSON.stringify(payload));
};

export default {
  name: 'xiaozhi',
  dsc: '小智 ESP32 对接 API',
  priority: 88,

  routes: [
    { method: 'GET', path: '/xiaozhi-esp32', handler: wsPathHealth },
    { method: 'GET', path: '/xiaozhi/v1', handler: wsPathHealth },
    { method: 'GET', path: '/xiaozhi/ota', handler: otaGet },
    { method: 'GET', path: '/xiaozhi/ota/', handler: otaGet },
    { method: 'POST', path: '/xiaozhi/ota', handler: otaPost },
    { method: 'POST', path: '/xiaozhi/ota/', handler: otaPost },
    { method: 'POST', path: '/xiaozhi/ota/activate', handler: otaPost },
    {
      method: 'GET',
      path: '/api/xiaozhi/config',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const data = await getXiaozhiConfig();
        HttpResponse.success(res, { data });
      }, 'xiaozhi.config.read')
    },
    {
      method: 'POST',
      path: '/api/xiaozhi/config',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const config = global.ConfigManager?.get('xiaozhi');
        if (!config) return HttpResponse.notFound(res, 'xiaozhi 配置不存在');
        const { data } = req.body || {};
        if (!data || typeof data !== 'object') {
          return HttpResponse.validationError(res, '缺少 data 对象');
        }
        await config.write(data, { backup: true, validate: true });
        HttpResponse.success(res, null, '配置已保存');
      }, 'xiaozhi.config.write')
    },
    {
      method: 'GET',
      path: '/api/xiaozhi/status',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const cfg = await getXiaozhiConfig();
        const tasker = Array.isArray(Bot.tasker) ? Bot.tasker.find(t => t?.id === 'xiaozhi-esp32' || t?.path === 'xiaozhi-esp32') : null;
        const connections = tasker?.getConnections?.() ?? [];
        HttpResponse.success(res, {
          enabled: cfg?.enabled !== false,
          path: cfg?.path ?? 'xiaozhi-esp32',
          connections,
          count: tasker?.getConnectionCount?.() ?? 0
        });
      }, 'xiaozhi.status')
    }
  ]
};
