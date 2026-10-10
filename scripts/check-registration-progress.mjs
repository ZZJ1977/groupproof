import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { launchChrome, closeChrome, openTab, sleep } from "./browser-check.mjs";

/**
 * 注册进度与「登入」按钮浏览器验收（2026-10-10）：
 * R1 阶段整行底色（完成=浅蓝/待完成=浅红/可选=浅灰）+ 文字/图标双通道；
 * R2 保存资料只点亮第 1 项；R3 学校邮箱验证后前三项完成 →“完成注册”+ 绿色登入；
 * R4 点击登入完成会话升级并进入业务页（受保护 API 200，无 403/跳回循环）；
 * R5 历史账户（登录邮箱未验证）：账号安全浅灰“可选”，不计入必填进度，不伪造进入；
 * R6 教师：待提交/审核中保持浅红 + 按钮禁用；审核依据失效同步退回；
 * R7 一致性与可访问性：刷新/跨页/切换账号/三语/360px/200% 缩放/键盘。
 *
 * 前置：`npm run dev` + `MAIL_MODE=capture npm run server:dev`（验证码仅从本地邮件捕获器读取）。
 * 教师“有效批准后变蓝并允许进入”由服务端测试 test_registration_progress 覆盖（开发环境无管理员浏览器凭据）。
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

const COLORS = {
  done: "rgb(234, 242, 255)",
  todo: "rgb(254, 242, 242)",
  optional: "rgb(243, 244, 246)",
  enter: "rgb(21, 128, 61)",
};

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

function sql(query) {
  return execSync(`docker exec gp-pg-test psql -U gp -d gp_dev -t -A -c ${JSON.stringify(query)}`, { encoding: "utf8" }).trim();
}

async function stageInfo(tab, index) {
  return tab.evaluate(`(() => {
    const row = document.querySelectorAll('.gp-stage-row')[${index}];
    if (!row) return null;
    return {
      tone: row.getAttribute('data-tone'),
      bg: getComputedStyle(row).backgroundColor,
      text: row.textContent.trim(),
      current: row.getAttribute('aria-current'),
    };
  })()`);
}

async function statusInfo(tab) {
  return tab.evaluate(`(() => {
    const el = document.querySelector('.gp-progress-status');
    return el ? { tone: el.getAttribute('data-tone'), text: el.textContent.trim() } : null;
  })()`);
}

/** 等待注册进度读取完成（加载中为中性占位，不得当作完成或未完成） */
async function waitForProgressOnce(tab) {
  // 宽松等待：dev 模式首次进入路由会编译并短暂阻塞 /me 代理请求
  await tab.waitFor(`document.querySelectorAll('.gp-stage-row').length === 4`, 30000);
  await tab.waitFor(`Object.keys(document.body).some((k) => k.startsWith('__react'))`, 30000);
  await tab.waitFor(
    `Array.from(document.querySelectorAll('.gp-stage-row .gp-stage-state')).some((el) => el.textContent.trim().length > 0)`,
    30000,
  );
}

async function waitForProgress(tab) {
  try {
    await waitForProgressOnce(tab);
  } catch {
    // dev 模式偶发水合卡顿：整页重载后重试一次（不改变断言语义）
    await tab.reload();
    try {
      await waitForProgressOnce(tab);
    } catch (error) {
      const dump = await tab.evaluate(`(() => ({
        path: location.pathname,
        rows: Array.from(document.querySelectorAll('.gp-stage-row')).map((r) => ({ tone: r.getAttribute('data-tone'), state: r.querySelector('.gp-stage-state')?.textContent ?? '(none)' })),
        chip: document.querySelector('.gp-progress-status')?.textContent.trim() ?? null,
        meRequests: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/v1/')).map((e) => e.name.split('/api/v1/')[1]),
        onLine: navigator.onLine,
      }))()`);
      console.error("waitForProgress 超时诊断：", JSON.stringify(dump, null, 1));
      throw error;
    }
  }
}

