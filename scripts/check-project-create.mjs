import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { createCourseProject } from "../lib/commands/project-create.ts";
import { publishedCourseRule } from "../lib/versioning.ts";

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

function setup({ actorId = "member-8" } = {}) {
  const repo = memoryRepository(seedData);
  const state = { actor: actorId, logSeq: 0 };
  const run = createCommandRunner({
    repository: repo,
    currentActorId: () => state.actor,
    now: () => "2026-10-06T12:00:00.000Z",
    makeLogId: () => `log-create-${++state.logSeq}`,
  });
  return { repo, state, run };
}

const ruleIdOf = (data, courseId) => publishedCourseRule(data, courseId)?.id;
const inputFor = (data, groupId, overrides = {}) => {
  const group = data.groups.find((item) => item.id === groupId);
  return {
    groupId,
    name: "智能校园助手",
    description: "面向校园场景的智能服务项目",
    templateMode: "course",
    expectedGroupVersion: group.version,
    expectedCourseRuleRevisionId: ruleIdOf(data, "course-1"),
    ...overrides,
  };
};

// ── 全局 student 但为该组组长可以创建 ─────────────────────────────
{
  const { repo, run } = setup({ actorId: "member-8" });
  const before = structuredClone(repo.data);
  const outcome = await run(createCourseProject, inputFor(repo.data, "group-3"));
  ok("group-3 组长（全局 student）创建成功", outcome.ok === true && outcome.result.alreadyExists === false);
  const project = outcome.result.project;
  check("项目成员来自小组名单", project.memberIds, before.groups.find((item) => item.id === "group-3").memberIds);
  check("记录采用的课程规则版本", project.appliedCourseRuleRevisionId, ruleIdOf(before, "course-1"));
  check("类型与截止日来源于课程规则", [project.type, project.finalDeadline], ["课程项目", publishedCourseRule(before, "course-1").snapshot.projectDeadline]);
  check("新项目为 not_initialized/active", [project.setupStatus, project.lifecycle], ["not_initialized", "active"]);
  const milestones = repo.data.milestones.filter((item) => item.projectId === project.id);
  ok("模板里程碑归属新项目", milestones.length > 0 && milestones.every((item) => item.projectId === project.id));
  check("里程碑来自规则快照模板", milestones.map((item) => item.title), (publishedCourseRule(before, "course-1").snapshot.milestoneTemplate ?? []).map((item) => item.title));
  const group = repo.data.groups.find((item) => item.id === "group-3");
  check("Group.projectId 同批更新", group.projectId, project.id);
  check("Group.version 递增", group.version, before.groups.find((item) => item.id === "group-3").version + 1);
  ok("创建日志同批提交", repo.data.logs.some((item) => item.action === "创建课程项目" && item.target === project.id && item.actorId === "member-8"));
  check("旧项目数据不被改写", JSON.stringify(repo.data.milestones.filter((item) => item.projectId === "project-1")), JSON.stringify(before.milestones.filter((item) => item.projectId === "project-1")));
}

// ── 其他组长不能跨组创建 ─────────────────────────────────────────
{
  const { repo, run } = setup({ actorId: "member-1" });
  const before = JSON.stringify(repo.data);
  const outcome = await run(createCourseProject, inputFor(repo.data, "group-4"));
  ok("其他小组组长被拒绝", outcome.ok === false && outcome.error.code === "FORBIDDEN");
  check("拒绝时不写入任何数据", JSON.stringify(repo.data), before);

  const teacher = setup({ actorId: "teacher-1" });
  const byTeacher = await teacher.run(createCourseProject, inputFor(teacher.repo.data, "group-4"));
  ok("教师不能创建小组项目", byTeacher.ok === false && byTeacher.error.code === "FORBIDDEN");
}

