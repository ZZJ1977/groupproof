"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Feedback, PageHeader } from "@/components/common";
import { LanguageSwitcher } from "@/components/language-switcher";
import { authClient } from "@/lib/api/auth-client";
import { ErrorNote } from "@/features/auth/LoginPage";

/**
 * 密码重置页（公开）：恢复令牌经邮件链接以 URL fragment 携带（不进服务端日志/Referer）。
 * 页面读取后立即从地址栏清除、只在内存使用；最终通过 POST 提交（不在 GET 消费令牌）。
 */
export function ResetPasswordPage() {
  const t = useTranslations("auth.resetPage");
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null; retryAfter: number | null } | null>(null);
  const router = useRouter();

  useEffect(() => {
    const fragment = window.location.hash;
    const match = /token=([A-Za-z0-9_\-]+)/.exec(fragment);
    if (match) {
      setToken(match[1]);
      // 尽快从地址栏清除令牌（防 Referer/历史泄露）
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (pending || !token) return;
    if (password !== confirm) {
      setError({ message: t("mismatch"), requestId: null, retryAfter: null });
      return;
    }
    setPending(true);
    setError(null);
    try {
      await authClient.resetPassword(token, password);
      setDone(true);
      window.setTimeout(() => router.push("/login"), 1500);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code: string }).code;
        const requestId = (err as { requestId?: string | null }).requestId ?? null;
        const retryAfter = (err as { retryAfterSeconds?: number | null }).retryAfterSeconds ?? null;
        setError({ message: t(`errors.${code}`), requestId, retryAfter });
      } else {
        setError({ message: t("errors.SERVICE_UNAVAILABLE"), requestId: null, retryAfter: null });
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f6f9fd]">
      <header className="flex h-[65px] items-center justify-between border-b border-[#e7edf5] bg-white px-[max(24px,4vw)]">
        <div className="text-[22px] font-bold text-[#14213b]">GroupProof</div>
        <LanguageSwitcher compact />
      </header>
      <main className="mx-auto max-w-[520px] px-[max(24px,4vw)] py-12">
        <PageHeader title={t("title")} description={t("description")} />
        {done ? (
          <Feedback tone="success">{t("done")}</Feedback>
        ) : !token ? (
          <Feedback tone="error">{t("missingToken")}</Feedback>
        ) : (
          <form className="space-y-3 rounded-[8px] border border-[#e0e7f0] bg-white p-6" onSubmit={submit}>
            <label className="gp-field">
              {t("newPassword")}
              <Input type="password" value={password} onChange={(event) => { setPassword(event.target.value); setError(null); }} autoComplete="new-password" aria-label={t("newPassword")} />
            </label>
            <label className="gp-field">
              {t("confirmPassword")}
              <Input type="password" value={confirm} onChange={(event) => { setConfirm(event.target.value); setError(null); }} autoComplete="new-password" aria-label={t("confirmPassword")} />
            </label>
            <p className="text-[11px] leading-5 text-[#8d9aad]">{t("policyNote")}</p>
            {error && <ErrorNote {...error} />}
            <Button type="submit" className="w-full" loading={pending} disabled={!password || !confirm}>
              {t("submit")}
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
