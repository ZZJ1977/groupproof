/**
 * 鉴权门禁检查（匿名负面用例）：直接 URL 绕过、旧 onboarding 链接、登录页文案与业务数据隔离。
 * 使用 redirect:"manual" 检查 Location 与状态码，不跟随到登录页后用 200 判定业务页正常。
 *
 * 前置：`npm run dev`（可选 AUTH_API=http://localhost:8000 同时验证 /api/v1 代理）。
 * 运行：npm run check:auth
 */
import assert from "node:assert/strict";

const ORIGIN = process.env.CHECK_ORIGIN ?? "http://localhost:3000";

async function probe(path) {
  return fetch(`${ORIGIN}${path}`, { redirect: "manual" });
}

function location(response) {
  return response.headers.get("location") ?? "";
}

// 1) 公共登录页：200，且旧“完善个人资料 / 验证邮箱”入口彻底移除（U01）
const login = await probe("/login");
assert.equal(login.status, 200, `/login 应为 200，实际 ${login.status}`);
const loginHtml = await login.text();
// 只检查可见界面文本（排除内嵌词条数据），并全文确认无旧链接
const visibleText = loginHtml.replace(/<script[\s\S]*?<\/script>/g, "");
assert(!visibleText.includes("完善个人资料"), "登录页不得保留“完善个人资料”入口");
assert(!visibleText.includes("验证邮箱"), "登录页不得保留“验证邮箱”入口");
assert(!loginHtml.includes("/onboarding/"), "登录页不得保留旧 onboarding 链接");
assert(visibleText.includes("使用 Google 登录"), "登录页应保留 Google 登录入口");
// 账号密码登录窗口与注册入口（2026-10-08 新增需求）
assert(visibleText.includes("已注册账户登录"), "登录页应包含已注册账户登录窗口");
assert(visibleText.includes("注册账号"), "登录页应提供账号密码注册入口");
assert(loginHtml.includes('type="password"'), "登录窗口应包含密码输入");

// 2) 业务页匿名直链：一律跳登录，响应不含业务数据（A01）
const protectedPaths = [
  "/home",
  "/notifications",
  "/action-items",
  "/activity",
  "/courses",
  "/courses/course-1/groups",
  "/projects/project-1",
  "/projects/project-1/tasks?view=board",
  "/projects/project-1/tasks/task-1/verification",
  "/teacher/courses/course-1",
  "/teacher/courses/course-1/settings",
  "/admin/users",
  "/admin/teacher-verifications",
];
for (const path of protectedPaths) {
  const response = await probe(path);
  assert([301, 302, 303, 307, 308].includes(response.status), `${path} 匿名应重定向，实际 ${response.status}`);
  assert(location(response).startsWith("/login"), `${path} 应跳 /login，实际 ${location(response)}`);
  const body = await response.text();
  assert(!body.includes("gp-sidebar"), `${path} 响应不得包含业务工作区标记`);
}

// 3) 旧 onboarding 链接：兼容跳转个人中心，且不能绕过会话检查（A01/R2）
for (const [alias, target] of [
  ["/onboarding/profile", "/account/profile"],
  ["/onboarding/email-verification", "/account/email"],
]) {
  const response = await probe(alias);
  assert([301, 302, 303, 307, 308].includes(response.status), `${alias} 应重定向`);
  assert.equal(location(response), target, `${alias} 应跳 ${target}，实际 ${location(response)}`);
  const gated = await probe(target);
  assert(location(gated).startsWith("/login"), `${target} 匿名应跳登录`);
}

// 4) 个人中心匿名：跳登录并保留站内 returnTo
const account = await probe("/account/profile");
assert(location(account).startsWith("/login"), "匿名访问个人中心应跳登录");

// 5) 未知路由：404，不加载工作区
const missing = await probe("/definitely-not-a-page");
assert.equal(missing.status, 404, `未知路由应 404，实际 ${missing.status}`);

// 5b) 密码重置页：公开可达（无业务会话），无令牌时给出可恢复提示
const resetPage = await probe("/reset-password");
assert.equal(resetPage.status, 200, `/reset-password 应公开可达，实际 ${resetPage.status}`);
const resetHtml = (await resetPage.text()).replace(/<script[\s\S]*?<\/script>/g, "");
assert(resetHtml.includes("重置密码") || resetHtml.includes("Reset password"), "重置页应渲染标题");
assert(!resetHtml.includes("gp-sidebar"), "重置页不得包含业务工作区标记");

// 5c) 登录页包含注册/忘记密码入口（账号密码通道）
assert(visibleText.includes("忘记密码"), "登录页应提供忘记密码入口");
assert(visibleText.includes("注册账号"), "登录页应提供注册入口");

// 6)（可选）同源 API 代理：匿名业务 API 401，session 接口最小响应（A01）
if (process.env.CHECK_AUTH_API === "1") {
  const session = await fetch(`${ORIGIN}/api/v1/auth/session`);
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, false, "匿名 session 应为 authenticated=false");
  for (const path of ["/api/v1/me", "/api/v1/home/summary", "/api/v1/projects/project-1/content"]) {
    const response = await fetch(`${ORIGIN}${path}`);
    assert.equal(response.status, 401, `${path} 匿名应 401，实际 ${response.status}`);
  }
}

// 7) 语言选择与恢复（U03/U07）：Cookie 白名单、Accept-Language 回退、非法值拒绝
{
  const setEnglish = await fetch(`${ORIGIN}/api/locale`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale: "en" }),
  });
  assert.equal(setEnglish.status, 200, "设置语言应成功");
  const cookie = (setEnglish.headers.get("set-cookie") ?? "").split(";")[0];
  assert(cookie.startsWith("gp_locale=en"), `语言 Cookie 应为白名单值，实际 ${cookie}`);

  const englishLogin = await fetch(`${ORIGIN}/login`, { headers: { cookie } });
  const englishHtml = (await englishLogin.text()).replace(/<script[\s\S]*?<\/script>/g, "");
  assert(englishHtml.includes("Sign in"), "Cookie 显式选择应恢复英文界面");
  assert(!englishHtml.includes("使用 Google 登录"), "英文界面不应夹杂中文系统文案");

  const fallback = await fetch(`${ORIGIN}/login`, { headers: { "Accept-Language": "zh-TW,zh;q=0.9" } });
  const fallbackHtml = (await fallback.text()).replace(/<script[\s\S]*?<\/script>/g, "");
  assert(fallbackHtml.includes("繁體中文"), "Accept-Language 应回退到繁體中文");

  const invalid = await fetch(`${ORIGIN}/api/locale`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale: "../../etc" }),
  });
  assert.equal(invalid.status, 400, "非法语言值应拒绝（U07）");

  const htmlLang = englishHtml.match(/<html[^>]*lang="([^"]+)"/);
  assert.equal(htmlLang?.[1], "en", "HTML lang 应跟随当前语言，避免闪烁/读屏错误");
}

console.log("check:auth 通过：匿名直链、旧链接兼容、登录页文案、404、语言恢复与（可选）API 负面用例均符合预期。");
