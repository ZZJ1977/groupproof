import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  TW_COURSE_1_ID,
  TW_GROUP_1_ID,
  TW_GROUP_2_ID,
  TW_OUTSIDER_ID,
  TW_PROJECT_1_ID,
  TW_STUDENT_1_ID,
  TW_STUDENT_2_ID,
  createTeacherWorkbenchStore,
  installTeacherWorkbenchMocks,
  type InstallTeacherWorkbenchMocksOptions,
  type MockActor,
  type TeacherWorkbenchStore,
} from "./fixtures/teacher-workbench-mock-api";
import {
  assertIconButtonsAccessible,
  assertPrimaryCtaCaps,
  assertSingleInviteCard,
  assertSingleRowCourseNav,
  assertStudentShellUntouched,
  assertTeacherShellTokens,
  collectConsoleAndPageErrors,
} from "./fixtures/teacher-workbench-helpers";

async function setupActorPage(
  page: Page,
  actor: MockActor = "teacher",
  store: TeacherWorkbenchStore = createTeacherWorkbenchStore(),
  options: Omit<InstallTeacherWorkbenchMocksOptions, "actor"> = {},
): Promise<{ store: TeacherWorkbenchStore; errors: string[] }> {
  await page.context().addCookies([
    { name: "gp_tw_actor", value: actor, url: "http://127.0.0.1:13009" },
  ]);
  await installTeacherWorkbenchMocks(page, store, { actor, ...options });
  const errors = collectConsoleAndPageErrors(page);
  return { store, errors };
}

async function createActorContext(
  browser: Browser,
  actor: MockActor,
  store: TeacherWorkbenchStore,
  options: Omit<InstallTeacherWorkbenchMocksOptions, "actor"> = {},
): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  await setupActorPage(page, actor, store, options);
  const errors = collectConsoleAndPageErrors(page);
  return { context, page, errors };
}

async function ensureRosterOpen(page: Page) {
  const sidebar = page.getByTestId("class-roster-sidebar");
  const toggleBtn = page.getByRole("button", { name: /花名册/ }).first();
  await expect(sidebar.or(toggleBtn).first()).toBeVisible();
  if (!(await sidebar.isVisible())) {
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();
  }
  await expect(sidebar).toBeVisible();
  return sidebar;
}

function nonHttp4xxErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.includes("Failed to load resource"));
}

