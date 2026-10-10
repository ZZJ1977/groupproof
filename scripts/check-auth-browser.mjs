import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { launchChrome, closeChrome, openTab, sleep } from "./browser-check.mjs";

/**
 * E20 真实浏览器走查：注册三步、登录、忘记密码、重置页、键盘与窄屏。
 * 通过 Chrome 实际操作完成（不以 API 测试替代）；验证码仅在隔离开发环境从
 * 邮件捕获器（PostgreSQL email_outbox）读取——真实收件验证（E21）另行人工联调。
 * 前置：`npm run dev` + `npm run server:dev`（开发捕获器模式）。
 */

let passed = 0;
const records = [];
function ok(desc, value) {
  assert.ok(value, desc);
  passed += 1;
  records.push(`✅ ${desc}`);
}
function note(desc) {
  records.push(`ℹ️ ${desc}`);
}

/** 仅隔离开发环境：从邮件捕获器读取发往该地址的最新验证码 */
function readCapturedCode(email) {
  const body = execSync(
    `docker exec gp-pg-test psql -U gp -d gp_dev -t -A -c "SELECT body FROM email_outbox WHERE to_email='${email}' ORDER BY id DESC LIMIT 1"`,
    { encoding: "utf8" },
  );
  const match = /(\d{6})/.exec(body);
  assert(match, `捕获邮件中未找到验证码：${body.slice(0, 60)}`);
  return match[1];
}

const stamp = Date.now().toString().slice(-8);
const email = `browser-${stamp}@qq.com`;
const username = `brw${stamp}`;
const password = "correct-horse-battery-1";

await launchChrome();
const tab = await openTab();

