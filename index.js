/**
 * xiaozhi-Core 入口（由底层 PluginsLoader 自动加载，非官方 Core）
 * 在 Core 目录内生成默认 xiaozhi.yaml，不存在则创建（与 commonconfig/xiaozhi.js schema 一致）
 * 相对路径：从 core/xiaozhi-Core/ 到项目根为 ../../
 */
import path from 'node:path';
import fs from 'node:fs';
import paths from '../../src/utils/paths.js';

const configPath = path.join(paths.root, 'core', 'xiaozhi-Core', 'xiaozhi.yaml');
const defaultContent = `# 小智设备配置（与 XiaozhiConfig schema 一致）
workflows:
  - xiaozhi
volume:
  default: 50
  min: 0
  max: 100
  step: 5
persona: "你是一个简洁友好的设备语音助手，以地道中文回答。"
# API/状态用
path: xiaozhi-esp32
enabled: true
`;

if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, defaultContent, 'utf8');
}

export default {};
