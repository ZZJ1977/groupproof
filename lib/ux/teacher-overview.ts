import type { MockData, Project } from "@/types/domain";
import { currentTasks, deriveProgress, weightedProgress } from "@/lib/overview";

export interface TeacherOverviewRisk {
  level: "none" | "low" | "medium" | "high";
  label: string;
  tone: "gray" | "green" | "amber" | "red";
}

export interface TeacherOverviewActivity {
  id: string;
  title: string;
  at: string;
}

/** 总览进度统一使用当前正式计划中的根任务加权结果。 */
export function teacherOverviewProgress(data: MockData, project?: Project): number | null {
  return project ? deriveProgress(data, project.id).overall : null;
}

export function teacherOverviewModuleProgress(data: MockData, projectId: string, moduleId: string): number | null {
  return weightedProgress(currentTasks(data, projectId).filter((task) => task.moduleId === moduleId && !task.parentTaskId));
}

/** 仅统计已完成任务或当前验收已通过且有人确认的任务。 */
export function teacherOverviewAcceptance(data: MockData, project?: Project) {
  if (!project) return { passed: 0, total: 0 };
  const tasks = currentTasks(data, project.id);
  const passedTaskIds = new Set(
    data.verifications
      .filter((item) => item.projectId === project.id && item.status === "current" && item.result === "passed" && item.humanConfirmedBy.length > 0)
      .map((item) => item.taskId),
  );
  return {
    passed: tasks.filter((task) => task.status === "completed" || passedTaskIds.has(task.id)).length,
    total: tasks.length,
  };
}

/** 风险只取真实里程碑、任务和当前验收状态，不再由进度百分比猜测。 */
export function teacherOverviewRisk(data: MockData, project?: Project, now = new Date()): TeacherOverviewRisk {
  if (!project) return { level: "none", label: "未开始", tone: "gray" };
  const tasks = currentTasks(data, project.id);
  const milestones = data.milestones.filter((item) => item.projectId === project.id);
  const verifications = data.verifications.filter((item) => item.projectId === project.id && item.status === "current");
  const overdue = milestones.some((item) => item.status !== "completed" && new Date(item.deadline).getTime() < now.getTime());
  if (overdue || milestones.some((item) => item.status === "at_risk") || verifications.some((item) => item.result === "failed")) {
    return { level: "high", label: "高风险", tone: "red" };
  }
  if (verifications.some((item) => item.result === "partially_passed" || item.result === "uncertain") || tasks.some((item) => item.status === "pending_verification")) {
    return { level: "medium", label: "中风险", tone: "amber" };
  }
  if (!tasks.length && !milestones.length && !verifications.length) {
    return { level: "none", label: "暂无数据", tone: "gray" };
  }
  return { level: "low", label: "低风险", tone: "green" };
}

/** 汇总项目相关任务、证据、验收和协作活动，并按真实时间倒序。 */
export function teacherOverviewActivities(data: MockData, project?: Project): TeacherOverviewActivity[] {
  if (!project) return [];
  const targetIds = new Set<string>([
    project.id,
    ...(project.groupId ? [project.groupId] : []),
    ...data.tasks.filter((item) => item.projectId === project.id).map((item) => item.id),
    ...data.modules.filter((item) => item.projectId === project.id).map((item) => item.id),
    ...data.milestones.filter((item) => item.projectId === project.id).map((item) => item.id),
    ...data.evidence.filter((item) => item.projectId === project.id).map((item) => item.id),
  ]);
  return [
    ...data.github.filter((item) => item.projectId === project.id).map((item) => ({ id: `github-${item.id}`, title: item.title, at: item.timestamp })),
    ...data.evidence.filter((item) => item.projectId === project.id).map((item) => ({ id: `evidence-${item.id}`, title: `提交证据：${item.title}`, at: item.createdAt })),
    ...data.verifications.filter((item) => item.projectId === project.id).map((item) => ({ id: `verification-${item.id}`, title: `验收结果：${item.result}`, at: item.createdAt })),
    ...data.feishu.filter((item) => item.projectId === project.id).map((item) => ({ id: `feishu-${item.id}`, title: item.summary, at: item.timestamp })),
    ...data.discussions.filter((item) => item.projectId === project.id).map((item) => ({ id: `discussion-${item.id}`, title: item.title, at: item.updatedAt })),
    ...data.logs.filter((item) => targetIds.has(item.target)).map((item) => ({ id: `log-${item.id}`, title: item.action, at: item.createdAt })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}
