import type {
  AssistantGrant,
  Course,
  DelegatedPermission,
  MockData,
  Project,
  ProjectSummary,
  User,
} from "@/types/domain";

/**
 * 统一权限资格判断（阶段 01）。
 *
 * - can() 是只读纯函数：只判断“账号角色 + 资源关系 + 操作”的资格；
 *   项目状态、确认完整性、版本冲突等执行条件由业务命令另行校验（阶段 03 起）。
 * - 不存在的资源、不匹配的账号、未知操作、跨课程引用一律拒绝。
 * - 平台管理员不在本范围内获得项目/课程内容权限，治理接口另有专用规则。
 */

export type Action = DelegatedPermission
  | "project.summary.read" | "project.content.read"
  | "project.create" | "project.draft.edit"
  | "project.confirm.self" | "project.publish"
  | "project.publish.override" | "project.plan.unlock"
  | "project.files.write" | "project.settings.update"
  | "project.archive" | "project.reopen" | "project.rules.apply"
  | "course.read" | "course.staff.manage";

export type Target = {
  kind: "project" | "course" | "group";
  id: string;
};

export function projectSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    progress: project.progress,
    lifecycle: project.lifecycle,
  };
}

export function assistantGrantOf(data: MockData, actorId: string, course?: Course): AssistantGrant | undefined {
  return course?.assistantGrants?.find((item) => item.userId === actorId);
}

/** 教学人员（所属教师或课程内有助教归属）——教学工作区页面入口判断 */
export function isCourseStaff(data: MockData, actorId: string, courseId: string): boolean {
  const course = data.courses.find((item) => item.id === courseId);
  if (!course) return false;
  return teacherOf(data, actorId, course) || !!assistantGrantOf(data, actorId, course);
}

function userOf(data: MockData, actorId: string): User | undefined {
  return data.users.find((item) => item.id === actorId);
}

function isStudent(user: User): boolean {
  return user.role === "student" || user.role === "leader";
}

function teacherOf(data: MockData, actorId: string, course?: Course): boolean {
  const user = userOf(data, actorId);
  return !!user && user.role === "teacher" && user.teacherStatus === "approved" && course?.teacherId === user.id;
}

export function can(
  data: MockData,
  actorId: string,
  action: Action,
  target: Target,
): boolean {
  const user = data.users.find((item) => item.id === actorId);
  if (!user || user.status !== "active") return false;
  const student = isStudent(user);
  const teacher = (course: Course | undefined) => teacherOf(data, actorId, course);
  const assistantOf = (course: Course | undefined) =>
    user.role === "ta" ? assistantGrantOf(data, actorId, course) : undefined;

  if (target.kind === "course") {
    const course = data.courses.find((item) => item.id === target.id);
    if (!course) return false;
    const teacherHere = teacher(course);
    const assistant = assistantOf(course);
    switch (action) {
      case "course.read":
        return teacherHere || !!assistant ||
          (student && course.memberIds.includes(user.id));
      case "course.staff.manage":
        return teacherHere;
      case "course.settings.update":
      case "course.rules.edit":
      case "course.rules.publish":
        return teacherHere || !!assistant?.permissions.includes(action);
      default:
        return false;
    }
  }

  if (target.kind === "group") {
    const group = data.groups.find((item) => item.id === target.id);
    const course = data.courses.find((item) => item.id === group?.courseId);
    return !!group && !!course && action === "project.create" &&
      student && group.memberIds.includes(user.id) &&
      course.memberIds.includes(user.id) && group.leaderId === user.id;
  }

  if (target.kind !== "project") return false;
  const project = data.projects.find((item) => item.id === target.id);
  if (!project) return false;
  const course = data.courses.find((item) => item.id === project.courseId);
  const group = data.groups.find((item) => item.id === project.groupId);
  if (project.courseId && !course) return false;
  if (project.groupId && (!group || group.courseId !== project.courseId))
    return false;

  const member = student && project.memberIds.includes(user.id);
  const leaderId = project.groupId ? group?.leaderId : project.ownerId;
  const leader = member && leaderId === user.id;
  const staff = teacher(course) || !!assistantOf(course);
  const coursePeer = student && !!course?.memberIds.includes(user.id);

  switch (action) {
    case "project.summary.read":
      return member || staff ||
        (project.visibility === "course" && coursePeer);
    case "project.content.read":
      return member || staff;
    case "project.draft.edit":
    case "project.confirm.self":
    case "project.files.write":
      return member;
    case "project.publish":
    case "project.publish.override":
    case "project.plan.unlock":
    case "project.settings.update":
    case "project.archive":
    case "project.reopen":
    case "project.rules.apply":
      return leader;
    default:
      return false;
  }
}
