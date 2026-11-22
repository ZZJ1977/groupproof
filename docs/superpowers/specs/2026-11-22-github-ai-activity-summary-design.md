# 通用 Git 活动 AI 摘要与分层交互设计

## 1. 背景

当前 GitHub 开发活动页主要展示提交、Pull Request 和 CI 的原始记录。原始记录适合作为证据，但不适合作为项目进展的第一阅读层：用户需要自己阅读提交信息、PR 正文和 diff，才能判断一次提交到底完成了什么。

本设计将“原始活动”与“AI 解释”分层：

- 第一层是简略摘要，快速回答“谁提交了什么”；
- 第二层是详情，解释实现范围、影响、验证、风险和证据；
- 原始提交、PR、分支和 CI 只作为可展开的来源证据；
- AI 结果是建议，始终标记为待人工确认。

提示词不绑定 GroupProof、某个仓库或某种任务编号，而是面向任意软件项目的通用模板。当前先接入 GitHub 提交，后续可复用于其他代码托管平台或活动来源。

## 2. 目标与非目标

### 目标

1. 让列表卡片在不展开详情时就能看到提交者和实现内容。
2. 让 AI 只根据提交 diff、测试/CI 证据和可选上下文总结，不把 PR 计划当成已完成事实。
3. 让用户可以按需生成单条摘要，也可以批量生成当前页摘要。
4. 以来源版本和提示词版本缓存结果，避免重复调用，并能在源内容变化后重新生成。
5. 在 AI 不可用、上下文不足或结果不可信时，保留原始记录和人工处理路径。
6. 通过结构化 JSON 和服务端校验，阻止不存在的文件路径、测试结果和无证据结论进入页面。

### 非目标

1. 本次不让 AI 自动修改代码、关闭 PR、采纳证据或改变任务状态。
2. 本次不把 AI 生成的文字写入正式需求、任务或证据正文。
3. 本次不在 GitHub 同步事务中强制调用 AI；同步与摘要生成解耦。
4. 本次不要求 AI 对所有历史 PR 重新解释；首期以提交活动为主，PR/CI 继续作为来源活动和证据展示。

## 3. 术语与规范化输入

提示词接收一个平台无关的 `ActivityAnalysisInput`。GitHub 适配器负责把提交详情转换为该结构，其他平台只需实现同样的适配器。

```json
{
  "source": {
    "provider": "github",
    "repository": "owner/repository",
    "branch": "default-branch",
    "activity_type": "commit",
    "activity_id": "immutable-source-id",
    "source_url": "https://...",
    "occurred_at": "2026-11-22T00:00:00Z"
  },
  "actor": {
    "display_name": "提交者显示名",
    "login": "provider-login",
    "member_id": null
  },
  "change": {
    "revision": "source-revision-or-hash",
    "parent_revision": "...",
    "message": "原始提交说明",
    "files": [
      {
        "path": "relative/path.ts",
        "status": "added|modified|deleted|renamed",
        "additions": 10,
        "deletions": 2,
        "patch": "unified diff or null"
      }
    ],
    "diff_truncated": false,
    "files_truncated": false
  },
  "context": {
    "linked_change_request": {
      "title": "可选的 PR/MR 标题",
      "body": "可选正文",
      "number": null
    },
    "known_tasks": [],
    "verification": {
      "tests": [],
      "ci_runs": [],
      "deployments": []
    }
  },
  "policy": {
    "language": "zh-CN",
    "max_detail_items": 6,
    "prompt_version": "activity-summary.v1"
  }
}
```

约束：

- `change` 是主要事实来源；PR/MR 正文只是辅助上下文。
- `patch` 可能为空或被截断，AI 必须据此降低结论强度。
- 传给 AI 前由服务端进行长度限制和常见凭据脱敏；GitHub token、应用私钥和环境变量不进入输入。
- 适配器不把项目特定术语写入系统提示词；任务号、模块名等只能作为输入上下文传入。

## 4. 通用提示词模板

### 4.1 系统提示词

