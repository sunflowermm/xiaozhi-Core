/**
 * 读取 xiaozhi 配置（core/xiaozhi-Core/xiaozhi.yaml，由 ConfigLoader 注册为 xiaozhi）
 */
export async function getXiaozhiConfig() {
  const config = global.ConfigManager?.get('xiaozhi');
  if (!config) {
    // 兜底：在 ConfigManager 未初始化/未注册时，也能首次创建并读取默认配置文件
    try {
      const { default: XiaozhiConfig } = await import('../commonconfig/xiaozhi.js');
      const c = new XiaozhiConfig();
      return (await c.read(false)) || {};
    } catch {
      return {};
    }
  }
  try {
    return (await config.read()) || {};
  } catch {
    return {};
  }
}
