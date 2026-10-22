import assert from "node:assert/strict";
import { z } from "zod";
import { seedData } from "../mocks/seed.ts";
import { DomainError, createCommandRunner } from "../lib/commands/core.ts";
import { archiveProject, commands } from "../lib/commands/registry.ts";
import { can } from "../lib/access/policy.ts";

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
  let failSaves = 0;
  return {
    read: async () => structuredClone(data),
    save: async (next) => {
      if (failSaves > 0) { failSaves -= 1; throw new Error("storage unavailable"); }
      data = structuredClone(next);
    },
    get data() { return data; },
    set data(value) { data = structuredClone(value); },
    failNextSaves(count) { failSaves = count; },
  };
}

function setup({ actorId = "member-1" } = {}) {
  const repo = memoryRepository(seedData);
  const saved = [];
  const state = { actor: actorId, now: "2026-10-06T12:00:00.000Z", logSeq: 0 };
  const run = createCommandRunner({
    repository: repo,
    currentActorId: () => state.actor,
    now: () => state.now,
    makeLogId: () => `log-test-${++state.logSeq}`,
    onSaved: (next) => saved.push(next),
  });
  return { repo, saved, state, run };
}

const finalizedFixture = (repo, projectId, lifecycle) => {
  const data = repo.data;
  repo.data = {
    ...data,
    projects: data.projects.map((item) => item.id === projectId ? { ...item, lifecycle } : item),
  };
};

// ── 场景：普通成员直接调用归档命令被拒绝 ──────────────────────────
{
  const { repo, saved, run } = setup({ actorId: "member-2" });
  const before = JSON.stringify(repo.data);
  const outcome = await run(archiveProject, { projectId: "project-1", expectedVersion: 3 });
  ok("普通成员归档被拒绝", outcome.ok === false && outcome.error.code === "FORBIDDEN");
  check("拒绝时数据未变更", JSON.stringify(repo.data), before);
  check("拒绝时不更新缓存", saved, []);
}

// ── 场景：只有 finalized 可归档，成功后更新为 archived ─────────────
{
  const { repo, saved, state, run } = setup({ actorId: "member-1" });
  const active = repo.data.projects.find((item) => item.id === "project-1");
  const busy = await run(archiveProject, { projectId: "project-1", expectedVersion: active.version });
  ok("进行中项目不能归档", busy.ok === false && busy.error.code === "INVALID_STATE");

  finalizedFixture(repo, "project-1", "finalized");
  const ready = repo.data.projects.find((item) => item.id === "project-1");
  const outcome = await run(archiveProject, { projectId: "project-1", expectedVersion: ready.version });
  ok("finalized 项目归档成功", outcome.ok === true);
  check("归档结果返回更新后的项目", outcome.result.lifecycle, "archived");
  const after = repo.data.projects.find((item) => item.id === "project-1");
  check("归档后状态为 archived", after.lifecycle, "archived");
  check("归档后版本递增", after.version, ready.version + 1);
  check("主体与日志同批保存", saved.length, 1);
  const log = repo.data.logs.at(-1);
  check("日志使用注入的 logId", /^log-test-\d+$/.test(log.id), true);
  check("日志身份来自会话而非输入", log.actorId, state.actor);
  check("日志时间使用注入的 now", log.createdAt, state.now);
  ok("保存数据同时包含主体与日志", saved[0].projects.some((item) => item.lifecycle === "archived") && saved[0].logs.some((item) => item.id === log.id));
}

// ── 场景：expectedVersion 过期拒绝，原对象和日志不被修改 ───────────
{
  const { repo, saved, run } = setup({ actorId: "member-1" });
  finalizedFixture(repo, "project-1", "finalized");
  const current = repo.data.projects.find((item) => item.id === "project-1");
  const before = JSON.stringify(repo.data);
  const outcome = await run(archiveProject, { projectId: "project-1", expectedVersion: current.version - 1 });
  ok("过期版本拒绝", outcome.ok === false && outcome.error.code === "VERSION_CONFLICT");
  check("冲突时返回最新版本", outcome.error.latestVersion, current.version);
  check("冲突时对象与日志不被修改", JSON.stringify(repo.data), before);
  check("冲突时不更新缓存", saved, []);
}

