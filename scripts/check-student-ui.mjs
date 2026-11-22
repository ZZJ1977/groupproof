import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync("app/globals.css", "utf8");
const common = fs.readFileSync("components/common.tsx", "utf8");
const shell = fs.readFileSync("components/workspace-shell.tsx", "utf8");

const checks = [
  ["语义分隔色令牌", css.includes("--gp-border-subtle")],
  ["学生工作区标记", shell.includes("gp-student-workspace")],
  ["Section 组件", common.includes("export function Section")],
  ["ListRow 组件", common.includes("export function ListRow")],
  ["DetailDrawer 组件", common.includes("export function DetailDrawer")],
  ["StateBlock 组件", common.includes("export function StateBlock")],
];

for (const [label, value] of checks) assert.ok(value, `${label}尚未实现`);
console.log(`学生端 UI 基础契约通过：${checks.length} 项`);
