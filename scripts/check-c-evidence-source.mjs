import assert from "node:assert/strict";
import { buildCandidateEvidence, draftFromFeishu, draftFromGithub, emptyEvidenceDraft, githubEvidenceUrl, taskAcceptsEvidence } from "../features/c/evidence-source.ts";

let passed = 0;
function check(message, actual, expected) { assert.deepEqual(actual, expected, message); passed += 1; }
const context = { id: "evidence-new", projectId: "project-1", taskId: "task-1", taskStatus: "in_progress", authorId: "member-1", criterionIds: ["ac-1", "ac-2"], canSubmit: true, createdAt: "2026-10-11T12:00:00Z" };
const githubRecord = { id: "github-1", projectId: "project-1", repository: "team/repo", type: "pr", title: "登录 PR", authorId: "member-2", taskId: "task-1", status: "merged", timestamp: "2026-10-10T12:00:00Z", url: "https://github.com/team/repo/pull/2" };
const feishuRecord = { id: "feishu-1", projectId: "project-1", groupName: "项目组", type: "decision", summary: "讨论原文摘要：保留登录审计。", authorId: "member-2", timestamp: "2026-10-10T13:00:00Z", status: "adopted", taskId: "task-1" };
const githubDraft = { ...draftFromGithub(githubRecord), criterionIds: ["ac-1"] };
const feishuDraft = { ...draftFromFeishu(feishuRecord), criterionIds: ["ac-1", "ac-2"] };

for (const value of ["https://github.com/team/repo/pull/2", "https://github.com/team/repo/commit/abc", "HTTPS://GITHUB.COM/team/repo"]) check("HTTPS 官方 GitHub 来源允许", Boolean(githubEvidenceUrl(value)), true);
for (const value of ["http://github.com/team/repo", "https://github.com.attacker.test/team/repo", "https://github.com@attacker.test/team/repo", "https://attacker.test@github.com/team/repo", "https://user:password@github.com/team/repo", "https://www.github.com/team/repo", "https://github.com:444/team/repo", "https://github.com./team/repo", "//github.com/team/repo", "javascript:alert(1)", "file:///github.com", "https:\\github.com/team/repo", "github.com/team/repo"]) check("非官方、安全协议或带凭据的 GitHub 地址拒绝", githubEvidenceUrl(value), null);

const switched = emptyEvidenceDraft("manual");
check("切换来源同时清除文本、链接、文件、标准与原始记录归属", switched, { source: "manual", title: "", description: "", sourceUrl: "", file: null, criterionIds: [], sourceRecordId: "", sourceRecordUrl: "" });
check("新来源不能借用旧来源说明直接提交", buildCandidateEvidence(switched, context).ok, false);
const isolated = emptyEvidenceDraft("github");
isolated.criterionIds.push("ac-1");
check("不同草稿不会共享标准选择", emptyEvidenceDraft("github").criterionIds, []);

const before = JSON.stringify({ context, feishuRecord, feishuDraft });
const candidate = buildCandidateEvidence(feishuDraft, context);
check("无外链但有现存飞书记录可作为候选", candidate.ok, true);
check("添加证据不会直接成为 formal", candidate.evidence.status, "candidate");
check("保存选中来源记录 ID", candidate.evidence.sourceRecordId, "feishu-1");
check("没有伪造原始来源 URL", candidate.evidence.sourceUrl, undefined);
check("本地记录定位独立保存", candidate.evidence.sourceRecordUrl, "/projects/project-1/collaboration#feishu-1");
check("保持原始记录可核对字段而非用户说明", candidate.evidence.sourceSnapshot.record, feishuRecord);
check("构造候选不修改任务或原始来源", JSON.stringify({ context, feishuRecord, feishuDraft }), before);
feishuDraft.sourceSnapshot.record.summary = "后来修改的记录";
check("候选快照不随草稿修改", candidate.evidence.sourceSnapshot.record.summary, "讨论原文摘要：保留登录审计。");
check("选择记录没有修改原数据", feishuRecord.summary, "讨论原文摘要：保留登录审计。");
const restored = JSON.parse(JSON.stringify(candidate.evidence));
check("浏览器持久化可保留来源快照", restored.sourceSnapshot.record.timestamp, feishuRecord.timestamp);
const withUrl = draftFromFeishu({ ...feishuRecord, sourceUrl: "https://example.feishu.cn/docx/document" });
check("存在真实外链则保留", withUrl.sourceUrl, "https://example.feishu.cn/docx/document");
check("选择另一个记录不会沿用旧标准选择", withUrl.criterionIds, []);

for (const source of ["file", "screenshot"]) {
  const draft = { ...emptyEvidenceDraft(source), title: "test.png", description: "已选择本地文件", criterionIds: ["ac-1"], file: { name: "test.png", size: 100 } };
  const result = buildCandidateEvidence(draft, context);
  check("没有存储服务时不允许文件元数据假成功", result.ok, false);
  check("上传阻断提供明确原因", result.message.includes("文件存储尚未接入"), true);
}
for (const taskStatus of ["not_started", "pending_verification", "completed"]) {
  check("限定可补充证据的任务状态", taskAcceptsEvidence(taskStatus), false);
  check("不隐式启动任务或修改已验收任务", buildCandidateEvidence(githubDraft, { ...context, taskStatus }).ok, false);
}
for (const taskStatus of ["in_progress", "pending_submission"]) check("进行中和待提交任务允许候选", buildCandidateEvidence(githubDraft, { ...context, taskStatus }).ok, true);
check("没有编辑资格时拒绝", buildCandidateEvidence(githubDraft, { ...context, canSubmit: false }).ok, false);
check("跨任务验收标准拒绝", buildCandidateEvidence({ ...githubDraft, criterionIds: ["foreign-ac"] }, context).ok, false);
check("空标准选择拒绝", buildCandidateEvidence({ ...githubDraft, criterionIds: [] }, context).ok, false);
check("其他项目的来源记录拒绝", buildCandidateEvidence({ ...draftFromGithub({ ...githubRecord, projectId: "other-project" }), criterionIds: ["ac-1"] }, context).ok, false);
check("旧来源快照不能复用于新来源", buildCandidateEvidence({ ...githubDraft, source: "feishu" }, context).ok, false);
check("失配原始记录 ID 拒绝", buildCandidateEvidence({ ...githubDraft, sourceRecordId: "other-record" }, context).ok, false);
check("没有记录的飞书输入必须提供原始链接", buildCandidateEvidence({ ...emptyEvidenceDraft("feishu"), title: "讨论", description: "讨论结果", criterionIds: ["ac-1"] }, context).ok, false);
check("手填来源也拒绝脚本协议", buildCandidateEvidence({ ...emptyEvidenceDraft("manual"), title: "记录", description: "说明", criterionIds: ["ac-1"], sourceUrl: "javascript:alert(1)" }, context).ok, false);
console.log(`C evidence source flow: ${passed} assertions passed.`);
