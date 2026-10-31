import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { createCommandRunner } from "../lib/commands/core.ts";
import { migrateWorkspace } from "../lib/versioning.ts";
import { activityHistory, activityVersion, canManageActivity, decideFeishuRecord, feishuActivityFilters, githubActivityFilters, githubTaskSuggestions, linkGithubActivity, queryFeishuActivities, queryGithubActivities } from "../features/c/activity-records.ts";

let passed = 0;
function check(message, actual, expected) { assert.deepEqual(actual, expected, message); passed += 1; }
function setup(actorId = "member-1") {
  let data = structuredClone(seedData), failNext = false;
  const saved = [];
  const run = createCommandRunner({ repository: {
    read: async () => structuredClone(data),
    save: async (next) => { if (failNext) { failNext = false; throw new Error("quota"); } data = structuredClone(next); },
  }, currentActorId: () => actorId, now: () => "2026-10-12T01:00:00Z", onSaved: (next) => saved.push(next) });
  return { run, saved, get data() { return data; }, failNextSave() { failNext = true; }, migrate() { data = migrateWorkspace(data).data; } };
}
const linkInput = { projectId: "project-1", recordId: "gh-1", taskId: "task-3", reason: "活动内容对应证据流程", expectedVersion: 0, idempotencyKey: "github-link-1" };
const adopt = { projectId: "project-1", recordId: "feishu-2", action: "adopt", taskId: "task-3", criterionIds: ["task-3-ac-1"], evidenceId: "feishu-candidate", reason: "这条测试讨论提供可追溯材料", expectedVersion: 0, idempotencyKey: "feishu-adopt-1" };
const ignore = { projectId: "project-1", recordId: "feishu-2", action: "ignore", reason: "暂与当前任务无关", expectedVersion: 0, idempotencyKey: "feishu-ignore-1" };
const restore = { ...ignore, action: "restore", reason: "核对后仍需作为待确认记录", expectedVersion: 1, idempotencyKey: "feishu-restore-1" };
const github = (s) => s.data.github.find((item) => item.id === "gh-1");
const feishu = (s) => s.data.feishu.find((item) => item.id === "feishu-2");

{
  const s = setup();
  const filters = githubActivityFilters(new URLSearchParams("kind=commit&days=7&author=member-1&task=task-1&q=GitHub&page=2"));
  check("GitHub组合过滤保留URL值", filters, { kind: "commit", days: "7", author: "member-1", task: "task-1", q: "GitHub", page: 2 });
  const found = queryGithubActivities(s.data, "project-1", { ...filters, page: 1 }, Date.parse("2026-10-05T09:00:00Z"));
  check("GitHub作者任务时间类型关键词取交集", found.items.map((item) => item.id), ["gh-2"]);
  check("未来活动不落入最近时间窗口", queryGithubActivities(s.data, "project-1", { ...filters, page: 1 }, Date.parse("2026-10-01T09:00:00Z")).total, 0);
  check("未关联过滤不会混入已关联活动", queryGithubActivities(s.data, "project-1", githubActivityFilters(new URLSearchParams("task=unlinked"))).items.map((item) => item.id), ["gh-4"]);
  for (const page of ["0", "-1", "NaN", "1.5", "99999999", ""]) check("非法页码回到首页", githubActivityFilters(new URLSearchParams({ page })).page, 1);
  check("未知枚举安全回退", githubActivityFilters(new URLSearchParams("kind=script&days=365")).kind, "all");
  for (let index = 0; index < 23; index++) s.data.github.push({ ...s.data.github[0], id: `paged-${String(index).padStart(2, "0")}` });
  s.data.github.push({ ...s.data.github[0], id: "other-project", projectId: "project-2" });
  const first = queryGithubActivities(s.data, "project-1", githubActivityFilters(new URLSearchParams()));
  const second = queryGithubActivities(s.data, "project-1", githubActivityFilters(new URLSearchParams("page=2")));
  const last = queryGithubActivities(s.data, "project-1", githubActivityFilters(new URLSearchParams("page=9999")));
  check("每页固定10条且不跨项目", [first.total, first.items.length, second.items.length, last.items.length], [27, 10, 10, 7]);
  check("超过总页数按末页取值", [last.page, last.totalPages], [3, 3]);
  check("稳定分页无重复", new Set([...first.items, ...second.items, ...last.items].map((item) => item.id)).size, 27);
  const before = JSON.stringify(s.data.github);
  queryGithubActivities(s.data, "project-1", filters);
  check("查询不重排原数据", JSON.stringify(s.data.github), before);
  const f = feishuActivityFilters(new URLSearchParams("group=GroupProof+项目组&status=candidate&author=member-2&task=task-3&q=截图&page=2"));
  check("飞书组合过滤与边界页", queryFeishuActivities(s.data, "project-1", f).items.map((item) => item.id), ["feishu-2"]);
  check("未知群组不泄露其他记录", queryFeishuActivities(s.data, "project-1", { ...f, group: "missing" }).total, 0);
  check("飞书未关联条件", queryFeishuActivities(s.data, "project-1", feishuActivityFilters(new URLSearchParams("task=unlinked"))).items.map((item) => item.id), ["feishu-3"]);
  for (const actorId of ["member-5", "teacher-2", "admin-1", "missing"]) {
    s.data.currentUserId = actorId;
    check("只读查询也拒绝外组读取数量", queryGithubActivities(s.data, "project-1", filters).total, 0);
    check("飞书只读查询不泄露外组记录", queryFeishuActivities(s.data, "project-1", f).items, []);
    check("外组不能读取编号建议", githubTaskSuggestions(s.data, { ...s.data.github[0], title: "T-03" }), []);
  }
}

