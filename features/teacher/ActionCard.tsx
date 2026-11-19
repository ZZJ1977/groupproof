"use client";

import Link from "next/link";
import { button, dateTime, secondary } from "@/features/b/ui";
import type { ActionDef, TeacherActionItem } from "@/lib/api/teacher-actions-client";
import { tr } from "@/lib/i18n/tr";

const dangerBtn =
  "inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50";

export function ActionCard({
  item,
  selected,
  busy,
  onToggleSelect,
  onTriggerAction,
}: {
  item: TeacherActionItem;
  selected: boolean;
  busy: boolean;
  onToggleSelect: (id: string) => void;
  onTriggerAction: (item: TeacherActionItem, action: ActionDef) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2.5">
          {item.status === "pending" && (
            <input
              type="checkbox"
              aria-label={tr("选择 {0}", { 0: item.title })}
              className="mt-1"
              checked={selected}
              onChange={() => onToggleSelect(item.id)}
            />
          )}
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  item.status !== "pending"
                    ? "bg-slate-300"
                    : item.priority === "urgent"
                      ? "bg-red-500"
                      : "bg-amber-400"
                }`}
              />
              <span className="text-sm font-semibold text-slate-900">{item.title}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  item.status === "pending"
                    ? "bg-amber-50 text-amber-800"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {item.status === "pending" ? "待处理" : "已处理"}
              </span>
            </div>
            <p className="text-xs text-slate-600">{item.description}</p>
            <p className="text-[11px] text-slate-400">
              {dateTime(item.created_at)}
              {item.handled_by ? tr(" · 处理人：{0}", { 0: item.handled_by }) : ""}
              {item.decision_reason ? tr(" · 说明：{0}", { 0: item.decision_reason }) : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={item.href} className={secondary}>
            查看详情
          </Link>
          {item.available_actions.map((act) => (
            <button
              key={act.key}
              type="button"
              disabled={busy}
              className={
                act.style === "primary" ? button : act.style === "danger" ? dangerBtn : secondary
              }
              onClick={() => onTriggerAction(item, act)}
            >
              {tr(act.label)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
