import assert from "node:assert/strict";
import { buildSetupCards, projectNavGroups } from "../student/ux/student-workspace.ts";

const projectId = "00000000-0000-0000-0000-000000000123";
const base = `/projects/${projectId}`;
const groups = projectNavGroups(projectId);

assert.deepEqual(
  groups.map((group) => group.id),
  ["overview", "plan", "collaborate", "review"],
  "project navigation follows the student task model",
);

const hrefs = groups.flatMap((group) => group.items.map((item) => item.href));
for (const href of [
  base,
  `${base}/requirements`,
  `${base}/tasks?view=tree`,
  `${base}/milestones`,
  `${base}/github`,
  `${base}/collaboration`,
  `${base}/files`,
  `${base}/discussions`,
  `${base}/evidence`,
  `${base}/contribution`,
]) assert.ok(hrefs.includes(href), `keeps existing destination ${href}`);
assert.ok(!hrefs.includes(`${base}/setup`), "setup is reached from overview rather than a flat primary nav item");
assert.ok(!hrefs.includes(`${base}/planning`), "planning is unified inside tasks workspace rather than a duplicate nav item");

const independent = buildSetupCards({
  projectId,
  kind: "independent",
  detailsComplete: true,
  memberCount: 1,
  githubBindings: 0,
  feishuBindings: 0,
  materialCount: 0,
  requirementCount: 0,
  moduleCount: 0,
  unresolvedConflictCount: 0,
  baselineStarted: false,
  baselineFrozen: false,
  hasPlan: false,
});
assert.equal(independent.find((card) => card.id === "baseline")?.required, false, "personal project baseline is optional");
assert.equal(independent.some((card) => card.id === "conflicts"), false, "zero conflicts do not create an empty workflow");

const course = buildSetupCards({
  projectId,
  kind: "course",
  detailsComplete: false,
  memberCount: 3,
  githubBindings: 0,
  feishuBindings: 1,
  materialCount: 2,
  requirementCount: 3,
  moduleCount: 1,
  unresolvedConflictCount: 2,
  baselineStarted: true,
  baselineFrozen: false,
  hasPlan: false,
  githubRequired: true,
});
assert.equal(course.find((card) => card.id === "github")?.required, true, "course GitHub policy is reflected in setup");
assert.equal(course.find((card) => card.id === "baseline")?.required, true, "course baseline remains required");
assert.equal(course.find((card) => card.id === "conflicts")?.status, "attention", "real conflicts surface as attention work");
assert.equal(course.find((card) => card.id === "feishu")?.status, "complete", "connected integrations are complete");

console.log("student workspace policy: ok");
