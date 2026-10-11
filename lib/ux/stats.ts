import type { Project } from "@/types/domain";

/**
 * 教师统计口径（UX 改版定向复核）。
 * 100% 进度不等于完成/已验收/已定稿：完成仅按 lifecycle=finalized 表述；
 * 进度满但未定稿的项目单列为“待定稿”。
 */

export interface TeacherProjectStats {
  total: number;
  finalized: number;
  pendingFinalize: number;
  highRisk: number;
  averageProgress: number;
}

export function teacherProjectStats(projects: Project[]): TeacherProjectStats {
  const total = projects.length;
  const finalized = projects.filter((item) => item.lifecycle === "finalized").length;
  const pendingFinalize = projects.filter((item) => item.lifecycle === "active" && item.progress >= 100).length;
  const highRisk = projects.filter((item) => item.lifecycle === "active" && item.progress < 55).length;
  const averageProgress = total ? Math.round(projects.reduce((sum, item) => sum + item.progress, 0) / total) : 0;
  return { total, finalized, pendingFinalize, highRisk, averageProgress };
}

/** 模块列按进度口径表述为“进度满模块”，不称为已验证/已验收 */
export function completedModuleCount(modules: { progress: number }[]): number {
  return modules.filter((item) => item.progress >= 100).length;
}
