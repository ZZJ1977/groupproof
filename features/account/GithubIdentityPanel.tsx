"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Feedback, Panel, StatusBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ApiError, authClient } from "@/lib/api/auth-client";

export function GithubIdentityPanel({ userId, csrfToken }: { userId: string; csrfToken: string }) {
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

  return (
    <div id="github-identity" className="scroll-mt-6">
      <Panel title={t("title")}>
        <p className="text-sm leading-6 text-[var(--gp-ink-soft)]">{t("description")}</p>
        {status.isPending && <p className="mt-3 text-sm" role="status">{t("loading")}</p>}
        {status.isError && <div className="mt-3 space-y-3"><Feedback tone="error">{t("loadFailed")}</Feedback><Button variant="outline" onClick={() => void status.refetch()}>{t("retry")}</Button></div>}
        {identity?.login ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <StatusBadge status="verified" label={t("verified")} />
            <span className="break-all text-sm font-medium">@{identity.login}</span>
            <Button variant="outline" loading={pending} disabled={!csrfToken} onClick={() => void change("unlink")}>{t("unlink")}</Button>
          </div>
        ) : identity?.available ? (
          <Button className="mt-3" loading={pending} disabled={!csrfToken} onClick={() => void change("link")}>{t("link")}</Button>
        ) : identity && (
          <p className="mt-3 text-sm text-[var(--gp-muted)]" role="status">{t("unavailable")}</p>
        )}
        {feedback && (feedback !== "unavailable" || identity?.available) && (
          <Feedback className="mt-3" tone={feedback === "linked" || feedback === "unlinked" ? "success" : feedback === "cancelled" ? "info" : "error"}>{t(feedback)}</Feedback>
        )}
      </Panel>
    </div>
  );
}
