"use client";

import { useWorkspace } from "@/lib/workspace";
import type {
  AcceptanceCriterion,
  Evidence,
  FunctionalModule,
  Milestone,
  Project,
  Requirement,
  Task,
  User,
  Verification,
} from "@/types/domain";

type Workspace = ReturnType<typeof useWorkspace>;

export interface ProjectCore {
  data: Workspace["data"];
  role: Workspace["role"];
  update: Workspace["update"];
  add: Workspace["add"];
  remove: Workspace["remove"];
  project: Project;
  tasks: Task[];
  requirements: Requirement[];
  modules: FunctionalModule[];
  criteria: AcceptanceCriterion[];
  evidence: Evidence[];
  verifications: Verification[];
  milestones: Milestone[];
  currentUser: User | undefined;
  canView: boolean;
  canEdit: boolean;
}

export function useProjectCore(projectId: string): ProjectCore | null {
  const workspace = useWorkspace();
  const { data } = workspace;
  const project = data.projects.find((item) => item.id === projectId);
  if (!project) return null;

  const tasks = data.tasks.filter((item) => item.projectId === projectId);
  const isMember = project.memberIds.includes(data.currentUserId);
  const isCourseTeacher = (workspace.role === "teacher" || workspace.role === "ta") && data.courses.some((course) => course.id === project.courseId && course.teacherId === data.currentUserId);
  return {
    data,
    role: workspace.role,
    update: workspace.update,
    add: workspace.add,
    remove: workspace.remove,
    project,
    tasks,
    requirements: data.requirements.filter((item) => item.projectId === projectId),
    modules: data.modules.filter((item) => item.projectId === projectId),
    criteria: data.criteria.filter((item) => tasks.some((task) => task.id === item.taskId)),
    evidence: data.evidence.filter((item) => item.projectId === projectId),
    verifications: data.verifications.filter((item) => item.projectId === projectId),
    milestones: data.milestones.filter((item) => item.projectId === projectId),
    currentUser: data.users.find((item) => item.id === data.currentUserId),
    canView: isMember || isCourseTeacher,
    canEdit: isMember && (workspace.role === "student" || workspace.role === "leader") && project.lifecycle === "active",
  };
}

export const projectPath = (projectId: string) => `/projects/${projectId}`;
export const taskPath = (projectId: string, taskId: string) => `${projectPath(projectId)}/tasks/${taskId}`;

export const taskStatuses = [
  { value: "not_started", label: "待开始" },
  { value: "in_progress", label: "进行中" },
  { value: "pending_submission", label: "待提交" },
  { value: "pending_verification", label: "待验证" },
  { value: "completed", label: "已完成" },
] as const;

export const statusLabel = (status: string) => {
  const labels: Record<string, string> = {
    not_started: "待开始",
    in_progress: "进行中",
    pending_submission: "待提交",
    pending_verification: "待验证",
    completed: "已完成",
    draft: "草稿",
    confirmed: "已确认",
    implemented: "已实现",
    verified: "已验证",
    frozen: "已冻结",
    pending_confirmation: "待确认",
    active: "进行中",
    at_risk: "有风险",
    formal: "正式证据",
    candidate: "候选证据",
    withdrawn: "已撤回",
    void: "已作废",
    passed: "通过",
    partially_passed: "部分通过",
    failed: "未通过",
    uncertain: "待人工复核",
  };
  return labels[status] ?? status;
};

export const priorityLabel = (priority: string) => ({ high: "高", medium: "中", low: "低" })[priority] ?? priority;
export const sourceLabel = (source: string) => ({ github: "GitHub", file: "文件", screenshot: "截图", feishu: "飞书", discussion: "讨论", manual: "手动记录" })[source] ?? source;
export const personName = (core: ProjectCore, id: string) => core.data.users.find((user) => user.id === id)?.name ?? "未分配";
export const taskCode = (task: Task) => task.title.match(/^T-\d+(?:\.\d+)?/)?.[0] ?? `T-${(task.id.match(/\d+$/)?.[0] ?? "1").padStart(2, "0")}`;
export const taskTitle = (task: Task) => task.title.replace(/^T-\d+(?:\.\d+)?\s*/, "");
export const requirementCode = (requirement: Requirement) => `R-${(requirement.id.match(/\d+$/)?.[0] ?? "1").padStart(2, "0")}`;
export const milestoneCode = (milestone: Milestone) => `M${milestone.id.match(/\d+$/)?.[0] ?? "1"}`;
export const displayDate = (value: string) => value ? new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—";
export const makeId = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;

export function latestVerification(core: ProjectCore, taskId: string) {
  return core.verifications
    .filter((item) => item.taskId === taskId && item.status === "current")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function recordTaskProgress(core: ProjectCore, task: Task, value: number) {
  const next = new Map<string, number>([[task.id, value]]);
  core.update("tasks", task.id, { progress: value, updatedAt: new Date().toISOString() });

  let parentId = task.parentTaskId;
  while (parentId) {
    const parent = core.tasks.find((item) => item.id === parentId);
    if (!parent) break;
    const children = core.tasks.filter((item) => item.parentTaskId === parentId);
    const totalWeight = children.reduce((sum, item) => sum + item.weight, 0);
    const progress = totalWeight ? Math.round(children.reduce((sum, item) => sum + item.weight * (next.get(item.id) ?? item.progress), 0) / totalWeight) : parent.progress;
    next.set(parent.id, progress);
    core.update("tasks", parent.id, { progress, updatedAt: new Date().toISOString() });
    parentId = parent.parentTaskId;
  }

  const roots = core.tasks.filter((item) => !item.parentTaskId);
  const totalWeight = roots.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight) {
    const progress = Math.round(roots.reduce((sum, item) => sum + item.weight * (next.get(item.id) ?? item.progress), 0) / totalWeight);
    core.update("projects", core.project.id, { progress });
  }
  const functionalModule = core.modules.find((item) => item.id === task.moduleId);
  if (functionalModule) {
    const moduleTasks = roots.filter((item) => item.moduleId === functionalModule.id);
    const moduleWeight = moduleTasks.reduce((sum, item) => sum + item.weight, 0);
    if (moduleWeight) core.update("modules", functionalModule.id, { progress: Math.round(moduleTasks.reduce((sum, item) => sum + item.weight * (next.get(item.id) ?? item.progress), 0) / moduleWeight) });
  }
  for (const milestone of core.milestones.filter((item) => item.taskIds.some((id) => next.has(id)))) {
    const relatedTasks = core.tasks.filter((item) => milestone.taskIds.includes(item.id));
    if (relatedTasks.length) core.update("milestones", milestone.id, { progress: Math.round(relatedTasks.reduce((sum, item) => sum + (next.get(item.id) ?? item.progress), 0) / relatedTasks.length) });
  }
}
