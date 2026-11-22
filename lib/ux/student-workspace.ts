export type ProjectNavItem = {
  label: string;
  href: string;
  iconKey: string;
};

export type ProjectNavGroup = {
  id: "overview" | "plan" | "collaborate" | "review" | "settings";
  label: string;
  items: ProjectNavItem[];
};

export function projectNavGroups(projectId: string): ProjectNavGroup[] {
  const base = `/projects/${projectId}`;
  return [
    {
      id: "overview",
      label: "overviewGroup",
      items: [{ label: "overview", href: base, iconKey: "folder" }],
    },
    {
      id: "plan",
      label: "planGroup",
      items: [
        { label: "requirements", href: `${base}/requirements`, iconKey: "fileText" },
        { label: "planning", href: `${base}/planning`, iconKey: "clipboardList" },
        { label: "tasks", href: `${base}/tasks?view=tree`, iconKey: "listTree" },
        { label: "milestones", href: `${base}/milestones`, iconKey: "fileCheck" },
      ],
    },
    {
      id: "collaborate",
      label: "collaborateGroup",
      items: [
        { label: "GitHub", href: `${base}/github`, iconKey: "gitBranch" },
        { label: "collaboration", href: `${base}/collaboration`, iconKey: "messageSquare" },
        { label: "files", href: `${base}/files`, iconKey: "folder" },
        { label: "discussions", href: `${base}/discussions`, iconKey: "messageSquare" },
      ],
    },
    {
      id: "review",
      label: "reviewGroup",
      items: [
        { label: "evidence", href: `${base}/evidence`, iconKey: "shieldCheck" },
        { label: "contribution", href: `${base}/contribution`, iconKey: "users" },
        { label: "reports", href: `${base}/reports`, iconKey: "fileText" },
      ],
    },
    {
      id: "settings",
      label: "settingsGroup",
      items: [{ label: "settings", href: `${base}/settings`, iconKey: "settings" }],
    },
  ];
}

export type SetupCardStatus = "not_started" | "in_progress" | "complete" | "required" | "unavailable" | "attention";
export type SetupCardId = "details" | "members" | "github" | "feishu" | "materials" | "requirements" | "conflicts" | "baseline" | "plan";

export type SetupCardInput = {
  projectId: string;
  kind: "independent" | "course";
  detailsComplete: boolean;
  memberCount: number;
  githubBindings: number;
  feishuBindings: number;
  materialCount: number;
  requirementCount: number;
  moduleCount: number;
  unresolvedConflictCount: number;
  baselineStarted: boolean;
  baselineFrozen: boolean;
  hasPlan: boolean;
  githubRequired?: boolean;
  githubAvailable?: boolean;
  feishuAvailable?: boolean;
};

export type SetupCard = {
  id: SetupCardId;
  title: string;
  description: string;
  href: string;
  actionLabel: string;
  status: SetupCardStatus;
  required: boolean;
};

function integrationStatus(count: number, available: boolean, required: boolean): SetupCardStatus {
  if (!available) return "unavailable";
  if (count > 0) return "complete";
  return required ? "required" : "not_started";
}

export function buildSetupCards(input: SetupCardInput): SetupCard[] {
  const base = `/projects/${input.projectId}`;
  const course = input.kind === "course";
  const cards: SetupCard[] = [
    {
      id: "details",
      title: "项目信息",
      description: input.detailsComplete ? "名称和项目说明已就绪。" : "补充项目说明、类型和时间安排。",
      href: `${base}/setup#project-details`,
      actionLabel: input.detailsComplete ? "查看设置" : "完善信息",
      status: input.detailsComplete ? "complete" : course ? "required" : "in_progress",
      required: course,
    },
    {
      id: "members",
      title: "项目成员",
      description: input.memberCount > 1 ? `已有 ${input.memberCount} 位成员。` : "当前为个人项目，可随时邀请协作者。",
      href: `${base}#project-members`,
      actionLabel: "管理成员",
      status: input.memberCount > 0 ? "complete" : "required",
      required: true,
    },
    {
      id: "github",
      title: "GitHub 仓库",
      description: input.githubBindings > 0 ? `已连接 ${input.githubBindings} 个仓库。` : "绑定仓库后同步提交、PR 和 CI 活动。",
      href: `${base}/settings#github-integration`,
      actionLabel: input.githubBindings > 0 ? "管理 GitHub 仓库" : "绑定 GitHub 仓库",
      status: integrationStatus(input.githubBindings, input.githubAvailable !== false, course && input.githubRequired === true),
      required: course && input.githubRequired === true,
    },
    {
      id: "feishu",
      title: "飞书群聊",
      description: input.feishuBindings > 0 ? `已连接 ${input.feishuBindings} 个群聊。` : "接入项目群，沉淀可追溯的协作记录。",
      href: `${base}/settings#feishu-integration`,
      actionLabel: input.feishuBindings > 0 ? "管理飞书群" : "接入飞书群",
      status: integrationStatus(input.feishuBindings, input.feishuAvailable !== false, false),
      required: false,
    },
    {
      id: "materials",
      title: "项目资料",
      description: input.materialCount > 0 ? `已保存 ${input.materialCount} 份可追溯资料。` : "添加课程要求、需求说明或项目文件。",
      href: `${base}/setup#project-materials`,
      actionLabel: input.materialCount > 0 ? "查看资料" : "添加资料",
      status: input.materialCount > 0 ? "complete" : "not_started",
      required: false,
    },
    {
      id: "requirements",
      title: "需求与模块",
      description: input.requirementCount > 0 && input.moduleCount > 0
        ? `已整理 ${input.requirementCount} 条需求和 ${input.moduleCount} 个模块。`
        : "手动整理需求，或从资料中辅助提取。",
      href: `${base}/requirements`,
      actionLabel: input.requirementCount > 0 ? "管理需求" : "开始整理",
      status: input.requirementCount > 0 && input.moduleCount > 0 ? "complete" : course ? "required" : "not_started",
      required: course,
    },
  ];

  if (input.unresolvedConflictCount > 0) {
    cards.push({
      id: "conflicts",
      title: "待处理冲突",
      description: `${input.unresolvedConflictCount} 项资料内容需要确定采用版本。`,
      href: `${base}/requirements?section=conflicts`,
      actionLabel: "处理冲突",
      status: "attention",
      required: course,
    });
  }

  cards.push(
    {
      id: "baseline",
      title: "需求基线",
      description: input.baselineFrozen
        ? "正式需求版本已经冻结。"
        : course ? "课程项目需由团队确认正式需求范围。" : "需要正式版本时，可选择冻结当前需求。",
      href: `${base}/requirements?section=baseline`,
      actionLabel: input.baselineFrozen ? "查看基线" : input.baselineStarted ? "继续确认" : "查看基线选项",
      status: input.baselineFrozen ? "complete" : input.baselineStarted ? "in_progress" : course ? "required" : "not_started",
      required: course,
    },
    {
      id: "plan",
      title: "任务计划",
      description: input.hasPlan ? "任务结构已经建立。" : "拆分任务、负责人、里程碑和验收标准。",
      href: `${base}/planning`,
      actionLabel: input.hasPlan ? "查看计划" : "制定计划",
      status: input.hasPlan ? "complete" : "not_started",
      required: false,
    },
  );
  return cards;
}
