#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = (file) => readFileSync(resolve(root, file), "utf8");
const pages = {
  dashboard: source("features/c/AdminDashboardPage.tsx"),
  identity: source("features/c/IdentityAdminApiPages.tsx"),
  usage: source("features/c/GovernanceApiPages.tsx"),
};
const governanceStyles = source("features/governance/governance.module.css");

const checks = [
  ["dashboard keeps real KPI queries", /admin-dashboard-users/.test(pages.dashboard) && /admin-dashboard-courses/.test(pages.dashboard)],
  ["dashboard has a visual workbench wrapper", /styles\.page/.test(pages.dashboard) && /styles\.metrics/.test(pages.dashboard)],
  ["identity page uses the shared visual scope", /styles\.identityPage/.test(pages.identity) && /styles\.identityTablePanel/.test(pages.identity)],
  ["identity keeps critical admin actions", ["新增账号", "刷新列表", "查看", "处理原因", "取消"].every((label) => pages.identity.includes(label))],
  ["identity directory has real result summaries", ["结果总数", "当前页可用", "当前页已停用", "当前页待验证"].every((label) => pages.identity.includes(label))],
  ["identity directory has resettable filters and table", /重置筛选/.test(pages.identity) && /identityTable/.test(pages.identity) && /identityFilterChip/.test(pages.identity)],
  ["identity drawer has responsive and focus-safe styling", /identityDrawerFooter/.test(pages.identity) && /identityDrawerFooter/.test(governanceStyles) && /max-width: 768px/.test(governanceStyles) && /:focus/.test(governanceStyles)],
  ["usage page keeps scenario breakdown", /usageScenarioDefinitions/.test(pages.usage) && /业务场景分布/.test(pages.usage)],
  ["usage page keeps data-quality caveats", /unpriced_requests/.test(pages.usage) && /incomplete_token_records/.test(pages.usage)],
  ["usage page does not turn unknown cost into zero", /function metricCost[\s\S]*未计价/.test(pages.usage) && !/metricCost[\s\S]*\|\|\s*["']0["']/.test(pages.usage)],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  for (const [label] of failed) console.error(`FAIL: ${label}`);
  process.exit(1);
}
for (const [label] of checks) console.log(`PASS: ${label}`);
