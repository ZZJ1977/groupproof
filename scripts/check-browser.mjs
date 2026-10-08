import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { launchChrome, closeChrome, openTab, injectWorkspace, readWorkspace, armStorageFailure, sleep } from "./browser-check.mjs";

/**
 * 阶段 14/15 浏览器验收：截图、导航、角色差异、UI 流程、失败/冲突/重复/刷新、
 * 视口、键盘与减少动效。夹具在 Node 侧准备；被验收操作通过界面真实事件执行。
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

const clone = (data) => structuredClone(data);
function fixture(mutate) {
  const data = clone(seedData);
  return mutate ? mutate(data) : data;
}

// project-2 夹具：member-1 唯一成员且为负责人（用于初始化→基线→计划 UI 流程）
const flowFixture = () => fixture((data) => {
  data.currentUserId = "member-1";
  data.currentRole = "leader";
  data.projects = data.projects.map((item) => item.id === "project-2"
    ? { ...item, memberIds: ["member-1"], ownerId: "member-1", lifecycle: "active", setupStatus: "not_initialized", setupStep: 1, activeBaselineRevisionId: undefined, activePlanRevisionId: undefined, planConfirmed: false, baselineVersion: 0, planVersion: 0, progress: 0, coreProgress: 0 }
    : item);
  return data;
});

// 创建流程夹具：member-1 所在小组（group-1，组长）尚无项目
const createFixture = () => fixture((data) => {
  data.currentUserId = "member-1";
  data.currentRole = "leader";
  data.groups = data.groups.map((item) => item.id === "group-1" ? { ...item, projectId: undefined } : item);
  return data;
});

await launchChrome();
const tab = await openTab();
await tab.setViewport(1440, 900);

try {
  // ── S1 代表页截图（1440） ─────────────────────────────────────
  await injectWorkspace(tab, fixture((data) => { data.currentUserId = "member-1"; data.currentRole = "leader"; return data; }));
  await tab.goto("/projects/project-1");
  ok("07 项目总览渲染", await tab.hasText("版本与计划") && await tab.hasText("总进度"));
  note(`实现截图：${await tab.screenshot("stage14-07-overview-1440")}`);

  await tab.goto("/projects/project-1/planning");
  ok("10 任务规划渲染", await tab.hasText("确认进度") && await tab.hasText("发布条件"));
  note(`实现截图：${await tab.screenshot("stage14-10-planning-1440")}`);

  await injectWorkspace(tab, fixture((data) => { data.currentUserId = "teacher-1"; data.currentRole = "teacher"; return data; }));
  await tab.goto("/teacher/courses/course-1/rules");
  ok("47 规则配置渲染", await tab.hasText("变更预览") && await tab.hasText("复核要求"));
  note(`实现截图：${await tab.screenshot("stage14-47-rules-1440")}`);

  // ── S2 导航跟随对象 + 任务入口合并 ─────────────────────────────
  await injectWorkspace(tab, fixture((data) => { data.currentUserId = "member-1"; data.currentRole = "leader"; return data; }));
  await tab.goto("/projects/project-3/tasks?view=board");
  const navHtml = await tab.evaluate("document.querySelector('.gp-sidebar').innerHTML");
  ok("项目导航跟随 project-3", navHtml.includes("/projects/project-3") && !navHtml.includes("/projects/project-1/"));
  ok("横幅显示真实项目名", await tab.hasText("智能交通分析"));
  const taskEntries = await tab.evaluate("Array.from(document.querySelectorAll('.gp-nav-link')).filter(a => a.getAttribute('href').includes('/tasks')).length");
  ok("任务三视图合并为单一入口", taskEntries === 1);
  note(`实现截图：${await tab.screenshot("stage14-nav-project3-board")}`);
  await tab.clickByText("任务", "a");
  await sleep(300);
  ok("旧链接兼容（页内视图可切换）", (await tab.evaluate("location.href")).includes("/tasks?view="));

  // ── S3 角色差异（界面切换演示角色） ────────────────────────────
  await tab.goto("/projects/project-2/setup");
  await tab.type('select[aria-label="切换演示角色"]', "teacher");
  await sleep(400);
  await tab.goto("/projects/project-2/setup");
  ok("教学人员只读提示", await tab.hasText("教学人员为只读视图"));
  note(`实现截图：${await tab.screenshot("stage14-readonly-teacher")}`);

  await tab.goto("/home");
  await tab.type('select[aria-label="切换演示角色"]', "student");
  await sleep(400);
  await tab.goto("/projects/project-1");
  ok("同课其他组仅公开总览", await tab.hasText("项目公开总览") && !await tab.hasText("版本与计划") && !await tab.hasText("我的任务"));
  note(`实现截图：${await tab.screenshot("stage14-public-summary")}`);

  await tab.goto("/home");
  await tab.type('select[aria-label="切换演示角色"]', "ta");
  await sleep(400);
  await tab.goto("/teacher/courses/course-1/rules");
  ok("助教（无发布授权）无保存入口", !await tab.hasText("保存草稿"));
  await tab.goto("/teacher/courses/course-2/rules");
  ok("非归属课程助教被拒绝", await tab.hasText("无权访问此页面"));
  note(`实现截图：${await tab.screenshot("stage14-ta-boundary")}`);

  // ── S4 UI 流程：初始化 → 基线确认/发布 → 计划确认/发布 ──────────
  await injectWorkspace(tab, flowFixture());
  await tab.goto("/projects/project-2/setup");
  await tab.clickByText("保存并继续");
  await tab.typeInLabeled("粘贴课程要求", "必须绑定 GitHub 仓库并提交最终报告与完整演示材料");
  await tab.clickByText("添加文本资料");
  await tab.clickByText("保存并继续");
  await tab.clickByText("开始分析");
  ok("初始化：模拟分析完成", await tab.hasText("演示分析完成"));
  await tab.clickByText("保存并继续");
  await tab.clickByText("保存并继续");
  await tab.clickByText("保存并继续");
  ok("初始化：到达团队确认步骤", await tab.hasText("确认基线"));
  await tab.clickByText("确认基线");
  ok("基线：本人确认成功", await tab.hasText("已记录你的确认"));
  await tab.clickByText("组长按规则发布");
  ok("基线：发布冻结", await tab.hasText("基线已发布并冻结"));
  note(`实现截图：${await tab.screenshot("stage14-flow-baseline-published")}`);

  await tab.goto("/projects/project-2/planning");
  await tab.clickByText("新建任务");
  await tab.typeInLabeled("任务名称", "核心流程交付");
  await tab.typeInLabeled("权重", "100");
  await tab.typeInLabeled("验收标准", "核心流程可运行");
  await tab.typeInLabeled("负责人", "member-1");
  await tab.clickByText("保存任务草稿");
  ok("计划：任务草稿保存反馈", await tab.hasText("任务草稿已保存"));
  await tab.clickByText("确认我的分配");
  ok("计划：责任确认反馈", await tab.hasText("已记录你的任务分配确认"));
  await tab.clickByText("发布整体计划");
  ok("计划：发布成功", await tab.hasText("任务计划已发布"));
  note(`实现截图：${await tab.screenshot("stage14-flow-plan-published")}`);

  // ── S5 创建项目（界面实际执行，夹具预置无项目小组） ──────────────
  await injectWorkspace(tab, createFixture());
  await tab.goto("/courses/course-1/projects/new");
  await tab.typeInLabeled("项目名称", "智能校园助手");
  await tab.clickByText("下一步");
  await tab.clickByText("下一步");
  await tab.clickByText("创建项目");
  await sleep(500);
  ok("创建：跳转到新项目", (await tab.evaluate("location.href")).includes("/projects/project-"));
  note(`实现截图：${await tab.screenshot("stage14-flow-project-created")}`);

  // ── S6 保存失败/版本冲突/重复提交/刷新恢复（界面操作） ────────────
  const settingsFixture = fixture((data) => { data.currentUserId = "member-1"; data.currentRole = "leader"; return data; });
  await injectWorkspace(tab, settingsFixture);
  await tab.goto("/projects/project-1/settings");
  await armStorageFailure(tab, 1);
  await tab.typeInLabeled("项目名称", "失败保留输入");
  await tab.clickByText("保存设置");
  ok("保存失败：明确反馈", await tab.hasText("保存失败"));
  ok("保存失败：输入保留", (await tab.evaluate(`(() => { const l=[...document.querySelectorAll("label")].find(x=>x.textContent.includes("项目名称")); const el = l && (l.querySelector("input") || (l.nextElementSibling && l.nextElementSibling.matches("input") ? l.nextElementSibling : null)); return el ? el.value : ""; })()`)) === "失败保留输入");
  note(`实现截图：${await tab.screenshot("stage14-save-failure")}`);

  await injectWorkspace(tab, settingsFixture);
  await tab.goto("/projects/project-1/settings");
  await tab.typeInLabeled("项目名称", "冲突保留输入");
  const conflictData = await readWorkspace(tab);
  conflictData.projects = conflictData.projects.map((item) => item.id === "project-1" ? { ...item, version: item.version + 5 } : item);
  await tab.evaluate(`localStorage.setItem("groupproof-v1-workspace", ${JSON.stringify(JSON.stringify(conflictData))}); "ok"`);
  await tab.clickByText("保存设置");
  ok("版本冲突：提示重新核对", await tab.hasText("重新核对") || await tab.hasText("刷新后重试"));
  ok("版本冲突：输入保留", (await tab.evaluate(`(() => { const l=[...document.querySelectorAll("label")].find(x=>x.textContent.includes("项目名称")); const el = l && (l.querySelector("input") || (l.nextElementSibling && l.nextElementSibling.matches("input") ? l.nextElementSibling : null)); return el ? el.value : ""; })()`)) === "冲突保留输入");
  note(`实现截图：${await tab.screenshot("stage14-version-conflict")}`);

  await injectWorkspace(tab, settingsFixture);
  await tab.goto("/projects/project-1/settings");
  await tab.typeInLabeled("项目名称", "重复提交测试");
  await tab.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim().startsWith("保存设置") && !b.disabled);
    const r = btn.getBoundingClientRect();
    window.__gpClickPoint = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    return true;
  })()`);
  const pt = await tab.evaluate("window.__gpClickPoint");
  for (let i = 0; i < 2; i += 1) {
    await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(40);
  }
  await sleep(500);
  const afterDouble = await readWorkspace(tab);
  ok("重复提交：变更只生效一次", afterDouble.logs.filter((item) => item.action === "修改项目设置").length === 1);

  await injectWorkspace(tab, flowFixture());
  await tab.goto("/projects/project-2/setup");
  await tab.typeInLabeled("项目名称", "刷新恢复名称");
  await tab.clickByText("保存并继续");
  await tab.reload();
  ok("刷新恢复：步骤位置保留", await tab.hasText("导入资料"));
  await tab.clickByText("上一步");
  const restored = await tab.evaluate(`(() => { const l=[...document.querySelectorAll("label")].find(x=>x.textContent.includes("项目名称")); const el = l && (l.querySelector("input") || (l.nextElementSibling && l.nextElementSibling.matches("input") ? l.nextElementSibling : null)); return el ? el.value : ""; })()`);
  ok("刷新恢复：已保存字段保留", restored === "刷新恢复名称");
  note(`实现截图：${await tab.screenshot("stage14-refresh-restore")}`);

  // ── S7 视口（375/768/1024/1440） ───────────────────────────────
  for (const width of [375, 768, 1024, 1440]) {
    await tab.setViewport(width, 900);
    await tab.goto("/projects/project-1");
    const overflow = await tab.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 2");
    ok(`${width}px 总览布局无横向溢出`, overflow);
    note(`实现截图：${await tab.screenshot(`stage14-07-overview-${width}`)}`);
  }
  await tab.setViewport(375, 800);
  await tab.goto("/projects/project-1/planning");
  note(`实现截图：${await tab.screenshot("stage14-10-planning-375")}`);
  await tab.setViewport(1440, 900);

  // ── S8 键盘导航 / 焦点 / 减少动效（阶段 15） ─────────────────────
  await tab.goto("/projects/project-1/planning");
  const focus1 = await tab.pressTab(1);
  const focus2 = await tab.pressTab(2);
  ok("键盘 Tab 焦点可移动且可读", Boolean(focus1) && Boolean(focus2) && focus1 !== focus2);
  await tab.setReducedMotion(true);
  const reduced = await tab.evaluate(`(() => {
    const el = document.querySelector("button, .gp-nav-link");
    return getComputedStyle(el).transitionDuration;
  })()`);
  ok("减少动效：过渡被压至即时", reduced.includes("0.001") || reduced === "0s");
  note(`实现截图：${await tab.screenshot("stage15-reduced-motion")}`);
  await tab.setReducedMotion(false);
  await tab.clickByText("新建任务");
  await tab.clickByText("新建任务"); // 连续点击不产生重复表单
  const forms = await tab.evaluate("document.body.innerText.split('保存任务草稿').length - 1");
  ok("快速重复点击不重复打开表单", forms === 1);
  await tab.screenshot("stage15-motion-panel");
} finally {
  closeChrome();
}

console.log(records.join("\n"));
console.log(`浏览器验收通过：${passed} 项断言全部符合预期；截图见 docs/design/screenshots/。`);
