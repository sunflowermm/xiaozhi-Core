/**
 * xiaozhi-esp32 事件监听器
 * 订阅 xiaozhi.device.* 事件，标准化 device_id / self_id 后交给插件系统
 */

import EventListenerBase from '../../../src/infrastructure/listener/base.js';

const DEVICE_EVENTS = [
  'device.connected',
  'device.listen',
  'device.abort',
  'device.mcp',
  'device.audio',
  'device.disconnected',
];

export default class XiaozhiEvent extends EventListenerBase {
  _listenersInitialized = false;

  constructor() {
    super('xiaozhi-esp32');
  }

  async init() {
    if (this._listenersInitialized) return;
    const bot = this.bot || Bot;
    for (const type of DEVICE_EVENTS) {
      bot.on(`xiaozhi.${type}`, (e) => this.handleEvent(e));
    }
    this._listenersInitialized = true;
  }

  async handleEvent(e) {
    if (!e || e.tasker !== 'xiaozhi-esp32') return;
    this.ensureEventId(e);
    if (!this.markProcessed(e)) return;
    this.markAdapter(e, { isXiaozhi: true });
    e.device_id = e.device_id ?? (e.self_id ? String(e.self_id).replace(/^xiaozhi-/, '') : undefined);
    await this.plugins.deal(e);
  }
}
