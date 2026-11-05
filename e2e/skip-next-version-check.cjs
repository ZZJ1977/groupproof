// next dev 启动时会 await 一次 npm registry 版本检查（无超时，见 next/dist/server/dev/hot-reloader-webpack.js
// getVersionInfo）。网络慢或被代理卡住时，开发服务器要等 ~120 秒才就绪，导致 Playwright webServer 超时。
// 测试里不需要这个检查：直接让该请求失败，Next 会按 staleness: "unknown" 继续启动。
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof url === "string" && url.startsWith("https://registry.npmjs.org/-/package/next/")) {
    return Promise.reject(new Error("next version check skipped in e2e"));
  }
  return originalFetch(input, init);
};
