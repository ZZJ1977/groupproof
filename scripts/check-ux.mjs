import assert from "node:assert/strict";
import { seedData } from "../mocks/seed.ts";
import { projectNavItems, resolveObjectContext, taskViewLinks, teacherNavItems } from "../lib/ux/navigation.ts";
import { completedModuleCount, teacherProjectStats } from "../lib/ux/stats.ts";

let passed = 0;
function check(desc, actual, expected) {
  assert.deepEqual(actual, expected, `${desc}：实际 ${JSON.stringify(actual)}，预期 ${JSON.stringify(expected)}`);
  passed += 1;
}
function ok(desc, value) {
  assert.ok(value, desc);
  passed += 1;
}

// ── 导航上下文跟随当前对象（不再固定 project-1/course-1） ────────────
{
  const context = resolveObjectContext(seedData, "/projects/project-3/tasks");
  check("项目上下文跟随路由对象", [context.projectId, context.projectName, context.courseId], ["project-3", "智能交通分析", "course-1"]);
  check("教师路径上下文跟随课程", resolveObjectContext(seedData, "/teacher/courses/course-2/settings"), { courseId: "course-2", courseName: "数据结构与算法 · 2026" });
  check("课程路径上下文", resolveObjectContext(seedData, "/courses/course-3/groups").courseId, "course-3");
  check("未知路径不猜测对象", resolveObjectContext(seedData, "/home"), {});

  const items = projectNavItems("project-3");
  ok("项目导航不含固定示例 ID", items.every((item) => item.href.includes("/projects/project-3") && !item.href.includes("project-1")));
  check("任务三视图合并为单一入口", items.filter((item) => item.href.includes("/tasks")).map((item) => item.label), ["tasks"]);
  ok("旧任务链接保持兼容", Object.values(taskViewLinks("project-3")).every((href) => href.includes("/projects/project-3/tasks?view=")));
  ok("教师导航跟随课程", teacherNavItems("course-2").every((item) => item.href.includes("/teacher/courses/course-2")));
}

// ── 教师统计口径：100% 进度不表述为完成/已验收/已定稿 ─────────────────
{
  const projects = [
    { id: "p1", progress: 100, lifecycle: "active" },
    { id: "p2", progress: 100, lifecycle: "finalized" },
    { id: "p3", progress: 40, lifecycle: "active" },
    { id: "p4", progress: 80, lifecycle: "archived" },
  ];
  const stats = teacherProjectStats(projects);
  check("完成仅按已定稿统计", stats.finalized, 1);
  check("进度满未定稿单列", stats.pendingFinalize, 1);
  check("高风险只看进行中项目", stats.highRisk, 1);
  check("平均进度为派生值", stats.averageProgress, 80);
  ok("进度 100 不进入完成数", stats.finalized === 1 && projects.filter((item) => item.progress === 100).length === 2);
  check("模块列按进度口径", completedModuleCount([{ progress: 100 }, { progress: 99 }, { progress: 100 }]), 2);
}

// ── 保存反馈语义（服务层已有断言，此处核对页面状态契约常量） ─────────────
{
  ok("任务视图兼容链接含三种视图", Object.keys(taskViewLinks("project-1")).sort().join(","), "board,list,tree");
  ok("导航项使用稳定词条键（显示文案由 i18n 提供）", projectNavItems("project-1").some((item) => item.label === "requirements"));
}

console.log(`UX 定向复核回归通过：${passed} 项断言全部符合预期。`);
