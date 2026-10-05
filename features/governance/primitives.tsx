"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Info, Search } from "lucide-react";
import { PageHeader, Panel, ProgressBar } from "@/components/common";
import type { MockData, Role, SystemLog } from "@/types/domain";
import styles from "./governance.module.css";

export function Header({
  title,
  description,
  breadcrumb,
  action,
}: {
  title: string;
  description: string;
  breadcrumb?: string;
  action?: ReactNode;
}) {
  return <PageHeader title={title} description={description} eyebrow={breadcrumb} actions={action} />;
}

export function Box({ children, title, action, className = "" }: {
  children: ReactNode;
  title?: string;
  action?: ReactNode;
  className?: string;
}) {
  return <Panel title={title} action={action} className={`${styles.panel} ${className}`} noPadding>{children}</Panel>;
}

export function Metric({ label, value, hint, icon: Icon, tone = "blue" }: {
  label: string;
  value: string | number;
  hint?: string;
  icon: LucideIcon;
  tone?: "blue" | "green" | "amber" | "red";
}) {
  const colors = { blue: "#1767e7", green: "#0d9a62", amber: "#b77a02", red: "#d43b38" };
  return (
    <div className={styles.metric}>
      <div className={styles.metricIcon} style={{ color: colors[tone] }}><Icon size={18} /></div>
      <div>
        <div className={styles.metricLabel}>{label}</div>
        <div className={styles.metricValue} style={{ color: tone === "blue" ? undefined : colors[tone] }}>{value}</div>
        {hint ? <div className={styles.metricHint}>{hint}</div> : null}
      </div>
    </div>
  );
}

export function Badge({ children, tone = "gray" }: {
  children: ReactNode;
  tone?: "blue" | "green" | "amber" | "red" | "gray" | "purple";
}) {
  const classes = { blue: styles.badgeBlue, green: styles.badgeGreen, amber: styles.badgeAmber, red: styles.badgeRed, gray: styles.badgeGray, purple: styles.badgePurple };
  return <span className={`${styles.badge} ${classes[tone]}`}>{children}</span>;
}

export function Progress({ value, label = true }: { value: number; label?: boolean }) {
  const safe = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={styles.progressCell} aria-label={`进度 ${safe}%`}>
      {label ? <strong>{safe}%</strong> : null}
      <ProgressBar value={safe} className={styles.progressTrack} />
    </div>
  );
}

export function SearchField({ value, onChange, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return <label className={styles.search}><Search size={16} aria-hidden="true" /><input className={styles.input} type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} /></label>;
}

export function Notice({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return <div className={`${styles.notice} ${danger ? styles.warning : ""}`}><Info size={17} aria-hidden="true" /><div>{children}</div></div>;
}

export function Empty({ children = "暂无符合条件的记录" }: { children?: ReactNode }) {
  return <div className={styles.empty}>{children}</div>;
}

export function Table({ children }: { children: ReactNode }) {
  return <div className={styles.tableWrap}><table className={styles.table}>{children}</table></div>;
}

export function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function formatDateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function auditRecord(data: MockData, action: string, target: string, detail: string, result: SystemLog["result"] = "success"): SystemLog {
  return {
    id: newId("log"),
    actorId: data.currentUserId,
    action,
    target,
    result,
    ip: "127.0.0.1",
    createdAt: new Date().toISOString(),
    detail,
  };
}

export function roleLabel(role: Role) {
  return { student: "学生", leader: "组长", teacher: "教师", ta: "助教", admin: "管理员" }[role];
}

export function statusTone(status: string): "blue" | "green" | "amber" | "red" | "gray" | "purple" {
  if (["active", "approved", "completed", "formal", "finalized", "success", "current", "verified"].includes(status)) return "green";
  if (["pending", "draft", "in_progress", "provisional"].includes(status)) return "amber";
  if (["rejected", "disabled", "failed", "failure", "high", "outdated"].includes(status)) return "red";
  if (["teacher", "ta"].includes(status)) return "purple";
  if (["student", "leader"].includes(status)) return "blue";
  return "gray";
}
