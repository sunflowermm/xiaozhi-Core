/**
 * xiaozhi-esp32 Tasker 自测：加载、getConnectionCount/getConnections
 * Opus 编解码已全部由 Python 子进程处理，此处仅验证 tasker 加载与 API。
 * 项目根目录：node core/xiaozhi-Core/scripts/test-xiaozhi-tasker.js；或 pnpm run test:tasker
 */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(msg) { console.log('[test-xiaozhi-tasker]', msg); }
function fail(msg) { console.error('[test-xiaozhi-tasker] FAIL:', msg); process.exitCode = 1; }

global.Bot = { tasker: [], wsf: {}, uin: [], on: () => {}, em: () => {} };
await import(pathToFileURL(path.join(__dirname, '../tasker/xiaozhi-esp32.js')).href);

const tasker = global.Bot.tasker.find((t) => t?.id === 'xiaozhi-esp32');
if (!tasker) { fail('未找到 xiaozhi-esp32 Tasker'); process.exit(1); }

log('Tasker 已加载');
if (tasker.id !== 'xiaozhi-esp32') fail(`id 应为 xiaozhi-esp32，实际: ${tasker.id}`);
if (tasker.name !== 'Xiaozhi ESP32') fail(`name 应为 Xiaozhi ESP32，实际: ${tasker.name}`);
if (typeof tasker.getConnectionCount() !== 'number') fail('getConnectionCount 应返回 number');
if (!Array.isArray(tasker.getConnections())) fail('getConnections 应返回 array');
log(`getConnectionCount=${tasker.getConnectionCount()}, getConnections.length=${tasker.getConnections().length}`);

log('自测通过。');
process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
