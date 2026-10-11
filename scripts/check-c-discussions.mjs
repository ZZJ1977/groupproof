import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { canMarkDiscussionImportant, canWriteDiscussion, createDiscussion, discussionAsEvidence, discussionMentionTargets, markDiscussionImportant, replyDiscussion } from "../features/c/discussions.ts";

let passed = 0;
function check(message, actual, expected) { assert.deepEqual(actual, expected, message); passed += 1; }
function setup(actorId = "member-1") {
  let data = structuredClone(seedData);
  let failNext = false;
  const saved = [];
  const run = createCommandRunner({
    repository: {
      read: async () => structuredClone(data),
      save: async (next) => { if (failNext) { failNext = false; throw new Error("quota"); } data = structuredClone(next); },
    },
    currentActorId: () => actorId,
    now: () => "2026-10-11T12:00:00Z",
    onSaved: (next) => saved.push(next),
  });
  return { run, saved, get data() { return data; }, failNextSave() { failNext = true; } };
}
const createInput = { projectId: "project-1", id: "discussion-new", title: "新讨论", body: "可复查的讨论原文", taskId: "task-3", requirementId: "req-1", moduleId: "module-1", milestoneId: "milestone-1" };
const replyInput = { projectId: "project-1", discussionId: "discussion-new", replyId: "reply-new", text: "第一条回复", mentionedUserIds: ["member-2"] };
const importantInput = { projectId: "project-1", discussionId: "discussion-new", important: true, reason: "讨论结论将作为验收依据" };
const evidenceInput = { projectId: "project-1", discussionId: "discussion-new", evidenceId: "discussion-evidence", taskId: "task-3", criterionIds: ["task-3-ac-1"] };

{
  const s = setup();
  const count = s.data.discussions.length;
  const [first, duplicate] = await Promise.all([s.run(createDiscussion, createInput), s.run(createDiscussion, createInput)]);
  check("连续发布同一提交只创建一条", s.data.discussions.length, count + 1);
  check("重复请求返回相同讨论", [first.ok, duplicate.ok, first.result.id, duplicate.result.id], [true, true, createInput.id, createInput.id]);
  check("同项目四类关联都保留", [first.result.taskId, first.result.requirementId, first.result.moduleId, first.result.milestoneId], ["task-3", "req-1", "module-1", "milestone-1"]);
  check("内容修改不能复用旧提交标识", (await s.run(createDiscussion, { ...createInput, body: "替换旧讨论" })).error.code, "VERSION_CONFLICT");
  for (const key of ["taskId", "requirementId", "moduleId", "milestoneId"]) {
    const collection = { taskId: "tasks", requirementId: "requirements", moduleId: "modules", milestoneId: "milestones" }[key];
    s.data[collection].push({ ...s.data[collection][0], id: `foreign-${key}`, projectId: "project-2" });
    const before = JSON.stringify(s.data.discussions);
    check("跨项目关联拒绝", (await s.run(createDiscussion, { ...createInput, id: `invalid-${key}`, [key]: `foreign-${key}` })).error.code, "VALIDATION_ERROR");
    check("拒绝关联时不留下讨论", JSON.stringify(s.data.discussions), before);
    check("不存在关联拒绝", (await s.run(createDiscussion, { ...createInput, id: `missing-${key}`, [key]: "missing" })).error.code, "VALIDATION_ERROR");
  }
  check("空白标题拒绝", (await s.run(createDiscussion, { ...createInput, id: "blank", title: "   " })).error.code, "VALIDATION_ERROR");
  check("不能从输入冒用作者", (await s.run(createDiscussion, { ...createInput, id: "spoof", authorId: "teacher-1" })).error.code, "VALIDATION_ERROR");
}