// ── 重复创建返回现有项目，不产生副本 ─────────────────────────────
{
  const { repo, run } = setup({ actorId: "member-1" });
  const before = repo.data;
  const outcome = await run(createCourseProject, { ...inputFor(repo.data, "group-1"), name: "重复创建" });
  ok("重复创建返回现有项目入口", outcome.ok === true && outcome.result.alreadyExists === true);
  check("返回现有项目 ID", outcome.result.project.id, "project-1");
  check("不产生第二个同组项目", repo.data.projects.length, before.projects.length);
  check("不新增里程碑", repo.data.milestones.length, before.milestones.length);
}

// ── 无已发布规则 / 课程结束 / 人数不满足 拒绝 ─────────────────────
{
  const { repo, run } = setup({ actorId: "member-8" });
  const noRule = structuredClone(repo.data);
  noRule.courseRuleRevisions = [];
  repo.data = noRule;
  const withoutRule = await run(createCourseProject, inputFor(repo.data, "group-3", { expectedCourseRuleRevisionId: "any" }));
  ok("无已发布规则时拒绝", withoutRule.ok === false && withoutRule.error.code === "INVALID_STATE");

  const ended = setup({ actorId: "member-1" });
  const endedData = ended.repo.data;
  ended.repo.data = {
    ...endedData,
    groups: endedData.groups.map((item) => item.id === "group-7" ? { ...item, projectId: undefined } : item),
    projects: endedData.projects.filter((item) => item.id !== "project-4"),
  };
  const endedInput = inputFor(ended.repo.data, "group-7", { expectedCourseRuleRevisionId: ruleIdOf(ended.repo.data, "course-3") });
  const endedOutcome = await ended.run(createCourseProject, endedInput);
  ok("已结束课程拒绝创建", endedOutcome.ok === false && endedOutcome.error.code === "INVALID_STATE");

  const { repo: sizeRepo, run: sizeRun } = setup({ actorId: "member-8" });
  const sizeData = sizeRepo.data;
  sizeRepo.data = {
    ...sizeData,
    courseRuleRevisions: sizeData.courseRuleRevisions.map((item) => item.id === ruleIdOf(sizeData, "course-1") ? { ...item, snapshot: { ...item.snapshot, maxGroupSize: 2 } } : item),
  };
  const sizeOutcome = await sizeRun(createCourseProject, inputFor(sizeRepo.data, "group-3"));
  ok("人数不满足条件时拒绝", sizeOutcome.ok === false && sizeOutcome.error.code === "INVALID_STATE");
  ok("拒绝消息说明人数范围", sizeOutcome.error.message.includes("人数"));
}

// ── 版本冲突：规则版本变化 / 小组版本过期，且失败不改 Group ────────
{
  const { repo, run } = setup({ actorId: "member-8" });
  const before = JSON.stringify(repo.data);
  const staleRule = await run(createCourseProject, inputFor(repo.data, "group-3", { expectedCourseRuleRevisionId: "course-rule-course-1-stale" }));
  ok("规则版本变化时要求重新确认", staleRule.ok === false && staleRule.error.code === "VERSION_CONFLICT");

  const staleGroup = await run(createCourseProject, inputFor(repo.data, "group-3", { expectedGroupVersion: 0 }));
  ok("小组版本过期拒绝", staleGroup.ok === false && staleGroup.error.code === "VERSION_CONFLICT");
  check("失败不改变 Group.projectId", JSON.stringify(repo.data), before);
}

// ── blank 模板不生成里程碑 ───────────────────────────────────────
{
  const { repo, run } = setup({ actorId: "member-12" });
  const outcome = await run(createCourseProject, inputFor(repo.data, "group-4", { templateMode: "blank" }));
  ok("blank 模式创建成功", outcome.ok === true);
  check("blank 模式不生成里程碑", repo.data.milestones.filter((item) => item.projectId === outcome.result.project.id), []);
  ok("课程强制约束仍然适用（截止日来自规则）", outcome.result.project.finalDeadline === publishedCourseRule(repo.data, "course-1").snapshot.projectDeadline);
}

console.log(`课程项目创建检查通过：${passed} 项断言全部符合预期。`);
