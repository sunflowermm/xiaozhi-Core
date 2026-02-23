/**
 * xiaozhi-esp32 HTTP 路由
 *
 * - 设备侧：WS 路径健康检查、OTA 接口（与官方 server 协议一致）
 * - 控制台侧：配置读写、状态/连接数（标准化 JSON，供前端面板使用）
 */
import { HttpResponse } from '../../../src/utils/http-utils.js';
import { getXiaozhiConfig } from '../utils/config.js';

const DEFAULT_WS_PATH = 'xiaozhi-esp32';
const TASKER_ID = 'xiaozhi-esp32';

/** 根据当前请求与配置 path 构造 WebSocket 地址 */
function buildWsUrl(req, wsPath) {
  const path = (wsPath || DEFAULT_WS_PATH).trim() || DEFAULT_WS_PATH;
  const prefix = path.startsWith('/') ? '' : '/';
  const host = req.get('host') || req.headers?.host || 'localhost';
  const proto = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'wss' : 'ws';
  return `${proto}://${host}${prefix}${path}`;
}

/** 获取 xiaozhi-esp32 Tasker 实例 */
function getTasker() {
  if (!Array.isArray(global.Bot?.tasker)) return null;
  return global.Bot.tasker.find(t => t?.id === TASKER_ID || t?.path === TASKER_ID) || null;
}

// ----- 设备侧（协议兼容，勿改格式） -----

const health = (req, res) => {
  res.status(200).set('Content-Type', 'text/plain; charset=utf-8')
    .send('端口正常，如需测试连接，请使用 WebSocket 协议。\n');
};

const otaGet = async (req, res) => {
  const cfg = await getXiaozhiConfig();
  const wsUrl = buildWsUrl(req, cfg?.path);
  res.status(200).set('Content-Type', 'text/plain; charset=utf-8')
    .send(`OTA接口运行正常，向设备发送的websocket地址是：${wsUrl}\n`);
};

const otaPost = async (req, res) => {
  const cfg = await getXiaozhiConfig();
  const wsUrl = buildWsUrl(req, cfg?.path);
  res.status(200).set('Content-Type', 'application/json').json({
    server_time: {
      timestamp: Math.round(Date.now()),
      timezone_offset: 8 * 60
    },
    firmware: { version: '0.0.0', url: '' },
    websocket: { url: wsUrl, token: '', version: 1 }
  });
};

// ----- 控制台 API（统一 success/data/code） -----

const getConfig = async (req, res) => {
  const data = await getXiaozhiConfig();
  HttpResponse.success(res, { data });
};

const setConfig = async (req, res) => {
  const config = global.ConfigManager?.get('xiaozhi');
  if (!config) return HttpResponse.notFound(res, 'xiaozhi 配置不存在');
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return HttpResponse.validationError(res, '缺少 data 对象');
  }
  await config.write(data, { backup: true, validate: true });
  HttpResponse.success(res, null, '配置已保存');
};

const getStatus = async (req, res) => {
  const cfg = await getXiaozhiConfig();
  const tasker = getTasker();
  const connections = tasker?.getConnections?.() ?? [];
  HttpResponse.success(res, {
    enabled: cfg?.enabled !== false,
    path: cfg?.path ?? DEFAULT_WS_PATH,
    count: tasker?.getConnectionCount?.() ?? 0,
    connections
  });
};

export default {
  name: 'xiaozhi',
  dsc: '小智 ESP32 对接 API',
  priority: 88,
  routes: [
    { method: 'GET', path: '/xiaozhi-esp32', handler: health },
    { method: 'GET', path: '/xiaozhi/v1', handler: health },
    { method: 'GET', path: '/xiaozhi/ota', handler: HttpResponse.asyncHandler(otaGet, 'xiaozhi.ota.get') },
    { method: 'GET', path: '/xiaozhi/ota/', handler: HttpResponse.asyncHandler(otaGet, 'xiaozhi.ota.get') },
    { method: 'POST', path: '/xiaozhi/ota', handler: HttpResponse.asyncHandler(otaPost, 'xiaozhi.ota.post') },
    { method: 'POST', path: '/xiaozhi/ota/', handler: HttpResponse.asyncHandler(otaPost, 'xiaozhi.ota.post') },
    { method: 'POST', path: '/xiaozhi/ota/activate', handler: HttpResponse.asyncHandler(otaPost, 'xiaozhi.ota.activate') },
    { method: 'GET', path: '/api/xiaozhi/config', handler: HttpResponse.asyncHandler(getConfig, 'xiaozhi.config.read') },
    { method: 'POST', path: '/api/xiaozhi/config', handler: HttpResponse.asyncHandler(setConfig, 'xiaozhi.config.write') },
    { method: 'GET', path: '/api/xiaozhi/status', handler: HttpResponse.asyncHandler(getStatus, 'xiaozhi.status') }
  ]
};