{
  const s = setup();
  await s.run(createDiscussion, createInput);
  await s.run(createDiscussion, { ...createInput, id: "second-thread", title: "另一条讨论" });
  const notificationsBefore = JSON.stringify(s.data.notifications);
  const replies = await Promise.all([
    s.run(replyDiscussion, replyInput),
    s.run(replyDiscussion, { ...replyInput, replyId: "reply-next", text: "第二条回复" }),
    s.run(markDiscussionImportant, importantInput),
  ]);
  check("快速回复与标记命令全部成功", replies.map((item) => item.ok), [true, true, true]);
  const thread = s.data.discussions.find((item) => item.id === createInput.id);
  check("最新读取保留两条回复", thread.replies.map((item) => item.text), ["第一条回复", "第二条回复"]);
  check("回复不串到其他讨论", s.data.discussions.find((item) => item.id === "second-thread").replies.length, 0);
  check("幂等重试回复成功", (await s.run(replyDiscussion, replyInput)).ok, true);
  check("重试不重复插入", s.data.discussions.find((item) => item.id === createInput.id).replies.length, 2);
  check("回复标识不可换串", (await s.run(replyDiscussion, { ...replyInput, discussionId: "second-thread" })).error.code, "VERSION_CONFLICT");
  check("回复标识不可换文", (await s.run(replyDiscussion, { ...replyInput, text: "修改正文" })).error.code, "VERSION_CONFLICT");
  check("不可回复别的项目同名线程", (await s.run(replyDiscussion, { ...replyInput, projectId: "project-2" })).error.code, "NOT_FOUND");
  check("不能提及无读取权限账号", (await s.run(replyDiscussion, { ...replyInput, replyId: "invalid-mention", mentionedUserIds: ["member-5"] })).error.code, "VALIDATION_ERROR");
  check("提及不会伪造通知送达", JSON.stringify(s.data.notifications), notificationsBefore);
  const restored = JSON.parse(JSON.stringify(s.data));
  check("刷新持久化重要标记", restored.discussions.find((item) => item.id === createInput.id).important, true);
  check("重要标记原因保留", restored.discussions.find((item) => item.id === createInput.id).importantReason, importantInput.reason);
  check("其他讨论不受重要标记影响", restored.discussions.find((item) => item.id === "second-thread").important, false);
  check("读取权限控制可提及成员", discussionMentionTargets(s.data, "project-1").some((item) => item.id === "member-5"), false);
}

{
  const s = setup();
  const before = JSON.stringify(s.data);
  s.failNextSave();
  check("保存失败是失败结果", (await s.run(createDiscussion, createInput)).error.code, "STORAGE_ERROR");
  check("保存失败不回写缓存", s.saved.length, 0);
  check("保存失败不变更数据", JSON.stringify(s.data), before);
  check("相同草稿与提交标识可重试", (await s.run(createDiscussion, createInput)).ok, true);
  s.failNextSave();
  check("回复保存失败可恢复", (await s.run(replyDiscussion, replyInput)).error.code, "STORAGE_ERROR");
  check("失败回复不提前显示成功", s.data.discussions.find((item) => item.id === createInput.id).replies.length, 0);
  await s.run(replyDiscussion, replyInput);
  check("重试回复只增加一条", s.data.discussions.find((item) => item.id === createInput.id).replies.length, 1);
}

for (const actor of ["member-1", "member-2", "teacher-1"]) check("成员及所属教师可写", canWriteDiscussion(seedData, actor, "project-1"), true);
for (const [actor, expected] of [["member-1", true], ["member-4", true], ["teacher-1", true], ["member-2", false], ["ta-1", false]]) {
  check("重要标记只允许作者组长所属教师", canMarkDiscussionImportant(seedData, actor, seedData.discussions.find((item) => item.id === "discussion-2")), expected);
}
{
  const s = setup("member-2");
  check("其他普通成员不能绕过UI标重要", (await s.run(markDiscussionImportant, { ...importantInput, discussionId: "discussion-2" })).error.code, "FORBIDDEN");
  check("没有原因不能修改重要标记", (await s.run(markDiscussionImportant, { ...importantInput, discussionId: "discussion-2", reason: "  " })).error.code, "VALIDATION_ERROR");
}
for (const actor of ["member-5", "teacher-2", "ta-1", "admin-1", "missing"]) {
  const s = setup(actor);
  check("非参与者或只读角色不能绕过界面写入", (await s.run(createDiscussion, createInput)).error.code, "FORBIDDEN");
}
for (const condition of ["unverified", "disabled", "archived", "course-ended"]) {
  const s = setup();
  if (condition === "unverified") s.data.users.find((item) => item.id === "member-1").verified = false;
  if (condition === "disabled") s.data.users.find((item) => item.id === "member-1").status = "disabled";
  if (condition === "archived") s.data.projects.find((item) => item.id === "project-1").lifecycle = "archived";
  if (condition === "course-ended") s.data.courses.find((item) => item.id === "course-1").status = "ended";
  check("身份与项目状态写入边界", (await s.run(createDiscussion, createInput)).error.code, "FORBIDDEN");
}

