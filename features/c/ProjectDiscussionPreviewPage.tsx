"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Hash,
  MessageSquare,
  Paperclip,
  Send,
  Settings,
  Sparkles,
  Users,
} from "lucide-react";
import { Avatar, Feedback, PageHeader, StatusBadge } from "@/components/common";
import { apiMode } from "@/lib/api/config";
import { tr } from "@/lib/i18n/tr";
import { useWorkspace } from "@/lib/workspace";
import {
  accessFailure,
  apiButton,
  ApiFailure,
  apiPrimaryButton,
  isUuid,
  projectApi,
  queryPolicy,
} from "./c-project-api";

type ChannelId = "general" | "api-sync" | "acceptance";

type PreviewMessage = {
  id: string;
  senderName: string;
  senderRole?: string;
  isSelf?: boolean;
  isLocalPreview?: boolean;
  time: string;
  divider?: string;
  text: string;
  linkedTask?: string;
  attachment?: { name: string; size: string };
};

type PreviewInsight = {
  id: string;
  category: string;
  statusLabel: string;
  statusTone: "green" | "blue" | "amber";
  linkedTask: string;
  summary: string;
};

type PreviewChannel = {
  id: ChannelId;
  name: string;
  description: string;
  unreadCount: number;
  messages: PreviewMessage[];
  aiCard: {
    title: string;
    summary: string;
    linkedTask: string;
  };
  insights: PreviewInsight[];
};

type MemberSlot = {
  name: string;
  role: string;
  color: string;
  online?: boolean;
};

const DEFAULT_MEMBERS: MemberSlot[] = [
  { name: "林同学", role: "组长", color: "#dbeafe", online: true },
  { name: "陈同学", role: "成员", color: "#dcfce7", online: true },
  { name: "周同学", role: "成员", color: "#fef3c7", online: true },
  { name: "吴同学", role: "成员", color: "#f3e8ff", online: false },
];

const MEMBER_COLORS = ["#dbeafe", "#dcfce7", "#fef3c7", "#f3e8ff", "#fee2e2", "#e0f2fe"];