/** 打开个人中心页面并等进度就绪；dev 冷编译/偶发空页时重载重试一次 */
async function openAccountPage(tab, path) {
  try {
    await tab.goto(path);
    await waitForProgress(tab);
  } catch {
    // dev 冷编译/偶发空页：重新导航一次
    try {
      await tab.goto(path);
      await waitForProgress(tab);
    } catch (error) {
      console.error("openAccountPage 失败：", path, await tab.evaluate("location.href").catch(() => "?"));
      throw error;
    }
  }
}

async function enterInfo(tab) {
  return tab.evaluate(`(() => {
    const el = document.querySelector('.gp-enter-button');
    return el ? { disabled: el.disabled, text: el.textContent.trim(), bg: getComputedStyle(el).backgroundColor } : null;
  })()`);
}

const stamp = Date.now().toString().slice(-8);
const password = "correct-horse-battery-1";
const student = {
  email: `prg-${stamp}@qq.com`,
  username: `prgs${stamp}`,
  name: "王小明",
  studentId: `2023${stamp}`,
  schoolEmail: `2023${stamp}@student.must.edu.mo`,
};
const teacher = {
  email: `prgt-${stamp}@qq.com`,
  username: `prgt${stamp}`,
  name: "陈老师",
  schoolEmail: `prgt${stamp}@must.edu.mo`,
};

async function registerAccount(tab, account) {
  await tab.goto("/login");
  await tab.clickByText("注册账号", "button");
  await tab.waitFor(`document.body.textContent.includes("第 1/3 步")`);
  await tab.typeInLabeled("登录邮箱", account.email);
  await tab.clickByText("发送验证码", "button");
  await tab.waitFor(`document.body.textContent.includes("第 2/3 步")`, 10000);
  await tab.type('input[autocomplete="one-time-code"]', readCapturedCode(account.email));
  await tab.clickByText("验证邮箱", "button");
  await tab.waitFor(`document.body.textContent.includes("第 3/3 步")`, 10000);
  await tab.type('div[role="dialog"] input[aria-label="用户名"]', account.username);
  await tab.type('div[role="dialog"] input[aria-label="密码"]', password);
  await tab.type('div[role="dialog"] input[aria-label="确认密码"]', password);
  await tab.clickByText("注册并继续", "button");
  await tab.waitFor(`location.pathname.startsWith("/account")`, 12000);
  await waitForProgress(tab);
}

async function login(tab, identifier) {
  await tab.goto("/login");
  await tab.typeInLabeled("用户名或邮箱", identifier);
  await tab.typeInLabeled("密码", password);
  await tab.clickByText("登录", "button");
  // 已激活账户登录后按 nextAction 直接落在业务首页；统一回个人中心检查注册进度
  await tab.waitFor(`location.pathname !== "/login"`, 12000);
  await openAccountPage(tab, "/account/profile");
}

async function verifySchoolEmail(tab, schoolEmail) {
  await tab.clickByText("重新发送验证码", "button");
  await tab.waitFor(`document.querySelectorAll('input[autocomplete="one-time-code"]').length > 0`, 10000);
  await tab.type('input[autocomplete="one-time-code"]', readCapturedCode(schoolEmail));
  await tab.clickByText("验证并继续", "button");
  await sleep(900);
}

await launchChrome();
const tab = await openTab();

