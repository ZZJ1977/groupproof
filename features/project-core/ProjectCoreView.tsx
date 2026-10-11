"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useProjectCore, projectPath } from "./core-model";
import { ProjectAccessDenied, ProjectPublicSummary } from "./ProjectPublicSummary";
import { getProjectSummary } from "@/lib/overview";
import { ProjectOverview, ProjectSetup } from "./ProjectOverviewSetup";
import { ProjectRequirements } from "./ProjectRequirementsPlanning";
import { ProjectPlanning } from "./ProjectPlanningView";
import { ProjectTasks, ProjectTaskDetail } from "./ProjectTasksViews";
import { ProjectTaskSubmit, ProjectEvidenceCheck, ProjectVerification } from "./ProjectTaskWorkflow";
import { ProjectMilestones, ProjectMilestoneDetail, ProjectEvidenceCenter } from "./ProjectMilestonesEvidence";
import s from "./project-core.module.css";

export type ProjectCoreScreen = 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

export default function ProjectCoreView({ screen, projectId, taskId, milestoneId }: { screen: number; projectId: string; taskId?: string; milestoneId?: string }) {
  const core = useProjectCore(projectId);
  if (!core) return <main className={s.page}><h1 className={s.title}>项目不存在</h1><p className={s.subtitle}>该项目可能已被移除，或当前数据中没有对应记录。</p><Link className={s.buttonSoft} href="/home"><ArrowLeft size={14} />返回首页</Link></main>;
  if (!core.canView) {
    if (core.canSummary) return <ProjectPublicSummary summary={getProjectSummary(core.data, core.data.currentUserId, core.project.id)} />;
    return <ProjectAccessDenied message="项目内容仅对成员及所属课程教学人员开放。" />;
  }

  const task = core.tasks.find((item) => item.id === taskId);
  const milestone = core.milestones.find((item) => item.id === milestoneId);

  switch (screen) {
    case 7: return <ProjectOverview core={core} />;
    case 8: return <ProjectSetup core={core} />;
    case 9: return <ProjectRequirements core={core} />;
    case 10: return <ProjectPlanning core={core} />;
    case 11: return <ProjectTasks core={core} view="tree" />;
    case 12: return <ProjectTasks core={core} view="board" />;
    case 13: return <ProjectTasks core={core} view="list" />;
    case 14: return task ? <ProjectTaskDetail core={core} task={task} /> : <MissingEntity href={`${projectPath(projectId)}/tasks?view=list`} />;
    case 15: return task ? <ProjectTaskSubmit core={core} task={task} /> : <MissingEntity href={`${projectPath(projectId)}/tasks?view=list`} />;
    case 16: return task ? <ProjectEvidenceCheck core={core} task={task} /> : <MissingEntity href={`${projectPath(projectId)}/tasks?view=list`} />;
    case 17: return task ? <ProjectVerification core={core} task={task} /> : <MissingEntity href={`${projectPath(projectId)}/tasks?view=list`} />;
    case 18: return <ProjectMilestones core={core} />;
    case 19: return milestone ? <ProjectMilestoneDetail core={core} milestone={milestone} /> : <MissingEntity href={`${projectPath(projectId)}/milestones`} />;
    case 20: return <ProjectEvidenceCenter core={core} />;
    default: return <MissingEntity href={projectPath(projectId)} />;
  }
}

function MissingEntity({ href }: { href: string }) {
  return <main className={s.page}><h1 className={s.title}>未找到对应记录</h1><p className={s.subtitle}>请返回列表重新选择。</p><Link className={s.buttonSoft} href={href}><ArrowLeft size={14} />返回列表</Link></main>;
}
