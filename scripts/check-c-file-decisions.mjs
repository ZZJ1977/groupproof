import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { migrateWorkspace } from "../lib/versioning.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { canWriteProjectFiles, designateProjectFile } from "../features/c/file-decisions.ts";

let passed = 0;
function check(message, actual, expected) { assert.deepEqual(actual, expected, message); passed += 1; }
function setup(actor = "member-1") {
  let data = migrateWorkspace(structuredClone(seedData)).data;
  const previous = data.files.find((item) => item.id === "file-2");
  data.files.push({ ...previous, id: "c5-draft", version: previous.version + 1, status: "draft" });
  data.files.push({ ...previous, id: "foreign-same-name", projectId: "project-3" });
  let fail = false;
  const actorState = { id: actor };
  const saved = [];
  const run = createCommandRunner({
    repository: {
      read: async () => structuredClone(data),
      save: async (next) => { if (fail) { fail = false; throw new Error("quota"); } data = structuredClone(next); },
    },
    currentActorId: () => actorState.id,
    now: () => "2026-10-12T00:10:00Z",
    onSaved: (next) => saved.push(next),
  });
  return { run, saved, actorState, get data() { return data; }, failNextSave() { fail = true; } };
}
const input = { projectId: "project-1", fileId: "c5-draft", expectedProjectVersion: 3, reason: "完成评审，设为当前正式资料", idempotencyKey: "file-designation-1" };
const file = (s, id = input.fileId) => s.data.files.find((item) => item.id === id);
const project = (s) => s.data.projects.find((item) => item.id === input.projectId);