{
  const s = setup();
  s.data.github = [{ ...s.data.github[0], id: "older", timestamp: "2026-10-12T09:30:00+08:00" }, { ...s.data.github[0], id: "newer", timestamp: "2026-10-12T02:30:00Z" }];
  s.data.feishu = [{ ...s.data.feishu[0], id: "older", timestamp: "2026-10-12T09:30:00+08:00" }, { ...s.data.feishu[0], id: "newer", timestamp: "2026-10-12T02:30:00Z" }];
  check("GitHub不同时区按实际时间倒序", queryGithubActivities(s.data, "project-1", githubActivityFilters(new URLSearchParams())).items.map((item) => item.id), ["newer", "older"]);
  check("飞书不同时区按实际时间倒序", queryFeishuActivities(s.data, "project-1", feishuActivityFilters(new URLSearchParams())).items.map((item) => item.id), ["newer", "older"]);
}

{
  const s = setup();
  const original = s.data.github[0];
  check("只匹配明确编号及子任务号", githubTaskSuggestions(s.data, { ...original, title: "fix T-03.1 and T-03" }).map((item) => item.id).sort(), ["task-1", "task-1a"]);
  check("编号不按前缀误关联", githubTaskSuggestions(s.data, { ...original, title: "T-030 / AT-03 / T-03abc" }).length, 0);
  s.data.tasks.push({ ...s.data.tasks[0], id: "ambiguous-task" });
  check("相同编号多任务不会自动猜一个", githubTaskSuggestions(s.data, { ...original, title: "T-03" }).length, 0);
  s.data.tasks.push({ ...s.data.tasks[0], id: "other-task", projectId: "project-2", title: "T-99 外组任务" });
  check("不建议跨项目编号", githubTaskSuggestions(s.data, { ...original, title: "T-99" }).length, 0);
  s.data.tasks.push({ ...s.data.tasks[0], id: "task-88", title: "没有显式编号" });
  check("不会从Task ID编造编号", githubTaskSuggestions(s.data, { ...original, title: "T-88" }).length, 0);
}

{
  const s = setup();
  const unchanged = JSON.stringify([s.data.tasks, s.data.evidence, s.data.verifications, s.data.notifications]);
  const logCount = s.data.logs.length;
  const results = await Promise.all([s.run(linkGithubActivity, linkInput), s.run(linkGithubActivity, linkInput)]);
  check("重复点击关联返回成功", results.map((result) => result.ok), [true, true]);
  check("只写一次关联历史和版本", [github(s).taskId, activityHistory(github(s)).length, activityVersion(github(s)), s.data.logs.length], ["task-3", 1, 1, logCount + 1]);
  check("不修改源标题链接作者", [github(s).title, github(s).url, github(s).authorId], [seedData.github[0].title, seedData.github[0].url, seedData.github[0].authorId]);
  check("关联不修改任务或D", JSON.stringify([s.data.tasks, s.data.evidence, s.data.verifications, s.data.notifications]), unchanged);
  check("旧版本关联拒绝", (await s.run(linkGithubActivity, { ...linkInput, idempotencyKey: "stale" })).error.code, "VERSION_CONFLICT");
  check("幂等键不能改任务", (await s.run(linkGithubActivity, { ...linkInput, taskId: "task-1" })).error.code, "VERSION_CONFLICT");
  check("解除关联也可追溯", (await s.run(linkGithubActivity, { ...linkInput, taskId: null, expectedVersion: 1, idempotencyKey: "unlink" })).ok, true);
  check("解除不删除来源活动", [github(s).taskId, s.data.github.length, activityHistory(github(s)).length], [undefined, seedData.github.length, 2]);
  check("旧关联重放不复活已解除关系", (await s.run(linkGithubActivity, linkInput)).result.taskId, undefined);
  check("同步事件不纳入C任务关联", (await s.run(linkGithubActivity, { ...linkInput, recordId: "gh-4", idempotencyKey: "sync-link" })).error.code, "INVALID_STATE");
  check("关联任务必须在同项目", (await s.run(linkGithubActivity, { ...linkInput, taskId: "other-task", expectedVersion: 2, idempotencyKey: "foreign-task" })).error.code, "VALIDATION_ERROR");
}

