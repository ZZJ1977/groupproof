import assert from "node:assert/strict";
import { can, isCourseStaff, projectSummary } from "../lib/access/policy.ts";
import { seedData } from "../mocks/seed.ts";

const base = structuredClone(seedData);
let passed = 0;
function check(desc, actual, expected) {
  assert.equal(actual, expected, `${desc}：实际 ${actual}，预期 ${expected}`);
  passed += 1;
}

const project = (id) => ({ kind: "project", id });
const course = (id) => ({ kind: "course", id });
const group = (id) => ({ kind: "group", id });

// 1. 组长资格按目标资源关系判断，不看全局角色标签
check("member-5（全局 student）可发布 group-2/project-3", can(base, "member-5", "project.publish", project("project-3")), true);
check("member-1（全局 leader）不能发布 project-3", can(base, "member-1", "project.publish", project("project-3")), false);
check("member-5 是 project-3 成员，可编辑草稿", can(base, "member-5", "project.draft.edit", project("project-3")), true);

// 2. 无小组项目按 ownerId 判断；不确定负责人时不按成员数组首项赋权
check("无小组项目 ownerId=member-1 可发布 project-2", can(base, "member-1", "project.publish", project("project-2")), true);
check("project-2 成员 member-5 不是负责人，不能发布", can(base, "member-5", "project.publish", project("project-2")), false);
const noOwner = structuredClone(base);
noOwner.projects = noOwner.projects.map((item) => item.id === "project-2" ? { ...item, ownerId: undefined } : item);
check("未确定负责人时 member-1 也不能发布", can(noOwner, "member-1", "project.publish", project("project-2")), false);

// 3. 所属教学人员可读项目内容，跨课程教师不可读
check("course-1 教师可读 project-1 内容", can(base, "teacher-1", "project.content.read", project("project-1")), true);
check("course-3 教师不能读 project-1 内容", can(base, "teacher-2", "project.content.read", project("project-1")), false);
check("course-3 教师不能读 project-1 公开总览", can(base, "teacher-2", "project.summary.read", project("project-1")), false);
check("教师不能编辑项目草稿", can(base, "teacher-1", "project.draft.edit", project("project-1")), false);

// 4. 同课程其他小组仅在 visibility=course 时读公开总览，且不含业务内容
check("member-21 可读课程公开项目 project-1 总览", can(base, "member-21", "project.summary.read", project("project-1")), true);
check("member-21 不能读 project-1 任务与资料", can(base, "member-21", "project.content.read", project("project-1")), false);
check("member-21 不能上传 project-1 资料", can(base, "member-21", "project.files.write", project("project-1")), false);
check("member-8 不能读 visibility=members 的 project-3 总览", can(base, "member-8", "project.summary.read", project("project-3")), false);
check("course-1 同组外成员 member-2 不能读 visibility=members 的 project-3 总览", can(base, "member-2", "project.summary.read", project("project-3")), false);
check("project-3 成员 member-6 可读自己的总览", can(base, "member-6", "project.summary.read", project("project-3")), true);

// 5. 助教按课程授权：默认只读，授权后按操作粒度生效，撤销后立即拒绝
check("ta-1 归属 course-1，可读课程", can(base, "ta-1", "course.read", course("course-1")), true);
check("ta-1 默认只读，不能改课程设置", can(base, "ta-1", "course.settings.update", course("course-1")), false);
check("ta-1 默认只读，不能编辑课程规则", can(base, "ta-1", "course.rules.edit", course("course-1")), false);
check("ta-1 可读所属课程项目内容", can(base, "ta-1", "project.content.read", project("project-1")), true);
check("ta-1 不能编辑项目草稿", can(base, "ta-1", "project.draft.edit", project("project-1")), false);
const granted = structuredClone(base);
granted.courses = granted.courses.map((item) => item.id === "course-1" ? { ...item, assistantGrants: [{ userId: "ta-1", permissions: ["course.rules.edit"] }] } : item);
check("ta-1 获得规则编辑授权后可编辑规则", can(granted, "ta-1", "course.rules.edit", course("course-1")), true);
check("ta-1 未获发布授权，不能发布规则", can(granted, "ta-1", "course.rules.publish", course("course-1")), false);
check("ta-1 未获设置授权，不能改课程设置", can(granted, "ta-1", "course.settings.update", course("course-1")), false);
check("ta-1 不能管理助教授权", can(granted, "ta-1", "course.staff.manage", course("course-1")), false);
const revoked = structuredClone(granted);
revoked.courses = revoked.courses.map((item) => item.id === "course-1" ? { ...item, assistantGrants: [{ userId: "ta-1", permissions: [] }] } : item);
check("撤销授权后立即拒绝编辑", can(revoked, "ta-1", "course.rules.edit", course("course-1")), false);
check("撤销授权后助教归属仍保留（只读）", can(revoked, "ta-1", "course.read", course("course-1")), true);

