import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveRoute } from "../lib/routes.ts";

const plan = readFileSync(new URL("../FRONTEND_IMPLEMENTATION_PLAN.md", import.meta.url), "utf8");
const cases = [...plan.matchAll(/^\|\s*(\d{2})\s*\|[^|]*\|\s*`([^`]+)`\s*\|/gm)].map((match) => ({ screen: Number(match[1]), path: match[2] }));
assert.equal(cases.length, 56, "计划中应列出全部 56 个设计页");

for (const item of cases) {
  const url = new URL(item.path, "http://localhost:3000");
  const actual = resolveRoute(url.pathname, url.searchParams.get("view"));
  assert.equal(actual?.screen, item.screen, `${item.path} 映射到页面 ${actual?.screen ?? "无"}，预期 ${item.screen}`);
}

if (process.env.CHECK_HTTP === "1") {
  // 鉴权语义（匿名）：使用 redirect:manual 检查状态码与 Location，不跟随到登录页后用 200 判定业务页正常
  for (const item of cases) {
    const response = await fetch(`http://localhost:3000${item.path}`, { redirect: "manual" });
    const target = response.headers.get("location") ?? "";
    if (item.screen === 1) {
      assert.equal(response.status, 200, `${item.path} HTTP ${response.status}`);
    } else if (item.screen === 2 || item.screen === 3) {
      assert([301, 302, 303, 307, 308].includes(response.status), `${item.path} 应重定向（旧链接兼容），实际 ${response.status}`);
      assert(target.startsWith("/account"), `${item.path} 应跳个人中心，实际 ${target}`);
    } else {
      assert([301, 302, 303, 307, 308].includes(response.status), `${item.path} 匿名应重定向，实际 ${response.status}`);
      assert(target.startsWith("/login"), `${item.path} 匿名应跳登录，实际 ${target}`);
    }
  }
}

console.log(`已核对 ${cases.length} 个设计页与路由${process.env.CHECK_HTTP === "1" ? "，匿名访问行为符合鉴权语义（登录页 200 / 其余重定向）" : ""}。`);
