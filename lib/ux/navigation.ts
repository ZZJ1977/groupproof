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
    { label: "项目总览", href: base, iconKey: "folder" },
    { label: "项目初始化", href: `${base}/setup`, iconKey: "fileClock" },
    { label: "需求基线", href: `${base}/requirements`, iconKey: "fileText" },
    { label: "任务规划", href: `${base}/planning`, iconKey: "clipboardList" },
    { label: "任务", href: `${base}/tasks?view=tree`, iconKey: "listTree" },
    { label: "里程碑", href: `${base}/milestones`, iconKey: "fileCheck" },
    { label: "证据中心", href: `${base}/evidence`, iconKey: "shieldCheck" },
    { label: "GitHub", href: `${base}/github`, iconKey: "gitBranch" },
    { label: "协作记录", href: `${base}/collaboration`, iconKey: "messageSquare" },
    { label: "文件资料", href: `${base}/files`, iconKey: "folder" },
    { label: "讨论区", href: `${base}/discussions`, iconKey: "messageSquare" },
    { label: "贡献", href: `${base}/contribution`, iconKey: "users" },
    { label: "报告", href: `${base}/reports`, iconKey: "fileText" },
    { label: "项目设置", href: `${base}/settings`, iconKey: "settings" },
  ];
}

export function teacherNavItems(courseId: string): { label: string; href: string; iconKey: string }[] {
  const base = `/teacher/courses/${courseId}`;
  return [
    { label: "课程总览", href: base, iconKey: "home" },
    { label: "小组", href: `${base}/groups`, iconKey: "users" },
    { label: "待处理", href: `${base}/actions`, iconKey: "checkSquare" },
    { label: "报告", href: `${base}/reports`, iconKey: "fileText" },
    { label: "课程设置", href: `${base}/settings`, iconKey: "settings" },
  ];
}

/** 任务三视图兼容链接：页面内切换使用，旧 URL（?view=tree/board/list）保持有效 */
export const taskViewLinks = (projectId: string) => ({
  tree: `/projects/${projectId}/tasks?view=tree`,
  board: `/projects/${projectId}/tasks?view=board`,
  list: `/projects/${projectId}/tasks?view=list`,
});
