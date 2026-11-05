import assert from "node:assert/strict";
import { clearUrlFilters, patchUrlFilters, readUrlFilters } from "../lib/url-filters.ts";

let passed = 0;
function check(description, actual, expected) {
  assert.deepEqual(actual, expected, description);
  passed += 1;
}
const q = (value = "") => new URLSearchParams(value);
const schema = {
  tab: { kind: "enum", values: ["all", "active", "ended"], default: "all" },
  q: { kind: "string" },
  status: { kind: "list" },
  sort: { kind: "enum", values: ["updated", "name"], default: "updated" },
  page: { kind: "int", default: 1, min: 1 },
};

check("空查询使用默认值", readUrlFilters(schema, q()), { tab: "all", q: "", status: [], sort: "updated", page: 1 });
check("读取全部字段", readUrlFilters(schema, q("tab=ended&q=%E8%BD%AF%E4%BB%B6&status=a,b&sort=name&page=3")), { tab: "ended", q: "软件", status: ["a", "b"], sort: "name", page: 3 });
check("未知枚举回退默认", readUrlFilters(schema, q("tab=deleted")).tab, "all");
check("非法页码回退默认", readUrlFilters(schema, q("page=0")).page, 1);
check("非数字页码回退默认", readUrlFilters(schema, q("page=2x")).page, 1);
check("多值重复参数合并去重", readUrlFilters(schema, q("status=a&status=b,a&status=")).status, ["a", "b"]);
check("写入非默认值", patchUrlFilters(schema, "/courses?x=1", { tab: "active" }), "/courses?x=1&tab=active");
check("默认值从 URL 移除", patchUrlFilters(schema, "/courses?tab=active", { tab: "all" }), "/courses");
check("null 移除字段", patchUrlFilters(schema, "/courses?q=abc", { q: null }), "/courses");
check("改筛选时页码回到第一页", patchUrlFilters(schema, "/courses?page=4&tab=active", { tab: "ended" }), "/courses?tab=ended");
check("单独翻页保留其他筛选", patchUrlFilters(schema, "/courses?tab=active", { page: 2 }), "/courses?tab=active&page=2");
check("多值写成逗号分隔", decodeURIComponent(patchUrlFilters(schema, "/r", { status: ["draft", "frozen"] })), "/r?status=draft,frozen");
check("空数组移除多值字段", patchUrlFilters(schema, "/r?status=a", { status: [] }), "/r");
check("模式外字段不受影响", patchUrlFilters(schema, "/r?view=board&tab=active", { tab: "ended" }), "/r?view=board&tab=ended");
check("清除只去掉模式字段", clearUrlFilters(schema, "/r?view=board&tab=active&q=x&page=2#top"), "/r?view=board#top");
const href = patchUrlFilters(schema, "/courses", { tab: "ended", q: "数据库", sort: "name" });
check("写出再读回一致（复制链接到新标签页）", readUrlFilters(schema, new URL(href, "http://x").searchParams), { tab: "ended", q: "数据库", status: [], sort: "name", page: 1 });

console.log(`check-b-url-filters: ${passed} checks passed`);
