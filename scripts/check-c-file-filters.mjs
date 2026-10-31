import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { fileFilterPatch, filterProjectFiles, queryProjectFiles, readFileFilters } from "../features/c/file-filters.ts";
import { patchQueryHref } from "../features/c/url-filters.ts";

let passed = 0;
function check(message, actual, expected) { assert.deepEqual(actual, expected, message); passed += 1; }
const filters = (search = "") => readFileFilters(new URLSearchParams(search));
const data = structuredClone(seedData);
const base = { projectId: "project-1", type: "PDF", source: "项目资料", uploaderId: "member-1", version: 1, status: "current", updatedAt: "2026-10-10", size: "1 KB" };
const records = Array.from({ length: 23 }, (_, i) => ({ ...base, id: `c5-${i + 1}`, name: `C5 文档 ${String(i + 1).padStart(2, "0")}.pdf` }));
records.push(
  { ...base, id: "image", name: "页面截图.png", type: "PNG" },
  { ...base, id: "export", name: "导出报告.pdf", source: "报告导出" },
  { ...base, id: "draft", name: "说明草稿.md", type: "MD", status: "draft", uploaderId: "member-2" },
  { ...base, id: "old", name: "C5 文档 01.pdf", status: "superseded", version: 0 },
);
data.files = [...records, { ...base, id: "foreign", name: "外组保密文件.xlsx", type: "XLSX", projectId: "project-3" }, { ...base, id: "course-only", projectId: undefined, courseId: "course-1", name: "课程原始文件.docx" }];
const query = (search, actor = "member-1") => queryProjectFiles(data, actor, "project-1", filters(search));
const ids = (search) => query(search).items.map((item) => item.id);
const before = JSON.stringify(data);

check("缺省URL参数", filters(), { category: "all", q: "", type: "all", sort: "recent", page: 1, pageSize: 10 });
check("类型归一化、组合参数保留", filters("category=documents&q=C5&type=pdf&sort=name&page=2&pageSize=20"), { category: "documents", q: "C5", type: "PDF", sort: "name", page: 2, pageSize: 20 });
check("未知类别排序回落", filters("category=invalid&sort=unknown").category + ":" + filters("category=invalid&sort=unknown").sort, "all:recent");
for (const value of ["", "0", "-1", "1.5", "1e2", "0x10", "NaN", "Infinity", "9007199254740993", "001", "2x"]) {
  check("非法页码安全回落", filters(`page=${value}`).page, 1);
}
for (const value of ["-1", "11", "100", "Infinity", "10.0"]) check("非法页大小回落10", filters(`pageSize=${value}`).pageSize, 10);
for (const value of [10, 20, 50]) check("受支持页大小", filters(`pageSize=${value}`).pageSize, value);
check("未知类型不放宽筛选", query("type=missing").total, 0);
check("默认只排除归档历史", query("").total, 26);
check("缺省仅10条", ids("").length, 10);
check("正式文档排除图片及草稿", query("category=documents").total, 24);
check("图片类别", ids("category=images"), ["image"]);
check("导出类别", ids("category=exports"), ["export"]);
check("归档旧版本可单独读取", ids("category=archived"), ["old"]);
check("草稿在全部资料可见", ids("q=草稿"), ["draft"]);
check("来源文本可搜索", ids("q=报告导出"), ["export"]);
check("上传人可搜索", ids(`q=${encodeURIComponent(seedData.users.find((user) => user.id === "member-2").name)}`), ["draft"]);
check("搜索忽略大小写和首尾空白", query("q=%20c5%20").total, 23);
check("类型与类别组合取交集", query("category=images&type=PDF").total, 0);
check("全部筛选与排序再分页", ids("category=documents&q=c5&type=PDF&sort=name&page=2"), records.slice(10, 20).map((item) => item.id));
check("最后一页剩余3条", ids("q=c5&sort=name&page=3"), ["c5-21", "c5-22", "c5-23"]);
check("越界页码夹取至最后页", [query("q=c5&page=999").page, query("q=c5&page=999").items.length], [3, 3]);
check("空集页码与导航稳定", [query("q=无结果&page=999").page, query("q=无结果").pageCount, query("q=无结果").items.length], [1, 1, 0]);
check("公开总览不泄露外组记录", query("").files.some((item) => item.id === "foreign"), false);
check("课程文件不自动混入项目副本", query("").files.some((item) => item.id === "course-only"), false);
for (const actor of ["member-1", "member-2", "teacher-1", "ta-1"]) check("本组及所属教学人员允许读取", query("", actor).total, 26);
for (const actor of ["member-5", "teacher-2", "admin-1", "missing"]) {
  assert.throws(() => query("", actor), (error) => error.code === "FORBIDDEN", `无项目内容权限：${actor}`); passed += 1;
}
const disabled = structuredClone(data); disabled.users.find((user) => user.id === "member-1").status = "disabled";
assert.throws(() => queryProjectFiles(disabled, "member-1", "project-1", filters()), (error) => error.code === "FORBIDDEN"); passed += 1;
assert.throws(() => queryProjectFiles(data, "member-1", "missing", filters()), (error) => error.code === "FORBIDDEN"); passed += 1;

const samples = [
  { ...base, id: "b", name: "same.pdf", updatedAt: "2026-10-10T08:00:00+08:00" },
  { ...base, id: "a", name: "same.pdf", updatedAt: "2026-10-10T00:00:00Z" },
  { ...base, id: "new", name: "new.pdf", updatedAt: "2026-10-10T01:00:00Z" },
  { ...base, id: "invalid", name: "invalid.pdf", updatedAt: "invalid" },
];
check("按真实时间排序且相同时ID稳定", filterProjectFiles(samples, filters(), () => "").map((item) => item.id), ["new", "a", "b", "invalid"]);
check("输入顺序改变不导致翻页重复", filterProjectFiles([...samples].reverse(), filters(), () => "").map((item) => item.id), ["new", "a", "b", "invalid"]);
check("MIME图片可归类", filterProjectFiles([{ ...base, id: "mime", name: "blob", type: "BIN", mimeType: "image/webp" }], filters("category=images"), () => "").length, 1);
check("不以格式子串误识别图片", filterProjectFiles([{ ...base, id: "txt", name: "text", type: "TEXTIMAGE" }], filters("category=images"), () => "").length, 0);

const href = "https://example.test/projects/project-1/files?category=documents&type=PDF&sort=name&page=3&origin=review#files";
for (const [key, value] of [["category", "images"], ["q", "图"], ["type", "PNG"], ["sort", "recent"], ["pageSize", "20"]]) {
  const updated = new URL(patchQueryHref(href, fileFilterPatch(key, value)), "https://example.test");
  check("改变任一筛选或页大小重置页", updated.searchParams.has("page"), false);
  check("筛选保留其他上下文和锚点", [updated.searchParams.get("origin"), updated.hash], ["review", "#files"]);
}
check("翻页保留已有筛选", patchQueryHref(href, fileFilterPatch("page", "2")), "/projects/project-1/files?category=documents&type=PDF&sort=name&page=2&origin=review#files");
check("回第一页清除默认页码", fileFilterPatch("page", "1"), { page: null });
check("默认类别清除参数", fileFilterPatch("category", "all"), { page: null, category: null });
check("空搜索清除参数", fileFilterPatch("q", ""), { page: null, q: null });
check("过滤排序分页不修改原始状态", JSON.stringify(data), before);
console.log(`C file filters: ${passed} assertions passed.`);
