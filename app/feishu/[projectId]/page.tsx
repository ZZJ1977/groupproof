import { redirect } from "next/navigation";
import { getAuthSession } from "@/lib/auth/server";
import { FeishuChatBinding } from "@/features/feishu-binding/FeishuChatBinding";

export const dynamic = "force-dynamic";

/** 受保护页面：未登录直接跳转登录，与主路由守卫保持一致。 */
export default async function FeishuBindingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const lookup = await getAuthSession();
  if (!lookup.ok || !lookup.session.authenticated) {
    redirect(`/login?returnTo=${encodeURIComponent(`/feishu/${projectId}`)}`);
  }
  return <FeishuChatBinding projectId={projectId} />;
}