{
  const s = setup();
  await s.run(createDiscussion, createInput);
  check("普通讨论不能直接成为来源", (await s.run(discussionAsEvidence, evidenceInput)).error.code, "INVALID_STATE");
  await s.run(markDiscussionImportant, importantInput);
  const tasksBefore = JSON.stringify(s.data.tasks);
  const verificationsBefore = JSON.stringify(s.data.verifications);
  check("未开始任务不被证据隐式启动", (await s.run(discussionAsEvidence, { ...evidenceInput, taskId: "task-4", criterionIds: ["task-4-ac-1"] })).error.code, "INVALID_STATE");
  check("拒绝别的任务的验收标准", (await s.run(discussionAsEvidence, { ...evidenceInput, criterionIds: ["task-1-ac-1"] })).error.code, "VALIDATION_ERROR");
  check("空标准不能形成候选", (await s.run(discussionAsEvidence, { ...evidenceInput, criterionIds: [] })).error.code, "VALIDATION_ERROR");
  const result = await s.run(discussionAsEvidence, evidenceInput);
  check("重要讨论可以生成候选来源", result.ok, true);
  check("来源类型与状态准确", [result.result.source, result.result.status], ["discussion", "candidate"]);
  check("不捏造原始外部链接", result.result.sourceUrl, undefined);
  check("本地记录链接单独保存", result.result.sourceRecordUrl, "/projects/project-1/discussions?discussion=discussion-new");
  check("原文快照与关联保存", [result.result.sourceSnapshot.record.body, result.result.sourceSnapshot.record.requirementId], [createInput.body, createInput.requirementId]);
  await s.run(replyDiscussion, replyInput);
  check("后来的回复不会污染已存证据快照", s.data.evidence.find((item) => item.id === evidenceInput.evidenceId).sourceSnapshot.record.replies.length, 0);
  check("回复更新来源失效标记", s.data.evidence.find((item) => item.id === evidenceInput.evidenceId).sourceChanged, true);
  check("重复候选请求幂等", (await s.run(discussionAsEvidence, evidenceInput)).ok, true);
  check("重复来源候选不会新增记录", s.data.evidence.filter((item) => item.id === evidenceInput.evidenceId).length, 1);
  check("候选不会完成或改写任务", JSON.stringify(s.data.tasks), tasksBefore);
  check("保存候选或来源变化不直接写D验收", JSON.stringify(s.data.verifications), verificationsBefore);
  await s.run(discussionAsEvidence, { ...evidenceInput, evidenceId: "second-capture" });
  await s.run(markDiscussionImportant, { ...importantInput, important: false });
  check("撤销重要使关联来源失效", s.data.evidence.find((item) => item.id === "second-capture").sourceChanged, true);
  check("取消重要保留既有证据快照", s.data.evidence.find((item) => item.id === evidenceInput.evidenceId).sourceSnapshot.record.important, true);
  await s.run(markDiscussionImportant, importantInput);
  s.data.projects.find((item) => item.id === "project-1").planConfirmed = false;
  check("未确认计划不能形成来源候选", (await s.run(discussionAsEvidence, { ...evidenceInput, evidenceId: "unconfirmed" })).error.code, "INVALID_STATE");
}

console.log(`C discussions: ${passed} assertions passed.`);
