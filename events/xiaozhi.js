/**
 * xiaozhi-esp32 事件监听器
 * 订阅 xiaozhi.device.* 事件，标准化 device_id / self_id 后交给插件系统
 */

import PluginsLoader from '../../../src/infrastructure/plugins/loader.js';

export default class XiaozhiEventListener {
    prefix = 'xiaozhi.';
    event = [
        'device.connected',
        'device.listen',
        'device.abort',
        'device.mcp',
        'device.audio',
        'device.disconnected'
    ];

    async execute(e) {
        if (!e || e.tasker !== 'xiaozhi-esp32') return;
        e.isXiaozhi = true;
        e.device_id = e.device_id ?? (e.self_id ? String(e.self_id).replace(/^xiaozhi-/, '') : undefined);
        await PluginsLoader.deal(e);
    }
}