{
  const s = setup();
  const original = structuredClone(s.data);
  const [first, repeated] = await Promise.all([s.run(designateProjectFile, input), s.run(designateProjectFile, input)]);
  check("重复确认返回相同成功", [first.ok, repeated.ok], [true, true]);
  check("旧版本保留且切换历史状态", [file(s, "file-2").status, file(s).status, s.data.files.length], ["superseded", "current", original.files.length]);
  check("文件正文版本不由决策递增", file(s).version, 2);
  check("同名仅一个正式版本", s.data.files.filter((item) => item.projectId === "project-1" && item.name === file(s).name && item.status === "current").map((item) => item.id), ["c5-draft"]);
  check("项目并发版本只增加一次", project(s).version, 4);
  check("只追加一次历史和日志", [file(s).cDesignationHistory.length, s.data.logs.length], [1, original.logs.length + 1]);
  check("决策记下原因身份旧文件与版本", file(s).cDesignationHistory[0], {
    idempotencyKey: input.idempotencyKey, actorId: "member-1", reason: input.reason,
    expectedProjectVersion: 3, resultProjectVersion: 4, fileVersion: 2,
    supersededFileIds: ["file-2"], decidedAt: "2026-10-12T00:10:00Z",
  });
  check("其他项目同名文件不变", file(s, "foreign-same-name"), original.files.find((item) => item.id === "foreign-same-name"));
  for (const collection of ["baselineRevisions", "planRevisions", "evidence", "verifications", "notifications", "actionItems", "tasks"]) {
    check("冻结引用及其他模块数据不变", s.data[collection], original[collection]);
  }
  check("刷新后原因和历史仍在", JSON.parse(JSON.stringify(s.data)).files.find((item) => item.id === input.fileId).cDesignationHistory[0].reason, input.reason);
  for (const change of [{ reason: "换原因" }, { expectedProjectVersion: 4 }, { fileId: "file-1" }]) {
    check("旧key换内容拒绝", (await s.run(designateProjectFile, { ...input, ...change })).error.code, "VERSION_CONFLICT");
  }
  s.actorState.id = "member-2";
  check("旧key不能冒用其他成员身份", (await s.run(designateProjectFile, input)).error.code, "VERSION_CONFLICT");
  s.actorState.id = "member-1";
  s.data.files.push({ ...file(s), id: "c5-next", version: 3, status: "draft", cDesignationHistory: undefined });
  check("后续新版本可以设正式", (await s.run(designateProjectFile, { ...input, fileId: "c5-next", expectedProjectVersion: 4, idempotencyKey: "newer-key" })).ok, true);
  check("旧提交重试不复活旧版本", (await s.run(designateProjectFile, input)).result.status, "superseded");
  check("重试不重复追加日志", s.data.logs.length, original.logs.length + 2);
}
for (const actor of ["member-1", "member-2", "member-3", "member-4"]) {
  const s = setup(actor);
  check("保留原有项目成员资料写资格", canWriteProjectFiles(s.data, actor, "project-1"), true);
  check("成员设正式成功", (await s.run(designateProjectFile, input)).ok, true);
}
for (const actor of ["member-5", "teacher-1", "teacher-2", "ta-1", "admin-1", "missing"]) {
  const s = setup(actor); const before = JSON.stringify(s.data);
  check("教学读取资格不自动变为项目文件写资格", canWriteProjectFiles(s.data, actor, "project-1"), false);
  check("越权命令拒绝", (await s.run(designateProjectFile, input)).error.code, "FORBIDDEN");
  check("越权不改任何资料", JSON.stringify(s.data), before);
}
for (const state of ["unverified", "disabled", "removed", "archived", "finalized", "ended-course", "draft-course", "missing-course"]) {
  const s = setup();
  const actor = s.data.users.find((item) => item.id === "member-1");
  if (state === "unverified") actor.verified = false;
  if (state === "disabled") actor.status = "disabled";
  if (state === "removed") project(s).memberIds = project(s).memberIds.filter((id) => id !== actor.id);
  if (state === "archived" || state === "finalized") project(s).lifecycle = state;
  if (state === "ended-course" || state === "draft-course") s.data.courses.find((item) => item.id === project(s).courseId).status = state === "ended-course" ? "ended" : "draft";
  if (state === "missing-course") project(s).courseId = "missing";
  check("最新身份及课程项目状态拒绝", (await s.run(designateProjectFile, input)).error.code, "FORBIDDEN");
}
{
  const s = setup();
  check("跨项目文件拒绝", (await s.run(designateProjectFile, { ...input, fileId: "foreign-same-name" })).error.code, "NOT_FOUND");
  check("课程原文件不能当项目版本", (await s.run(designateProjectFile, { ...input, fileId: "file-4" })).error.code, "NOT_FOUND");
  check("不存在项目拒绝", (await s.run(designateProjectFile, { ...input, projectId: "missing" })).error.code, "NOT_FOUND");
  for (const state of ["current", "superseded"]) {
    file(s).status = state;
    check("只接受草稿版本设正式", (await s.run(designateProjectFile, input)).error.code, "INVALID_STATE");
  }
}
{
  const s = setup();
  const before = JSON.stringify(s.data); s.failNextSave();
  check("存储失败返回明确错误", (await s.run(designateProjectFile, input)).error.code, "STORAGE_ERROR");
  check("失败不提前切换版本或写历史", JSON.stringify(s.data), before);
  check("失败不更新缓存", s.saved.length, 0);
  check("原原因和key重试可恢复", (await s.run(designateProjectFile, input)).ok, true);
  check("恢复只写一条历史", file(s).cDesignationHistory.length, 1);
}
{
  const s = setup();
  s.data.files.push({ ...file(s), id: "competing-draft", version: 3 });
  const outcomes = await Promise.all([
    s.run(designateProjectFile, input),
    s.run(designateProjectFile, { ...input, fileId: "competing-draft", idempotencyKey: "competing-key" }),
  ]);
  check("同项目版本竞争只允许一次成功", outcomes.map((item) => item.ok), [true, false]);
  check("竞争版本冲突明确", [outcomes[1].error.code, outcomes[1].error.latestVersion], ["VERSION_CONFLICT", 4]);
  check("落败草稿保持不变", file(s, "competing-draft").status, "draft");
  check("核对最新版本后重新确认可行", (await s.run(designateProjectFile, { ...input, fileId: "competing-draft", expectedProjectVersion: 4, idempotencyKey: "reviewed-key" })).ok, true);
}
{
  const s = setup();
  s.data.files.push({ ...file(s, "file-2"), id: "legacy-duplicate-current" });
  await s.run(designateProjectFile, input);
  check("旧数据多个current原子收敛到一个", s.data.files.filter((item) => item.projectId === "project-1" && item.name === file(s).name && item.status === "current").length, 1);
  check("两份旧current都记入历史", file(s).cDesignationHistory[0].supersededFileIds, ["file-2", "legacy-duplicate-current"]);
}
{
  const s = setup();
  for (const invalid of [{ reason: "   " }, { reason: "a".repeat(2001) }, { actorId: "teacher-1" }, { expectedProjectVersion: -1 }, { idempotencyKey: "" }]) {
    check("原因必填与输入白名单", (await s.run(designateProjectFile, { ...input, ...invalid })).error.code, "VALIDATION_ERROR");
  }
}
console.log(`C file decisions: ${passed} assertions passed.`);
