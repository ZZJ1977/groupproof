"use client";

import { CApiError } from "@/shared/daily-inbox/c-client";
import { projectApi } from "@/shared/lib/c-project-api";
import type { FeishuCollaborationInsights, FeishuInsightItem } from "@/student/execution/FeishuCollaborationInsights";
import type { GithubActivityStats } from "@/student/execution/GithubStatsChart";
import { projectRequest } from "@/shared/lib/integration-request";
import { bProjectsApi, type BProjectOverview } from "@/student/api/b-projects";
import { bTasksApi, type BTaskRow } from "@/student/api/b-tasks";
import { fetchWithSession } from "@/shared/lib/api-client";
import { apiConfig } from "@/shared/lib/api-config";
import type { components } from "@/packages/domain/api.generated";

export type ContributionTaskCredit = {
  task_id: string;
  title: string;
  responsibility_share: number;
  weight: number;
  formal_outcome_id: string | null;
  evidence_url: string;
  evidence: { criterion_id: string; evidence_id: string; version: number }[];
};

export type ContributionSnapshotMember = {
  user_id: string;
  name: string;
  share: number;
  task_credit: number;
  tasks: ContributionTaskCredit[];
};

export type ContributionSnapshot = {
  id: string;
  version: number;
  status?: string;
  frozen_at?: string | null;
  formula_version: string;
  calculated_at: string;
  stale: boolean;
  members: ContributionSnapshotMember[];
};

export type MemberAnalyticsRow = {
  userId: string;
  name: string;
  color: string;
  // Formal acceptance metrics
  formalShare: number;
  taskCredit: number;
  formalTasks: ContributionTaskCredit[];
  // Task execution metrics
  assignedCount: number;
  completedCount: number;
  pendingVerificationCount: number;
  inProgressCount: number;
  pendingSubmissionCount: number;
  notStartedCount: number;
  assignedWeight: number;
  weightedTaskProgress: number;
  assignedTasks: BTaskRow[];
  // GitHub metrics
  commits: number;
  additions: number;
  deletions: number;
  filesChanged: number;
  pullRequests: number;
  githubLogin: string | null;
  lastCommitAt: string | null;
  // Feishu collaboration metrics
  collabTopics: number;
  collabRecords: number;
  collabScore: number;
  // Multi-source composite reference (0-100%, never replaces formal weight)
  activityShare: number;
};

export type TaskStatusCounts = {
  completed: number;
  pendingVerification: number;
  inProgress: number;
  pendingSubmission: number;
  notStarted: number;
  total: number;
};

export type ProjectContributionAnalytics = {
  projectId: string;
  projectName: string;
  snapshot: ContributionSnapshot | null;
  members: MemberAnalyticsRow[];
  tasks: BTaskRow[];
  taskStatusCounts: TaskStatusCounts;
  githubStats: GithubActivityStats | null;
  feishuInsights: FeishuCollaborationInsights | null;
  feishuTotalMessages: number;
  totalFormalCredit: number;
  formalParticipantCount: number;
  activeContributorCount: number;
  totalCommits: number;
  totalAdditions: number;
  totalDeletions: number;
  totalPullRequests: number;
  unmatchedCommits: number;
  unmatchedLines: number;
  canCalculate: boolean;
  canFreeze: boolean;
};

const MEMBER_COLORS = [
  "#0284c7", // sky-600
  "#059669", // emerald-600
  "#7c3aed", // violet-600
  "#d97706", // amber-600
  "#e11d48", // rose-600
  "#0d9488", // teal-600
  "#4f46e5", // indigo-600
  "#ca8a04", // yellow-600
];

const GENERIC_FEISHU_SENDERS = new Set(["飞书成员", "未知发送者", "群机器人", "系统", "system", "unknown"]);

type ActivityItem = components["schemas"]["ActivityDTO"];

type FlexibleInsightMessage = FeishuInsightItem["messages"][number] & {
  author_user_id?: string | null;
  user_id?: string | null;
  author_id?: string | null;
  sender_name?: string | null;
};

type FlexibleInsightItem = Omit<FeishuInsightItem, "messages"> & {
  messages?: FlexibleInsightMessage[];
  participants?: (string | { user_id?: string | null; id?: string | null; name?: string | null })[];
};

type FlexibleFeishuInsights = FeishuCollaborationInsights & {
  conclusions?: FlexibleInsightItem[];
  topics?: FlexibleInsightItem[];
};

export type FeishuMemberAttribution = {
  collabTopics: number;
  collabRecords: number;
  collabScore: number;
};

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function extractSenderLetter(label: string | null | undefined): string | null {
  const text = (label ?? "").trim();
  if (!text) return null;
  const match =
    text.match(/^(?:群成员|成员|组员|同学|角色|member|user)\s*[-_·:：]?\s*([A-Z])$/i) ??
    text.match(/^([A-Z])$/i);
  return match ? match[1].toUpperCase() : null;
}

