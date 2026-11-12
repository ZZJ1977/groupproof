import { formatDate } from "@/lib/utils";

type Decision<Action extends string> = {
  id: string;
  version_id: string;
  action: Action;
  reason: string;
  created_at: string;
};

export function groupVersionDecisions<T extends { version_id: string }>(decisions: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const decision of decisions) {
    const group = groups.get(decision.version_id);
    if (group) group.push(decision);
    else groups.set(decision.version_id, [decision]);
  }
  return groups;
}

export function FileVersionHistory<Action extends string>({ version, decisions, labels }: {
  version: number;
  decisions?: readonly Decision<Action>[];
  labels: Record<Action, string>;
}) {
  if (!decisions?.length) return null;
  return (
    <ul aria-label={`v${version} 操作历史`} className="my-2 space-y-1 text-sm">
      {decisions.map((decision) => (
        <li key={decision.id}>
          {labels[decision.action]} · {decision.reason} ·{" "}
          <time dateTime={decision.created_at}>
            {formatDate(decision.created_at, { dateStyle: "medium", timeStyle: "short" })}
          </time>
        </li>
      ))}
    </ul>
  );
}
