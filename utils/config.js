/**
 * 读取 xiaozhi 配置
 *
 * 单一来源：
 * - 由 commonconfig/xiaozhi.js 注册到 ConfigManager，负责 schema + 默认值 + 首次自动创建 yaml 文件
 * - 这里仅通过 ConfigManager 读取一次，不再重复 new XiaozhiConfig，避免冗余配置入口
 */
export async function getXiaozhiConfig() {
  const config = global.ConfigManager?.get('xiaozhi');
  if (!config) return {};
  try {
    return (await config.read()) || {};
  } catch {
    return {};
  }
}
