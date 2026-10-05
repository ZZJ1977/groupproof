import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, eyebrow, actions, icon: Icon }: { title: string; description?: string; eyebrow?: string; actions?: ReactNode; icon?: LucideIcon }) {
  return <div className="gp-page-header flex flex-wrap items-start justify-between gap-3"><div>{eyebrow && <div className="gp-breadcrumb">{eyebrow}</div>}<div className="flex items-center gap-3">{Icon && <span className="flex h-10 w-10 items-center justify-center rounded-[7px] bg-[#eaf2ff] text-[#246bfa]"><Icon size={21} /></span>}<div><h1 className="gp-page-title">{title}</h1>{description && <p className="gp-page-description">{description}</p>}</div></div></div>{actions && <div className="flex items-center gap-2">{actions}</div>}</div>;
}

export function Panel({ title, action, children, className, bodyClassName, noPadding = false }: { title?: string; action?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; noPadding?: boolean }) {
  return <section className={cn("gp-panel", className)}>{(title || action) && <div className="gp-panel-header"><h2 className="gp-panel-title">{title}</h2>{action}</div>}<div className={cn(noPadding ? "" : "gp-panel-body", bodyClassName)}>{children}</div></section>;
}

const toneByStatus: Record<string, "blue" | "green" | "amber" | "red" | "gray"> = {
  completed: "green", passed: "green", formal: "green", active: "green", approved: "green", verified: "green", confirmed: "green", generated: "green", current: "green",
  in_progress: "blue", pending_verification: "blue", draft: "blue", candidate: "blue", pending_confirmation: "amber", pending_submission: "amber", pending: "amber", partially_passed: "amber", at_risk: "amber", uncertain: "amber",
  failed: "red", rejected: "red", disputed: "red", high: "red", disabled: "red", void: "red", withdrawn: "gray", not_started: "gray", archived: "gray", expired: "gray",
};
const labelByStatus: Record<string, string> = { completed: "已完成", passed: "通过", formal: "正式", active: "进行中", approved: "已通过", verified: "已验证", confirmed: "已确认", generated: "已生成", current: "当前", in_progress: "进行中", pending_verification: "待验证", draft: "草稿", candidate: "候选", pending_confirmation: "待确认", pending_submission: "待提交", pending: "待处理", partially_passed: "部分通过", at_risk: "有风险", uncertain: "不确定", failed: "未通过", rejected: "已拒绝", disputed: "申诉中", high: "高", disabled: "已停用", void: "已作废", withdrawn: "已撤回", not_started: "待开始", archived: "已归档", expired: "已过期" };

export function StatusBadge({ status, label, tone, className }: { status?: string; label?: string; tone?: "blue" | "green" | "amber" | "red" | "gray"; className?: string }) {
  const resolved = status ?? "gray";
  return <span className={cn("gp-badge", tone ?? toneByStatus[resolved] ?? "gray", className)}><span className="h-[6px] w-[6px] rounded-full bg-current" />{label ?? labelByStatus[resolved] ?? resolved}</span>;
}

export function ProgressBar({ value, className, color }: { value: number; className?: string; color?: string }) {
  return <div className={cn("gp-progress", className)} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }} /></div>;
}

export function Stat({ label, value, sub, icon: Icon, className, accent }: { label: string; value: string | number; sub?: string; icon?: LucideIcon; className?: string; accent?: string }) {
  return <div className={cn("gp-stat", className)}><div className="flex items-center justify-between gap-3"><div className="gp-stat-label">{label}</div>{Icon && <Icon size={17} style={{ color: accent ?? "#246bfa" }} />}</div><div className="gp-stat-value" style={accent ? { color: accent } : undefined}>{value}</div>{sub && <div className="gp-stat-sub">{sub}</div>}</div>;
}

export function Avatar({ name, color, size = 28 }: { name: string; color?: string; size?: number }) {
  return <span className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-[#385273]" style={{ width: size, height: size, background: color ?? "#e5edf9", fontSize: Math.max(10, size * .36) }}>{name.slice(0, 1)}</span>;
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="gp-empty"><div className="font-semibold text-[#52647f]">{title}</div>{description && <p className="mt-1 text-[12px]">{description}</p>}{action && <div className="mt-4">{action}</div>}</div>;
}