function extractModuleLetterFromTask(task: BTaskRow): { letter: string; weight: number } | null {
  const moduleCode = (task.module?.code ?? "").trim();
  if (moduleCode) {
    const m = moduleCode.match(/^([A-Z])(?:\d*)$/i);
    if (m && m[1].toUpperCase() !== "T") {
      return { letter: m[1].toUpperCase(), weight: 4 };
    }
  }

  const moduleName = (task.module?.name ?? "").trim();
  if (moduleName) {
    const m =
      moduleName.match(
        /^\s*(?:模块|成员|组员|角色|part|module)?\s*[\[【(（]?\s*([A-Z])\s*[\]】)）]?(?:\s*(?:模块|端|组|部分|成员)|[\s:：·\-—_、.．]|$)/i,
      ) ??
      moduleName.match(/(?:模块|成员|组员)\s*([A-Z])(?![A-Za-z])/i) ??
      moduleName.match(/(?<![A-Za-z])([A-Z])\s*(?:模块|端|部分)(?![A-Za-z])/i);
    if (m) {
      return { letter: m[1].toUpperCase(), weight: 3 };
    }
  }

  const taskCode = (task.code ?? "").trim();
  if (taskCode) {
    const m =
      taskCode.match(/^([A-Z])[-_]?\d+/i) ??
      taskCode.match(/^(?:mod|m)[-_]?([A-Z])(?:\d|$)/i);
    if (m && m[1].toUpperCase() !== "T") {
      return { letter: m[1].toUpperCase(), weight: 2 };
    }
  }

  const title = (task.title ?? "").trim();
  if (title) {
    const m =
      title.match(/^\s*[\[【(（]\s*([A-Z])\s*[\]】)）]/i) ??
      title.match(/^\s*(?:模块|成员|组员)\s*([A-Z])(?![A-Za-z])/i) ??
      title.match(/^\s*([A-Z])\s*(?:模块|端|部分)(?![A-Za-z])/i) ??
      title.match(/^\s*([A-Z])\d+(?![A-Za-z0-9])/i);
    if (m && m[1].toUpperCase() !== "T") {
      return { letter: m[1].toUpperCase(), weight: 1 };
    }
  }

  return null;
}

function buildModuleLetterRegex(letter: string): RegExp {
  const L = letter.toUpperCase();
  const parts = [
    `(?:模块|module|part)\\s*${L}(?![A-Za-z])`,
    `(?<![A-Za-z])${L}\\s*(?:模块|端|部分|方向|任务)`,
  ];
  if (L !== "T") {
    parts.push(`(?<![A-Za-z0-9])${L}[-_]?\\d{1,2}(?![A-Za-z0-9])`);
  }
  return new RegExp(parts.join("|"), "i");
}

function buildSenderLetterMentionRegex(letter: string): RegExp {
  const L = letter.toUpperCase();
  return new RegExp(`(?:群成员|成员|组员|同学)\\s*${L}(?![A-Za-z])|(?<![A-Za-z])${L}\\s*(?:同学|组员|成员)`, "i");
}

function buildTaskCodeRegex(code: string): RegExp {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i");
}

