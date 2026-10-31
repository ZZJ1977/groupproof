import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { applyCourseRuleChange, compareCourseRuleSnapshots, getRuleChangeImpact } from "../lib/commands/rule-change.ts";

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
    makeLogId: () => `log-rule-${++state.logSeq}`,
  });
  return { repo, state, run };
}

const baseRule = seedData.courseRuleRevisions.find((item) => item.id === "course-rule-course-1-legacy");
const makeRevision = (repo, id, number, snapshotOverrides = {}, rulesText) => {
  const data = repo.data;
  repo.data = {
    ...data,
    courseRuleRevisions: [...data.courseRuleRevisions, {
      ...structuredClone(baseRule),
      id,
      number,
      status: "published",
      snapshot: { ...structuredClone(baseRule.snapshot), ...snapshotOverrides },
      rulesText: rulesText ?? [...baseRule.rulesText],
      publishedBy: "teacher-1",
      publishedAt: "2026-10-06T08:00:00.000Z",
    }],
  };
};
const version = (repo) => repo.data.projects.find((item) => item.id === "project-1").version;
const impactOf = (repo, toId) => getRuleChangeImpact(repo.data, "project-1", toId);

// ── 只改人数：不展示截止顺延/格式变化 ─────────────────────────────
{
  const { repo } = setup();
  makeRevision(repo, "rule-size", 3, { minGroupSize: 2, maxGroupSize: 6 });
  const impact = impactOf(repo, "rule-size");
  check("仅人数字段变化", impact.changedFields.map((item) => item.field).sort(), ["最多人数", "最少人数"]);
  check("无截止顺延信息", impact.deadlineChange, undefined);
  check("无材料变化", impact.materialChanges, []);
  check("无需计划复核", impact.planReviewRequired, false);
  check("需要名单复核", impact.rosterReviewRequired, true);
  check("无需基线复核", impact.baselineReviewRequired, false);
}

// ── 提前截止：只报告真实超期里程碑，不自动改日期/计划 ───────────────
{
  const { repo, run } = setup();
  makeRevision(repo, "rule-early", 3, { projectDeadline: "2026-11-01" });
  const impact = impactOf(repo, "rule-early");
  ok("截止变化被记录", impact.deadlineChange?.after === "2026-11-01");
  ok("真实超期里程碑被报告", impact.conflictingMilestoneIds.includes("milestone-4") && impact.conflictingMilestoneIds.includes("milestone-3"));
  ok("未超期里程碑不报告", !impact.conflictingMilestoneIds.includes("milestone-1"));
  ok("需要计划复核", impact.planReviewRequired === true && impact.baselineReviewRequired === true);

  const milestonesBefore = JSON.stringify(repo.data.milestones.filter((item) => item.projectId === "project-1"));
  const plansBefore = JSON.stringify(repo.data.planRevisions);
  const outcome = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-early", expectedVersion: version(repo) });
  ok("组长确认适用成功", outcome.ok === true);
  check("里程碑日期不被自动修改", JSON.stringify(repo.data.milestones.filter((item) => item.projectId === "project-1")), milestonesBefore);
  check("正式计划不被自动修改", JSON.stringify(repo.data.planRevisions), plansBefore);
  check("项目截止字段更新为规则值", repo.data.projects.find((item) => item.id === "project-1").finalDeadline, "2026-11-01");
  check("适用指针更新", repo.data.projects.find((item) => item.id === "project-1").appliedCourseRuleRevisionId, "rule-early");
  ok("生成超期里程碑待办", repo.data.actionItems.some((item) => item.type.startsWith("rule-milestone:") && item.description.includes("milestone-4")));
  ok("生成计划复核待办", repo.data.actionItems.some((item) => item.type.startsWith("rule-plan:")));
  ok("生成基线变更草稿", repo.data.baselineRevisions.some((item) => item.projectId === "project-1" && item.status === "draft" && item.reason?.includes("rule-early")));
}