```text
你是一个跨项目的软件工程变更分析助手。

你的职责不是播报 Pull Request，也不是评价开发者，而是根据一项代码活动的可验证输入，解释：
1. 谁完成了这次变更；
2. 这次变更实际实现或改变了什么；
3. 哪些模块、行为或交付流程受到影响；
4. 哪些验证有证据支持；
5. 哪些风险、未知项或结论需要人工确认。

事实规则：
- 只能使用输入中的提交元数据、文件差异、测试/CI 记录和明确提供的上下文。
- 代码 diff 是“已实现内容”的主要证据；变更请求正文只能作为辅助背景。
- 不得把“计划、要求、待办、PR 描述”改写成“已经实现”。
- 不得凭空补充不存在的文件、接口、测试、性能、用户行为或业务收益。
- 每条 confirmed 或 inferred 结论都必须引用 evidence id。
- confirmed 表示能从 diff、测试或 CI 直接确认；inferred 表示有限的代码结构推断；
  unavailable 表示输入没有足够证据。证据不足时必须保留 unavailable。
- 如果 diff 被截断、文件列表不完整或无法判断行为，明确说明上下文不足，不要猜测。
- 提交者必须从 actor 字段读取；不要把 PR 作者、评论者或合并者误当成提交者。
- 输出只允许是符合要求的 JSON，不要输出 Markdown、前言或代码围栏。
- 所有结果都需要人工复核，needs_human_review 必须为 true。
```

### 4.2 请求模板

```text
请分析下面的规范化代码活动输入，并严格按照输出 schema 返回 JSON：

<activity_input>
{{ACTIVITY_ANALYSIS_INPUT_JSON}}
</activity_input>

重点：列表摘要必须能让用户快速知道“{{ACTOR_DISPLAY_NAME}} 实现了什么”。
如果实现内容无法从证据中可靠确认，请明确返回证据不足，而不是复述提交标题或 PR 正文。
```

### 4.3 输出 schema

```json
{
  "actor": {
    "display_name": "提交者名称",
    "login": "提交者账号或 null"
  },
  "brief": {
    "headline": "不超过 80 字；说明这次提交实际完成了什么",
    "implementation": "不超过 160 字；列表卡片使用的核心实现摘要",
    "certainty": "confirmed|inferred|unavailable",
    "evidence_ids": ["e1"]
  },
  "details": {
    "implementation_points": [
      {
        "statement": "一个具体实现点",
        "certainty": "confirmed|inferred|unavailable",
        "evidence_ids": ["e1"]
      }
    ],
    "affected_areas": ["frontend|backend|database|api|auth|tests|deployment|docs|other"],
    "user_or_team_impact": {
      "statement": "对用户、团队或交付流程的影响",
      "certainty": "confirmed|inferred|unavailable",
      "evidence_ids": ["e2"]
    },
    "verification": [
      {
        "statement": "验证事实",
        "result": "passed|failed|partial|not_provided",
        "evidence_ids": ["e3"]
      }
    ],
    "risk_flags": [
      {
        "statement": "风险或待确认事项",
        "severity": "low|medium|high",
        "evidence_ids": ["e4"]
      }
    ],
    "task_relation": {
      "matched_task": "任务标识或 null",
      "certainty": "confirmed|inferred|unavailable",
      "evidence_ids": []
    }
  },
  "evidence": [
    {
      "id": "e1",
      "path": "relative/path.ts",
      "location": "diff hunk、行号或测试名称",
      "reason": "该证据支持的结论"
    }
  ],
  "confidence": 0.0,
  "needs_human_review": true,
  "insufficient_context": false,
  "insufficient_context_reason": null
}
```

### 4.4 二次校验提示词

```text
请校验上一份 AI 摘要 JSON：

1. brief.actor 是否与输入 actor 完全一致；
2. brief.implementation 是否描述代码实际变化，而不是只复述标题或 PR 计划；
3. 每个 evidence id 是否存在，且 path/location 是否来自输入；
4. confirmed 是否确实有 diff、测试或 CI 证据；
5. 是否把测试通过夸大为整个功能正确；
6. 是否出现输入中不存在的文件、接口、性能或业务结论；
7. diff 不完整时是否正确标记 insufficient_context；
8. needs_human_review 是否仍为 true。

有问题时只返回修正后的合法 JSON；没有问题时原样返回合法 JSON。
```

