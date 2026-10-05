import { Suspense } from "react";
import { WorkspaceProvider } from "@/lib/workspace";
import { RouteDispatcher } from "@/features/route-dispatcher";

export default function Page() {
  return <WorkspaceProvider><Suspense fallback={<div className="gp-empty">正在加载...</div>}><RouteDispatcher /></Suspense></WorkspaceProvider>;
}
