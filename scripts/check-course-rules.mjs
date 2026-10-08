import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import {
  publishCourseRules,
  saveCourseRuleDraft,
  setAssistantPermissions,
  updateCourseSettings,
  validateGrant,
} from "../lib/commands/course.ts";
import { draftCourseRule, publishedCourseRule } from "../lib/versioning.ts";

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

function setup({ actorId = "teacher-1" } = {}) {
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

const payloadOf = (course, overrides = {}) => ({
  projectDeadline: course.projectDeadline,
  formationDeadline: course.formationDeadline,
  groupingMode: course.groupingMode,
  minGroupSize: course.minGroupSize,
  maxGroupSize: course.maxGroupSize,
  requiredFiles: [...course.requiredFiles],
  gradingNotes: "评分说明：按证据与验收结果计分",
  githubRequired: true,
  aiAllowed: true,
  rulesText: [...course.rules],
  milestoneTemplate: (course.milestoneTemplate ?? []).map((item) => ({ ...item })),
  ...overrides,
});

const grantTa = (repo, courseId, permissions) => {
  const data = repo.data;
  repo.data = {
    ...data,
    courses: data.courses.map((item) => item.id === courseId ? { ...item, assistantGrants: [{ userId: "ta-1", permissions }] } : item),
  };
};

// ── edit-only 助教：可保存草稿、不能发布 ──────────────────────────
{
  const { repo, state, run } = setup({ actorId: "ta-1" });
  grantTa(repo, "course-1", ["course.rules.edit"]);
  const course = repo.data.courses.find((item) => item.id === "course-1");
  const saved = await run(saveCourseRuleDraft, { courseId: "course-1", payload: payloadOf(course), reason: "调整必交材料", expectedVersion: course.version });
  ok("edit-only 助教可保存规则草稿", saved.ok === true);
  check("草稿未覆盖已发布版本", publishedCourseRule(repo.data, "course-1")?.id, "course-rule-course-1-legacy");
  ok("草稿单独存在", draftCourseRule(repo.data, "course-1")?.id === saved.result.id);

  const denied = await run(publishCourseRules, { courseId: "course-1", revisionId: saved.result.id, expectedVersion: course.version });
  ok("edit-only 助教不能发布", denied.ok === false && denied.error.code === "FORBIDDEN");
  void state;
}

// ── 其他课程教师/助教不能修改 ────────────────────────────────────
{
  const { run } = setup({ actorId: "teacher-2" });
  const course = seedData.courses.find((item) => item.id === "course-1");
  const denied = await run(saveCourseRuleDraft, { courseId: "course-1", payload: payloadOf(course), reason: "越权", expectedVersion: course.version });
  ok("其他课程教师不能修改规则", denied.ok === false && denied.error.code === "FORBIDDEN");

  const ta = setup({ actorId: "ta-1" });
  grantTa(ta.repo, "course-1", ["course.rules.edit", "course.rules.publish"]);
  const course2 = ta.repo.data.courses.find((item) => item.id === "course-2");
  const cross = await ta.run(saveCourseRuleDraft, { courseId: "course-2", payload: payloadOf(course2), reason: "越权", expectedVersion: course2.version });
  ok("其他课程助教不能修改", cross.ok === false && cross.error.code === "FORBIDDEN");
}

// ── 无原因、无效人数、颠倒日期、不完整模板拒绝 ─────────────────────
{
  const { run } = setup({ actorId: "teacher-1" });
  const course = seedData.courses.find((item) => item.id === "course-1");
  const noReason = await run(saveCourseRuleDraft, { courseId: "course-1", payload: payloadOf(course), reason: "", expectedVersion: course.version });
  ok("无原因拒绝", noReason.ok === false && noReason.error.code === "VALIDATION_ERROR");

  const badSize = await run(saveCourseRuleDraft, { courseId: "course-1", payload: payloadOf(course, { minGroupSize: 4, maxGroupSize: 2 }), reason: "人数调整", expectedVersion: course.version });
  ok("无效人数拒绝", badSize.ok === false && badSize.error.code === "VALIDATION_ERROR" && Boolean(badSize.error.fieldErrors?.maxGroupSize));

  const badDates = await run(saveCourseRuleDraft, { courseId: "course-1", payload: payloadOf(course, { projectDeadline: "2026-10-01", formationDeadline: "2026-11-01" }), reason: "日期调整", expectedVersion: course.version });
  ok("颠倒日期拒绝", badDates.ok === false && badDates.error.code === "VALIDATION_ERROR" && Boolean(badDates.error.fieldErrors?.formationDeadline));

  const badTemplate = await run(saveCourseRuleDraft, { courseId: "course-1", payload: payloadOf(course, { milestoneTemplate: [{ id: "m1", title: "", description: "", deadline: "2026-11-01" }] }), reason: "模板调整", expectedVersion: course.version });
  const templateFields = Object.keys(badTemplate.error.fieldErrors ?? {});
  ok("不完整模板拒绝", badTemplate.ok === false && badTemplate.error.code === "VALIDATION_ERROR" && templateFields.some((key) => key.includes("milestoneTemplate")));
}

// ── 发布链路：保留旧版本、真实提醒、不改项目基线、幂等提醒 ──────────
{
  const { repo, run } = setup({ actorId: "teacher-1" });
  const course = repo.data.courses.find((item) => item.id === "course-1");
  const baselinesBefore = JSON.stringify(repo.data.baselineRevisions);
  const draft = await run(saveCourseRuleDraft, {
    courseId: "course-1",
    payload: payloadOf(course, { requiredFiles: [...course.requiredFiles, "演示视频"] }),
    reason: "新增演示视频要求",
    expectedVersion: course.version,
  });
  ok("教师可保存草稿", draft.ok === true);

  // 预置一条复核提醒，验证重复发布不会重复生成
  const data = repo.data;
  repo.data = {
    ...data,
    actionItems: [...data.actionItems, {
      id: "pre-rule-review", assigneeId: "member-1", courseId: "course-1", groupId: "group-1",
      type: `rule-review:${draft.result.id}`, title: "预置复核", description: "", status: "pending",
      dueAt: "2026-12-20", href: "/courses/course-1/rule-changes", priority: "medium",
    }],
  };

  const published = await run(publishCourseRules, { courseId: "course-1", revisionId: draft.result.id, expectedVersion: course.version });
  ok("教师发布规则成功", published.ok === true);
  check("发布后草稿变为已发布", published.result.status, "published");
  check("发布记录发布者", published.result.publishedBy, "teacher-1");
  ok("v1 历史保留", repo.data.courseRuleRevisions.some((item) => item.id === "course-rule-course-1-legacy"));
  ok("v2 新版本存在", repo.data.courseRuleRevisions.some((item) => item.id === draft.result.id && item.status === "published"));
  check("发布后学生读取最新已发布版本", publishedCourseRule(repo.data, "course-1")?.id, draft.result.id);
  check("不修改已有项目基线", JSON.stringify(repo.data.baselineRevisions), baselinesBefore);
  const reminders = repo.data.actionItems.filter((item) => item.type === `rule-review:${draft.result.id}`);
  check("每个关联小组一条复核提醒（含预置不重复）", reminders.length, repo.data.groups.filter((item) => item.courseId === "course-1").length);
  ok("提醒包含规则版本", reminders.filter((item) => item.id !== "pre-rule-review").every((item) => item.description.includes(`v${draft.result.number}`)));

  const repeat = await run(publishCourseRules, { courseId: "course-1", revisionId: draft.result.id, expectedVersion: repo.data.courses.find((item) => item.id === "course-1").version });
  ok("重复发布被拒绝", repeat.ok === false && repeat.error.code === "INVALID_STATE");
  check("重复发布不新增提醒", repo.data.actionItems.filter((item) => item.type === `rule-review:${draft.result.id}`).length, reminders.length);
  ok("发布日志写入", repo.data.logs.some((item) => item.action === "课程规则发布" && item.actorId === "teacher-1"));
}

// ── 助教授权：白名单、撤销保留归属、不能自授 ──────────────────────
{
  const { repo, state, run } = setup({ actorId: "teacher-1" });
  const course = repo.data.courses.find((item) => item.id === "course-1");
  const draftByTeacher = await run(saveCourseRuleDraft, { courseId: "course-1", payload: payloadOf(course), reason: "授权测试草稿", expectedVersion: course.version });
  ok("教师可保存规则草稿", draftByTeacher.ok === true);

  const granted = await run(setAssistantPermissions, { courseId: "course-1", assistantId: "ta-1", permissions: ["course.rules.publish"], expectedVersion: course.version });
  ok("教师可授予助教权限", granted.ok === true);

  state.actor = "ta-1";
  const publishByTa = await run(publishCourseRules, { courseId: "course-1", revisionId: draftByTeacher.result.id, expectedVersion: repo.data.courses.find((item) => item.id === "course-1").version });
  ok("获发布授权的助教可发布", publishByTa.ok === true);

  const selfGrant = await run(setAssistantPermissions, { courseId: "course-1", assistantId: "ta-1", permissions: ["course.staff.manage"], expectedVersion: repo.data.courses.find((item) => item.id === "course-1").version });
  ok("助教自授被拒（输入白名单不含 staff.manage）", selfGrant.ok === false && selfGrant.error.code === "VALIDATION_ERROR");
  const taManage = await run(setAssistantPermissions, { courseId: "course-1", assistantId: "ta-1", permissions: ["course.rules.edit"], expectedVersion: repo.data.courses.find((item) => item.id === "course-1").version });
  ok("助教调用授权管理命令被拒", taManage.ok === false && taManage.error.code === "FORBIDDEN");
  ok("白名单拒绝 staff.manage", (() => { try { validateGrant(["course.staff.manage"]); return false; } catch { return true; } })());

  state.actor = "teacher-1";
  const current = repo.data.courses.find((item) => item.id === "course-1");
  const revoked = await run(setAssistantPermissions, { courseId: "course-1", assistantId: "ta-1", permissions: [], expectedVersion: current.version });
  ok("撤销授权成功", revoked.ok === true);
  check("撤销后保留归属（只读）", revoked.result.assistantGrants.find((item) => item.userId === "ta-1")?.permissions, []);
  ok("撤销写入日志", repo.data.logs.some((item) => item.action === "撤销助教权限"));

  state.actor = "ta-1";
  const afterRevoke = await run(saveCourseRuleDraft, {
    courseId: "course-1",
    payload: payloadOf(repo.data.courses.find((item) => item.id === "course-1")),
    reason: "撤销后编辑",
    expectedVersion: repo.data.courses.find((item) => item.id === "course-1").version,
  });
  ok("撤销授权后编辑被拒绝", afterRevoke.ok === false && afterRevoke.error.code === "FORBIDDEN");

  state.actor = "teacher-1";
  const notTa = await run(setAssistantPermissions, { courseId: "course-1", assistantId: "member-2", permissions: [], expectedVersion: repo.data.courses.find((item) => item.id === "course-1").version });
  ok("非助教账号不能被关联", notTa.ok === false && notTa.error.code === "VALIDATION_ERROR");
}

// ── 课程设置命令与 ended 只读 ────────────────────────────────────
{
  const { repo, run } = setup({ actorId: "teacher-1" });
  const course = repo.data.courses.find((item) => item.id === "course-1");
  const updated = await run(updateCourseSettings, {
    courseId: "course-1", name: "软件工程 · 2026（调整）", projectDeadline: course.projectDeadline,
    formationDeadline: course.formationDeadline, groupingMode: "approval", minGroupSize: 3, maxGroupSize: 5,
    reason: "调整分组方式", expectedVersion: course.version,
  });
  ok("课程设置保存成功", updated.ok === true);
  check("设置写入兼容字段", updated.result.groupingMode, "approval");
  ok("设置变更写入日志", repo.data.logs.some((item) => item.action === "课程设置变更"));

  const stale = await run(updateCourseSettings, {
    courseId: "course-1", name: "过期版本", projectDeadline: course.projectDeadline,
    formationDeadline: course.formationDeadline, groupingMode: "free", minGroupSize: 3, maxGroupSize: 4,
    reason: "过期", expectedVersion: course.version,
  });
  ok("过期版本拒绝", stale.ok === false && stale.error.code === "VERSION_CONFLICT");

  const ended = await run(updateCourseSettings, {
    courseId: "course-3", name: "已结束课程", projectDeadline: "2025-12-18", formationDeadline: "2025-10-15",
    groupingMode: "free", minGroupSize: 3, maxGroupSize: 5, reason: "修改", expectedVersion: seedData.courses.find((item) => item.id === "course-3").version,
  });
  ok("非所属教师不能改其他课程", ended.ok === false && ended.error.code === "FORBIDDEN");

  const { repo: endedRepo, state: endedState, run: endedRun } = setup({ actorId: "teacher-2" });
  const endedCourse = endedRepo.data.courses.find((item) => item.id === "course-3");
  const endedDenied = await endedRun(updateCourseSettings, {
    courseId: "course-3", name: "已结束课程", projectDeadline: "2025-12-18", formationDeadline: "2025-10-15",
    groupingMode: "free", minGroupSize: 3, maxGroupSize: 5, reason: "修改", expectedVersion: endedCourse.version,
  });
  ok("ended 课程业务规则只读", endedDenied.ok === false && endedDenied.error.code === "INVALID_STATE");

  const revokeEnded = await endedRun(setAssistantPermissions, { courseId: "course-3", assistantId: "ta-1", permissions: [], expectedVersion: endedCourse.version });
  ok("ended 课程仍可处理授权撤销", revokeEnded.ok === true);
  void endedState;
}

console.log(`课程规则与授权检查通过：${passed} 项断言全部符合预期。`);