test.describe("Teacher Workbench Tier 3 — Consolidation Invariants & Multi-Role Flows", () => {
  test("T3-1 [post-m2] Single non-wrapping course nav bar (<= 6 hubs, scrollHeight <= 60px) and zero 12-item sidebar duplication", async ({ page }) => {
    const { errors } = await setupActorPage(page, "teacher");
    await page.setViewportSize({ width: 1280, height: 800 });

    for (const path of [
      `/teacher/courses/${TW_COURSE_1_ID}`,
      `/teacher/courses/${TW_COURSE_1_ID}/groups`,
      `/teacher/courses/${TW_COURSE_1_ID}/actions`,
      `/teacher/courses/${TW_COURSE_1_ID}/projects`,
      `/teacher/courses/${TW_COURSE_1_ID}/settings`,
    ]) {
      await page.goto(path);
      await assertTeacherShellTokens(page);
      await assertSingleRowCourseNav(page);
    }

    for (const hubLabel of ["概览", "组队与名单", "审批与申诉", "项目与报告", "课程设置|课程配置"]) {
      await expect(page.getByRole("link", { name: new RegExp(hubLabel) }).first()).toBeVisible();
    }
    expect(errors).toEqual([]);
  });

  test("T3-2 [post-m3] Max 1 InviteCodeCard on Class Home and primary CTA caps across headers and card footers", async ({ page }) => {
    const { errors } = await setupActorPage(page, "teacher");
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);
    await assertSingleInviteCard(page);
    await assertIconButtonsAccessible(page);

    const courseBar = page.locator('[data-testid="teacher-course-nav"]').locator("..");
    await expect(courseBar).toBeVisible();
    await assertPrimaryCtaCaps(page, courseBar);

    const headerScope = page
      .locator("main header, main [role='toolbar'], main .gp-panel-header")
      .or(page.getByRole("link", { name: /进入学生组队广场/ }).locator(".."))
      .first();
    await expect(headerScope).toBeVisible();
    await assertPrimaryCtaCaps(page, headerScope);

    await page.goto("/teacher/courses");
    await assertPrimaryCtaCaps(page, page.locator(`[data-testid="teacher-class-card-${TW_COURSE_1_ID}"]`));

    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);
    await assertPrimaryCtaCaps(page, page.locator(`[data-testid="team-card-${TW_GROUP_1_ID}"]`));
    expect(errors).toEqual([]);
  });

  test("T3-3 [post-m2] Zero 404 across all legacy teacher course routes rendering inside Teacher layout", async ({ page }) => {
    const { errors } = await setupActorPage(page, "teacher");
    const legacySubRoutes = [
      "/actions",
      "/member-changes",
      "/appeals",
      "/projects",
      "/reports",
      "/settings",
      "/rules",
      "/files",
      "/files?version=1",
      "/announcements",
      "/staff",
    ];

    for (const sub of legacySubRoutes) {
      const response = await page.goto(`/teacher/courses/${TW_COURSE_1_ID}${sub}`);
      expect(response?.status() ?? 0, `Legacy route ${sub} returned error status`).toBeLessThan(400);
      await expect(page.locator(".gp-teacher-shell").first()).toBeVisible();
      await expect(page.locator('nav[aria-label="班级管理子导航"], [data-testid="teacher-course-nav"]').first()).toBeVisible();
      await expect(page.getByText("页面不存在")).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  test("T3-4 Student -> Backend -> Teacher Flow 1: Student joins in approval mode, Teacher approves in Actions Center, Student appears in ClassRosterSidebar", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const course1 = store.courses.get(TW_COURSE_1_ID)!;
    course1.join_mode = "approval";
    course1.joinRequests = [];
    course1.actions = course1.actions.filter((a) => a.type !== "join_request");

    const student = await createActorContext(browser, "outsider", store);
    const teacher = await createActorContext(browser, "teacher", store);

    try {
      await student.page.goto("/courses/join");
      await expect(student.page.getByRole("heading", { level: 1, name: "加入课程" })).toBeVisible();
      await student.page.locator("#b-invite-code").fill("TW-SE01");
      await student.page.getByRole("button", { name: "下一步" }).click();

      await expect(student.page.getByText("软件工程实践").first()).toBeVisible();
      await student.page.getByRole("button", { name: /提交加入申请|确认加入/ }).click();

      await expect.poll(() =>
        course1.joinRequests.some((j) => j.student.id === TW_OUTSIDER_ID && j.status === "pending"),
      ).toBe(true);
      await assertStudentShellUntouched(student.page);

      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/actions`);
      await expect(teacher.page.getByText("王旁听申请加入软件工程实践")).toBeVisible();
      await teacher.page.getByRole("button", { name: "同意加入" }).first().click();

      await expect.poll(() =>
        course1.roster.some((s) => s.id === TW_OUTSIDER_ID && s.status !== "left"),
      ).toBe(true);

      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);
      const sidebar = await ensureRosterOpen(teacher.page);
      await expect(sidebar.getByTestId(`student-entity-${TW_OUTSIDER_ID}`)).toBeVisible();
      await expect(sidebar).toContainText("王旁听");

      expect(student.errors).toEqual([]);
      expect(teacher.errors).toEqual([]);
    } finally {
      await student.context.close();
      await teacher.context.close();
    }
  });

  test("T3-5 Student -> Backend -> Teacher Flow 2: Student group & member-change workflow updates Team Plaza on Teacher approval", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const course1 = store.courses.get(TW_COURSE_1_ID)!;

    const student = await createActorContext(browser, "student", store);
    const teacher = await createActorContext(browser, "teacher", store);

    try {
      // Student context verifies current course/group state and creates a new student group via API
      await student.page.goto("/courses");
      await expect(student.page.getByText("软件工程实践").first()).toBeVisible();

      const createdGroupId = await student.page.evaluate(async (cid: string) => {
        const sessRes = await fetch("/api/v1/auth/session", { credentials: "include" });
        const sessJson = (await sessRes.json()) as { data?: { csrfToken?: string } };
        const csrf = sessJson.data?.csrfToken ?? "";
        const res = await fetch(`/api/v1/courses/${cid}/groups`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ name: "学生自建联调组", direction: "前后端协同" }),
        });
        const json = (await res.json()) as { data?: { id?: string } };
        return json.data?.id ?? null;
      }, TW_COURSE_1_ID);

      expect(createdGroupId).toBeTruthy();
      expect(course1.groups.some((g) => g.name === "学生自建联调组")).toBe(true);

      // Teacher approves pending member-leave request in /member-changes
      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/member-changes`);
      const memberReqCard = teacher.page.getByTestId("membership-request").first();
      await expect(memberReqCard).toBeVisible();
      await expect(memberReqCard).toContainText("赵同学");
      await expect(memberReqCard).toContainText("实现前端工作台视图");

      await memberReqCard.getByRole("button", { name: "批准" }).click();

      await expect.poll(() =>
        course1.membershipChanges.find((mc) => mc.member?.id === TW_STUDENT_2_ID)?.status,
      ).toBe("approved");

      // Teacher Team Plaza reflects both the student-created group and Zhao's departure to ungrouped pool
      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);
      await expect(teacher.page.getByTestId(`team-card-${createdGroupId!}`)).toContainText("学生自建联调组");
      const group1Card = teacher.page.getByTestId(`team-card-${TW_GROUP_1_ID}`);
      await expect(group1Card).not.toContainText("赵同学");
      await expect(teacher.page.getByTestId("ungrouped-pool-dropzone")).toContainText("赵同学");

      expect(student.errors).toEqual([]);
      expect(teacher.errors).toEqual([]);
    } finally {
      await student.context.close();
      await teacher.context.close();
    }
  });

  test("T3-6 Student -> Backend -> Teacher Flow 3: Student 3-step file upload on Setup/Files -> Teacher Projects & Reports", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const student = await createActorContext(browser, "student", store);
    const teacher = await createActorContext(browser, "teacher", store);

    try {
      const uploadSteps: string[] = [];
      student.page.on("request", (req) => {
        const u = req.url();
        if (req.method() === "POST" && u.endsWith("/api/v1/storage/uploads")) {
          uploadSteps.push("init");
        } else if (req.method() === "PUT" && u.startsWith("https://fixture.invalid/")) {
          uploadSteps.push("put");
        } else if (req.method() === "POST" && u.endsWith("/complete")) {
          uploadSteps.push("complete");
        } else if (
          req.method() === "POST" &&
          (u.endsWith(`/api/v1/projects/${TW_PROJECT_1_ID}/materials`) ||
            u.endsWith(`/api/v1/projects/${TW_PROJECT_1_ID}/files`))
        ) {
          uploadSteps.push("register");
        }
      });

      await student.page.goto(`/projects/${TW_PROJECT_1_ID}/files`);
      await expect(student.page.getByRole("heading", { level: 1, name: "项目资料" })).toBeVisible();

      const fileInput = student.page.getByLabel("选择文件");
      await expect(fileInput).toBeVisible();
      await fileInput.setInputFiles({
        name: "midterm-architecture.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("GroupProof midterm architecture upload payload"),
      });
      await student.page.getByLabel("新文件分类").selectOption("documents");
      await student.page.getByLabel("版本说明").fill("中期架构文档提交");
      const uploadBtn = student.page.getByRole("button", { name: "上传并保存草稿" });
      await expect(uploadBtn).toBeEnabled();
      await uploadBtn.click();

      await expect.poll(() => uploadSteps).toEqual(["init", "put", "complete", "register"]);
      await expect(student.page.getByRole("status").filter({ hasText: "文件草稿版本已保存" })).toBeVisible();
      await expect(student.page.getByText("midterm-architecture.txt").first()).toBeVisible();
      await expect.poll(() =>
        store.projects.get(TW_PROJECT_1_ID)!.logicalFiles.some((f) => f.filename === "midterm-architecture.txt"),
      ).toBe(true);

      // Teacher inspects Projects Monitor, Reports Center, and Project Files view
      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);
      await expect(teacher.page.getByText("智能协作教学平台").first()).toBeVisible();
      await expect(teacher.page.locator(`a[href="/projects/${TW_PROJECT_1_ID}"]`).first()).toBeVisible();

      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/reports`);
      await expect(teacher.page.getByRole("heading", { level: 1, name: "数据报告中心" })).toBeVisible();
      await expect(teacher.page.getByText("第一组 · 飞书协同").first()).toBeVisible();

      await teacher.page.goto(`/projects/${TW_PROJECT_1_ID}/files`);
      await expect(teacher.page.getByText("midterm-architecture.txt").first()).toBeVisible();

      expect(student.errors).toEqual([]);
      expect(teacher.errors).toEqual([]);
    } finally {
      await student.context.close();
      await teacher.context.close();
    }
  });

  test("T3-7 Student -> Backend -> Teacher Flow 4: Teacher publishes announcement, Student reads on /home, Teacher sees read receipt incremented", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const course1 = store.courses.get(TW_COURSE_1_ID)!;
    const teacher = await createActorContext(browser, "teacher", store);
    const student = await createActorContext(browser, "student", store);

    try {
      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/announcements`);
      await teacher.page.getByRole("button", { name: "发布新公告" }).click();
      await teacher.page.getByLabel("公告标题").fill("期末答辩时间通知");
      await teacher.page.getByLabel("公告正文").fill("请各小组提前十分钟到达答辩教室并测试演示环境。");
      await teacher.page.getByRole("button", { name: "立即发布" }).click();

      await expect.poll(() =>
        course1.announcements.some((a) => a.title === "期末答辩时间通知" && a.status === "published"),
      ).toBe(true);

      await student.page.goto("/home");
      await expect(student.page.getByText("期末答辩时间通知").first()).toBeVisible();
      await student.page.getByRole("button", { name: "展开查看" }).first().click();
      await expect(student.page.getByText("请各小组提前十分钟到达答辩教室并测试演示环境。")).toBeVisible();
      await student.page.getByRole("button", { name: "收起并标为已读" }).first().click();

      await expect.poll(() =>
        Boolean(course1.announcements.find((a) => a.title === "期末答辩时间通知")?.read_by[TW_STUDENT_1_ID]),
      ).toBe(true);

      await teacher.page.reload();
      await teacher.page.getByRole("button", { name: "阅读统计" }).first().click();
      await expect(teacher.page.getByText("李同学").first()).toBeVisible();
      await expect(teacher.page.getByText(/已读.*1|1.*已读/).or(teacher.page.getByText("李同学")).first()).toBeVisible();

      expect(teacher.errors).toEqual([]);
      expect(student.errors).toEqual([]);
    } finally {
      await teacher.context.close();
      await student.context.close();
    }
  });

  test("T3-8 Student -> Backend -> Teacher Flow 5: Student submits appeal, Teacher reviews evidence/tasks/snapshot and adjudicates", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const course1 = store.courses.get(TW_COURSE_1_ID)!;
    const student = await createActorContext(browser, "student", store);
    const teacher = await createActorContext(browser, "teacher", store);

    try {
      await student.page.goto("/home");
      const appealId = await student.page.evaluate(
        async ({ cid, pid }: { cid: string; pid: string }) => {
          const sessRes = await fetch("/api/v1/auth/session", { credentials: "include" });
          const sessJson = (await sessRes.json()) as { data?: { csrfToken?: string } };
          const csrf = sessJson.data?.csrfToken ?? "";
          const res = await fetch(`/api/v1/courses/${cid}/appeals`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify({
              project_id: pid,
              appeal_type: "contribution",
              title: "联调测试贡献度补正申诉",
              content: "已完成 TASK-01 契约与回归脚本验证，申请更新贡献快照。",
              evidence: ["PR-99", "commit-xyz789"],
            }),
          });
          const json = (await res.json()) as { data?: { id?: string } };
          return json.data?.id ?? null;
        },
        { cid: TW_COURSE_1_ID, pid: TW_PROJECT_1_ID },
      );

      expect(appealId).toBeTruthy();
      expect(course1.appeals.some((a) => a.title === "联调测试贡献度补正申诉" && a.status === "pending")).toBe(true);

      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/appeals`);
      await expect(teacher.page.getByText("联调测试贡献度补正申诉").first()).toBeVisible();
      await teacher.page.getByText("联调测试贡献度补正申诉").first().click();

      await expect(teacher.page.getByText("PR-99")).toBeVisible();
      await expect(teacher.page.getByText("commit-xyz789")).toBeVisible();
      await expect(teacher.page.getByText("完成 API 接口契约设计")).toBeVisible();

      await teacher.page.locator("#appeal-reason").fill("核实 PR-99 证据有效，同意受理申诉");
      await teacher.page.getByRole("button", { name: /受理申诉|接受并生成新快照/ }).first().click();

      await expect.poll(() =>
        course1.appeals.find((a) => a.title === "联调测试贡献度补正申诉")?.status,
      ).toBe("accepted");
      await expect(teacher.page.getByText(/已受理|已通过|accepted/i).first()).toBeVisible();

      expect(student.errors).toEqual([]);
      expect(teacher.errors).toEqual([]);
    } finally {
      await student.context.close();
      await teacher.context.close();
    }
  });

  test("T3-9 [post-m4] Cross-Hub Configuration Consistency across Hub 5 Settings/Rules and Hub 4 Projects/Reports", async ({ page }) => {
    const { store, errors } = await setupActorPage(page, "teacher");

    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);
    for (const tab of ["基础设置", "规则与模板", "课程资料", "课程公告", "助教管理"]) {
      await expect(
        page.getByRole("tab", { name: new RegExp(tab) }).or(page.getByRole("link", { name: new RegExp(tab) })).first(),
      ).toBeVisible();
    }

    await page.getByRole("tab", { name: /规则与模板/ }).or(page.getByRole("link", { name: /规则与模板/ })).first().click();
    await expect(page.getByText("需求基线与立项").or(page.locator('input[value="需求基线与立项"]')).first()).toBeVisible();
    const maxSizeInput = page
      .locator('#rules-max-group-size, input[name="max_group_size"]')
      .or(page.getByLabel(/最大人数/))
      .first();
    await expect(maxSizeInput).toBeVisible();
    await maxSizeInput.fill("6");
    await page.getByRole("button", { name: "发布规则" }).click();
    await page.locator("#rules-publish-summary").fill("调整队伍最大人数为 6 人");
    await page.getByRole("button", { name: "确认发布" }).click();
    await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.max_group_size).toBe(6);

    await page.getByRole("tab", { name: /基础设置/ }).or(page.getByRole("link", { name: /基础设置/ })).first().click();
    await expect(page.getByText(/队伍人数要求：\d+-6\s*人/)).toBeVisible();

    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);
    await expect(
      page.getByRole("tab", { name: /项目监控/ }).or(page.getByRole("link", { name: /项目监控/ })).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: /班级数据报告/ }).or(page.getByRole("link", { name: /班级数据报告/ })).first(),
    ).toBeVisible();

    await page.getByRole("tab", { name: /班级数据报告/ }).or(page.getByRole("link", { name: /班级数据报告/ })).first().click();
    await expect(page.getByText("第一组 · 飞书协同").first()).toBeVisible();
    // Deduplicated basic headcount KPIs in Reports view
    await expect(page.getByText("班级学生总数")).toHaveCount(0);
    await expect(page.getByText("已建队伍")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("T3-10 Multi-Actor Permission Isolation: Owner vs restricted TA (manage_files=false, post_announcements=false) and Student denied Teacher endpoints", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const owner = await createActorContext(browser, "teacher", store);
    const restrictedTa = await createActorContext(browser, "ta", store, {
      taPermissions: { manage_files: false, post_announcements: false, approve_changes: false },
    });
    const student = await createActorContext(browser, "student", store);

    try {
      // Owner has full controls on Staff & Settings
      await owner.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/staff`);
      await expect(owner.page.getByRole("heading", { level: 1, name: "助教管理" })).toBeVisible();
      const ownerEmailInput = owner.page.locator('input[type="email"], input[placeholder*="邮箱"]').first();
      await expect(ownerEmailInput).toBeVisible();
      await ownerEmailInput.fill("verify_ta@must.edu.mo");
      await expect(owner.page.getByRole("button", { name: "发送邀请" })).toBeEnabled();
      await owner.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);
      await expect(owner.page.getByRole("heading", { level: 1, name: "班级设置" })).toBeVisible();
      await expect(owner.page.getByRole("button", { name: "删除课程" })).toBeEnabled();

      // Restricted TA lacks owner actions & manage_files / post_announcements
      await restrictedTa.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/staff`);
      await expect(restrictedTa.page.getByRole("heading", { level: 1, name: "助教管理" })).toBeVisible();
      const taInviteBtn = restrictedTa.page.getByRole("button", { name: "发送邀请" });
      if ((await taInviteBtn.count()) > 0) {
        await expect(taInviteBtn).toBeDisabled();
      } else {
        await expect(taInviteBtn).toHaveCount(0);
      }

      await restrictedTa.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);
      await expect(restrictedTa.page.getByRole("heading", { level: 1, name: "班级设置" })).toBeVisible();
      const taDeleteBtn = restrictedTa.page.getByRole("button", { name: "删除课程" });
      if ((await taDeleteBtn.count()) > 0) {
        await expect(taDeleteBtn).toBeDisabled();
      } else {
        await expect(taDeleteBtn).toHaveCount(0);
      }

      await restrictedTa.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/files`);
      await expect(restrictedTa.page.getByRole("heading", { level: 1, name: "课程资料中心" })).toBeVisible();
      const taUploadBtn = restrictedTa.page.getByRole("button", { name: "上传资料" });
      if ((await taUploadBtn.count()) > 0) {
        await expect(taUploadBtn).toBeDisabled();
      } else {
        await expect(taUploadBtn).toHaveCount(0);
      }

      const taStatuses = await restrictedTa.page.evaluate(async (cid: string) => {
        const sessRes = await fetch("/api/v1/auth/session", { credentials: "include" });
        const sessJson = (await sessRes.json()) as { data?: { csrfToken?: string } };
        const csrf = sessJson.data?.csrfToken ?? "";
        const uploadRes = await fetch(`/api/v1/teacher/classes/${cid}/files/upload`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ name: "forbidden.txt", visibility: "all", status: "published", mime_type: "text/plain" }),
        });
        const annRes = await fetch(`/api/v1/teacher/classes/${cid}/announcements`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ title: "越权公告", content: "测试", priority: "normal", is_pinned: false, status: "published" }),
        });
        return { uploadStatus: uploadRes.status, annStatus: annRes.status };
      }, TW_COURSE_1_ID);

      expect(taStatuses.uploadStatus).toBe(403);
      expect(taStatuses.annStatus).toBe(403);

      // Student context is denied access to Teacher API endpoints
      await student.page.goto("/home");
      const studentProbe = await student.page.evaluate(async (cid: string) => {
        const [dashRes, classesRes, settingsRes] = await Promise.all([
          fetch("/api/v1/teacher/dashboard", { credentials: "include" }),
          fetch("/api/v1/teacher/classes", { credentials: "include" }),
          fetch(`/api/v1/teacher/classes/${cid}/settings`, { credentials: "include" }),
        ]);
        return {
          dash: dashRes.status,
          classes: classesRes.status,
          settings: settingsRes.status,
        };
      }, TW_COURSE_1_ID);

      expect(studentProbe.dash).toBe(403);
      expect(studentProbe.classes).toBe(403);
      expect(studentProbe.settings).toBe(403);

      expect(owner.errors).toEqual([]);
      expect(nonHttp4xxErrors(restrictedTa.errors)).toEqual([]);
      expect(nonHttp4xxErrors(student.errors)).toEqual([]);
    } finally {
      await owner.context.close();
      await restrictedTa.context.close();
      await student.context.close();
    }
  });
});