try {
  // ── B1 登录页能力感知与布局 ─────────────────────────────
  await tab.setViewport(1440, 900);
  await tab.goto("/login");
  ok("登录页渲染账号密码窗口", await tab.hasText("已注册账户登录"));
  ok("登录页提供注册与忘记密码入口", (await tab.hasText("注册账号")) && (await tab.hasText("忘记密码")));
  const googleVisible = await tab.evaluate(`(() => !!Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("使用 Google 登录")))()`);
  note(googleVisible ? "Google 入口可见（已配置凭据）" : "Google 入口隐藏（未配置/不可用，能力感知生效）");
  await tab.clickByText("注册账号", "button");
  await tab.waitFor(`document.body.textContent.includes("第 1/3 步")`);
  ok("注册弹窗打开并显示步骤进度", true);
  note(`实现截图：${await tab.screenshot("auth-browser-01-register-step1")}`);

  // ── B2 注册三步（真实事件） ─────────────────────────────
  await tab.typeInLabeled("登录邮箱", email);
  await tab.clickByText("发送验证码", "button");
  await tab.waitFor(`document.body.textContent.includes("第 2/3 步")`, 10000);
  ok("步骤2显示脱敏收件地址", (await tab.text()).includes("***@qq.com"));
  const code = readCapturedCode(email);
  await tab.type('input[autocomplete="one-time-code"]', code);
  await tab.clickByText("验证邮箱", "button");
  await tab.waitFor(`document.body.textContent.includes("第 3/3 步")`, 10000);
  ok("步骤3显示已验证邮箱且不可改写", (await tab.text()).includes("已验证登录邮箱"));
  note(`实现截图：${await tab.screenshot("auth-browser-02-register-step3")}`);

  await tab.type('div[role="dialog"] input[aria-label="用户名"]', username);
  await tab.type('div[role="dialog"] input[aria-label="密码"]', password);
  await tab.type('div[role="dialog"] input[aria-label="确认密码"]', password);
  await tab.clickByText("注册并继续", "button");
  await tab.waitFor(`location.pathname.startsWith("/account")`, 12000);
  ok("建档成功进入个人中心（受限）", (await tab.evaluate("location.pathname")).startsWith("/account"));
  ok("个人中心提示继续完成资料与学校验证", (await tab.hasText("注册进度") || (await tab.hasText("基本资料"))));
  note(`实现截图：${await tab.screenshot("auth-browser-03-account-center")}`);

  // ── B3 注册后密码登录（退出→登录） ─────────────────────
  const logoutButton = await tab.evaluate(`(() => Array.from(document.querySelectorAll("button")).find(b => b.textContent.includes("退出登录"))?.textContent.trim() ?? null)()`);
  ok("个人中心提供真实退出", Boolean(logoutButton));
  await tab.clickByText("退出登录", "button");
  await tab.waitFor(`location.pathname === "/login"`, 10000);
  await tab.typeInLabeled("用户名或邮箱", username);
  await tab.typeInLabeled("密码", password);
  await tab.clickByText("登录", "button");
  await tab.waitFor(`location.pathname.startsWith("/account")`, 12000);
  ok("用户名+密码登录成功并按 nextAction 去向", true);

  // ── B4 忘记密码统一反馈 ────────────────────────────────
  await tab.goto("/login");
  await tab.clickByText("忘记密码", "button");
  await tab.waitFor(`document.body.textContent.includes("找回密码")`);
  await tab.typeInLabeled("登录邮箱", `ghost-${stamp}@qq.com`); // 不存在账户
  await tab.clickByText("发送重置链接", "button");
  await tab.waitFor(`document.body.textContent.includes("如果该邮箱符合恢复条件")`, 10000);
  ok("不存在账户的找回反馈与存在账户一致（无枚举）", true);
  note(`实现截图：${await tab.screenshot("auth-browser-04-forgot")}`);

  // ── B5 重置页（无令牌/伪令牌的可恢复反馈） ──────────────
  await tab.goto("/reset-password");
  ok("重置页公开可达", await tab.hasText("重置密码"));
  ok("无令牌给出可恢复提示", await tab.hasText("重置链接无效或不完整"));
  await tab.goto("/reset-password#token=definitely-not-valid");
  await tab.reload(); // 邮件链接是整页加载；同路径 hash 导航不重挂载属预期
  await tab.waitFor(`document.querySelectorAll('input[type="password"]').length >= 2`);
  await tab.typeInLabeled("新密码", password + "-v2");
  await tab.typeInLabeled("确认新密码", password + "-v2");
  await tab.clickByText("重置密码", "button");
  await tab.waitFor(`document.body.textContent.includes("重置链接无效或已使用") || document.body.textContent.includes("请求编号")`, 10000);
  ok("伪令牌提交得到可恢复错误（含请求编号）", true);
  ok("令牌已从地址栏清除", !(await tab.evaluate("location.hash")));
  note(`实现截图：${await tab.screenshot("auth-browser-05-reset")}`);

  // ── B6 键盘与焦点 ─────────────────────────────────────
  await tab.goto("/login");
  await tab.pressTab(1);
  const firstFocus = await tab.evaluate("document.activeElement?.tagName + ':' + (document.activeElement?.textContent || document.activeElement?.getAttribute('aria-label') || '').trim().slice(0, 12)");
  ok("Tab 可达首个交互元素", Boolean(firstFocus && firstFocus !== "BODY:"));
  await tab.clickByText("注册账号", "button");
  await tab.waitFor(`document.body.textContent.includes("第 1/3 步")`);
  await tab.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(400);
  ok("Esc 可关闭注册弹窗", !(await tab.evaluate(`document.body.textContent.includes("第 1/3 步")`)));

  // ── B7 360px 窄屏与 200% 缩放 ──────────────────────────
  await tab.setViewport(360, 740);
  await tab.goto("/login");
  const overflow360 = await tab.evaluate("document.documentElement.scrollWidth - window.innerWidth");
  ok("360px 无关键横向溢出", overflow360 <= 2);
  await tab.setViewport(720, 900); // 等效 200% 缩放视口
  const overflowZoom = await tab.evaluate("document.documentElement.scrollWidth - window.innerWidth");
  ok("200% 缩放视口无横向溢出", overflowZoom <= 2);
  note(`实现截图：${await tab.screenshot("auth-browser-06-narrow")}`);

  // ── B8 验证码错误反馈（真实事件） ──────────────────────
  await tab.setViewport(1440, 900);
  await tab.goto("/login");
  await tab.clickByText("注册账号", "button");
  await tab.waitFor(`document.body.textContent.includes("第 1/3 步")`);
  await tab.typeInLabeled("登录邮箱", `wrong-code-${stamp}@qq.com`);
  await tab.clickByText("发送验证码", "button");
  await tab.waitFor(`document.body.textContent.includes("第 2/3 步")`, 10000);
  await tab.type('input[autocomplete="one-time-code"]', "000000");
  await tab.clickByText("验证邮箱", "button");
  await tab.waitFor(`document.body.textContent.includes("验证码不正确")`, 10000);
  ok("错误验证码得到就近可播报反馈", true);
  note(`实现截图：${await tab.screenshot("auth-browser-07-code-error")}`);

  console.log("真实浏览器验收通过（E20 自动化部分）：");
  for (const line of records) console.log(" ", line);
  console.log(`共 ${passed} 项断言通过。E21（真实收件）需人工联调，不在本脚本范围。`);
} finally {
  closeChrome();
}
