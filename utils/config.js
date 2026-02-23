/**
 * 读取 xiaozhi 配置（core/xiaozhi-Core/xiaozhi.yaml，由 ConfigLoader 注册为 xiaozhi）
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
