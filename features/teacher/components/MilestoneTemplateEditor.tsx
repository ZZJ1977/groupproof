"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RuleMilestoneItem } from "@/features/teacher/api/teacher-rules-client";
import { tr } from "@/lib/i18n/tr";

const inputClass =
  "w-full rounded-[8px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface,#ffffff)] px-3 py-2 text-sm text-[var(--gp-ink,#1f2329)] outline-none transition-colors focus:border-[var(--gp-action,#3370ff)] focus:ring-2 focus:ring-[var(--gp-action-soft,#e8f0fe)] disabled:cursor-not-allowed disabled:bg-[var(--gp-surface-subtle,#f8f9fa)] disabled:text-[var(--gp-muted,#646a73)]";
const labelClass = "mb-1.5 block text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]";

function toDateTimeLocalValue(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MilestoneTemplateEditor({
  items,
  editable,
  onChange,
}: {
  items: RuleMilestoneItem[];
  editable: boolean;
  onChange: (next: RuleMilestoneItem[]) => void;
}) {
  const addItem = () => {
    onChange([
      ...items,
      {
        title: tr("阶段里程碑 {0}", { 0: items.length + 1 }),
        description: "",
        deadline: null,
        weight: null,
      },
    ]);
  };

  const updateAt = (idx: number, patch: Partial<RuleMilestoneItem>) => {
    onChange(items.map((item, i) => (i === idx ? { ...item, ...patch } : item)));
  };

  const move = (idx: number, delta: -1 | 1) => {
    const target = idx + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [picked] = next.splice(idx, 1);
    next.splice(target, 0, picked);
    onChange(next);
  };

  const removeAt = (idx: number) => {
    onChange(items.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--gp-ink,#1f2329)]">阶段里程碑模板</h3>
          <p className="text-xs text-[var(--gp-muted,#646a73)]">
            学生小组立项时将自动复制下方里程碑阶段；已立项项目保持创建时的原快照不受影响。
          </p>
        </div>
        {editable && items.length < 20 && (
          <Button type="button" variant="tonal" size="sm" pill onClick={addItem}>
            <Plus size={14} aria-hidden="true" />
            {tr("添加里程碑")}
          </Button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] px-4 py-5 text-center text-xs text-[var(--gp-muted,#646a73)]">
          尚未配置默认里程碑模板；可点击「添加里程碑」预设检查点。
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div
              key={idx}
              className="space-y-2.5 rounded-[10px] border border-[var(--gp-border,#dee0e3)] bg-[var(--gp-surface-subtle,#f8f9fa)] p-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="gp-tabular text-xs font-semibold text-[var(--gp-ink-soft,#4e5969)]">
                  {tr("第 {0} 阶段", { 0: idx + 1 })}
                </span>
                {editable && (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={idx === 0}
                      onClick={() => move(idx, -1)}
                      aria-label={tr("上移阶段")}
                      title={tr("上移阶段")}
                    >
                      <ArrowUp size={13} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={idx === items.length - 1}
                      onClick={() => move(idx, 1)}
                      aria-label={tr("下移阶段")}
                      title={tr("下移阶段")}
                    >
                      <ArrowDown size={13} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-[var(--gp-danger,#d93025)] hover:bg-red-50 hover:text-[var(--gp-danger,#d93025)]"
                      onClick={() => removeAt(idx)}
                      aria-label={tr("删除里程碑")}
                      title={tr("删除里程碑")}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="min-w-0">
                  <label className={labelClass} htmlFor={`ms-${idx}-title`}>
                    阶段名称
                  </label>
                  <input
                    id={`ms-${idx}-title`}
                    className={inputClass}
                    disabled={!editable}
                    value={item.title}
                    onChange={(e) => updateAt(idx, { title: e.target.value })}
                    placeholder="例如：需求评审"
                  />
                </div>
                <div className="min-w-0">
                  <label className={labelClass} htmlFor={`ms-${idx}-deadline`}>
                    建议截止时间（选填）
                  </label>
                  <input
                    id={`ms-${idx}-deadline`}
                    type="datetime-local"
                    className={inputClass}
                    disabled={!editable}
                    value={toDateTimeLocalValue(item.deadline)}
                    onChange={(e) =>
                      updateAt(idx, {
                        deadline: e.target.value ? new Date(e.target.value).toISOString() : null,
                      })
                    }
                  />
                </div>
                <div className="min-w-0">
                  <label className={labelClass} htmlFor={`ms-${idx}-weight`}>
                    参考权重 %（选填）
                  </label>
                  <input
                    id={`ms-${idx}-weight`}
                    type="number"
                    min={0}
                    max={100}
                    className={`${inputClass} gp-tabular`}
                    disabled={!editable}
                    value={item.weight ?? ""}
                    onChange={(e) =>
                      updateAt(idx, {
                        weight: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    placeholder="例如：25"
                  />
                </div>
              </div>
              <div className="min-w-0">
                <label className={labelClass} htmlFor={`ms-${idx}-desc`}>
                  交付要求说明（选填）
                </label>
                <input
                  id={`ms-${idx}-desc`}
                  className={inputClass}
                  disabled={!editable}
                  value={item.description}
                  onChange={(e) => updateAt(idx, { description: e.target.value })}
                  placeholder="简要说明本阶段需要完成的成果或检查标准"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
