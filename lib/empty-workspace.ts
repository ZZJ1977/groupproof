import type { MockData } from "@/types/domain";

/** Real feature pages own their queries; never populate their shell with demo objects. */
export function emptyWorkspace(userId: string): MockData {
  return {
    schemaVersion: 1, currentUserId: userId, currentRole: "student",
    users: [], courses: [], groups: [], projects: [], requirements: [], modules: [], tasks: [], criteria: [],
    evidence: [], verifications: [], milestones: [], github: [], feishu: [], files: [], discussions: [],
    contributions: [], reports: [], baselineRevisions: [], planRevisions: [], courseRuleRevisions: [],
    ruleChangeReviews: [], setupDrafts: [], notifications: [], actionItems: [], teacherRequests: [],
    accessRequests: [], logs: [], aiUsage: [],
  };
}