{
  const s = setup();
  const baseline = JSON.stringify([s.data.tasks, s.data.verifications, s.data.contributions, s.data.notifications]);
  const original = structuredClone(feishu(s));
  const count = s.data.evidence.length;
  const results = await Promise.all([s.run(decideFeishuRecord, adopt), s.run(decideFeishuRecord, adopt)]);
  check("重复采纳同次命令幂等", results.map((result) => result.ok), [true, true]);
  check("采纳状态及候选原子保存且仅一条", [feishu(s).status, activityVersion(feishu(s)), s.data.evidence.length], ["adopted", 1, count + 1]);
  const candidate = s.data.evidence.find((item) => item.id === adopt.evidenceId);
  check("记录采纳不是formal", candidate.status, "candidate");
  check("提交者是当前actor而非冒用来源作者", [candidate.authorId, candidate.sourceSnapshot.record.authorId], ["member-1", "member-2"]);
  check("保存完整现有记录快照", candidate.sourceSnapshot.record, original);
  check("没有编造feishu协议外链", candidate.sourceUrl, undefined);
  check("本地原记录链接单独保存", candidate.sourceRecordUrl, "/projects/project-1/collaboration#feishu-2");
  check("候选创建时间不伪造为原消息时间", candidate.createdAt, "2026-10-12T01:00:00Z");
  check("必须保留标准关系", candidate.criterionIds, ["task-3-ac-1"]);
  check("采纳不写B任务D记录通知", JSON.stringify([s.data.tasks, s.data.verifications, s.data.contributions, s.data.notifications]), baseline);
  feishu(s).summary = "后来更新摘要";
  check("原候选快照不会被源对象就地改变", candidate.sourceSnapshot.record.summary, original.summary);
  check("已采纳记录不得换键再建重复候选", (await s.run(decideFeishuRecord, { ...adopt, expectedVersion: 1, idempotencyKey: "again", evidenceId: "another" })).error.code, "INVALID_STATE");
  check("跨命令重复幂等键拒绝", (await s.run(linkGithubActivity, { ...linkInput, idempotencyKey: adopt.idempotencyKey })).error.code, "VERSION_CONFLICT");
}

{
  const s = setup();
  const count = s.data.evidence.length;
  const results = await Promise.all([s.run(decideFeishuRecord, ignore), s.run(decideFeishuRecord, ignore)]);
  check("忽略双击仅处理一次", [results.every((item) => item.ok), feishu(s).status, activityHistory(feishu(s)).length], [true, "ignored", 1]);
  check("忽略不能直接采纳", (await s.run(decideFeishuRecord, { ...adopt, expectedVersion: 1 })).error.code, "INVALID_STATE");
  check("恢复待确认成功", (await s.run(decideFeishuRecord, restore)).ok, true);
  check("恢复后保持待确认且不建候选", [feishu(s).status, activityVersion(feishu(s)), s.data.evidence.length], ["candidate", 2, count]);
  check("已完成恢复重放不增加历史", (await s.run(decideFeishuRecord, restore)).ok, true);
  check("历史保留处理原因", activityHistory(feishu(s)).map((entry) => entry.reason), [ignore.reason, restore.reason]);
  check("恢复后可以重新核对采纳", (await s.run(decideFeishuRecord, { ...adopt, expectedVersion: 2 })).ok, true);
}