## 5. 生成、缓存与失效策略（方案 A）

### 5.1 生成时机

- 活动同步只保存原始来源，不调用 AI。
- 用户可在单条卡片上点击“生成摘要”。
- 页面提供“总结当前页活动”，对当前筛选结果提交批量请求。
- 批量请求由服务端限制并发，建议初始并发上限为 3；单条失败不影响其他记录。

### 5.2 缓存键

摘要缓存键为：

```text
(activity_id, source_revision, prompt_version, normalized_input_hash)
```

同一键已有 `ready` 结果时直接返回，不重复调用 AI。`failed` 结果保留错误原因，但允许用户主动重试。

### 5.3 源内容变化

- GitHub 同步发现 `source_revision` 改变时，旧摘要标记为 `stale`，不删除。
- 详情页可以继续查看旧摘要及对应的旧证据，同时提供“重新生成”。
- 提示词版本变化不会覆盖旧结果；新版本首次请求时生成新缓存。

### 5.4 建议的数据表

新增独立的 `GithubActivitySummary`（或平台无关的 `ActivitySummary`）表，避免污染原始活动快照：

- `id`
- `activity_id`
- `source_revision`
- `prompt_version`
- `input_hash`
- `status`: `pending|ready|failed|stale`
- `result` JSONB
- `provider`
- `model`
- `error_code` / `error_message`
- `created_at` / `updated_at` / `generated_at`

原始活动仍是事实来源；摘要表是可重建的派生数据。

## 6. API 与页面交互

### 6.1 API 形状

在现有 GitHub 活动接口上增加摘要状态，不改变原始活动字段的语义：

- `GET /a/projects/{project_id}/github/activity`
  - 列表项增加 `summary_status`、`brief`（仅 ready 时返回）和 `summary_id`。
- `POST /a/projects/{project_id}/github/activity/{activity_id}/summary`
  - 单条生成或重试；返回摘要状态和结果。
- `POST /a/projects/{project_id}/github/activity/summaries`
  - 接收当前筛选条件或活动 ID 列表；返回已接受、已命中缓存和失败的明细。
- `GET /a/projects/{project_id}/github/activity/{activity_id}/summary`
  - 读取完整详情、证据和生成元数据。

所有接口复用现有项目成员权限和只读来源权限；生成摘要不能改变活动处理状态。

### 6.2 简略版列表卡片

每条 GitHub 提交卡片只显示：

1. 提交者名称和 GitHub 登录名；
2. AI 标签及状态（未生成、生成中、已生成、失败、待复核）；
3. `brief.headline` 或 `brief.implementation`；
4. 提交时间、提交类型、关联任务（如果已有）；
5. 一个主要操作：`生成摘要`、`查看详情` 或 `重新生成`。

未生成时保留简短的原始提交标题作为占位，但必须明确标记“尚未生成 AI 摘要”，不得伪装成 AI 结论。

### 6.3 详情版

详情抽屉或详情面板按以下顺序展示：

1. 提交者和一句话结论；
2. 具体实现点；
3. 影响范围；
4. 验证结果；
5. 风险和待人工确认；
6. 置信度与生成信息；
7. 证据列表（文件、diff 区块、测试/CI）；
8. 折叠的原始提交、PR、分支和来源链接；
9. 现有活动处理历史与关联操作。

详情默认不把完整 PR 正文铺开，用户主动展开“原始来源”后才读取或显示。

### 6.5 视觉与布局方向

本次页面不采用“每个区块都是带边框白色大卡片”的默认模板。信息层级优先通过排版、留白、背景色和轻量分隔建立：

