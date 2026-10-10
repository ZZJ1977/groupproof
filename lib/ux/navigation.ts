import type { MockData } from "@/types/domain";

/**
 * 工作区导航上下文（UX 改版定向复核）。
 * 导航链接与横幅名称跟随当前项目/课程对象，不再使用固定示例 ID；
 * 纯函数便于回归验证；缺对象时回退安全入口。
 */

export interface ObjectContext {
  projectId?: string;
  courseId?: string;
  projectName?: string;
  courseName?: string;
}

export function resolveObjectContext(data: MockData, pathname: string): ObjectContext {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) {
    const project = data.projects.find((item) => item.id === parts[1]);
    const course = project?.courseId ? data.courses.find((item) => item.id === project.courseId) : undefined;
    return {
      projectId: project?.id,
      courseId: course?.id,
      projectName: project?.name,
      courseName: course?.name,
    };
  }
  if ((parts[0] === "courses" || (parts[0] === "teacher" && parts[1] === "courses")) && parts.length >= 2) {
    const courseId = parts[0] === "teacher" ? parts[2] : parts[1];
    const course = data.courses.find((item) => item.id === courseId);
    return { courseId: course?.id, courseName: course?.name };
  }
  return {};
}

export interface NavItemLite {
  label: string;
  href: string;
  icon?: unknown;
}

/** 项目导航跟随目标项目；任务树/看板/列表合并为单一“任务”入口（旧链接保留兼容） */
export function projectNavItems(projectId: string): { label: string; href: string; iconKey: string }[] {
  const base = `/projects/${projectId}`;
  return [
    { label: "overview", href: base, iconKey: "folder" },
    { label: "setup", href: `${base}/setup`, iconKey: "fileClock" },
    { label: "requirements", href: `${base}/requirements`, iconKey: "fileText" },
    { label: "planning", href: `${base}/planning`, iconKey: "clipboardList" },
    { label: "tasks", href: `${base}/tasks?view=tree`, iconKey: "listTree" },
    { label: "milestones", href: `${base}/milestones`, iconKey: "fileCheck" },
    { label: "evidence", href: `${base}/evidence`, iconKey: "shieldCheck" },
    { label: "GitHub", href: `${base}/github`, iconKey: "gitBranch" },
    { label: "collaboration", href: `${base}/collaboration`, iconKey: "messageSquare" },
    { label: "files", href: `${base}/files`, iconKey: "folder" },
    { label: "discussions", href: `${base}/discussions`, iconKey: "messageSquare" },
    { label: "contribution", href: `${base}/contribution`, iconKey: "users" },
    { label: "reports", href: `${base}/reports`, iconKey: "fileText" },
    { label: "settings", href: `${base}/settings`, iconKey: "settings" },
  ];
}

export function teacherNavItems(courseId: string): { label: string; href: string; iconKey: string }[] {
  const base = `/teacher/courses/${courseId}`;
  return [
    { label: "overview", href: base, iconKey: "home" },
    { label: "groups", href: `${base}/groups`, iconKey: "users" },
    { label: "actions", href: `${base}/actions`, iconKey: "checkSquare" },
    { label: "reports", href: `${base}/reports`, iconKey: "fileText" },
    { label: "settings", href: `${base}/settings`, iconKey: "settings" },
  ];
}

/** 任务三视图兼容链接：页面内切换使用，旧 URL（?view=tree/board/list）保持有效 */
export const taskViewLinks = (projectId: string) => ({
  tree: `/projects/${projectId}/tasks?view=tree`,
  board: `/projects/${projectId}/tasks?view=board`,
  list: `/projects/${projectId}/tasks?view=list`,
});
