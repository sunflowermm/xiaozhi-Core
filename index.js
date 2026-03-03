/**
 * xiaozhi-Core 入口（由底层 PluginsLoader 自动加载）
 *
 * 配置初始化交由 `commonconfig/xiaozhi.js` 处理（ConfigLoader 会自动加载 core/<coreName>/commonconfig）。
 * 这里保持无副作用，避免与配置管理器的创建/校验逻辑重复。
 */
export default {};

