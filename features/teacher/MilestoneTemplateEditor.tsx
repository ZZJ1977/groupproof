"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { input, label, secondary } from "@/features/b/ui";
import type { RuleMilestoneItem } from "@/lib/api/teacher-rules-client";
import { tr } from "@/lib/i18n/tr";

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
        <div>
          <h3 className="text-sm font-semibold text-slate-900">阶段里程碑模板</h3>
          <p className="text-xs text-slate-500">
            学生小组立项时将自动复制下方里程碑阶段；已立项项目保持创建时的原快照不受影响。
          </p>
        </div>
        {editable && items.length < 20 && (
          <button type="button" className={secondary} onClick={addItem}>
            <Plus size={14} />
            添加里程碑
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5 text-center text-xs text-slate-500">
          尚未配置默认里程碑模板；可点击「添加里程碑」预设检查点。
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-slate-200 bg-slate-50/50 p-3.5 space-y-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-600">
                  {tr("第 {0} 阶段", { 0: idx + 1 })}
                </span>
                {editable && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-white p-1 text-slate-500 hover:text-slate-900 disabled:opacity-40"
                      disabled={idx === 0}
                      onClick={() => move(idx, -1)}
                      aria-label="上移阶段"
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-white p-1 text-slate-500 hover:text-slate-900 disabled:opacity-40"
                      disabled={idx === items.length - 1}
                      onClick={() => move(idx, 1)}
                      aria-label="下移阶段"
                    >
                      <ArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-white p-1 text-red-500 hover:bg-red-50"
                      onClick={() => removeAt(idx)}
                      aria-label="删除里程碑"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div>
                  <label className={label}>阶段名称</label>
                  <input
                    className={input}
                    disabled={!editable}
                    value={item.title}
                    onChange={(e) => updateAt(idx, { title: e.target.value })}
                    placeholder="例如：需求评审"
                  />
                </div>
                <div>
                  <label className={label}>建议截止时间（选填）</label>
                  <input
                    type="datetime-local"
                    className={input}
                    disabled={!editable}
                    value={toDateTimeLocalValue(item.deadline)}
                    onChange={(e) =>
                      updateAt(idx, {
                        deadline: e.target.value ? new Date(e.target.value).toISOString() : null,
                      })
                    }
                  />
                </div>
                <div>
                  <label className={label}>参考权重 %（选填）</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className={input}
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
              <div>
                <label className={label}>交付要求说明（选填）</label>
                <input
                  className={input}
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
