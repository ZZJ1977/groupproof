import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import {
  advanceSetupStep,
  runMockRequirementAnalysis,
  saveSetupDraft,
} from "../lib/commands/setup.ts";
import { confirmBaselineSelf, publishBaseline } from "../lib/commands/baseline.ts";

let passed = 0;
function check(desc, actual, expected) {
  assert.deepEqual(actual, expected, `${desc}：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
  passed += 1;
}
function ok(desc, value) {
  assert.ok(value, desc);
  passed += 1;
}

function memoryRepository(initial) {
  let data = structuredClone(initial);
  return {
    read: async () => structuredClone(data),
    save: async (next) => { data = structuredClone(next); },
    get data() { return data; },
    set data(value) { data = structuredClone(value); },
  };
}

function setup({ actorId = "member-1" } = {}) {
  const repo = memoryRepository(seedData);
  const state = { actor: actorId, logSeq: 0 };
  const run = createCommandRunner({
    repository: repo,
    currentActorId: () => state.actor,
    now: () => "2026-10-06T12:00:00.000Z",
    makeLogId: () => `log-setup-${++state.logSeq}`,
  });
  return { repo, state, run };
}

const version = (repo) => repo.data.projects.find((item) => item.id === "project-1").version;
const draftInput = (repo, overrides = {}) => ({
  projectId: "project-1",
  step: 1,
  form: { name: "GroupProof", description: "证据驱动的小组协作平台", type: "课程项目", finalDeadline: "2026-12-20" },
  selectedFileIds: [],
  pastedSources: [],
  conflicts: [],
  expectedVersion: version(repo),
  ...overrides,
});

// ── 草稿持久化：刷新后恢复字段、来源、选择和位置 ────────────────────
{
  const { repo, run } = setup();
  const saved = await run(saveSetupDraft, draftInput(repo, {
    step: 4,
    form: { name: "GroupProof 初始化", description: "带草稿字段的简介", type: "课程项目", finalDeadline: "2026-12-15" },
    pastedSources: [{ id: "source-1", title: "课程要求摘录", text: "要求绑定 GitHub 仓库并提交报告" }],
    conflicts: [{ id: "conflict-1", field: "format", choices: ["课程文件", "项目草案"], selected: "课程文件" }],
  }));
  ok("草稿保存成功", saved.ok === true);
  const reloaded = repo.data.setupDrafts.find((item) => item.projectId === "project-1");
  check("恢复步骤位置", reloaded.step, 4);
  check("恢复表单字段", reloaded.form.name, "GroupProof 初始化");
  check("恢复粘贴来源", reloaded.pastedSources.map((item) => item.id), ["source-1"]);
  check("恢复冲突选择", reloaded.conflicts[0].selected, "课程文件");
}

// ── 课程硬约束不能绕过 ───────────────────────────────────────────
{
  const { repo, run } = setup();
  const outcome = await run(saveSetupDraft, draftInput(repo, {
    form: { name: "GroupProof", description: "简介", type: "课程项目", finalDeadline: "2027-01-30" },
  }));
  ok("超出课程截止的表单被拒绝", outcome.ok === false && outcome.error.code === "VALIDATION_ERROR");
  ok("错误指向截止字段", Boolean(outcome.error.fieldErrors?.["form.finalDeadline"]));
}

// ── 步骤推进校验：无资料不能分析、分析未完成不能进 4、无冲突可继续 ──
{
  const { repo, run } = setup();
  await run(saveSetupDraft, draftInput(repo, { step: 2 }));
  const noSources = await run(advanceSetupStep, { projectId: "project-1", toStep: 3, expectedVersion: version(repo) });
  ok("没有有效资料不能进入分析", noSources.ok === false && noSources.error.code === "INVALID_STATE");

  await run(saveSetupDraft, draftInput(repo, {
    step: 2,
    pastedSources: [{ id: "source-1", title: "课程要求", text: "必须绑定 GitHub 仓库并在报告中说明使用范围" }],
  }));
  const toAnalysis = await run(advanceSetupStep, { projectId: "project-1", toStep: 3, expectedVersion: version(repo) });
  ok("有资料可进入分析", toAnalysis.ok === true);

  const beforeAnalysis = await run(advanceSetupStep, { projectId: "project-1", toStep: 4, expectedVersion: version(repo) });
  ok("分析未完成不能进入冲突处理", beforeAnalysis.ok === false && beforeAnalysis.error.code === "INVALID_STATE");

  const analyzed = await run(runMockRequirementAnalysis, { projectId: "project-1", expectedVersion: version(repo) });
  ok("分析完成", analyzed.ok === true && analyzed.result.analysis.status === "succeeded");

  const toReview = await run(advanceSetupStep, { projectId: "project-1", toStep: 5, expectedVersion: version(repo) });
  ok("无真实冲突时可继续", toReview.ok === true);
  check("本次分析无冲突项（来源未含差异日期）", analyzed.result.conflicts, []);
}

// ── Mock 分析失败可重试并保留资料；重复执行不产生重复正式数据 ────────
{
  const { repo, run } = setup();
  await run(saveSetupDraft, draftInput(repo, {
    step: 3,
    pastedSources: [{ id: "source-s", title: "短文本", text: "太短" }],
  }));
  const failed = await run(runMockRequirementAnalysis, { projectId: "project-1", expectedVersion: version(repo) });
  ok("分析失败返回状态", failed.ok === true && failed.result.analysis.status === "failed");
  check("失败后资料仍保留", repo.data.setupDrafts.find((item) => item.projectId === "project-1").pastedSources.length, 1);

  await run(saveSetupDraft, draftInput(repo, {
    step: 3,
    pastedSources: [
      { id: "source-s", title: "短文本", text: "太短" },
      { id: "source-good", title: "完整要求", text: "必须绑定 GitHub 仓库，最终截止 2026-12-10，报告使用 PDF 格式" },
    ],
    baselineDraftId: failed.result.baselineDraftId,
  }));
  const retried = await run(runMockRequirementAnalysis, { projectId: "project-1", expectedVersion: version(repo) });
  ok("重试后分析成功", retried.ok === true && retried.result.analysis.status === "succeeded");
  ok("生成需求草稿", retried.result.baselineDraftId && repo.data.baselineRevisions.some((item) => item.id === retried.result.baselineDraftId && item.payload.requirements.length > 0));
  ok("由实际结果生成冲突项", retried.result.conflicts.some((item) => item.field === "finalDeadline"));
  const countAfterFirst = repo.data.baselineRevisions.find((item) => item.id === retried.result.baselineDraftId).payload.requirements.length;

  const again = await run(runMockRequirementAnalysis, { projectId: "project-1", expectedVersion: version(repo) });
  ok("重复分析成功", again.ok === true);
  const countAfterSecond = repo.data.baselineRevisions.find((item) => item.id === again.result.baselineDraftId).payload.requirements.length;
  check("重复执行不产生重复需求", countAfterSecond, countAfterFirst);
  check("基线草稿唯一", repo.data.baselineRevisions.filter((item) => item.projectId === "project-1" && item.status !== "published").length, 1);
}

// ── 审核变更使旧确认失效；确认界面状态与基线一致 ───────────────────
{
  const { repo, state, run } = setup();
  await run(saveSetupDraft, draftInput(repo, { step: 3, pastedSources: [{ id: "source-1", title: "要求", text: "必须绑定 GitHub 仓库并提交最终报告与演示视频" }] }));
  const analyzed = await run(runMockRequirementAnalysis, { projectId: "project-1", expectedVersion: version(repo) });
  const revisionId = analyzed.result.baselineDraftId;
  const confirmed = await run(confirmBaselineSelf, { projectId: "project-1", revisionId, contentVersion: 1, expectedVersion: version(repo) });
  ok("本人确认成功", confirmed.ok === true);
  check("确认记录与基线一致", confirmed.result.confirmations.length, 1);

  const reanalyzed = await run(runMockRequirementAnalysis, { projectId: "project-1", expectedVersion: version(repo) });
  const revisedRevision = repo.data.baselineRevisions.find((item) => item.id === reanalyzed.result.baselineDraftId);
  check("审核/分析变更使旧确认失效", revisedRevision.confirmations, []);
  check("内容版本递增", revisedRevision.contentVersion, 2);
  void state;
}

// ── 未发布基线不能伪装初始化完成；发布后读取同一正式基线（project-2） ──
{
  const { repo, state, run } = setup();
  await run(saveSetupDraft, {
    ...draftInput(repo),
    projectId: "project-2",
    step: 3,
    expectedVersion: repo.data.projects.find((item) => item.id === "project-2").version,
    form: { name: "校园服务导航", description: "为学生提供校园服务统一入口", type: "课程项目", finalDeadline: "2026-12-10" },
    pastedSources: [{ id: "source-1", title: "要求", text: "必须绑定 GitHub 仓库并提交最终报告与演示视频" }],
  });
  const analyzed = await run(runMockRequirementAnalysis, { projectId: "project-2", expectedVersion: repo.data.projects.find((item) => item.id === "project-2").version });
  const revisionId = analyzed.result.baselineDraftId;
  const projectVersion = () => repo.data.projects.find((item) => item.id === "project-2").version;
  const toConfirm = await run(advanceSetupStep, { projectId: "project-2", toStep: 6, expectedVersion: projectVersion() });
  ok("可进入团队确认步骤", toConfirm.ok === true);
  check("未发布基线不冻结初始化", repo.data.projects.find((item) => item.id === "project-2").setupStatus, "not_initialized");
  check("完成依据是生效版本而非页面标记", repo.data.projects.find((item) => item.id === "project-2").activeBaselineRevisionId, undefined);

  for (const actor of ["member-1", "member-5"]) {
    state.actor = actor;
    const outcome = await run(confirmBaselineSelf, { projectId: "project-2", revisionId, contentVersion: 1, expectedVersion: projectVersion() });
    ok(`${actor} 确认成功`, outcome.ok === true);
  }
  state.actor = "member-1";
  const published = await run(publishBaseline, { projectId: "project-2", revisionId, expectedVersion: projectVersion() });
  ok("全员确认后发布成功", published.ok === true);
  const project = repo.data.projects.find((item) => item.id === "project-2");
  check("发布后初始化冻结", project.setupStatus, "frozen");
  check("生效指针指向同一基线", project.activeBaselineRevisionId, revisionId);
  ok("规划页读取同一正式基线", repo.data.baselineRevisions.find((item) => item.id === project.activeBaselineRevisionId).status === "published");
}

console.log(`项目初始化检查通过：${passed} 项断言全部符合预期。`);