function buildChannels(members: MemberSlot[]): PreviewChannel[] {
  const lead = members[0]?.name ?? "林同学";
  const fe = members[1]?.name ?? "陈同学";
  const be = members[2]?.name ?? "周同学";
  const leadRole = members[0]?.role ?? "组长";
  const feRole = members[1]?.role ?? "成员";
  const beRole = members[2]?.role ?? "成员";

  return [
    {
      id: "general",
      name: "项目主群",
      description: "日常同步与分工确认",
      unreadCount: 2,
      messages: [
        {
          id: "g-1",
          senderName: lead,
          senderRole: leadRole,
          time: "10:15",
          divider: "今天 10:15",
          text: "大家早，我把本周接口对齐与鉴权模块的初步拆分草案发群里，麻烦前端和后端同学确认一下边界。",
          linkedTask: "#T-12 登录鉴权联调",
          attachment: { name: "模块接口草案_v2.pdf", size: "1.4 MB" },
        },
        {
          id: "g-2",
          senderName: fe,
          senderRole: feRole,
          time: "10:18",
          text: "收到，页面登录态与重定向逻辑我这边按 v2 草案对齐，下午可以开始联调。",
        },
        {
          id: "g-3",
          senderName: be,
          senderRole: beRole,
          time: "10:21",
          text: "OK，回调校验与测试用例我已推到开发分支，联调环境随时可用。",
          linkedTask: "#T-12 登录鉴权联调",
        },
        {
          id: "g-4",
          senderName: "我",
          isSelf: true,
          time: "10:24",
          text: "明白，我下午两点把联调记录和接口截图同步上来，方便后续整理验收证据。",
        },
      ],
      aiCard: {
        title: "检测到分工确认与任务推进信号",
        summary: "AI 识别到 3 位成员已确认 #T-12 登录鉴权联调 接口方案并进入联调阶段，建议可沉淀为候选进度证据（仍需人工确认）。",
        linkedTask: "#T-12 登录鉴权联调",
      },
      insights: [
        {
          id: "ins-g-1",
          category: "分工确认",
          statusLabel: "已达成",
          statusTone: "green",
          linkedTask: "#T-12 登录鉴权联调",
          summary: "前后端成员均已明确回复确认 v2 接口草案边界，具备团队分工确认依据。",
        },
        {
          id: "ins-g-2",
          category: "候选证据",
          statusLabel: "待人工确认",
          statusTone: "amber",
          linkedTask: "#T-12 登录鉴权联调",
          summary: "群内含方案附件与测试分支推进说明，可在确认后关联至任务验收标准。",
        },
      ],
    },
    {
      id: "api-sync",
      name: "需求与接口联调",
      description: "前后端联调、方案确认",
      unreadCount: 0,
      messages: [
        {
          id: "a-1",
          senderName: be,
          senderRole: beRole,
          time: "昨天 16:40",
          divider: "昨天 16:40",
          text: "任务列表筛选接口已经补充了按里程碑和需求过滤的字段，响应字段与文档一致。",
          linkedTask: "#T-08 任务筛选接口",
        },
        {
          id: "a-2",
          senderName: fe,
          senderRole: feRole,
          time: "昨天 16:45",
          text: "已对接完成，边界情况如空列表和权限受限提示都验证过了。",
        },
        {
          id: "a-3",
          senderName: "我",
          isSelf: true,
          time: "昨天 16:52",
          text: "那这部分契约先冻结，不再改动字段命名。",
        },
      ],
      aiCard: {
        title: "检测到接口契约定稿决策",
        summary: "AI 从对话中识别出前后端对筛选接口字段达成一致并决定冻结契约，可关联到对应任务。",
        linkedTask: "#T-08 任务筛选接口",
      },
      insights: [
        {
          id: "ins-a-1",
          category: "团队决策",
          statusLabel: "已达成",
          statusTone: "green",
          linkedTask: "#T-08 任务筛选接口",
          summary: "成员就筛选接口字段命名达成共识，已确认完成边界验证。",
        },
        {
          id: "ins-a-2",
          category: "任务推进",
          statusLabel: "推进中",
          statusTone: "blue",
          linkedTask: "#T-08 任务筛选接口",
          summary: "联调验证完成后可补充截图或 PR 记录作为最终验收依据。",
        },
      ],
    },
    {
      id: "acceptance",
      name: "验收与证据归档",
      description: "交付物核对、里程碑检查",
      unreadCount: 1,
      messages: [
        {
          id: "c-1",
          senderName: lead,
          senderRole: leadRole,
          time: "11:05",
          divider: "今天 11:05",
          text: "本周末前需要完成第二阶段里程碑材料汇总，请各位把各自任务的说明和截图补齐。",
          linkedTask: "#M-02 中期交付检查",
        },
        {
          id: "c-2",
          senderName: fe,
          senderRole: feRole,
          time: "11:09",
          text: "响应式检查结果已经导出一份清单，我整理好后会贴出来。",
          attachment: { name: "移动端自检清单.xlsx", size: "420 KB" },
        },
      ],
      aiCard: {
        title: "检测到里程碑材料收集提醒",
        summary: "AI 已标记本周里程碑材料归档诉求，提示正式证据仍需在证据中心完成人工核验确认。",
        linkedTask: "#M-02 中期交付检查",
      },
      insights: [
        {
          id: "ins-c-1",
          category: "任务推进",
          statusLabel: "推进中",
          statusTone: "blue",
          linkedTask: "#M-02 中期交付检查",
          summary: "成员正在汇总移动端自检清单与任务说明，准备提交阶段验收。",
        },
        {
          id: "ins-c-2",
          category: "待跟进风险",
          statusLabel: "待跟进",
          statusTone: "amber",
          linkedTask: "#M-02 中期交付检查",
          summary: "仍需等待所有成员补齐各自任务的正式证据并在证据中心人工确认。",
        },
      ],
    },
  ];
}


