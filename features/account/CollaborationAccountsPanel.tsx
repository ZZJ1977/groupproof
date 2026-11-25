"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowRight, GitBranch, Link2, MessageSquare } from "lucide-react";
import { StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError, authClient, type MeDTO, type SessionDTO } from "@/lib/api/auth-client";

export function FeishuAccountSection({
  session,
  me,
  refetch,
  compact = false,
}: {
  session: SessionDTO;
  me: MeDTO;
  refetch: () => unknown;
  compact?: boolean;
}) {
  const tc = useTranslations("account.collaboration");
  const tp = useTranslations("account.profile");
  const [value, setValue] = useState(me.user.feishuAccount ?? "");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setValue(me.user.feishuAccount ?? "");
  }, [me.user.feishuAccount]);

  const currentSaved = me.user.feishuAccount ?? "";
  const trimmed = value.trim();
  const dirty = trimmed !== currentSaved;

  const save = async () => {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      await authClient.updateProfile(session.csrfToken ?? "", {
        feishuAccount: trimmed || null,
        expectedVersion: me.user.version,
      });
      await refetch();
      setNotice({ tone: "success", text: trimmed ? tc("feishuSaved") : tc("feishuCleared") });
    } catch (err) {
      if (err instanceof ApiError && err.code === "VERSION_CONFLICT") {
        setNotice({ tone: "error", text: tp("errors.version_conflict") });
      } else if (err instanceof ApiError && err.fieldErrors.feishuAccount) {
        const code = err.fieldErrors.feishuAccount;
        setNotice({
          tone: "error",
          text: tp.has(`errors.${code}`) ? tp(`errors.${code}`) : tp("saveFailed"),
        });
      } else {
        setNotice({ tone: "error", text: tp("saveFailed") });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div id="feishu-account" className={compact ? "space-y-2" : "space-y-2.5"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare size={15} className="shrink-0 text-sky-600" aria-hidden="true" />
          <span className="text-xs font-semibold text-[var(--gp-ink)]">{tc("feishuTitle")}</span>
          {currentSaved ? (
            <StatusBadge status="verified" label={tc("feishuLinked")} />
          ) : (
            <StatusBadge status="gray" label={tc("feishuNotLinked")} />
          )}
        </div>
        {currentSaved && (
          <span className="max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-[var(--gp-ink-soft)]">
            {currentSaved}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-8 min-w-0 flex-1 text-xs"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setNotice(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
          maxLength={120}
          aria-label={tc("feishuTitle")}
          placeholder={tc("feishuPlaceholder")}
          disabled={pending}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 px-3 text-xs"
          loading={pending}
          disabled={!dirty && !pending}
          onClick={() => void save()}
        >
          {tc("feishuSave")}
        </Button>
      </div>

      <p className="text-[11px] leading-4 text-[var(--gp-muted)]">{tc("feishuHint")}</p>
      {notice && (
        <p
          className={`text-xs ${notice.tone === "success" ? "text-[#15ac70]" : "text-[var(--gp-danger)]"}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

export function CollaborationAccountsCard({
  session,
  me,
  refetch,
}: {
  session: SessionDTO;
  me: MeDTO;
  refetch: () => unknown;
}) {
  const tc = useTranslations("account.collaboration");
  const tg = useTranslations("account.githubIdentity");
  const githubStatus = useQuery({
    queryKey: ["verified-github-identity", me.user.id],
    queryFn: ({ signal }) => authClient.githubIdentity(signal),
    retry: false,
    gcTime: 0,
  });

  const verifiedGithub = githubStatus.data?.login ?? me.user.githubLogin ?? null;
  const declaredGithub = me.user.githubUsername ?? null;

  return (
    <section
      aria-label={tc("title")}
      className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-slate-50/70 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Link2 size={15} className="shrink-0 text-primary" aria-hidden="true" />
          <h2 className="truncate text-sm font-semibold text-[var(--gp-ink)]">{tc("title")}</h2>
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {/* GitHub row */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <GitBranch size={15} className="shrink-0 text-slate-700" aria-hidden="true" />
            <span className="text-xs font-semibold text-[var(--gp-ink)]">{tg("title")}</span>
            {verifiedGithub ? (
              <>
                <span className="break-all font-mono text-xs font-semibold text-[var(--gp-ink)]">
                  @{verifiedGithub}
                </span>
                <StatusBadge status="verified" label={tg("verified")} />
              </>
            ) : declaredGithub ? (
              <>
                <span className="break-all font-mono text-xs font-medium text-[var(--gp-ink-soft)]">
                  @{declaredGithub}
                </span>
                <StatusBadge status="gray" label={tc("githubDeclared")} />
              </>
            ) : (
              <StatusBadge status="gray" label={tc("githubNotBound")} />
            )}
          </div>
          <Link
            href="/account/security#github-identity"
            className="gp-link inline-flex shrink-0 items-center gap-1 text-xs font-semibold"
          >
            {verifiedGithub ? tc("githubManage") : tc("githubBind")}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>

        {/* Feishu row */}
        <div className="px-4 py-3">
          <FeishuAccountSection session={session} me={me} refetch={refetch} compact />
        </div>
      </div>
    </section>
  );
}
