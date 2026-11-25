import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveRoute } from "../lib/routes.ts";

const plan = readFileSync(new URL("../docs/architecture/FRONTEND_IMPLEMENTATION_PLAN.md", import.meta.url), "utf8");
const origin = process.env.CHECK_ORIGIN ?? "http://localhost:3000";
const cases = [...plan.matchAll(/^\|\s*(\d{2})\s*\|[^|]*\|\s*`([^`]+)`\s*\|/gm)].map((match) => ({ screen: Number(match[1]), path: match[2] }));
assert.equal(cases.length, 56, "计划中应列出全部 56 个设计页");

// The Admin workbench is an operational landing page added after the original
// 56-page design set. Keep it out of the historical page count, but verify its
// route explicitly so the real-data dashboard cannot silently lose coverage.
const adminHome = resolveRoute("/admin");
assert.equal(adminHome?.screen, 62, "/admin 应映射到 Admin 工作台页面 62");

const myProjects = resolveRoute("/projects");
assert.equal(myProjects?.screen, 63, "/projects 应映射到我的项目页面 63");

for (const item of cases) {
  const url = new URL(item.path, "http://localhost:3000");
  const actual = resolveRoute(url.pathname, url.searchParams.get("view"));
  assert.equal(actual?.screen, item.screen, `${item.path} 映射到页面 ${actual?.screen ?? "无"}，预期 ${item.screen}`);
}

if (process.env.CHECK_HTTP === "1") {
  // 鉴权语义（匿名）：使用 redirect:manual 检查状态码与 Location，不跟随到登录页后用 200 判定业务页正常
  for (const item of cases) {
    const response = await fetch(`${origin}${item.path}`, { redirect: "manual" });
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
  const adminResponse = await fetch(`${origin}/admin`, { redirect: "manual" });
  const adminTarget = adminResponse.headers.get("location") ?? "";
  assert([301, 302, 303, 307, 308].includes(adminResponse.status), `/admin 匿名应重定向，实际 ${adminResponse.status}`);
  assert(adminTarget.startsWith("/login"), `/admin 匿名应跳登录，实际 ${adminTarget}`);

  const projectsResponse = await fetch(`${origin}/projects`, { redirect: "manual" });
  const projectsTarget = projectsResponse.headers.get("location") ?? "";
  assert([301, 302, 303, 307, 308].includes(projectsResponse.status), `/projects 匿名应重定向，实际 ${projectsResponse.status}`);
  assert(projectsTarget.startsWith("/login"), `/projects 匿名应跳登录，实际 ${projectsTarget}`);
}

console.log(`已核对 ${cases.length} 个设计页与 /projects、/admin 入口${process.env.CHECK_HTTP === "1" ? "，匿名访问行为符合鉴权语义（登录页 200 / 其余重定向）" : ""}。`);
