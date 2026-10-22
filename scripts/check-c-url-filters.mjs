import assert from "node:assert/strict";
import { filterEvidence, patchQueryHref, readEvidenceFilters, readEvidenceView, readTaskDetailTab, safeEvidenceSourceUrl, taskDetailTabs } from "../features/c/url-filters.ts";

let passed = 0;
function check(description, actual, expected) {
  assert.deepEqual(actual, expected, description);
  passed += 1;
}
const query = (value = "") => new URLSearchParams(value);
const records = [
  { id: "a", taskId: "task-1", source: "github", authorId: "member-1", criterionIds: ["ac-1", "ac-2"], status: "formal", title: "LOGIN API", description: "完整登录流程" },
  { id: "b", taskId: "task-1", source: "file", authorId: "member-2", criterionIds: ["ac-2"], status: "candidate", title: "登录测试", description: "待审核" },
  { id: "c", taskId: "task-2", source: "github", authorId: "member-1", criterionIds: ["ac-3"], status: "withdrawn", title: "LOGIN 历史", description: "旧版" },
  { id: "d", taskId: "task-1", source: "github", authorId: "member-1", criterionIds: ["ac-1"], status: "void", title: "无效记录", description: "不应混入正式证据" },
];
const before = JSON.stringify(records);
const labels = { task: (id) => ({ "task-1": "T-001 身份认证", "task-2": "T-002 历史归档" })[id] ?? "", author: (id) => ({ "member-1": "张同学", "member-2": "李同学" })[id] ?? "" };
const matches = (search) => filterEvidence(records, readEvidenceFilters(query(search)), labels).map((item) => item.id);

check("全部证据可读，包括撤回和作废历史", matches(""), ["a", "b", "c", "d"]);
check("六项组合按交集筛选，正式状态不混入撤回或作废", matches("task=task-1&source=github&author=member-1&criterion=ac-2&status=formal&q=login"), ["a"]);
check("标准支持一条证据关联多个标准", matches("criterion=ac-2"), ["a", "b"]);
check("任务与标准冲突时为空，不擅自清除条件", matches("task=task-2&criterion=ac-2"), []);
check("搜索任务编号", matches("q=T-001"), ["a", "b", "d"]);
check("搜索任务标题", matches("q=历史归档"), ["c"]);
check("搜索提交人", matches("q=李同学"), ["b"]);
check("搜索忽略大小写与外围空白", matches("q=%20login%20"), ["a", "c"]);
check("未知任务不回退为全部记录", matches("task=deleted-task"), []);
check("未知作者不泄漏全部记录", matches("author=deleted-member"), []);
check("明确选择作废状态可追溯历史", matches("status=void"), ["d"]);
check("筛选不修改源记录", JSON.stringify(records), before);
check("不支持的枚举值使用明确的默认值", readEvidenceFilters(query("source=script&status=approved")).source, "all");
check("未知状态回退全部状态", readEvidenceFilters(query("status=approved")).status, "all");

for (const tab of taskDetailTabs) check(`直链恢复 ${tab} 标签`, readTaskDetailTab(query(`tab=${tab}`)), tab);
check("未知任务标签恢复概览", readTaskDetailTab(query("tab=not-a-tab")), "overview");
check("空任务标签恢复概览", readTaskDetailTab(query()), "overview");
check("证据时间线直链", readEvidenceView(query("view=timeline")), "timeline");
check("未知证据视图恢复按任务", readEvidenceView(query("view=unknown")), "task");

const origin = "https://groupproof.test";
const original = `${origin}/projects/project-1/evidence?task=task-1&view=timeline&keep=yes#proof`;
const withAuthor = patchQueryHref(original, { author: "member-1", q: "API & 登录" });
const withStatus = patchQueryHref(`${origin}${withAuthor}`, { status: "formal" });
check("修改后保留页面与锚点", new URL(`${origin}${withStatus}`).hash, "#proof");
check("连续更新保留已选择作者", readEvidenceFilters(new URL(`${origin}${withStatus}`).searchParams).author, "member-1");
check("带特殊字符的搜索词准确恢复", readEvidenceFilters(new URL(`${origin}${withStatus}`).searchParams).q, "API & 登录");
check("保留不属于筛选器的参数", new URL(`${origin}${withStatus}`).searchParams.get("keep"), "yes");
check("历史条目重新读取恢复上一步状态", readEvidenceFilters(new URL(`${origin}${withAuthor}`).searchParams).status, "all");
const cleared = new URL(`${origin}${patchQueryHref(`${origin}${withStatus}`, { task: null, author: null, status: null, q: null })}`);
check("清除筛选保留展示视图与额外参数", cleared.search, "?view=timeline&keep=yes");
check("重复 query key 更新为一个值", patchQueryHref(`${origin}/tasks/t?tab=overview&tab=history`, { tab: "evidence" }), "/tasks/t?tab=evidence");

check("有效 HTTPS 来源可点击", safeEvidenceSourceUrl(" https://github.com/org/repo/pull/1 "), "https://github.com/org/repo/pull/1");
check("HTTP 来源保留兼容", safeEvidenceSourceUrl("http://example.test/proof"), "http://example.test/proof");
for (const value of [undefined, "", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///C:/private.txt", "//example.test/proof", "/api/private", "https://username:password@example.test/proof", "not a url"]) {
  check("非网页协议、相对地址、凭据与损坏来源不生成链接", safeEvidenceSourceUrl(value), null);
}

console.log(`C URL and evidence filters: ${passed} assertions passed.`);
