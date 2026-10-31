"use client";

import Link from "next/link";
import { ArrowLeft, Info, ShieldCheck } from "lucide-react";
import { statusLabel } from "./core-model";
import { Header, Panel, Progress, Stat, Status } from "./CoreUI";
import type { ProjectSummary } from "@/types/domain";
import s from "./project-core.module.css";

/**
 * 课程内可见项目的公开总览（阶段 01）。
 * 仅展示 ProjectSummary DTO 字段：id / name / description / progress / lifecycle。
 * 需求、任务、资料、证据和成员确认信息不在公开范围内。
 */
export function ProjectPublicSummary({ summary }: { summary: ProjectSummary }) {
  return <div className={s.page}>
    <Header
      eyebrow={summary.name}
      title="项目公开总览"
      subtitle="课程内可见项目仅向同课程其他小组公开基本信息。"
      actions={<Link className={s.buttonSoft} href="/home"><ArrowLeft size={14} />返回首页</Link>}
    />
    <div className={s.notice}><Info size={16} />你不是该项目成员或所属教学人员，仅可查看公开总览。任务、资料、证据与成员确认记录不对外开放。</div>
    <div className={s.stats}>
      <Stat label="总进度" value={`${summary.progress}%`} note={<Progress value={summary.progress} />} tone="blue" />
      <Stat label="生命周期" value={<Status value={summary.lifecycle} />} note={statusLabel(summary.lifecycle)} />
      <Stat label="项目编号" value={summary.id} note="公开标识，可用于引用该课程项目" />
      <Stat label="可见范围" value="课程内可见" note="仅公开总览字段" tone="green" />
    </div>
    <Panel title="项目简介">
      <p className={s.small}>{summary.description || "暂无项目简介。"}</p>
    </Panel>
    <div className={`${s.notice} ${s.noticeWarn}`}><ShieldCheck size={16} />如需查看项目业务内容，请联系该项目组长或所属课程教师。</div>
  </div>;
}

export function ProjectAccessDenied({ message, backHref = "/home" }: { message: string; backHref?: string }) {
  return <div className={s.page}>
    <Header title="无权查看此项目" subtitle={message} actions={<Link className={s.buttonSoft} href={backHref}><ArrowLeft size={14} />返回</Link>} />
    <div className={`${s.notice} ${s.noticeWarn}`}><Info size={16} />项目内容仅对成员及所属课程教学人员开放。同课程其他小组只能查看课程内可见项目的公开总览。</div>
  </div>;
}