// ── 新增必交材料：缺口/待处理；确认后指针与约束一致 ─────────────────
{
  const { repo, run } = setup();
  makeRevision(repo, "rule-files", 3, { requiredFiles: [...baseRule.snapshot.requiredFiles, "部署说明"] });
  const impact = impactOf(repo, "rule-files");
  check("材料真实新增", impact.materialChanges, ["新增必交材料：部署说明"]);
  // 预置复核待办，验证确认后完成
  const data = repo.data;
  repo.data = {
    ...data,
    actionItems: [...data.actionItems, {
      id: "pre-review", assigneeId: "member-1", courseId: "course-1", projectId: "project-1", groupId: "group-1",
      type: "rule-review:rule-files", title: "复核规则", description: "", status: "pending", dueAt: "2026-12-20",
      href: "/courses/course-1/rule-changes", priority: "medium",
    }],
  };
  const outcome = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-files", expectedVersion: version(repo) });
  ok("确认适用成功", outcome.ok === true);
  ok("生成材料缺口待办", repo.data.actionItems.some((item) => item.type.startsWith("rule-material:") && item.title.includes("部署说明")));
  check("复核待处理项被完成", repo.data.actionItems.find((item) => item.id === "pre-review").status, "completed");
  check("规则指针一致", repo.data.projects.find((item) => item.id === "project-1").appliedCourseRuleRevisionId, "rule-files");
  check("截止字段与规则一致", repo.data.projects.find((item) => item.id === "project-1").finalDeadline, baseRule.snapshot.projectDeadline);
}

// ── v1 直接复核 v3；重复确认无重复记录/待办 ────────────────────────
{
  const { repo, run } = setup();
  makeRevision(repo, "rule-v3", 3, { projectDeadline: "2026-12-10", minGroupSize: 2, maxGroupSize: 6, requiredFiles: [...baseRule.snapshot.requiredFiles, "部署说明"] }, [...baseRule.rulesText, "新增：报告需附演示脚本"]);
  const impact = impactOf(repo, "rule-v3");
  ok("跨版本比较包含截止变化", impact.changedFields.some((item) => item.field === "项目截止"));
  ok("跨版本比较包含人数变化", impact.changedFields.some((item) => item.field === "最少人数"));
  ok("跨版本比较包含材料变化", impact.materialChanges.includes("新增必交材料：部署说明"));
  ok("跨版本比较包含规则条目变化", impact.changedFields.some((item) => item.field === "规则条目（新增）"));

  const first = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-v3", expectedVersion: version(repo) });
  ok("首次确认成功", first.ok === true);
  const reviewsBefore = repo.data.ruleChangeReviews.length;
  const actionsBefore = repo.data.actionItems.length;
  const second = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-v3", expectedVersion: version(repo) });
  ok("重复确认返回同一记录", second.ok === true && second.result.id === first.result.id);
  check("无重复确认记录", repo.data.ruleChangeReviews.length, reviewsBefore);
  check("无重复待处理项", repo.data.actionItems.length, actionsBefore);
}

// ── 资格与版本：普通成员/其他组长/失效版本拒绝 ──────────────────────
{
  const { repo, state, run } = setup({ actorId: "member-2" });
  makeRevision(repo, "rule-x", 3, { projectDeadline: "2026-12-10" });
  const byMember = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-x", expectedVersion: version(repo) });
  ok("普通成员不能提交适用", byMember.ok === false && byMember.error.code === "FORBIDDEN");

  state.actor = "member-5";
  const byOtherLeader = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-x", expectedVersion: version(repo) });
  ok("其他小组组长不能提交", byOtherLeader.ok === false && byOtherLeader.error.code === "FORBIDDEN");

  state.actor = "member-1";
  const stale = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-x", expectedVersion: 0 });
  ok("过期版本拒绝", stale.ok === false && stale.error.code === "VERSION_CONFLICT");

  const data = repo.data;
  repo.data = {
    ...data,
    courseRuleRevisions: data.courseRuleRevisions.map((item) => item.id === "rule-x" ? { ...item, status: "draft" } : item),
  };
  const invalid = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-x", expectedVersion: version(repo) });
  ok("未发布/失效版本拒绝", invalid.ok === false && invalid.error.code === "INVALID_STATE");

  const missing = await run(applyCourseRuleChange, { projectId: "project-1", toRevisionId: "rule-ghost", expectedVersion: version(repo) });
  ok("未知版本返回明确错误", missing.ok === false && missing.error.code === "NOT_FOUND");
}

// ── 纯比较器：模板变化分类 ────────────────────────────────────────
{
  const { repo } = setup();
  makeRevision(repo, "rule-template", 3, { milestoneTemplate: [{ id: "t1", title: "M1 新阶段", description: "", deadline: "2026-11-01" }] });
  const impact = impactOf(repo, "rule-template");
  ok("模板变化被识别", impact.changedFields.some((item) => item.field === "里程碑模板"));
  ok("模板变化触发计划复核", impact.planReviewRequired === true);
  void compareCourseRuleSnapshots;
}

console.log(`课程规则变更检查通过：${passed} 项断言全部符合预期。`);