function solveOneToOneAssignment(
  votes: Map<string, Map<string, number>>,
): Map<string, string> {
  const pairs: { key: string; target: string; score: number }[] = [];
  for (const [key, targetScores] of votes.entries()) {
    for (const [target, score] of targetScores.entries()) {
      if (score > 0) pairs.push({ key, target, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key) || a.target.localeCompare(b.target));
  const assigned = new Map<string, string>();
  const usedTargets = new Set<string>();
  for (const pair of pairs) {
    if (assigned.has(pair.key) || usedTargets.has(pair.target)) continue;
    assigned.set(pair.key, pair.target);
    usedTargets.add(pair.target);
  }
  return assigned;
}

function addVote(votes: Map<string, Map<string, number>>, key: string, target: string, delta: number) {
  let inner = votes.get(key);
  if (!inner) {
    inner = new Map<string, number>();
    votes.set(key, inner);
  }
  inner.set(target, (inner.get(target) ?? 0) + delta);
}

export function resolveFeishuMemberAttribution(params: {
  orderedIds: string[];
  memberNameMap: Map<string, string>;
  assignedTasksByUser: Map<string, BTaskRow[]>;
  githubLoginByUser: Map<string, string | null>;
  feishuInsights: FeishuCollaborationInsights | null;
  feishuActivities: ActivityItem[];
}): Map<string, FeishuMemberAttribution> {
  const {
    orderedIds,
    memberNameMap,
    assignedTasksByUser,
    githubLoginByUser,
    feishuInsights,
    feishuActivities,
  } = params;

  const result = new Map<string, FeishuMemberAttribution>();
  for (const uid of orderedIds) {
    result.set(uid, { collabTopics: 0, collabRecords: 0, collabScore: 0 });
  }
  if (orderedIds.length === 0) return result;

  const flexibleInsights = feishuInsights as FlexibleFeishuInsights | null;
  const insightItems: FlexibleInsightItem[] =
    flexibleInsights?.items ??
    flexibleInsights?.conclusions ??
    flexibleInsights?.topics ??
    [];

  // Build lookup tables for exact real name / login matching
  const memberIdsByName = new Map<string, string[]>();
  const memberIdsByLogin = new Map<string, string[]>();
  const assignedTaskIdsByUser = new Map<string, Set<string>>();
  const assignedTaskCodesByUser = new Map<string, Set<string>>();
  const taskOwnerIdsByTaskId = new Map<string, string[]>();
  const moduleLetterVotes = new Map<string, Map<string, number>>(); // letter -> uid -> votes

  for (const uid of orderedIds) {
    const normName = normalizeToken(memberNameMap.get(uid));
    if (normName) {
      const list = memberIdsByName.get(normName) ?? [];
      list.push(uid);
      memberIdsByName.set(normName, list);
    }
    const normLogin = normalizeToken(githubLoginByUser.get(uid));
    if (normLogin.length >= 3) {
      const list = memberIdsByLogin.get(normLogin) ?? [];
      list.push(uid);
      memberIdsByLogin.set(normLogin, list);
    }

    const tasks = assignedTasksByUser.get(uid) ?? [];
    const taskIds = new Set<string>();
    const taskCodes = new Set<string>();
    for (const t of tasks) {
      taskIds.add(t.id);
      const owners = taskOwnerIdsByTaskId.get(t.id) ?? [];
      owners.push(uid);
      taskOwnerIdsByTaskId.set(t.id, owners);
      if (t.code && t.code.trim()) {
        taskCodes.add(t.code.trim().toUpperCase());
      }
      const extracted = extractModuleLetterFromTask(t);
      if (extracted) {
        addVote(moduleLetterVotes, extracted.letter, uid, extracted.weight);
      }
    }
    assignedTaskIdsByUser.set(uid, taskIds);
    assignedTaskCodesByUser.set(uid, taskCodes);
  }

  // Primary module letter per member (e.g. A -> 卓子杰, B -> 杨凯景, C -> 郑元泰, D -> 林星妤)
  const moduleLetterToUser = solveOneToOneAssignment(moduleLetterVotes);
  const userToModuleLetter = new Map<string, string>();
  for (const [letter, uid] of moduleLetterToUser.entries()) {
    userToModuleLetter.set(uid, letter);
  }

  // Helper: match a speaker/author label or user ID directly to a canonical member (non-anonymized)
  const matchDirectSpeaker = (
    candidateId: string | null | undefined,
    candidateLabel: string | null | undefined,
  ): string | null => {
    if (candidateId && memberNameMap.has(candidateId)) return candidateId;
    const norm = normalizeToken(candidateLabel);
    if (!norm || GENERIC_FEISHU_SENDERS.has(norm)) return null;
    const exactName = memberIdsByName.get(norm);
    if (exactName && exactName.length === 1) return exactName[0];
    const exactLogin = memberIdsByLogin.get(norm);
    if (exactLogin && exactLogin.length === 1) return exactLogin[0];
    // Substring match for display labels like "卓子杰 (组长)" or "卓子杰 · A"
    const partialMatches: string[] = [];
    for (const uid of orderedIds) {
      const memberName = normalizeToken(memberNameMap.get(uid));
      if (memberName.length >= 2 && norm.includes(memberName)) {
        partialMatches.push(uid);
      }
    }
    if (partialMatches.length === 1) return partialMatches[0];
    return null;
  };

  // Pre-build regexes for module letters & task codes
  const moduleLetterRegexByLetter = new Map<string, RegExp>();
  for (const letter of moduleLetterToUser.keys()) {
    moduleLetterRegexByLetter.set(letter, buildModuleLetterRegex(letter));
  }
  const taskCodeRegexByUser = new Map<string, RegExp[]>();
  for (const uid of orderedIds) {
    const codes = Array.from(assignedTaskCodesByUser.get(uid) ?? []);
    taskCodeRegexByUser.set(uid, codes.map(buildTaskCodeRegex));
  }

  // Discover anonymized sender labels (e.g. "群成员 A/B/C/D") and infer their mapping to members
  const seenSenderLetters = new Set<string>();
  const senderLetterVotes = new Map<string, Map<string, number>>(); // senderLetter -> uid -> score

  for (const [letter, uid] of moduleLetterToUser.entries()) {
    addVote(senderLetterVotes, letter, uid, 2);
  }

  for (const item of insightItems) {
    const msgs = item.messages ?? [];
    const itemSenderLetters = new Set<string>();
    for (const msg of msgs) {
      const directUid = matchDirectSpeaker(
        msg.author_user_id ?? msg.user_id ?? msg.author_id,
        msg.sender_name ?? msg.sender_label,
      );
      if (directUid) continue;
      const letter = extractSenderLetter(msg.sender_label ?? msg.sender_name);
      if (!letter) continue;
      seenSenderLetters.add(letter);
      itemSenderLetters.add(letter);

      const msgText = `${msg.text ?? ""} ${(msg.attachments ?? []).map((a) => a.name ?? "").join(" ")}`;
      const msgLower = msgText.toLowerCase();

      // If this anonymized speaker uniquely references one module letter or task code (not a group-wide list), vote strongly
      const matchedModUids: string[] = [];
      for (const [modLetter, modUid] of moduleLetterToUser.entries()) {
        const rx = moduleLetterRegexByLetter.get(modLetter);
        if (rx && rx.test(msgText)) {
          matchedModUids.push(modUid);
        }
      }
      if (matchedModUids.length === 1) {
        const firstPerson = /(?:我|这边|已经|提交|完成|推了|改了|搞定|负责)/.test(msgText);
        addVote(senderLetterVotes, letter, matchedModUids[0], firstPerson ? 4 : 2);
      }
      const matchedCodeUids: string[] = [];
      const matchedNameUids: string[] = [];
      for (const uid of orderedIds) {
        const codeRegexes = taskCodeRegexByUser.get(uid) ?? [];
        if (codeRegexes.some((rx) => rx.test(msgText))) {
          matchedCodeUids.push(uid);
        }
        const memberName = normalizeToken(memberNameMap.get(uid));
        if (memberName.length >= 2 && msgLower.includes(memberName)) {
          matchedNameUids.push(uid);
        }
      }
      if (matchedCodeUids.length === 1) {
        addVote(senderLetterVotes, letter, matchedCodeUids[0], 4);
      }
      if (matchedNameUids.length === 1) {
        addVote(senderLetterVotes, letter, matchedNameUids[0], 2);
      }
    }

    // If an insight has a single anonymized sender and linked tasks owned by a single member, vote strongly
    if (itemSenderLetters.size === 1 && (item.linked_tasks?.length ?? 0) > 0) {
      const onlyLetter = Array.from(itemSenderLetters)[0];
      const linkedOwners = new Set<string>();
      for (const lt of item.linked_tasks ?? []) {
        for (const ownerId of taskOwnerIdsByTaskId.get(lt.id) ?? []) {
          linkedOwners.add(ownerId);
        }
      }
      if (linkedOwners.size === 1) {
        addVote(senderLetterVotes, onlyLetter, Array.from(linkedOwners)[0], 5);
      }
    }
  }

  for (const act of feishuActivities) {
    const directUid = matchDirectSpeaker(act.author_id, act.author_name);
    if (directUid) continue;
    const letter = extractSenderLetter(act.author_name);
    if (letter) seenSenderLetters.add(letter);
  }

  // Resolve anonymized sender letters to canonical members (votes first, then stable order fallback)
  const senderLetterToUser = solveOneToOneAssignment(senderLetterVotes);
  const usedUsersForSenders = new Set<string>(senderLetterToUser.values());
  const remainingSenderLetters = Array.from(seenSenderLetters)
    .filter((l) => !senderLetterToUser.has(l))
    .sort();
  const remainingUsers = orderedIds.filter((uid) => !usedUsersForSenders.has(uid));
  for (let i = 0; i < Math.min(remainingSenderLetters.length, remainingUsers.length); i += 1) {
    senderLetterToUser.set(remainingSenderLetters[i], remainingUsers[i]);
  }

  // Pre-build regexes for resolved sender letters (e.g. "群成员 A" -> uB, "成员 B" -> uA)
  const senderLetterMentionRegexByUser = new Map<string, RegExp[]>();
  for (const [letter, uid] of senderLetterToUser.entries()) {
    const list = senderLetterMentionRegexByUser.get(uid) ?? [];
    list.push(buildSenderLetterMentionRegex(letter));
    senderLetterMentionRegexByUser.set(uid, list);
  }
  // If a member's module letter isn't claimed by a DIFFERENT anonymized sender, also match "成员 <modLetter>"
  for (const [modLetter, uid] of moduleLetterToUser.entries()) {
    const claimedBy = senderLetterToUser.get(modLetter);
    if (!claimedBy || claimedBy === uid) {
      const list = senderLetterMentionRegexByUser.get(uid) ?? [];
      list.push(buildSenderLetterMentionRegex(modLetter));
      senderLetterMentionRegexByUser.set(uid, list);
    }
  }

  const resolveSpeakerUserId = (
    candidateId: string | null | undefined,
    candidateLabel: string | null | undefined,
  ): string | null => {
    const direct = matchDirectSpeaker(candidateId, candidateLabel);
    if (direct) return direct;
    const letter = extractSenderLetter(candidateLabel);
    if (letter) {
      return senderLetterToUser.get(letter) ?? moduleLetterToUser.get(letter) ?? null;
    }
    return null;
  };

  const textMatchesMember = (uid: string, rawText: string): boolean => {
    if (!rawText) return false;
    const lower = rawText.toLowerCase();
    const normName = normalizeToken(memberNameMap.get(uid));
    if (normName.length >= 2 && lower.includes(normName)) return true;
    const normLogin = normalizeToken(githubLoginByUser.get(uid));
    if (normLogin.length >= 3 && lower.includes(normLogin)) return true;
    const codeRegexes = taskCodeRegexByUser.get(uid) ?? [];
    if (codeRegexes.some((rx) => rx.test(rawText))) return true;
    const modLetter = userToModuleLetter.get(uid);
    if (modLetter) {
      const rx = moduleLetterRegexByLetter.get(modLetter);
      if (rx && rx.test(rawText)) return true;
    }
    const senderRegexes = senderLetterMentionRegexByUser.get(uid) ?? [];
    if (senderRegexes.some((rx) => rx.test(rawText))) return true;
    return false;
  };

  // Track unique matched topics and unique matched message/activity IDs per member
  const matchedTopicIdsByUser = new Map<string, Set<string>>();
  const matchedRecordIdsByUser = new Map<string, Set<string>>();
  for (const uid of orderedIds) {
    matchedTopicIdsByUser.set(uid, new Set<string>());
    matchedRecordIdsByUser.set(uid, new Set<string>());
  }

  // 1. Attribute Feishu AI Insights (conclusions/topics + hydrated messages)
  for (let idx = 0; idx < insightItems.length; idx += 1) {
    const item = insightItems[idx];
    const topicId = item.id || `insight-${idx + 1}`;
    const msgs = item.messages ?? [];
    const itemHeaderText = `${item.title ?? ""} ${item.summary ?? ""} ${item.judgment_basis ?? ""}`;

    const directMsgsByUser = new Map<string, string[]>();
    let hasUnresolvableGenericOnly = msgs.length > 0;

    for (const msg of msgs) {
      const speakerUid = resolveSpeakerUserId(
        msg.author_user_id ?? msg.user_id ?? msg.author_id,
        msg.sender_name ?? msg.sender_label,
      );
      if (speakerUid) {
        hasUnresolvableGenericOnly = false;
        const list = directMsgsByUser.get(speakerUid) ?? [];
        list.push(msg.id);
        directMsgsByUser.set(speakerUid, list);
      }

      const msgBody = `${msg.text ?? ""} ${(msg.attachments ?? []).map((a) => a.name ?? "").join(" ")}`;
      for (const uid of orderedIds) {
        if (uid === speakerUid) continue;
        if (textMatchesMember(uid, msgBody)) {
          const list = directMsgsByUser.get(uid) ?? [];
          list.push(msg.id);
          directMsgsByUser.set(uid, list);
        }
      }
    }

    // Optional participants field (defensive compatibility)
    const participantUids = new Set<string>();
    for (const p of item.participants ?? []) {
      if (typeof p === "string") {
        const uid = resolveSpeakerUserId(p, p);
        if (uid) participantUids.add(uid);
      } else if (p && typeof p === "object") {
        const uid = resolveSpeakerUserId(p.user_id ?? p.id, p.name);
        if (uid) participantUids.add(uid);
      }
    }

    let matchedAnyMember = false;
    for (const uid of orderedIds) {
      const assignedTaskIds = assignedTaskIdsByUser.get(uid) ?? new Set<string>();
      const assignedTaskCodes = assignedTaskCodesByUser.get(uid) ?? new Set<string>();
      const directMsgIds = directMsgsByUser.get(uid) ?? [];
      const linkedToMemberTask = (item.linked_tasks ?? []).some(
        (lt) =>
          assignedTaskIds.has(lt.id) ||
          (lt.code ? assignedTaskCodes.has(lt.code.trim().toUpperCase()) : false),
      );
      const inParticipants = participantUids.has(uid);
      const mentionedInSummary = textMatchesMember(uid, itemHeaderText);

      if (directMsgIds.length > 0 || linkedToMemberTask || inParticipants || mentionedInSummary) {
        matchedAnyMember = true;
        matchedTopicIdsByUser.get(uid)!.add(topicId);
        const recSet = matchedRecordIdsByUser.get(uid)!;
        if (directMsgIds.length > 0) {
          for (const mid of directMsgIds) recSet.add(mid);
        } else {
          recSet.add(`insight:${topicId}`);
        }
      }
    }

    // Team-wide unanimous confirmation fallback when messages only carried generic labels
    const isUnanimousTeamItem =
      (item.confirmed_count ?? 0) >= orderedIds.length ||
      (item.category === "division_confirm" &&
        item.status === "completed" &&
        (item.confirmed_count ?? 0) >= Math.max(2, orderedIds.length - 1));
    if (isUnanimousTeamItem && (!matchedAnyMember || hasUnresolvableGenericOnly)) {
      for (const uid of orderedIds) {
        matchedTopicIdsByUser.get(uid)!.add(topicId);
        const recSet = matchedRecordIdsByUser.get(uid)!;
        if (recSet.size === 0 || !matchedAnyMember) {
          recSet.add(`insight:${topicId}`);
        }
      }
    }
  }

  // 2. Attribute raw Feishu activity records (deduplicated by message UUID against insights)
  for (const act of feishuActivities) {
    const attachmentNames = (act.feishu_attachments ?? []).map((a) => a.name ?? "").join(" ");
    const actText = `${act.title ?? ""} ${act.summary ?? ""} ${attachmentNames}`;
    const speakerUid = resolveSpeakerUserId(act.author_id, act.author_name);
    const actKey = act.source_id || act.record_id || act.source_identity;

    for (const uid of orderedIds) {
      const assignedTaskIds = assignedTaskIdsByUser.get(uid) ?? new Set<string>();
      const directAuthor = speakerUid === uid;
      const linkedTask = act.task_id ? assignedTaskIds.has(act.task_id) : false;
      const mentioned = textMatchesMember(uid, actText);
      if (directAuthor || linkedTask || mentioned) {
        matchedRecordIdsByUser.get(uid)!.add(actKey);
      }
    }
  }

  for (const uid of orderedIds) {
    const collabTopics = matchedTopicIdsByUser.get(uid)!.size;
    const collabRecords = matchedRecordIdsByUser.get(uid)!.size;
    const collabScore = collabTopics * 2 + collabRecords;
    result.set(uid, { collabTopics, collabRecords, collabScore });
  }

  return result;
}

export function computeEffectiveCodeVolumeScore(additions: number, deletions: number): number {
  const weightedLines = Math.max(0, additions) + 0.5 * Math.max(0, deletions);
  return weightedLines > 0 ? Math.log1p(weightedLines) : 0;
}

export async function contributionRequest<T>(url: string, method = "GET"): Promise<T> {
  const response = await fetchWithSession(
    new Request(new URL(apiConfig.baseUrl + url, window.location.origin), {
      method,
      credentials: "include",
      cache: "no-store",
    }),
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new CApiError(
      response.status,
      typeof body?.error?.code === "string" ? body.error.code : "INVALID_API_RESPONSE",
      typeof body?.error?.message === "string" ? body.error.message : "读取贡献失败",
      response.headers.get("X-Request-Id"),
    );
  }
  return body.data as T;
}

async function fetchAllProjectTasks(projectId: string) {
  const first = await bTasksApi.list(projectId, { view: "list", page: 1, page_size: 100 });
  const items = [...first.items];
  const totalPages = Math.min(10, Math.ceil(first.total / 100));
  if (totalPages > 1) {
    const rest = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, idx) =>
        bTasksApi.list(projectId, { view: "list", page: idx + 2, page_size: 100 }),
      ),
    );
    for (const page of rest) {
      items.push(...page.items);
    }
  }
  return { items, members: first.members, total: first.total };
}

