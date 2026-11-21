import { bRequest } from "@/lib/api/b-client";
import type { BPerson } from "@/lib/api/b-courses";

export type BFileRef = { id: string; name: string; href: string };
export type BRiskLevel = "high" | "medium" | "low";
export type BMilestoneRiskItem = {
  id: string; title: string; level: BRiskLevel; status: "open" | "mitigating"; due_at: string | null; owner: BPerson | null;
  /** The linked task the risk is recorded on; null when it is on the milestone itself. */
  task: { id: string; code: string | null; title: string } | null;
};
/** Open and mitigating risks read from D; `level` is the highest one, null when none is open. */
export type BMilestoneRisk = { level: BRiskLevel | null; open_count: number; items: BMilestoneRiskItem[] };
export type BMilestone = {
  id: string; title: string; description: string | null; deadline: string | null; status: string; overdue: boolean;
  progress_percent: number | null; task_count: number; completed_task_count: number; deliverables_done: number; deliverables_total: number;
  /** From D's risks; null when D's data is not available yet. */
  risk: BMilestoneRisk | null; lock_version: number; href: string;
};
export type BDeliverable = {
  id: string; title: string; done: boolean; done_by: BPerson | null; done_at: string | null; file: BFileRef | null; lock_version: number;
  history: { action: "checked" | "unchecked"; actor: BPerson | null; at: string; file: BFileRef | null }[];
};
export type BMilestoneDetail = BMilestone & {
  tasks: { id: string; code: string | null; title: string; status: string; progress_percent: number; weight: number; assignees: BPerson[]; href: string }[];
  deliverables: BDeliverable[];
  date_changes: { old_deadline: string | null; new_deadline: string; reason: string; changed_by: BPerson | null; changed_at: string }[];
  can_lead: boolean; files: BFileRef[];
};
export type BMilestoneMissing = { tasks: { id: string; code: string | null; title: string; state: string }[]; deliverables: { id: string; title: string }[] };

const id = encodeURIComponent;
const base = (projectId: string, milestoneId?: string) => `/api/v1/projects/${id(projectId)}/milestones${milestoneId ? `/${id(milestoneId)}` : ""}`;
export const bMilestonesApi = {
  list: (projectId: string) => bRequest<{ items: BMilestone[]; can_lead: boolean }>({ path: base(projectId) }),
  detail: (projectId: string, milestoneId: string) => bRequest<BMilestoneDetail>({ path: base(projectId, milestoneId) }),
  addDeliverable: (projectId: string, milestoneId: string, title: string) =>
    bRequest<BMilestoneDetail>({ method: "POST", path: `${base(projectId, milestoneId)}/deliverables`, body: { title } }),
  check: (projectId: string, milestoneId: string, item: BDeliverable, done: boolean, fileId?: string | null) =>
    bRequest<BMilestoneDetail>({ method: "POST", path: `${base(projectId, milestoneId)}/deliverables/${id(item.id)}/check`, body: { done, file_id: fileId || null, expected_version: item.lock_version } }),
  complete: (projectId: string, milestone: BMilestoneDetail) =>
    bRequest<BMilestoneDetail>({ method: "POST", path: `${base(projectId, milestone.id)}/complete`, body: { expected_version: milestone.lock_version } }),
  reschedule: (projectId: string, milestone: BMilestoneDetail, deadline: string, reason: string) =>
    bRequest<BMilestoneDetail>({ method: "POST", path: `${base(projectId, milestone.id)}/reschedule`, body: { deadline, reason, expected_version: milestone.lock_version } }),
};
