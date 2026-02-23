import path from 'path';
import fs from 'fs';
import paths from '../../../src/utils/paths.js';
import ConfigBase from '../../../src/infrastructure/commonconfig/commonconfig.js';

const XIAOZHI_CONFIG_PATH = 'core/xiaozhi-Core/xiaozhi.yaml';
const DEFAULT_XIAOZHI_YAML = `# 小智设备配置（与 XiaozhiConfig schema 一致）
workflows:
  - xiaozhi
volume:
  default: 50
  min: 0
  max: 100
  step: 5
persona: "你是一个简洁友好的设备语音助手，以地道中文回答。"
path: xiaozhi-esp32
enabled: true
`;

/**
 * xiaozhi-Core 配置管理（非官方 Core，配置存放在 Core 目录内）
 * 配置文件：core/xiaozhi-Core/xiaozhi.yaml；若不存在则首次读时自动创建。
 */
export default class XiaozhiConfig extends ConfigBase {
  constructor() {
    super({
      name: 'xiaozhi',
      displayName: '小智设备配置',
      description: '小智 ESP32 设备工作流与设备控制配置',
      filePath: XIAOZHI_CONFIG_PATH,
      fileType: 'yaml',
      schema: {
        fields: {
          workflows: {
            type: 'array',
            label: '工作流列表',
            description: '启用的工作流名称数组，每行一个。如 xiaozhi 为自带工作流（包含音量控制等），desktop 为桌面工作流',
            itemType: 'string',
            default: ['xiaozhi'],
            component: 'Tags'
          },
          volume: {
            type: 'object',
            label: '音量控制',
            description: '设备音量相关配置',
            fields: {
              default: {
                type: 'number',
                label: '默认音量',
                description: '设备默认音量（0-100）',
                min: 0,
                max: 100,
                default: 50,
                component: 'InputNumber'
              },
              min: {
                type: 'number',
                label: '最小音量',
                description: '设备最小音量（0-100）',
                min: 0,
                max: 100,
                default: 0,
                component: 'InputNumber'
              },
              max: {
                type: 'number',
                label: '最大音量',
                description: '设备最大音量（0-100）',
                min: 0,
                max: 100,
                default: 100,
                component: 'InputNumber'
              },
              step: {
                type: 'number',
                label: '音量步进',
                description: '音量调整步进值（1-10）',
                min: 1,
                max: 10,
                default: 5,
                component: 'InputNumber'
              }
            }
          },
          persona: {
            type: 'string',
            label: '人设',
            description: '设备 AI 人设描述',
            default: '你是一个简洁友好的设备语音助手，以地道中文回答。',
            component: 'TextArea'
          }
        }
      }
    });
  }

  /** 若配置文件不存在则写入默认内容（与 index.js 一致），再读 */
  async read(useCache = true) {
    const fullPath = path.join(paths.root, XIAOZHI_CONFIG_PATH);
    if (!fs.existsSync(fullPath)) {
      try {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, DEFAULT_XIAOZHI_YAML, 'utf8');
      } catch (e) {
        throw new Error(`配置文件不存在且创建失败: ${fullPath} — ${e.message}`);
      }
    }
    return super.read(useCache);
  }
}