try {
  await tab.setViewport(1440, 900);
  // 无头 Chrome 默认 Accept-Language 为英文：先固定简体中文（保留既有语言偏好机制）
  await tab.goto("/login");
  await tab.evaluate(`fetch("/api/locale", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: "zh-Hans" }) }).then((r) => r.ok)`);
  await tab.reload();

  // ── R1 新用户（学生）：前三项浅红待完成；账号安全注册时已满足=浅蓝 ──
  await registerAccount(tab, student);
  let stages = await Promise.all([0, 1, 2, 3].map((i) => stageInfo(tab, i)));
  ok("阶段条目共 4 项（含可选账号安全）", stages.every(Boolean));
  ok("未完成必填阶段为浅红整行底色（非仅图标）", stages.slice(0, 3).every((s) => s.tone === "todo" && s.bg === COLORS.todo));
  ok("未完成阶段有“待完成”文字（不只靠颜色）", stages.slice(0, 3).every((s) => s.text.includes("待完成")));
  ok("账号安全注册时已满足：浅蓝 + 已完成（未要求再改密码）", stages[3].tone === "done" && stages[3].bg === COLORS.done && stages[3].text.includes("已完成"));
  ok("账号安全行标注“可选”", stages[3].text.includes("可选"));
  ok("总状态显示“待完善基本资料”", (await statusInfo(tab)).text.includes("待完善基本资料"));
  ok("前三项未完成时“登入”灰色且真实 disabled", (await enterInfo(tab)).disabled === true);
  // 2026-10-10 验收调整：资料页=注意事项提示（无修改密码）；语言选择仅右上角一处且不重复
  const ui = await tab.evaluate(`(() => {
    const text = document.body.innerText;
    return {
      panels: Array.from(document.querySelectorAll('.gp-panel-title')).map((e) => e.textContent.trim()),
      pwd: text.includes('当前密码') || Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === '修改密码'),
      langTexts: Array.from(document.querySelectorAll('button')).filter((b) => (b.getAttribute('aria-label') || '').includes('简体中文')).map((b) => b.textContent.trim()),
      switchers: document.querySelectorAll('button[aria-label*="简体中文"]').length,
    };
  })()`);
  ok("资料页显示“注意事项提示”板块", ui.panels.includes("注意事项提示"));
  ok("资料页不再包含修改密码功能", ui.pwd === false);
  ok("语言选择仅保留右上角一处", ui.switchers === 1);
  ok("语言名称不重复显示", ui.langTexts.length === 1 && ui.langTexts[0] === "简体中文");

  note(`实现截图：${await tab.screenshot("registration-progress-01-initial")}`);

  // 仅切换页面（含直接进入第 3 页）不改变完成状态（验收 1）
  await openAccountPage(tab, "/account/status");
  stages = await Promise.all([0, 1, 2, 3].map((i) => stageInfo(tab, i)));
  ok("仅切换页面/跳到第 3 页不会使前三项自动变蓝", stages.slice(0, 3).every((s) => s.tone === "todo"));

  // ── R2 保存资料：只点亮第 1 项（验收 2） ──
  await tab.goto("/account/profile");
  await tab.typeInLabeled("姓名", student.name);
  await tab.typeInLabeled("用户名", student.username);
  await tab.typeInLabeled("学号", student.studentId);
  await tab.typeInLabeled("学校邮箱", student.schoolEmail);
  await tab.clickByText("保存并继续", "button");
  await tab.waitFor(`location.pathname === "/account/email"`, 12000);
  await tab.waitFor(`document.querySelectorAll('.gp-stage-row')[0].getAttribute('data-tone') === 'done'`, 10000);
  stages = await Promise.all([0, 1, 2, 3].map((i) => stageInfo(tab, i)));
  ok("资料保存后仅第 1 项变蓝", stages[0].tone === "done" && stages[1].tone === "todo" && stages[2].tone === "todo");
  ok("第 1 项显示“已完成”勾选图标文字", stages[0].text.includes("已完成"));
  ok("总状态变为“待验证学校邮箱”", (await statusInfo(tab)).text.includes("待验证学校邮箱"));
  ok("前三项未齐时“登入”仍禁用", (await enterInfo(tab)).disabled === true);
  note(`实现截图：${await tab.screenshot("registration-progress-02-profile-done")}`);

  // ── R3 学校邮箱真实验证：前三项完成 →“完成注册”+ 绿色登入（验收 3） ──
  await verifySchoolEmail(tab, student.schoolEmail);
  await tab.waitFor(`document.querySelectorAll('.gp-stage-row')[2].getAttribute('data-tone') === 'done'`, 10000);
  stages = await Promise.all([0, 1, 2, 3].map((i) => stageInfo(tab, i)));
  ok("学校邮箱验证后第 2、3 项变蓝并显示“已完成”", stages[1].tone === "done" && stages[2].tone === "done" && stages[2].text.includes("已完成"));
  const status = await statusInfo(tab);
  ok("前三项完成显示“完成注册”完成态样式（替换旧黄色提示）", status.tone === "done" && status.text.includes("完成注册"));
  const enter = await enterInfo(tab);
  ok("前三项完成“登入”为绿色可点击", enter.disabled === false && enter.bg === COLORS.enter);
  ok("选中页（第 3 页）以 aria-current 区分且与完成态分离", (await stageInfo(tab, 2)).current === "page");
  note(`实现截图：${await tab.screenshot("registration-progress-03-complete")}`);

  // ── R4 点击登入：会话更新 + 进入业务页（验收 7） ──
  await tab.clickByText("登入", "button");
  await tab.waitFor(`location.pathname.startsWith("/home")`, 12000);
  ok("点击登入进入账号业务首页", (await tab.evaluate("location.pathname")).startsWith("/home"));
  const apiStatus = await tab.evaluate(`fetch("/api/v1/home/summary", { credentials: "same-origin" }).then((r) => r.status)`);
  ok("业务受保护 API 可正常访问（无 403 循环）", apiStatus === 200);
  await tab.reload();
  await tab.waitFor(`location.pathname.startsWith("/home")`, 10000);
  ok("刷新后仍在业务页（会话 Cookie 生效，未跳回登录页）", (await tab.evaluate("location.pathname")).startsWith("/home"));
  note(`实现截图：${await tab.screenshot("registration-progress-04-entered")}`);

  // ── R5 历史账户（登录邮箱未验证）：账号安全=浅灰“可选”（验收 5） ──
  await openAccountPage(tab, "/account/profile");
  await tab.clickByText("退出登录", "button");
  await tab.waitFor(`location.pathname === "/login"`, 10000);
  sql(`UPDATE password_credentials SET login_email_verified_at=NULL WHERE user_id=(SELECT id FROM users WHERE username_normalized='${student.username}')`);
  await login(tab, student.username);
  stages = await Promise.all([0, 1, 2, 3].map((i) => stageInfo(tab, i)));
  ok("历史账户：账号安全未完成=浅灰 + “可选”", stages[3].tone === "optional" && stages[3].bg === COLORS.optional && stages[3].text.includes("可选"));
  ok("可选阶段不计入必填进度（前三项保持完成）", stages.slice(0, 3).every((s) => s.tone === "done"));
  ok("总状态仍为“完成注册”（可选项不计入）", (await statusInfo(tab)).text.includes("完成注册"));
  ok("前三项完成时“登入”保持可点击（不因可选项拦截）", (await enterInfo(tab)).disabled === false);
  ok("提示登录邮箱待验证并给出入口", (await tab.text()).includes("登录邮箱尚未完成归属验证"));
  await tab.clickByText("登入", "button");
  await sleep(1500);
  ok("未验证登录邮箱不放行进入：留在个人中心并解释（历史账户保护）", (await tab.evaluate("location.pathname")).startsWith("/account"));
  note(`实现截图：${await tab.screenshot("registration-progress-05-optional-security")}`);

  // 恢复验证后同一按钮经会话升级可进入（历史补验完成后放行）
  sql(`UPDATE password_credentials SET login_email_verified_at=NOW() WHERE user_id=(SELECT id FROM users WHERE username_normalized='${student.username}')`);
  await openAccountPage(tab, "/account/profile");
  await tab.clickByText("登入", "button");
  await tab.waitFor(`location.pathname.startsWith("/home")`, 12000);
  ok("登录邮箱补验完成后可正常进入（会话升级到 full）", true);

  // ── R6 教师：待提交/审核中浅红 + 禁用；审核依据失效退回（验收 4/6） ──
  await openAccountPage(tab, "/account/profile");
  await tab.clickByText("退出登录", "button");
  await tab.waitFor(`location.pathname === "/login"`, 10000);
  await registerAccount(tab, teacher);
  await tab.typeInLabeled("姓名", teacher.name);
  await tab.typeInLabeled("用户名", teacher.username);
  await tab.typeInLabeled("申请身份", "teacher");
  await tab.typeInLabeled("学校邮箱", teacher.schoolEmail);
  await tab.clickByText("保存并继续", "button");
  await tab.waitFor(`location.pathname === "/account/email"`, 12000);
  await verifySchoolEmail(tab, teacher.schoolEmail);
  await tab.waitFor(`document.querySelectorAll('.gp-stage-row')[2].getAttribute('data-tone') === 'todo'`, 10000);
  stages = await Promise.all([0, 1, 2, 3].map((i) => stageInfo(tab, i)));
  ok("教师邮箱验证后第 3 项保持浅红 + “待提交”", stages[2].tone === "todo" && stages[2].text.includes("待提交"));
  ok("教师未确认时总状态为“待提交”", (await statusInfo(tab)).text.includes("待提交"));
  ok("教师未通过审核时“登入”禁用", (await enterInfo(tab)).disabled === true);
  ok("按钮旁说明尚缺的必填阶段", (await tab.text()).includes("尚缺必填阶段"));
  await tab.clickByText("提交教师审核申请", "button");
  await tab.waitFor(`document.querySelectorAll('.gp-stage-row')[2].textContent.includes('审核中')`, 10000);
  ok("提交申请后第 3 项仍浅红 + “审核中”（申请≠完成）", (await stageInfo(tab, 2)).text.includes("审核中"));
  ok("审核中“登入”仍禁用", (await enterInfo(tab)).disabled === true);
  note(`实现截图：${await tab.screenshot("registration-progress-06-teacher-review")}`);

  // 审核依据（姓名）变化 → 旧结论失效，状态退回（验收 6）
  await openAccountPage(tab, "/account/profile");
  await tab.typeInLabeled("姓名", "陈大老师");
  await tab.clickByText("保存并继续", "button");
  await tab.waitFor(`document.querySelectorAll('.gp-stage-row')[2].textContent.includes('待提交')`, 12000);
  ok("审核依据变化后第 3 项退回“待提交”，不展示过期完成结果", true);

  // ── R7 一致性与可访问性（验收 9） ──
  await openAccountPage(tab, "/account/status");
  const before = await stageInfo(tab, 2);
  await tab.reload();
  await waitForProgress(tab);
  const after = await stageInfo(tab, 2);
  ok("刷新后阶段状态一致（同一份持久化事实）", before.tone === after.tone && before.text === after.text);

  await tab.setViewport(360, 740);
  ok("360px 窄屏无关键横向溢出", (await tab.evaluate("document.documentElement.scrollWidth - window.innerWidth")) <= 2);
  await tab.setViewport(720, 900);
  ok("200% 缩放视口无横向溢出", (await tab.evaluate("document.documentElement.scrollWidth - window.innerWidth")) <= 2);
  await tab.setViewport(1440, 900);
  ok("键盘/鼠标均不能触发禁用的“登入”", (await enterInfo(tab)).disabled === true);

  // 三语：切换 English 后文案正确、无原始 key
  await tab.click('[aria-label*="简体中文"]');
  await sleep(500);
  await tab.clickByText("English", "[role='menuitemradio']");
  await tab.waitFor(`document.body.textContent.includes("Identity confirmation")`, 10000);
  const enText = await tab.text();
  ok("英文界面标题正确", enText.includes("Identity confirmation (student/teacher)"));
  ok("英文“登入”按钮文案正确", enText.includes("Enter workspace"));
  ok("英文界面无原始翻译 key", !enText.includes("account."));
  note(`实现截图：${await tab.screenshot("registration-progress-07-en")}`);
  await tab.click('[aria-label*="English"]');
  await sleep(500);
  await tab.clickByText("简体中文", "[role='menuitemradio']");
  await tab.waitFor(`document.body.textContent.includes("注册进度")`, 10000);

  // 切换账号后各自状态正确（学生=完成注册 + 可进入）
  await tab.clickByText("退出登录", "button");
  await tab.waitFor(`location.pathname === "/login"`, 10000);
  await login(tab, student.username);
  ok("切换账号后显示该账号自己的持久化状态", (await statusInfo(tab)).text.includes("完成注册") && (await enterInfo(tab)).disabled === false);
  await tab.clickByText("登入", "button");
  await tab.waitFor(`location.pathname.startsWith("/home")`, 12000);
  ok("切换账号后“登入”仍可正常进入业务", true);
  note(`实现截图：${await tab.screenshot("registration-progress-08-switch-account")}`);

  // ── R8 验收临时密令（仅测试模式；与 .env 的 ACCEPTANCE_TEST_TOKEN 一致）──
  // 注册邮箱框输入密令直达信息完善页；验证码框输入同一密令直通学校邮箱验证（无需发码/读码）
  const TOKEN = "202610";
  const acceptanceOn = await tab.evaluate(`fetch("/api/v1/auth/capabilities").then((r) => r.json()).then((c) => c.acceptanceTest?.enabled === true)`);
  if (acceptanceOn) {
    await openAccountPage(tab, "/account/profile");
    await tab.clickByText("退出登录", "button");
    await tab.waitFor(`location.pathname === "/login"`, 10000);
    await tab.clickByText("注册账号", "button");
    await tab.waitFor(`document.body.textContent.includes("第 1/3 步")`);
    await tab.typeInLabeled("登录邮箱", TOKEN);
    await tab.clickByText("发送验证码", "button");
    await tab.waitFor(`location.pathname.startsWith("/account")`, 12000);
    await waitForProgress(tab);
    ok("验收密令：注册邮箱框直达信息完善页（全新账户 + 真实会话）", (await tab.evaluate("location.pathname")).startsWith("/account"));
    ok("直达后仍是未完成初态（不跳过必填阶段）", (await stageInfo(tab, 0)).tone === "todo");
    note(`实现截图：${await tab.screenshot("registration-progress-09-test-entry")}`);

    const sid = `2023${stamp}9`;
    await tab.typeInLabeled("姓名", "验收同学");
    await tab.typeInLabeled("学号", sid);
    await tab.typeInLabeled("学校邮箱", `${sid}@student.must.edu.mo`);
    await tab.clickByText("保存并继续", "button");
    await tab.waitFor(`location.pathname === "/account/email"`, 12000);
    await waitForProgress(tab);
    await tab.type('input[autocomplete="one-time-code"]', TOKEN);
    await tab.clickByText("验证并继续", "button");
    await tab.waitFor(`document.querySelector('.gp-progress-status')?.textContent.includes('完成注册')`, 12000);
    ok("验收密令：验证码框直通学校邮箱验证 → 完成注册", true);
    const entry = await enterInfo(tab);
    ok("验收账户“登入”绿色可点击", entry.disabled === false && entry.bg === COLORS.enter);
    await tab.clickByText("登入", "button");
    await tab.waitFor(`location.pathname.startsWith("/home")`, 12000);
    ok("验收账户经真实会话升级进入业务页", (await tab.evaluate("location.pathname")).startsWith("/home"));
    note(`实现截图：${await tab.screenshot("registration-progress-10-test-entry-complete")}`);
  } else {
    note("ℹ️ 验收密令未启用（ACCEPTANCE_TEST_TOKEN 为空）：R8 跳过");
  }

  console.log("注册进度浏览器验收通过（2026-10-10）：");
  for (const line of records) console.log(" ", line);
  console.log(`共 ${passed} 项断言通过。教师“有效批准后变蓝并允许进入”由 server pytest（test_registration_progress）覆盖。`);
} finally {
  closeChrome();
}