// ── 场景：保存失败不更新缓存；连续写按最新版本处理 ─────────────────
{
  const { repo, saved, run } = setup({ actorId: "member-1" });
  finalizedFixture(repo, "project-1", "finalized");
  const current = repo.data.projects.find((item) => item.id === "project-1");
  repo.failNextSaves(1);
  const failed = await run(archiveProject, { projectId: "project-1", expectedVersion: current.version });
  ok("保存失败返回 STORAGE_ERROR", failed.ok === false && failed.error.code === "STORAGE_ERROR");
  check("保存失败不更新缓存", saved, []);
  check("保存失败保留旧状态", repo.data.projects.find((item) => item.id === "project-1").lifecycle, "finalized");

  const retried = await run(archiveProject, { projectId: "project-1", expectedVersion: current.version });
  ok("重试后保存成功", retried.ok === true);
  const next = repo.data.projects.find((item) => item.id === "project-1");
  check("连续写按最新版本递增", next.version, current.version + 1);
  check("成功后缓存更新一次", saved.length, 1);
}

// ── 场景：会话注入身份，输入不能指定他人 ──────────────────────────
{
  const { repo, run } = setup({ actorId: "member-1" });
  const outcome = await run(archiveProject, { projectId: "project-1", expectedVersion: 3, actorId: "teacher-1" });
  ok("输入指定他人身份被校验拒绝", outcome.ok === false && outcome.error.code === "VALIDATION_ERROR");
  ok("校验错误带字段信息", Boolean(outcome.error.fieldErrors));
  const missing = await run(archiveProject, { projectId: "", expectedVersion: -1 });
  ok("缺失字段校验失败", missing.ok === false && missing.error.code === "VALIDATION_ERROR");
  const unknown = await run(archiveProject, { projectId: "project-999", expectedVersion: 1 });
  ok("不存在的目标返回 NOT_FOUND", unknown.ok === false && unknown.error.code === "NOT_FOUND");
  ok("DomainError 可识别", new DomainError("NOT_FOUND", "x") instanceof DomainError);
  void repo;
}

// ── 未实现命令明确返回错误，不伪造保存成功（占位行为保留） ─────────
{
  const { repo, saved, run } = setup({ actorId: "member-1" });
  const before = JSON.stringify(repo.data);
  const placeholder = {
    name: "probe.unimplemented",
    input: z.unknown(),
    apply() { throw new DomainError("INVALID_STATE", "命令 probe.unimplemented 尚未实现（计划：后续阶段），本次未写入任何数据"); },
  };
  const outcome = await run(placeholder, {});
  ok("未实现命令返回错误", outcome.ok === false && outcome.error.code === "INVALID_STATE");
  ok("错误说明计划阶段", outcome.error.message.includes("尚未实现"));
  check("未实现命令不写入数据", JSON.stringify(repo.data), before);
  check("未实现命令不更新缓存", saved, []);
  ok("注册表命令均已实现", Object.values(commands).every((command) => command.name !== "probe.unimplemented"));
}

// ── 场景：授权变更后的下一次操作读取最新授权 ───────────────────────
{
  const probe = {
    name: "probe.course.settings.update",
    input: z.object({ courseId: z.string().min(1) }).strict(),
    apply(data, context, input) {
      if (!can(data, context.actorId, "course.settings.update", { kind: "course", id: input.courseId })) {
        throw new DomainError("FORBIDDEN", "当前用户不能修改课程设置");
      }
      return { data, result: true };
    },
  };
  const { repo, state, run } = setup({ actorId: "ta-1" });
  const denied = await run(probe, { courseId: "course-1" });
  ok("默认只读助教被拒绝", denied.ok === false && denied.error.code === "FORBIDDEN");

  let data = repo.data;
  repo.data = {
    ...data,
    courses: data.courses.map((item) => item.id === "course-1" ? { ...item, assistantGrants: [{ userId: "ta-1", permissions: ["course.settings.update"] }] } : item),
  };
  const granted = await run(probe, { courseId: "course-1" });
  ok("授予授权后下一次操作通过", granted.ok === true);

  data = repo.data;
  repo.data = {
    ...data,
    courses: data.courses.map((item) => item.id === "course-1" ? { ...item, assistantGrants: [{ userId: "ta-1", permissions: [] }] } : item),
  };
  const revoked = await run(probe, { courseId: "course-1" });
  ok("撤销授权后下一次操作立即拒绝", revoked.ok === false && revoked.error.code === "FORBIDDEN");
  void state;
}

console.log(`业务命令检查通过：${passed} 项断言全部符合预期。`);