for (const actorId of ["member-1", "member-2", "member-3", "teacher-1"]) {
  const s = setup(actorId);
  check("项目成员及所属教师处理资格", canManageActivity(s.data, actorId, "project-1"), true);
  check("可手动关联活动", (await s.run(linkGithubActivity, linkInput)).ok, true);
  check("可采纳为自己提交的候选", (await s.run(decideFeishuRecord, adopt)).ok, true);
}
for (const actorId of ["member-5", "teacher-2", "ta-1", "admin-1", "missing"]) {
  const s = setup(actorId), before = JSON.stringify(s.data);
  check("外组助教管理员不能越权关联", (await s.run(linkGithubActivity, linkInput)).error.code, "FORBIDDEN");
  check("外组助教管理员不能越权处理飞书", (await s.run(decideFeishuRecord, adopt)).error.code, "FORBIDDEN");
  check("越权没有部分写入", JSON.stringify(s.data), before);
}
for (const condition of ["unverified", "disabled", "archived", "course-ended"]) {
  const s = setup();
  if (condition === "unverified") s.data.users[0].verified = false;
  if (condition === "disabled") s.data.users[0].status = "disabled";
  if (condition === "archived") s.data.projects[0].lifecycle = "archived";
  if (condition === "course-ended") s.data.courses[0].status = "ended";
  check("身份生命周期变动拒绝处理", (await s.run(decideFeishuRecord, ignore)).error.code, "FORBIDDEN");
}
for (const condition of ["unfrozen", "plan-unlocked", "foreign-task", "wrong-criterion", "unstarted-task"]) {
  const s = setup(); let input = { ...adopt };
  if (condition === "unfrozen") s.data.projects[0].setupStatus = "draft";
  if (condition === "plan-unlocked") s.data.projects[0].planConfirmed = false;
  if (condition === "foreign-task") s.data.tasks.find((task) => task.id === adopt.taskId).projectId = "project-2";
  if (condition === "wrong-criterion") input.criterionIds = ["task-1-ac-1"];
  if (condition === "unstarted-task") input = { ...input, taskId: "task-4", criterionIds: ["task-4-ac-1"] };
  const before = JSON.stringify(s.data);
  check("候选创建业务前提被校验", (await s.run(decideFeishuRecord, input)).ok, false);
  check("无效候选不提前采纳记录", JSON.stringify(s.data), before);
}
{
  const s = setup(); s.migrate();
  const active = s.data.planRevisions.find((item) => item.id === s.data.projects[0].activePlanRevisionId);
  s.data.planRevisions.push({ ...structuredClone(active), id: "new-draft", number: active.number + 1, status: "draft" });
  check("新计划草稿不能借旧确认创建候选", (await s.run(decideFeishuRecord, adopt)).error.code, "INVALID_STATE");
  check("忽略与恢复无需冻结计划", (await s.run(decideFeishuRecord, ignore)).ok, true);
  check("可以恢复待确认供后续核对", (await s.run(decideFeishuRecord, restore)).ok, true);
}
for (const command of [linkGithubActivity, decideFeishuRecord]) {
  const input = command === linkGithubActivity ? linkInput : adopt;
  const s = setup(), before = JSON.stringify(s.data);
  s.failNextSave();
  check("保存失败明示错误", (await s.run(command, input)).error.code, "STORAGE_ERROR");
  check("保存失败无部分写入", JSON.stringify(s.data), before);
  check("失败不通知缓存成功", s.saved.length, 0);
  check("原输入同标识可重试", (await s.run(command, input)).ok, true);
}
{
  const s = setup();
  const results = await Promise.all([s.run(decideFeishuRecord, ignore), s.run(decideFeishuRecord, adopt)]);
  check("同版本并发不同决定只成功一次", results.map((item) => item.ok), [true, false]);
  check("落后决定返回版本冲突", results[1].error.code, "VERSION_CONFLICT");
  for (const input of [{ ...adopt, criterionIds: [] }, { ...adopt, reason: " " }, { ...adopt, actorId: "teacher-1" }, { ...adopt, expectedVersion: -1 }]) check("必填原因标准版本与会话身份边界", (await s.run(decideFeishuRecord, input)).error.code, "VALIDATION_ERROR");
  check("不能引用其他项目来源", (await s.run(linkGithubActivity, { ...linkInput, projectId: "project-2" })).error.code, "NOT_FOUND");
}
console.log(`C activity records: ${passed} assertions passed.`);