async function fetchAllFeishuActivities(projectId: string): Promise<{ items: ActivityItem[]; total: number }> {
  const pageSize = 50;
  const first = await projectApi.activities(projectId, "feishu", { page: 1, page_size: pageSize });
  const items = [...first.items];
  const totalPages = Math.min(5, Math.ceil(first.total / pageSize));
  if (totalPages > 1) {
    const rest = await Promise.allSettled(
      Array.from({ length: totalPages - 1 }, (_, idx) =>
        projectApi.activities(projectId, "feishu", { page: idx + 2, page_size: pageSize }),
      ),
    );
    for (const page of rest) {
      if (page.status === "fulfilled") {
        items.push(...page.value.items);
      }
    }
  }
  return { items, total: first.total };
}

export async function fetchContributionAnalytics(projectId: string): Promise<ProjectContributionAnalytics> {
  const encodedId = encodeURIComponent(projectId);
  const [
    snapshotRes,
    tasksRes,
    contextRes,
    overviewRes,
    githubStatsRes,
    githubPrsRes,
    feishuInsightsRes,
    feishuActivitiesRes,
  ] = await Promise.allSettled([
    contributionRequest<ContributionSnapshot | null>(`/api/v1/projects/${encodedId}/contribution`),
    fetchAllProjectTasks(projectId),
    projectApi.projectContext(projectId),
    bProjectsApi.overview(projectId),
    projectRequest<GithubActivityStats>(`/api/v1/a/projects/${encodedId}/github/stats?range=all`),
    projectApi.activities(projectId, "github", { kind: "pull_request", page: 1, page_size: 50 }),
    projectRequest<FeishuCollaborationInsights>(`/api/v1/a/projects/${encodedId}/feishu/insights`),
    fetchAllFeishuActivities(projectId),
  ]);

  if (snapshotRes.status === "rejected") {
    throw snapshotRes.reason instanceof Error
      ? snapshotRes.reason
      : new CApiError(500, "INVALID_API_RESPONSE", "读取贡献数据失败", null);
  }

  const snapshot = snapshotRes.value;
  const tasksData = tasksRes.status === "fulfilled" ? tasksRes.value : { items: [], members: [], total: 0 };
  const context = contextRes.status === "fulfilled" ? contextRes.value : null;
  const overview: BProjectOverview | null = overviewRes.status === "fulfilled" ? overviewRes.value : null;
  const githubStats = githubStatsRes.status === "fulfilled" ? githubStatsRes.value : null;
  const githubPrItems: ActivityItem[] =
    githubPrsRes.status === "fulfilled" ? githubPrsRes.value.items : [];
  const feishuInsights = feishuInsightsRes.status === "fulfilled" ? feishuInsightsRes.value : null;
  const feishuActivities =
    feishuActivitiesRes.status === "fulfilled" ? feishuActivitiesRes.value : null;

  const projectName = context?.project?.name || overview?.name || "当前项目";

  // 1. Build canonical list of ALL active project members (never drop 0% formal members)
  const memberNameMap = new Map<string, string>();
  for (const m of context?.members ?? []) {
    if (m.id && m.title) memberNameMap.set(m.id, m.title);
  }
  for (const m of overview?.members ?? []) {
    if (m.id && !memberNameMap.has(m.id)) memberNameMap.set(m.id, m.name || "项目成员");
  }
  for (const m of snapshot?.members ?? []) {
    if (m.user_id && !memberNameMap.has(m.user_id)) memberNameMap.set(m.user_id, m.name || "项目成员");
  }
  for (const m of tasksData.members ?? []) {
    if (m.id && !memberNameMap.has(m.id)) memberNameMap.set(m.id, m.name || "项目成员");
  }
  if (memberNameMap.size === 0) {
    for (const t of tasksData.items) {
      for (const a of t.assignees) {
        if (a.id && !memberNameMap.has(a.id)) memberNameMap.set(a.id, a.name || "项目成员");
      }
    }
  }

  const snapshotByUser = new Map<string, ContributionSnapshotMember>();
  for (const item of snapshot?.members ?? []) {
    snapshotByUser.set(item.user_id, item);
  }

  // 2. Match GitHub contributors & PRs to canonical project members
  const memberIdsByName = new Map<string, string[]>();
  for (const [uid, name] of memberNameMap.entries()) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    const list = memberIdsByName.get(key) ?? [];
    list.push(uid);
    memberIdsByName.set(key, list);
  }

  const githubByUser = new Map<
    string,
    { commits: number; additions: number; deletions: number; filesChanged: number; login: string | null; lastCommitAt: string | null }
  >();
  let unmatchedCommits = 0;
  let unmatchedLines = 0;

  for (const contributor of githubStats?.contributors ?? []) {
    let targetUid = contributor.author_user_id && memberNameMap.has(contributor.author_user_id)
      ? contributor.author_user_id
      : null;
    if (!targetUid && contributor.author_name) {
      const matches = memberIdsByName.get(contributor.author_name.trim().toLowerCase()) ?? [];
      if (matches.length === 1) targetUid = matches[0];
    }
    if (!targetUid && contributor.author_login) {
      const matches = memberIdsByName.get(contributor.author_login.trim().toLowerCase()) ?? [];
      if (matches.length === 1) targetUid = matches[0];
    }
    if (!targetUid) {
      unmatchedCommits += contributor.commits;
      unmatchedLines += contributor.additions + contributor.deletions;
      continue;
    }
    const prev = githubByUser.get(targetUid) ?? {
      commits: 0,
      additions: 0,
      deletions: 0,
      filesChanged: 0,
      login: null,
      lastCommitAt: null,
    };
    const nextLastCommit =
      !prev.lastCommitAt || contributor.last_commit_at > prev.lastCommitAt
        ? contributor.last_commit_at
        : prev.lastCommitAt;
    githubByUser.set(targetUid, {
      commits: prev.commits + contributor.commits,
      additions: prev.additions + contributor.additions,
      deletions: prev.deletions + contributor.deletions,
      filesChanged: prev.filesChanged + contributor.files_changed,
      login: prev.login || contributor.author_login || null,
      lastCommitAt: nextLastCommit,
    });
  }

  const prsByUser = new Map<string, number>();
  for (const pr of githubPrItems) {
    let targetUid = pr.author_id && memberNameMap.has(pr.author_id) ? pr.author_id : null;
    if (!targetUid && pr.author_name) {
      const matches = memberIdsByName.get(pr.author_name.trim().toLowerCase()) ?? [];
      if (matches.length === 1) targetUid = matches[0];
    }
    if (targetUid) {
      prsByUser.set(targetUid, (prsByUser.get(targetUid) ?? 0) + 1);
    }
  }

  // 3. Task counts & status aggregation
  const taskStatusCounts: TaskStatusCounts = {
    completed: 0,
    pendingVerification: 0,
    inProgress: 0,
    pendingSubmission: 0,
    notStarted: 0,
    total: tasksData.items.length,
  };
  for (const t of tasksData.items) {
    if (t.status === "completed") taskStatusCounts.completed += 1;
    else if (t.status === "pending_verification") taskStatusCounts.pendingVerification += 1;
    else if (t.status === "pending_submission") taskStatusCounts.pendingSubmission += 1;
    else if (t.status === "in_progress") taskStatusCounts.inProgress += 1;
    else taskStatusCounts.notStarted += 1;
  }

  // 4. Pre-compute per-member tasks & Feishu collaboration attribution
  const orderedIds = Array.from(memberNameMap.keys());
  const assignedTasksByUser = new Map<string, BTaskRow[]>();
  const githubLoginByUser = new Map<string, string | null>();
  for (const uid of orderedIds) {
    assignedTasksByUser.set(
      uid,
      tasksData.items.filter((t) => t.assignees.some((a) => a.id === uid)),
    );
    githubLoginByUser.set(uid, githubByUser.get(uid)?.login ?? null);
  }

  const feishuByUser = resolveFeishuMemberAttribution({
    orderedIds,
    memberNameMap,
    assignedTasksByUser,
    githubLoginByUser,
    feishuInsights,
    feishuActivities: feishuActivities?.items ?? [],
  });

  // 5. Build rows for every active member
  const rawRows: Omit<MemberAnalyticsRow, "color" | "activityShare">[] = orderedIds.map((uid) => {
    const name = memberNameMap.get(uid) ?? "项目成员";
    const formal = snapshotByUser.get(uid);
    const assignedTasks = assignedTasksByUser.get(uid) ?? [];

    let completedCount = 0;
    let pendingVerificationCount = 0;
    let inProgressCount = 0;
    let pendingSubmissionCount = 0;
    let notStartedCount = 0;
    let assignedWeight = 0;
    let weightedSum = 0;
    let plainSum = 0;

    for (const t of assignedTasks) {
      if (t.status === "completed") completedCount += 1;
      else if (t.status === "pending_verification") pendingVerificationCount += 1;
      else if (t.status === "pending_submission") pendingSubmissionCount += 1;
      else if (t.status === "in_progress") inProgressCount += 1;
      else notStartedCount += 1;
      const w = Number(t.weight) > 0 ? Number(t.weight) : 0;
      assignedWeight += w;
      weightedSum += w * t.progress_percent;
      plainSum += t.progress_percent;
    }

    const weightedTaskProgress =
      assignedTasks.length === 0
        ? 0
        : assignedWeight > 0
          ? Math.round(weightedSum / assignedWeight)
          : Math.round(plainSum / assignedTasks.length);

    const gh = githubByUser.get(uid);
    const feishu = feishuByUser.get(uid) ?? { collabTopics: 0, collabRecords: 0, collabScore: 0 };

    return {
      userId: uid,
      name,
      formalShare: formal?.share ?? 0,
      taskCredit: formal?.task_credit ?? 0,
      formalTasks: formal?.tasks ?? [],
      assignedCount: assignedTasks.length,
      completedCount,
      pendingVerificationCount,
      inProgressCount,
      pendingSubmissionCount,
      notStartedCount,
      assignedWeight,
      weightedTaskProgress,
      assignedTasks,
      commits: gh?.commits ?? 0,
      additions: gh?.additions ?? 0,
      deletions: gh?.deletions ?? 0,
      filesChanged: gh?.filesChanged ?? 0,
      pullRequests: prsByUser.get(uid) ?? 0,
      githubLogin: gh?.login ?? null,
      lastCommitAt: gh?.lastCommitAt ?? null,
      collabTopics: feishu.collabTopics,
      collabRecords: feishu.collabRecords,
      collabScore: feishu.collabScore,
    };
  });

  // Sort members: formalShare desc, then taskCredit desc, then effective code volume desc, then weightedTaskProgress desc, then name
  const codeVolForRow = (r: Omit<MemberAnalyticsRow, "color" | "activityShare">) =>
    computeEffectiveCodeVolumeScore(r.additions, r.deletions);

  rawRows.sort((a, b) => {
    if (b.formalShare !== a.formalShare) return b.formalShare - a.formalShare;
    if (b.taskCredit !== a.taskCredit) return b.taskCredit - a.taskCredit;
    const volDiff = codeVolForRow(b) - codeVolForRow(a);
    if (volDiff !== 0) return volDiff;
    if (b.weightedTaskProgress !== a.weightedTaskProgress) {
      return b.weightedTaskProgress - a.weightedTaskProgress;
    }
    return a.name.localeCompare(b.name, "zh-CN");
  });

  // 6. Compute composite activity share:
  //    85% actual task delivery (formalShare with cross-task equal split, or weighted task progress fallback)
  //  + 15% repo-wide logarithmic engineering floor (Math.log1p(additions + 0.5 * deletions) for infra/refactors)
  //    0% commit count, 0% Feishu chat (process references only).
  //    Pure non-code projects automatically normalize to 100% task delivery share.
  const sumFormal = rawRows.reduce((acc, r) => acc + r.formalShare, 0);
  const taskWorks = rawRows.map((r) =>
    r.assignedCount > 0 ? Math.max(1, r.assignedWeight) * (r.weightedTaskProgress / 100) : 0,
  );
  const sumTaskWork = taskWorks.reduce((acc, v) => acc + v, 0);
  const taskDeliveryScores = rawRows.map((r, idx) =>
    sumFormal > 0 ? r.formalShare / sumFormal : sumTaskWork > 0 ? taskWorks[idx] / sumTaskWork : 0,
  );
  const hasTaskDelivery = sumFormal > 0 || sumTaskWork > 0;

  const codeVolumes = rawRows.map((r) => codeVolForRow(r));
  const sumCodeVolume = codeVolumes.reduce((acc, v) => acc + v, 0);
  const hasCodeVolume = sumCodeVolume > 0;

  const rawActivityScores = rawRows.map((_, idx) => {
    let weightedSum = 0;
    let weightTotal = 0;
    if (hasTaskDelivery) {
      weightedSum += 0.85 * taskDeliveryScores[idx];
      weightTotal += 0.85;
    }
    if (hasCodeVolume) {
      weightedSum += 0.15 * (codeVolumes[idx] / sumCodeVolume);
      weightTotal += 0.15;
    }
    return weightTotal > 0 ? weightedSum / weightTotal : 0;
  });
  const totalRawActivity = rawActivityScores.reduce((acc, v) => acc + v, 0);

  const members: MemberAnalyticsRow[] = rawRows.map((row, idx) => ({
    ...row,
    color: MEMBER_COLORS[idx % MEMBER_COLORS.length],
    activityShare:
      totalRawActivity > 0 ? Math.round((rawActivityScores[idx] / totalRawActivity) * 1000) / 10 : 0,
  }));

  const totalFormalCredit = members.reduce((acc, m) => acc + m.taskCredit, 0);
  const formalParticipantCount = members.filter((m) => m.formalShare > 0).length;
  const activeContributorCount = members.filter(
    (m) => m.formalShare > 0 || m.commits > 0 || m.assignedCount > 0 || m.collabScore > 0,
  ).length;

  const canCalculate = context ? context.actor.is_leader || context.actor.is_teacher : true;
  const canFreeze = context ? context.actor.is_leader || context.actor.is_teacher : true;

  return {
    projectId,
    projectName,
    snapshot,
    members,
    tasks: tasksData.items,
    taskStatusCounts,
    githubStats,
    feishuInsights,
    feishuTotalMessages: feishuInsights?.total_messages ?? feishuActivities?.total ?? 0,
    totalFormalCredit: Math.round(totalFormalCredit * 100) / 100,
    formalParticipantCount,
    activeContributorCount,
    totalCommits: githubStats?.total_commits ?? 0,
    totalAdditions: githubStats?.total_additions ?? 0,
    totalDeletions: githubStats?.total_deletions ?? 0,
    totalPullRequests: githubStats?.total_pull_requests ?? 0,
    unmatchedCommits,
    unmatchedLines,
    canCalculate,
    canFreeze,
  };
}
