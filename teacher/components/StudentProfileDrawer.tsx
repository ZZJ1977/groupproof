"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UserMinus } from "lucide-react";
import { Button } from "@/shared/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import { dateOnly, input, label } from "@/shared/lib/b-ui";
import type { RosterStudent } from "@/teacher/api/teacher-client";
import { TeacherFeedbackPill } from "@/teacher/components/TeacherFeedbackPill";
import { tr } from "@/shared/i18n/tr";

export function StudentProfileDrawer({
  courseId,
  student,
  open,
  canManage,
  removing,
  errorMessage,
  onClose,
  onRemove,
}: {
  courseId: string;
  student: RosterStudent | null;
  open?: boolean;
  canManage: boolean;
  removing: boolean;
  errorMessage?: string;
  onClose: () => void;
  onRemove: (reason: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const isOpen = open ?? Boolean(student);

  useEffect(() => {
    setConfirming(false);
    setReason("");
  }, [student?.id, isOpen]);

  const isGrouped = student?.status === "grouped";

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(next) => {
        if (!next && !removing) onClose();
      }}
    >
      <SheetContent
        aria-label={tr("学生资料详情")}
        className="flex h-full w-full max-w-md flex-col justify-between p-6"
        onEscapeKeyDown={(event) => {
          if (removing) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (removing) event.preventDefault();
        }}
      >
        {student ? (
          <>
            <div>
              <SheetHeader className="border-b border-[var(--gp-border-subtle,#ebedf0)] pb-4 pr-8">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--gp-action-soft,#e8f0fe)] text-sm font-bold text-[var(--gp-action-on-soft,#1d4ed8)]">
                    {student.initial}
                  </span>
                  <div className="min-w-0">
                    <SheetTitle className="truncate text-base font-semibold text-[var(--gp-ink,#1f2329)]">
                      {student.name || "未命名学生"}
                    </SheetTitle>
                    <SheetDescription className="gp-tabular truncate text-xs text-[var(--gp-muted,#646a73)]">
                      {student.student_number || "无学号"}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>

              <dl className="mt-5 space-y-3 text-sm">
                <div className="flex justify-between gap-4 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-2.5">
                  <dt className="shrink-0 text-[var(--gp-muted,#646a73)]">邮箱</dt>
                  <dd className="truncate font-medium text-[var(--gp-ink,#1f2329)]">
                    {student.email || "未公开"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-2.5">
                  <dt className="shrink-0 text-[var(--gp-muted,#646a73)]">入班时间</dt>
                  <dd className="gp-tabular font-medium text-[var(--gp-ink,#1f2329)]">
                    {dateOnly(student.joined_at)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-2.5">
                  <dt className="shrink-0 text-[var(--gp-muted,#646a73)]">组队状态</dt>
                  <dd className="font-medium text-[var(--gp-ink,#1f2329)]">
                    {isGrouped ? "已组队" : "未组队"}
                    {student.is_leader ? "（队长）" : ""}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-[var(--gp-border-subtle,#ebedf0)] pb-2.5">
                  <dt className="shrink-0 text-[var(--gp-muted,#646a73)]">所在队伍</dt>
                  <dd className="truncate font-medium text-[var(--gp-ink,#1f2329)]">
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
                <div className="mt-4">
                  <TeacherFeedbackPill tone="error" message={errorMessage} />
                </div>
              )}

              {canManage && (
                <div className="mt-6 border-t border-[var(--gp-border-subtle,#ebedf0)] pt-5">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--gp-muted,#646a73)]">
                    班级成员管理
                  </h3>
                  {isGrouped ? (
                    <div className="mt-2">
                      <Button type="button" variant="outline" size="sm" disabled>
                        <UserMinus size={14} />
                        移出班级
                      </Button>
                      <p className="mt-1.5 text-xs text-[var(--gp-muted,#646a73)]">
                        该学生当前在队伍中，请先在组队广场将其移出队伍后再移出班级。
                      </p>
                    </div>
                  ) : !confirming ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2 border-red-200 text-[#d93025] hover:bg-red-50 hover:text-[#d93025]"
                      onClick={() => setConfirming(true)}
                    >
                      <UserMinus size={14} />
                      移出班级
                    </Button>
                  ) : (
                    <div className="mt-3 rounded-[10px] border border-red-200 bg-red-50/60 p-3.5">
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
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          pill
                          loading={removing}
                          preserveWidth
                          disabled={!reason.trim()}
                          onClick={() => onRemove(reason.trim())}
                        >
                          确认移出
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={removing}
                          onClick={() => setConfirming(false)}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <SheetFooter className="border-t border-[var(--gp-border-subtle,#ebedf0)] pt-4">
              <Button type="button" variant="outline" size="sm" disabled={removing} onClick={onClose}>
                关闭
              </Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