// 6. 课程教师的操作资格
check("course-1 教师可管理助教授权", can(base, "teacher-1", "course.staff.manage", course("course-1")), true);
check("course-3 教师不能管理 course-1 助教授权", can(base, "teacher-2", "course.staff.manage", course("course-1")), false);
check("course-1 教师可发布课程规则", can(base, "teacher-1", "course.rules.publish", course("course-1")), true);

// 7. 账号状态、未知操作、无效目标与跨课程引用默认拒绝
check("pending 教师无任何资格", can(base, "teacher-3", "course.read", course("course-1")), false);
const disabled = structuredClone(base);
disabled.users = disabled.users.map((item) => item.id === "member-1" ? { ...item, status: "disabled" } : item);
check("disabled 账号无任何资格", can(disabled, "member-1", "project.content.read", project("project-1")), false);
check("未知操作默认拒绝", can(base, "member-1", "project.explode", project("project-1")), false);
check("未知课程操作默认拒绝", can(base, "teacher-1", "course.delete", course("course-1")), false);
check("不存在的项目拒绝", can(base, "member-1", "project.content.read", project("project-999")), false);
check("不存在的课程拒绝", can(base, "teacher-1", "course.read", course("course-999")), false);
check("不存在的小组拒绝", can(base, "member-5", "project.create", group("group-999")), false);
check("不存在的账号拒绝", can(base, "ghost-1", "project.content.read", project("project-1")), false);
const crossCourse = structuredClone(base);
crossCourse.projects = crossCourse.projects.map((item) => item.id === "project-3" ? { ...item, courseId: "course-3" } : item);
check("跨课程引用（小组与课程不匹配）拒绝", can(crossCourse, "member-5", "project.content.read", project("project-3")), false);
const brokenCourse = structuredClone(base);
brokenCourse.projects = brokenCourse.projects.map((item) => item.id === "project-2" ? { ...item, courseId: "course-999" } : item);
check("项目引用不存在课程时拒绝", can(brokenCourse, "member-1", "project.content.read", project("project-2")), false);

// 8. 归档项目保留历史阅读资格；写条件由命令层拒绝
check("归档项目 project-4 历史仍可读", can(base, "member-22", "project.content.read", project("project-4")), true);
check("归档项目非成员不能读", can(base, "member-21", "project.content.read", project("project-4")), false);

// 9. 创建小组项目：仅目标小组组长
check("group-2 组长 member-5 可创建小组项目", can(base, "member-5", "project.create", group("group-2")), true);
check("member-1 不是 group-2 组长，不能创建", can(base, "member-1", "project.create", group("group-2")), false);
check("group-1 组长 member-1 可创建小组项目", can(base, "member-1", "project.create", group("group-1")), true);
check("教师不能创建小组项目", can(base, "teacher-1", "project.create", group("group-1")), false);

// 10. 管理员不默认获得本范围的项目/课程内容权限
check("管理员不能读项目内容", can(base, "admin-1", "project.content.read", project("project-1")), false);
check("管理员不能读课程", can(base, "admin-1", "course.read", course("course-1")), false);

// 11. 教学归属判断（教学工作区页面入口）
check("course-1 教师属于教学团队", isCourseStaff(base, "teacher-1", "course-1"), true);
check("ta-1 归属 course-1 教学团队", isCourseStaff(base, "ta-1", "course-1"), true);
check("ta-1 不在 course-2 教学团队", isCourseStaff(base, "ta-1", "course-2"), false);
check("teacher-2 不在 course-1 教学团队", isCourseStaff(base, "teacher-2", "course-1"), false);

// 12. 公开总览 DTO 只包含约定字段
const summary = projectSummary(base.projects.find((item) => item.id === "project-1"));
check("公开 DTO 字段仅 id/name/description/progress/lifecycle", Object.keys(summary).sort().join(","), "description,id,lifecycle,name,progress");

console.log(`权限矩阵检查通过：${passed} 项断言全部符合预期。`);