- 页面使用开放式画布和单一主内容流；筛选、批量操作和状态提示放在紧凑工具栏，不再各自包一层面板。
- 活动列表使用时间线/分组列表语义：日期、提交者、实现摘要和状态标签形成连续阅读节奏；相邻记录用细分隔线或留白区分。
- 只有需要聚焦的详情、证据和确认操作使用侧栏、抽屉或局部浮层；原始来源使用折叠 disclosure，而不是默认展开的大框。
- 颜色只表达语义状态（AI 生成、待确认、风险、失败、过期），不把所有区域染成相同的浅灰边框。
- 主要操作保持一个明确的视觉主次关系：页面级批量生成是主操作，单条生成/查看详情是内联操作，原始来源是低强调链接。
- 移动端将摘要内容、提交者和主要操作保持在同一纵向流中；详情从底部抽屉或全宽展开区打开，避免横向卡片溢出。
- 重点信息的首屏顺序固定为“提交者 → 实现内容 → AI 状态/时间”，而不是“面板标题 → 大量元数据 → 按钮”。

这些决策参考了成熟产品的共同模式：GitHub Desktop 将提交列表与选中提交的 diff 分层；GitLab 将 Overview、Commits、Pipelines 和 Changes 分开；Linear Pulse 使用连续更新流和可保存筛选；Vercel 将状态、分支、提交、作者和时间压缩在可筛选列表行中。GroupProof 借鉴“扫描层 + 证据层”的信息结构，不直接复制这些产品的视觉皮肤。

### 6.4 状态与错误

- `not_generated`: 显示“生成摘要”，不阻塞查看原始来源。
- `pending`: 显示进度，禁止重复提交。
- `ready`: 显示简略摘要和详情入口。
- `failed`: 显示可理解的失败原因和“重试”，保留原始来源。
- `stale`: 提示来源已更新，旧摘要仅供参考，提供重新生成。
- `insufficient_context`: 明确说明缺少 diff 或验证信息，不能用标题替代结论。
- `AI_UNAVAILABLE` 或超时：不影响 GitHub 活动同步和人工浏览。

## 7. 服务端校验与安全

1. Pydantic schema 校验枚举、长度、置信度范围和必填字段。
2. 验证所有 evidence id、路径和位置只能引用本次输入；不存在时整份结果视为不可用。
3. 服务端在调用供应商前截断超长 diff、脱敏常见 token/私钥/密码模式，并记录脱敏统计而不记录原文秘密。
4. 不把 GitHub App token、Feishu token、环境变量或内部数据库字段放入提示词。
5. AI 结果和原始来源分开存储；页面明确展示“AI 生成 / 待人工确认”。
6. 批量接口采用项目权限、并发限制和幂等键，避免重复点击产生重复调用。

## 8. 验收标准

### 功能

- 列表卡片在已生成时同时显示提交者和“实现了什么”。
- 点击详情可以看到实现点、影响、验证、风险和证据。
- 原始 PR/提交信息默认折叠，仍可访问。
- 单条生成、当前页批量生成、失败重试和来源变更后的重新生成可用。
- AI 不可用时，GitHub 同步、原始活动浏览和现有人工处理功能仍可用。

### 质量

- 提示词不包含 GroupProof、特定仓库名、特定任务编号或固定业务词汇。
- AI 输出无法引用不存在的文件或测试；无证据结论被拒绝或标记为 unavailable。
- 缓存命中不重复调用；源版本或提示词版本变化能正确失效。
- 页面窄屏下简略卡片仍能看到提交者、实现摘要和主要操作。

### 测试

- 单元测试：规范化输入、提示词版本、缓存键、证据引用校验和失败降级。
- API 测试：单条生成、批量生成、权限、幂等、缓存命中和 stale 状态。
- 前端测试：未生成/生成中/成功/失败/证据不足/来源变更六种状态，以及列表到详情的交互。
- 回归检查：`npm run lint`、`npm run typecheck`、`npm run build`、`npm run check:routes`；后端运行相关 ruff 与 pytest。

## 9. 首期范围决策

本次实现先覆盖 GitHub `commit` 活动的按需 AI 摘要；Pull Request 与 CI 继续作为原始活动和证据展示，并保留未来通过关联提交生成摘要的扩展点。这样既满足“每个提交实现了什么”的核心目标，也不会把不同类型的来源强行套成同一种叙事。
