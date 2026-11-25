"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { GitBranch } from "lucide-react";
import { Feedback, Panel, StatusBadge } from "@/shared/components/common";
import { Button } from "@/shared/components/ui/button";
import { ApiError, authClient } from "@/shared/auth/auth-client";

export function GithubIdentityPanel({
  userId,
  csrfToken,
  embedded = false,
}: {
  userId: string;
  csrfToken: string;
  embedded?: boolean;
}) {
  const t = useTranslations("account.githubIdentity");
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const queryKey = ["verified-github-identity", userId] as const;
  const status = useQuery({ queryKey, queryFn: ({ signal }) => authClient.githubIdentity(signal), retry: false, gcTime: 0 });
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<"unlinked" | "reauth" | "failed" | null>(null);
  const identity = status.isSuccess ? status.data : undefined;
  const callback = search.get("github");
  const callbackNotice = callback === "linked" && identity?.login ? "linked" :
    callback === "cancelled" || callback === "conflict" || callback === "failed" || callback === "unavailable" ? callback : null;
  const feedback = notice ?? callbackNotice;

  async function change(operation: "link" | "unlink") {
    if (!csrfToken || pending) return;
    if (operation === "unlink" && (!identity?.login || !window.confirm(t("confirmUnlink")))) return;
    setPending(true);
    setNotice(null);
    try {
      if (operation === "link") {
        const { authorizeUrl } = await authClient.linkGithub(csrfToken);
        const target = new URL(authorizeUrl);
        if (target.origin !== "https://github.com" || target.pathname !== "/login/oauth/authorize") {
          throw new Error("Unexpected GitHub authorization URL");
        }
        window.location.assign(target.href);
      } else {
        await authClient.unlinkGithub(csrfToken);
        queryClient.setQueryData(queryKey, { available: identity?.available ?? false, login: null, verifiedAt: null });
        setNotice("unlinked");
      }
    } catch (error) {
      setNotice(error instanceof ApiError && error.code === "REAUTH_REQUIRED" ? "reauth" : "failed");
    } finally {
      setPending(false);
    }
  }

  const content = (
    <div className="space-y-2">
      {embedded && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GitBranch size={15} className="shrink-0 text-slate-700" aria-hidden="true" />
            <span className="text-xs font-semibold text-[var(--gp-ink)]">{t("title")}</span>
            {identity?.login && <StatusBadge status="verified" label={t("verified")} />}
          </div>
          {identity?.login && (
            <span className="break-all font-mono text-xs font-semibold text-[var(--gp-ink)]">@{identity.login}</span>
          )}
        </div>
      )}
      <p className="text-xs leading-5 text-[var(--gp-ink-soft)]">{t("description")}</p>
      {status.isPending && <p className="text-xs text-[var(--gp-muted)]" role="status">{t("loading")}</p>}
      {status.isError && (
        <div className="space-y-2">
          <Feedback tone="error">{t("loadFailed")}</Feedback>
          <Button variant="outline" size="sm" onClick={() => void status.refetch()}>{t("retry")}</Button>
        </div>
      )}
      {identity?.login ? (
        <div className="flex flex-wrap items-center gap-2.5">
          {!embedded && (
            <>
              <StatusBadge status="verified" label={t("verified")} />
              <span className="break-all text-xs font-semibold">@{identity.login}</span>
            </>
          )}
          <Button variant="outline" size="sm" loading={pending} disabled={!csrfToken} onClick={() => void change("unlink")}>
            {t("unlink")}
          </Button>
        </div>
      ) : identity?.available ? (
        <Button size="sm" loading={pending} disabled={!csrfToken} onClick={() => void change("link")}>
          {t("link")}
        </Button>
      ) : identity && (
        <p className="text-xs text-[var(--gp-muted)]" role="status">{t("unavailable")}</p>
      )}
      {feedback && (feedback !== "unavailable" || identity?.available) && (
        <Feedback tone={feedback === "linked" || feedback === "unlinked" ? "success" : feedback === "cancelled" ? "info" : "error"}>
          {t(feedback)}
        </Feedback>
      )}
    </div>
  );

  if (embedded) {
    return (
      <div id="github-identity" className="scroll-mt-6">
        {content}
      </div>
    );
  }

  return (
    <div id="github-identity" className="scroll-mt-6">
      <Panel title={t("title")}>{content}</Panel>
    </div>
  );
}