type SidecarTab = "insights" | "members";

export function ProjectDiscussionPreviewPage({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName?: string;
}) {
  const { userId } = useWorkspace();
  const contextEnabled = apiMode("cworkspace") === "real" && isUuid(projectId);
  const context = useQuery({
    queryKey: ["c-project-context", userId, projectId],
    queryFn: () => projectApi.projectContext(projectId),
    enabled: contextEnabled,
    ...queryPolicy,
  });

  const [activeChannelId, setActiveChannelId] = useState<ChannelId>("general");
  const [composerText, setComposerText] = useState("");
  const [localMessages, setLocalMessages] = useState<Record<ChannelId, PreviewMessage[]>>({
    general: [],
    "api-sync": [],
    acceptance: [],
  });
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);
  const [showMobileInsights, setShowMobileInsights] = useState(false);
  const [sidecarTab, setSidecarTab] = useState<SidecarTab>("insights");

  // Real project members only: the context endpoint lists active student members and
  // exposes the actor's own leader flag, so a role is "组长" only when it is verified
  // (the current user is the leader); everyone else is shown as "成员". Never a teacher.
  const memberSlots = useMemo<MemberSlot[]>(() => {
    const apiMembers = context.data?.members ?? [];
    if (!apiMembers.length) return DEFAULT_MEMBERS;
    const leaderId = context.data?.actor.is_leader ? context.data.actor.id : null;
    const slots = apiMembers.map((member, index) => ({
      name: member.title,
      role: member.id === leaderId ? "组长" : "成员",
      color: MEMBER_COLORS[index % MEMBER_COLORS.length],
    }));
    return [...slots.filter((slot) => slot.role === "组长"), ...slots.filter((slot) => slot.role !== "组长")];
  }, [context.data]);

  const channels = useMemo(() => buildChannels(memberSlots), [memberSlots]);
  const activeChannel = channels.find((item) => item.id === activeChannelId) ?? channels[0];
  const visibleMessages = useMemo(
    () => [...activeChannel.messages, ...(localMessages[activeChannel.id] ?? [])],
    [activeChannel, localMessages],
  );

  if (contextEnabled && accessFailure(context.error)) {
    return (
      <>
        <PageHeader title="项目讨论区" />
        <ApiFailure error={context.error} retry={() => void context.refetch()} />
      </>
    );
  }

  const displayProjectName = projectName ?? context.data?.project.name;
  const memberCount = memberSlots.length;
  const collaborationHref = `/projects/${projectId}/collaboration`;
  const feishuSettingsHref = `/projects/${projectId}/settings#feishu-integration`;

  function handleSendPreview(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = composerText.trim();
    if (!trimmed) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const entry: PreviewMessage = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      senderName: "我",
      isSelf: true,
      isLocalPreview: true,
      time: `${hh}:${mm}`,
      text: trimmed,
    };
    setLocalMessages((prev) => ({
      ...prev,
      [activeChannel.id]: [...(prev[activeChannel.id] ?? []), entry],
    }));
    setComposerText("");
    setPreviewNotice("已添加本地预览消息：本页面为前端交互预览，刷新后不会保留，也不会发送给其他成员。");
  }

  function handlePlaceholderFeature(featureName: string) {
    setPreviewNotice(
      tr("「{0}」将随站内实时群聊正式版开放；当前可先在输入框发送本地预览消息，或前往「协作记录」同步飞书群聊。", {
        0: featureName,
      }),
    );
  }

  const sidecarContent = (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="讨论区侧栏" className="flex shrink-0 gap-1 rounded-lg bg-slate-100 p-0.5">
        {(
          [
            { id: "insights", label: "AI 洞察" },
            { id: "members", label: tr("群成员 ({0})", { 0: memberCount }) },
          ] as { id: SidecarTab; label: string }[]
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sidecarTab === tab.id}
            onClick={() => setSidecarTab(tab.id)}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${
              sidecarTab === tab.id ? "bg-white text-slate-900 shadow-2xs" : "text-slate-500 hover:text-slate-800"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="mt-2.5 min-h-0 flex-1 overflow-y-auto pr-0.5">
        {sidecarTab === "insights" ? (
          <div className="space-y-2">
            {activeChannel.insights.map((insight) => (
              <div key={insight.id} className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="gp-pill">{insight.category}</span>
                  <StatusBadge label={insight.statusLabel} tone={insight.statusTone} />
                </div>
                <p className="mt-1.5 text-xs leading-5 text-slate-700">{insight.summary}</p>
                <div className="mt-1 text-[11px] font-medium text-sky-700">{insight.linkedTask}</div>
              </div>
            ))}
            <p className="text-[11px] leading-4 text-slate-400">
              AI 识别仅用于辅助沉淀进度线索，正式任务验收仍需人工确认。
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {memberSlots.map((member, index) => (
              <div
                key={`${member.name}-${index}`}
                className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 hover:bg-slate-50"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Avatar name={member.name} color={member.color} size={24} />
                  <span className="truncate text-xs font-semibold text-slate-800">{member.name}</span>
                  <span className="shrink-0 rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                    {member.role}
                  </span>
                </div>
                {member.online !== undefined && (
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${member.online ? "bg-emerald-500" : "bg-slate-300"}`}
                    aria-hidden="true"
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <section
        aria-label="讨论区开发状态说明"
        className="flex flex-col gap-2 rounded-2xl border border-sky-200/80 bg-gradient-to-r from-sky-50/90 via-white to-slate-50/80 px-4 py-3 shadow-2xs lg:flex-row lg:items-center lg:justify-between"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold text-slate-900">项目讨论区</h1>
            <StatusBadge label="功能开发中" tone="amber" />
            <StatusBadge label="飞书同步已可用" tone="green" />
          </div>
          {displayProjectName && (
            <p className="gp-page-description mt-0.5 truncate text-xs text-slate-500">
              {displayProjectName}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Link href={feishuSettingsHref} className={apiButton}>
            <Settings size={14} />
            配置飞书群接入
          </Link>
          <Link href={collaborationHref} className={apiPrimaryButton}>
            <MessageSquare size={14} />
            前往飞书协作记录
          </Link>
        </div>
      </section>

      <section
        aria-label="项目群聊界面预览"
        className="flex flex-col overflow-hidden rounded-2xl border border-slate-200/85 bg-white shadow-xs lg:h-[calc(100vh-175px)] lg:max-h-[680px] lg:min-h-[500px]"
      >
        {/* Mobile / tablet channel switcher */}
        <div className="border-b border-slate-200/80 bg-slate-50/80 p-3 lg:hidden">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700">项目群聊频道（界面预览）</span>
            <Link href={collaborationHref} className="text-xs font-medium text-sky-700 hover:underline">
              去飞书协作记录 →
            </Link>
          </div>
          <div className="flex flex-wrap gap-2">
            {channels.map((channel) => {
              const active = channel.id === activeChannel.id;
              return (
                <button
                  key={channel.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setActiveChannelId(channel.id);
                    setPreviewNotice(null);
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition ${
                    active
                      ? "border-sky-300 bg-sky-50 text-sky-800"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <Hash size={12} />
                  <span>{channel.name}</span>
                  {channel.unreadCount > 0 && (
                    <span className="rounded-full bg-sky-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                      {channel.unreadCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[210px_minmax(0,1fr)] lg:grid-rows-1 xl:grid-cols-[210px_minmax(0,1fr)_280px]">
          {/* Left rail: Channels */}
          <aside className="hidden min-h-0 flex-col border-r border-slate-200/80 bg-slate-50/70 lg:flex">
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              <div className="flex items-center justify-between gap-2 px-1">
                <span className="text-xs font-semibold text-slate-500">项目群聊频道</span>
                <span className="gp-pill">界面预览</span>
              </div>
              <div className="space-y-1">
                {channels.map((channel) => {
                  const active = channel.id === activeChannel.id;
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setActiveChannelId(channel.id);
                        setPreviewNotice(null);
                      }}
                      className={`flex w-full items-start justify-between gap-2 rounded-xl border px-2.5 py-2 text-left transition ${
                        active
                          ? "border-sky-200/90 bg-sky-50/90 text-sky-900 shadow-2xs"
                          : "border-transparent bg-transparent text-slate-700 hover:bg-white/80"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-sm font-semibold">
                          <Hash size={14} className={active ? "shrink-0 text-sky-600" : "shrink-0 text-slate-400"} />
                          <span className="truncate">{channel.name}</span>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-slate-500">{channel.description}</p>
                      </div>
                      {channel.unreadCount > 0 && (
                        <span className="mt-0.5 rounded-full bg-sky-600 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                          {channel.unreadCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="shrink-0 border-t border-slate-200/80 bg-white/70 px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <MessageSquare size={13} className="text-emerald-600" />
                飞书项目群 · 实际同步渠道
              </div>
              <Link
                href={collaborationHref}
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-sky-700 hover:underline"
              >
                打开协作记录
                <ArrowRight size={12} />
              </Link>
            </div>
          </aside>

          {/* Center canvas: Conversation */}
          <div className="flex min-h-0 min-w-0 flex-col bg-white">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200/80 px-4 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <h2 className="text-sm font-semibold text-slate-900">{activeChannel.name}</h2>
                <span className="gp-pill">前端预览 · 示例数据</span>
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <Users size={12} />
                  {tr("{0} 位成员", { 0: memberCount })}
                </span>
              </div>
              <button
                type="button"
                className={`${apiButton} xl:hidden`}
                onClick={() => setShowMobileInsights((prev) => !prev)}
                aria-expanded={showMobileInsights}
              >
                <Sparkles size={14} className="text-sky-600" />
                <span>AI 识别与成员</span>
                {showMobileInsights ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>

            {showMobileInsights && (
              <div className="h-60 shrink-0 border-b border-slate-200/80 bg-white p-3 xl:hidden">{sidecarContent}</div>
            )}

            <div className="max-h-[60vh] min-h-[240px] flex-1 space-y-3 overflow-y-auto bg-slate-50/55 px-4 py-4 lg:max-h-none lg:min-h-0">
              {visibleMessages.map((msg) => (
                <div key={msg.id} className="space-y-2">
                  {msg.divider && (
                    <div className="flex justify-center">
                      <span className="rounded-full border border-slate-200/80 bg-white/90 px-3 py-0.5 text-[11px] font-medium text-slate-400">
                        {msg.divider}
                      </span>
                    </div>
                  )}

                  {msg.isSelf ? (
                    <div className="flex justify-end">
                      <div className="flex max-w-[88%] flex-col items-end gap-1 sm:max-w-[78%]">
                        <div className="flex items-center gap-2 text-[11px] text-slate-400">
                          {msg.isLocalPreview && (
                            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                              本地预览 · 刷新后不保留
                            </span>
                          )}
                          <span>{msg.time}</span>
                          <span className="font-medium text-slate-600">{msg.senderName}</span>
                        </div>
                        <div className="break-words rounded-2xl rounded-tr-sm bg-[var(--gp-action)] px-3 py-2 text-sm leading-6 text-white shadow-2xs">
                          {msg.text}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2.5">
                      <Avatar name={msg.senderName} size={28} />
                      <div className="min-w-0 max-w-[88%] space-y-1 sm:max-w-[78%]">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="font-semibold text-slate-800">{msg.senderName}</span>
                          {msg.senderRole && (
                            <span className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                              {msg.senderRole}
                            </span>
                          )}
                          <span className="text-[11px] text-slate-400">{msg.time}</span>
                        </div>
                        <div className="break-words rounded-2xl rounded-tl-sm border border-slate-200/85 bg-white px-3 py-2 text-sm leading-6 text-slate-800 shadow-2xs">
                          <p>{msg.text}</p>
                          {(msg.linkedTask || msg.attachment) && (
                            <div className="mt-2 flex flex-wrap gap-2 border-t border-slate-100 pt-2">
                              {msg.linkedTask && (
                                <span className="inline-flex items-center rounded-md bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                                  {msg.linkedTask}
                                </span>
                              )}
                              {msg.attachment && (
                                <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-700">
                                  <Paperclip size={12} className="text-slate-400" />
                                  <span className="font-medium">{msg.attachment.name}</span>
                                  <span className="text-slate-400">{msg.attachment.size}</span>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Inline AI Progress & Evidence Assistant Preview Card */}
              <div className="rounded-2xl border border-sky-200/85 bg-gradient-to-br from-sky-50/95 via-white to-slate-50 p-3 shadow-2xs">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white">
                      <Sparkles size={13} />
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">GroupProof AI 进度助手</span>
                        <span className="gp-pill">自动识别预览</span>
                      </div>
                      <p className="text-xs text-slate-500">{activeChannel.aiCard.title}</p>
                    </div>
                  </div>
                  <span className="rounded-md bg-sky-100/80 px-2 py-0.5 text-xs font-medium text-sky-800">
                    {activeChannel.aiCard.linkedTask}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-700">{activeChannel.aiCard.summary}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-sky-700"
                    onClick={() => handlePlaceholderFeature("群聊一键沉淀候选证据")}
                  >
                    <Sparkles size={12} className="text-sky-600" />
                    预览采证说明
                  </button>
                  <Link href={collaborationHref} className="text-xs font-semibold text-sky-700 hover:underline">
                    去飞书协作记录体验真实分析 →
                  </Link>
                </div>
              </div>
            </div>

            {/* Pinned compact composer */}
            <div className="shrink-0 border-t border-slate-200/80 bg-white px-3 py-2.5">
              {previewNotice && (
                <div className="mb-2">
                  <Feedback tone="info">{previewNotice}</Feedback>
                </div>
              )}
              <form className="flex items-center gap-2" onSubmit={handleSendPreview}>
                <button
                  type="button"
                  title="关联任务"
                  aria-label="关联任务"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200/80 bg-slate-50 text-slate-600 transition hover:bg-slate-100"
                  onClick={() => handlePlaceholderFeature("# 关联任务")}
                >
                  <Hash size={14} />
                </button>
                <button
                  type="button"
                  title="发送文件"
                  aria-label="发送文件"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200/80 bg-slate-50 text-slate-600 transition hover:bg-slate-100"
                  onClick={() => handlePlaceholderFeature("发送文件与附件")}
                >
                  <Paperclip size={14} />
                </button>
                <input
                  type="text"
                  value={composerText}
                  maxLength={500}
                  onChange={(event) => setComposerText(event.target.value)}
                  placeholder="输入消息体验对话界面（仅本地预览，不会发送至服务端）…"
                  aria-label="输入预览消息"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50/70 px-3 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/15"
                />
                <button type="submit" disabled={!composerText.trim()} className={apiPrimaryButton}>
                  <Send size={14} />
                  发送预览
                </button>
              </form>
            </div>
          </div>

          {/* Right sidecar on desktop xl */}
          <aside className="hidden min-h-0 border-l border-slate-200/80 bg-white p-3 xl:block">{sidecarContent}</aside>
        </div>
      </section>
    </div>
  );
}
