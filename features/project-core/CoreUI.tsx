"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { statusLabel, taskCode, taskPath, taskTitle, type ProjectCore } from "./core-model";
import type { Task } from "@/types/domain";
import s from "./project-core.module.css";

export function Header({ eyebrow, title, subtitle, actions }: { eyebrow?: ReactNode; title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className={s.header}>
    <div>{eyebrow && <p className={s.eyebrow}>{eyebrow}</p>}<h1 className={s.title}>{title}</h1>{subtitle && <p className={s.subtitle}>{subtitle}</p>}</div>
    {actions && <div className={s.actions}>{actions}</div>}
  </header>;
}

export function Panel({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`${s.panel} ${className}`}>{title && <div className={s.panelHead}><h2 className={s.panelTitle}>{title}</h2>{action}</div>}<div className={s.panelBody}>{children}</div></section>;
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "blue" | "green" | "orange" | "red" }) {
  return <div className={s.stat}><div className={s.statLabel}>{label}</div><div className={`${s.statValue} ${tone ? s[tone] : ""}`}>{value}</div>{note && <div className={s.statNote}>{note}</div>}</div>;
}

export function Progress({ value }: { value: number }) {
  return <div className={s.progress} aria-label={`完成 ${Math.round(value)}%`}><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

export function Status({ value }: { value: string }) {
  const tone = ["completed", "verified", "formal", "passed", "frozen", "confirmed"].includes(value)
    ? s.badgeGreen
    : ["in_progress", "pending_verification", "implemented"].includes(value)
      ? s.badgeBlue
      : ["at_risk", "pending_submission", "pending_confirmation", "partially_passed", "uncertain"].includes(value)
        ? s.badgeOrange
        : ["failed", "withdrawn", "void"].includes(value)
          ? s.badgeRed
          : "";
  return <span className={`${s.badge} ${tone}`}>{statusLabel(value)}</span>;
}

export function Tabs({ items, value, onChange }: { items: { value: string; label: string }[]; value: string; onChange: (value: string) => void }) {
  return <div className={s.tabs} role="tablist">{items.map((item) => <button key={item.value} type="button" role="tab" aria-selected={item.value === value} className={`${s.tab} ${item.value === value ? s.tabActive : ""}`} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}

export function TaskLink({ core, task, withArrow = false }: { core: ProjectCore; task: Task; withArrow?: boolean }) {
  return <Link className={s.link} href={taskPath(core.project.id, task.id)}>{taskCode(task)} · {taskTitle(task)}{withArrow && <ArrowRight size={13} style={{ marginLeft: 5, verticalAlign: "middle" }} />}</Link>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className={s.empty}>{children}</div>; }
