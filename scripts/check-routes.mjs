import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveRoute } from "../lib/routes.ts";

const plan = readFileSync(new URL("../FRONTEND_IMPLEMENTATION_PLAN.md", import.meta.url), "utf8");
const cases = [...plan.matchAll(/^\|\s*(\d{2})\s*\|[^|]*\|\s*`([^`]+)`\s*\|/gm)].map((match) => ({ screen: Number(match[1]), path: match[2] }));
assert.equal(cases.length, 56, "计划中应列出全部 56 个设计页");

for (const item of cases) {
  const url = new URL(item.path, "http://localhost:3000");
  const actual = resolveRoute(url.pathname, url.searchParams.get("view"));
  assert.equal(actual?.screen, item.screen, `${item.path} 映射到页面 ${actual?.screen ?? "无"}，预期 ${item.screen}`);
}

if (process.env.CHECK_HTTP === "1") {
  for (const item of cases) {
    const response = await fetch(`http://localhost:3000${item.path}`);
    assert.equal(response.status, 200, `${item.path} HTTP ${response.status}`);
  }
}

console.log(`已核对 ${cases.length} 个设计页与路由${process.env.CHECK_HTTP === "1" ? "，全部返回 HTTP 200" : ""}。`);
