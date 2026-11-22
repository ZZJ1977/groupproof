#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = {
  shell: readFileSync(resolve(root, "components/workspace-shell.tsx"), "utf8"),
  primitives: readFileSync(resolve(root, "features/governance/primitives.tsx"), "utf8"),
  globals: readFileSync(resolve(root, "app/globals.css"), "utf8"),
  governance: readFileSync(resolve(root, "features/governance/governance.module.css"), "utf8"),
  hans: readFileSync(resolve(root, "messages/zh-Hans.json"), "utf8"),
  hant: readFileSync(resolve(root, "messages/zh-Hant.json"), "utf8"),
  en: readFileSync(resolve(root, "messages/en.json"), "utf8"),
};

const checks = [
  ["admin navigation is grouped", /adminNavGroups/.test(files.shell)],
  ["admin shell has an isolated style scope", /gp-shell-admin/.test(files.shell) && /\.gp-shell-admin/.test(files.globals)],
  ["admin navigation has platform and analysis labels", [files.hans, files.hant, files.en].every((text) => /adminGroups/.test(text))],
  ["admin environment switch remains in the shell", /AdminEnvironmentSwitcher/.test(files.shell)],
  ["Header accepts eyebrow and actions aliases", /eyebrow\?/.test(files.primitives) && /actions\?/.test(files.primitives)],
  ["Metric exposes a trend affordance", /trend\?/.test(files.primitives) && /metricTrend/.test(files.primitives)],
  ["governance styles include an admin detail panel", /adminDetailPanel/.test(files.governance)],
  ["governance styles include an admin table container", /adminTableWrap/.test(files.governance)],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  for (const [label] of failed) console.error(`FAIL: ${label}`);
  process.exit(1);
}

for (const [label] of checks) console.log(`PASS: ${label}`);
