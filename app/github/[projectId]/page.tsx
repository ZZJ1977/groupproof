import { notFound, redirect } from "next/navigation";
import { resolveCanonicalRouteContext } from "@/shared/lib/navigation";

export const dynamic = "force-dynamic";

/** 旧入口保留，目标页面统一处理会话与项目权限。 */
export default async function GithubBindingPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  if (resolveCanonicalRouteContext(`/projects/${projectId}`).projectId !== projectId) notFound();
  redirect(`/projects/${projectId}/settings#github-integration`);
}
