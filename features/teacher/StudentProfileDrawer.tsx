"use client";

import { useState } from "react";
import Link from "next/link";
import { UserMinus, X } from "lucide-react";
import { button, dateOnly, input, label, secondary } from "@/features/b/ui";
import type { RosterStudent } from "@/lib/api/teacher-client";
import { tr } from "@/lib/i18n/tr";

export function StudentProfileDrawer({
  courseId,
  student,
  canManage,
  removing,
  errorMessage,
  onClose,
  onRemove,
}: {
  courseId: string;
  student: RosterStudent;
  canManage: boolean;
  removing: boolean;
  errorMessage?: string;
  onClose: () => void;
  onRemove: (reason: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const isGrouped = student.status === "grouped";

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/30"
      role="dialog"
      aria-modal="true"
      aria-label="学生资料详情"
    >
      <div className="flex h-full w-full max-w-md flex-col justify-between bg-white p-6 shadow-xl">
        <div>
          <div className="flex items-center justify-between border-b border-slate-200 pb-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-sm font-bold text-blue-700">
                {student.initial}
              </span>
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  {student.name || "未命名学生"}
                </h2>
                <p className="text-xs text-slate-500">{student.student_number || "无学号"}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              aria-label="关闭资料抽屉"
            >
              <X size={18} />
            </button>
          </div>

          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex justify-between border-b border-slate-100 pb-2.5">
              <dt className="text-slate-500">邮箱</dt>
              <dd className="font-medium text-slate-800">{student.email || "未公开"}</dd>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-2.5">
              <dt className="text-slate-500">入班时间</dt>
              <dd className="font-medium text-slate-800">{dateOnly(student.joined_at)}</dd>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-2.5">
              <dt className="text-slate-500">组队状态</dt>
              <dd className="font-medium text-slate-800">
                {isGrouped ? "已组队" : "未组队"}
                {student.is_leader ? "（队长）" : ""}
              </dd>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-2.5">
              <dt className="text-slate-500">所在队伍</dt>
              <dd className="font-medium text-slate-800">
                {student.group ? (
                  <Link
                    href={`/teacher/courses/${courseId}/groups/${student.group.id}`}
                    className="gp-link"
                    onClick={onClose}
                  >
                    {student.group.name}
                  </Link>
                ) : (
                  "暂未加入队伍"
                )}
              </dd>
            </div>
          </dl>

          {errorMessage && (
            <div role="alert" className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              {errorMessage}
            </div>
          )}

          {canManage && (
            <div className="mt-6 border-t border-slate-200 pt-5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                班级成员管理
              </h3>
              {isGrouped ? (
                <div className="mt-2">
                  <button type="button" className={secondary} disabled>
                    <UserMinus size={14} />
                    移出班级
                  </button>
                  <p className="mt-1.5 text-xs text-slate-500">
                    该学生当前在队伍中，请先在组队广场将其移出队伍后再移出班级。
                  </p>
                </div>
              ) : !confirming ? (
                <button
                  type="button"
                  className={`${secondary} mt-2 text-red-600 hover:bg-red-50`}
                  onClick={() => setConfirming(true)}
                >
                  <UserMinus size={14} />
                  移出班级
                </button>
              ) : (
                <div className="mt-3 rounded border border-red-200 bg-red-50/60 p-3.5">
                  <label className={label} htmlFor="remove-student-reason">
                    {tr("移出 {0} 的原因", { 0: student.name || "该学生" })}
                  </label>
                  <textarea
                    id="remove-student-reason"
                    className={input}
                    rows={3}
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="请填写移出班级原因"
                  />
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className={button}
                      disabled={removing || !reason.trim()}
                      onClick={() => onRemove(reason.trim())}
                    >
                      {removing ? "正在移出…" : "确认移出"}
                    </button>
                    <button
                      type="button"
                      className={secondary}
                      disabled={removing}
                      onClick={() => setConfirming(false)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-slate-200 pt-4 text-right">
          <button type="button" className={secondary} onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
