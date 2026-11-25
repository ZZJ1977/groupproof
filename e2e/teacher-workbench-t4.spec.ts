import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  TW_COURSE_1_ID,
  TW_COURSE_2_ID,
  TW_GROUP_1_ID,
  TW_GROUP_2_ID,
  TW_OUTSIDER_ID,
  TW_PROJECT_1_ID,
  TW_STUDENT_1_ID,
  TW_STUDENT_2_ID,
  TW_STUDENT_3_ID,
  createTeacherWorkbenchStore,
  installTeacherWorkbenchMocks,
  type InstallTeacherWorkbenchMocksOptions,
  type MockActor,
  type TeacherWorkbenchStore,
} from "./fixtures/teacher-workbench-mock-api";
import {
  assertIconButtonsAccessible,
  assertMotionAndReducedMotion,
  assertNoHorizontalOverflow,
  assertPrimaryCtaCaps,
  assertSheetMotionEnabled,
  assertSingleInviteCard,
  assertSingleRowCourseNav,
  assertStudentShellUntouched,
  assertTabularNums,
  assertTeacherShellTokens,
  assertToolbarButtonRadiusConsistent,
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

test.describe("Teacher Workbench Tier 4 — Real-World Scenarios & Checklists A-D Gate", () => {
  test("T4-1 [post-m4] Scenario 1: Teacher Full Course Lifecycle (Create Class in Sheet -> Rules & Templates -> Announcement -> Material -> End & Reopen)", async ({ page }) => {
    const { store, errors } = await setupActorPage(page, "teacher");
    await page.setViewportSize({ width: 1280, height: 800 });

    // 1. Create Class inside Sheet drawer on /teacher/courses
    await page.goto("/teacher/courses");
    await page.getByRole("button", { name: "创建班级" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await sheet.locator("#create-class-name").fill("云原生工程实训");
    await sheet.locator("#create-class-term").fill("2026-Autumn");
    await sheet.locator("#create-class-college").fill("计算机学院");
    await sheet.locator("#create-class-code").fill("CN-2026-09");
    await sheet.locator("#create-class-min-size").fill("2");
    await sheet.locator("#create-class-max-size").fill("5");
    await sheet.locator("#create-class-project-deadline").fill("2027-01-20T23:59");
    await sheet.getByRole("button", { name: "确认创建并生成邀请码" }).click();

    await expect(page.getByTestId("newly-created-class-banner")).toBeVisible();
    const createdCourse = Array.from(store.courses.values()).find((c) => c.code === "CN-2026-09");
    expect(createdCourse).toBeDefined();
    const newCourseId = createdCourse!.id;

    // 2. Verify Hub 5 sub-tabs, dirty SaveState tracking, and Rules & Templates publish via Esc-dismissible Sheet
    await page.goto(`/teacher/courses/${newCourseId}/settings`);
    for (const tabLabel of ["基础设置", "规则与模板", "课程资料", "课程公告", "助教管理"]) {
      await expect(
        page
          .getByRole("tab", { name: new RegExp(tabLabel) })
          .or(page.getByRole("link", { name: new RegExp(tabLabel) }))
          .first(),
      ).toBeVisible();
    }
    const descInput = page.locator("#settings-desc, textarea").first();
    await expect(descInput).toBeVisible();
    await descInput.fill("云原生工程实训补充说明");
    await expect(page.getByText(/未保存|待保存/)).toBeVisible();
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page.locator(".gp-save-state").filter({ hasText: /已保存/ })).toBeVisible();

    await page
      .getByRole("tab", { name: /规则与模板/ })
      .or(page.getByRole("link", { name: /规则与模板/ }))
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1, name: /课程规则/ })).toBeVisible();
    const addMilestoneBtn = page.getByRole("button", { name: /添加里程碑|新增阶段/ }).first();
    await expect(addMilestoneBtn).toBeVisible();
    await addMilestoneBtn.click();
    await expect(
      page.locator('input[value*="阶段里程碑"]').or(page.getByText(/阶段里程碑/)).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "发布规则" }).click();
    const pubSheet = page.getByRole("dialog");
    await expect(pubSheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pubSheet).toHaveCount(0);

    await page.getByRole("button", { name: "发布规则" }).click();
    await expect(pubSheet).toBeVisible();
    await pubSheet.locator("#rules-publish-summary").fill("发布初始实训规则与里程碑模板");
    await pubSheet.getByRole("button", { name: "确认发布" }).click();
    await expect.poll(() => store.courses.get(newCourseId)?.publishedRuleVersion?.version_no).toBe(1);

    // 3. Publish Announcement via Hub 5 tab
    await page
      .getByRole("tab", { name: /课程公告/ })
      .or(page.getByRole("link", { name: /课程公告/ }))
      .first()
      .click();
    await page.getByRole("button", { name: "发布新公告" }).click();
    await page.getByLabel("公告标题").fill("开课第一周安排");
    await page.getByLabel("公告正文").fill("请完成组队并阅读课程实验大纲。");
    await page.getByRole("button", { name: "立即发布" }).click();
    await expect.poll(() =>
      store.courses.get(newCourseId)?.announcements.some((a) => a.title === "开课第一周安排" && a.status === "published"),
    ).toBe(true);

    // 4. Upload Course Material & verify 2-step delete confirmation (Cancel vs Confirm) in Hub 5
    await page
      .getByRole("tab", { name: /课程资料/ })
      .or(page.getByRole("link", { name: /课程资料/ }))
      .first()
      .click();
    await page.getByRole("button", { name: "上传资料" }).click();
    await page.locator('input[type="file"]').first().setInputFiles({
      name: "cloud-native-syllabus.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Cloud Native Course Syllabus"),
    });
    const submitUpload = page.getByRole("button", { name: "确认上传" }).last();
    await expect(submitUpload).toBeVisible();
    await submitUpload.click();
    await expect.poll(() =>
      store.courses.get(newCourseId)?.materials.some((m) => m.name.includes("cloud-native-syllabus")),
    ).toBe(true);

    const uploadedFileBtn = page.getByRole("button", { name: "cloud-native-syllabus.txt" }).first();
    await expect(uploadedFileBtn).toBeVisible();
    const deleteFileBtn = page.getByRole("button", { name: "删除资料" }).first();
    if (!(await deleteFileBtn.isVisible().catch(() => false))) {
      await uploadedFileBtn.click();
    }
    await expect(deleteFileBtn).toBeVisible();
    await deleteFileBtn.click();
    await expect(page.getByRole("button", { name: "确认删除" }).last()).toBeVisible();
    await page.getByRole("button", { name: "取消" }).last().click();
    await expect(page.getByText("cloud-native-syllabus.txt").first()).toBeVisible();
    expect(store.courses.get(newCourseId)?.materials.length).toBe(1);

    await deleteFileBtn.click();
    await page.getByRole("button", { name: "确认删除" }).last().click();
    await expect(page.getByText("cloud-native-syllabus.txt")).toHaveCount(0);
    await expect.poll(() => store.courses.get(newCourseId)?.materials.length).toBe(0);

    // 5. End and Reopen Class in Hub 5 Settings
    await page
      .getByRole("tab", { name: /基础设置/ })
      .or(page.getByRole("link", { name: /基础设置/ }))
      .first()
      .click();
    await page.getByRole("button", { name: "结束课程" }).click();
    const endDialog = page.getByRole("dialog");
    await expect(endDialog).toBeVisible();
    await endDialog.getByLabel("结课原因").fill("学期考核结束");
    await endDialog.getByLabel(/请输入班级名称/).fill("云原生工程实训");
    await endDialog.getByRole("button", { name: "确认结束课程" }).click();
    await expect.poll(() => store.courses.get(newCourseId)?.status).toBe("ended");

    const reopenReasonInput = page.getByPlaceholder("重开原因");
    await expect(reopenReasonInput).toBeVisible();
    await reopenReasonInput.fill("补交大作业材料");
    await page.getByRole("button", { name: "重新开启课程" }).click();
    await expect.poll(() => store.courses.get(newCourseId)?.status).toBe("active");
    expect(errors).toEqual([]);
  });

  test("T4-2 [post-m3] Scenario 2: Multi-Actor Enrollment & Team Formation (Rotate Invite -> Student Joins -> Teacher Approves -> Assign & Promote Leader -> StudentProfileDrawer Esc)", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const course1 = store.courses.get(TW_COURSE_1_ID)!;
    course1.join_mode = "approval";
    course1.joinRequests = [];
    course1.actions = course1.actions.filter((a) => a.type !== "join_request");

    const teacher = await createActorContext(browser, "teacher", store);
    const student = await createActorContext(browser, "outsider", store);

    try {
      // Teacher opens header invite pill Dialog and rotates invite code (single InviteCodeCard)
      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);
      await expect(teacher.page.locator('main [data-testid="teacher-invite-code"]')).toHaveCount(0);
      await assertSingleInviteCard(teacher.page);
      const invitePill = teacher.page.locator('button[title*="邀请码"]').first();
      await expect(invitePill).toBeVisible();
      await invitePill.click();

      const inviteDialog = teacher.page.getByRole("dialog").filter({ hasText: "邀请码" }).first();
      await expect(inviteDialog).toBeVisible();
      await assertSingleInviteCard(teacher.page);
      const oldCode = (await inviteDialog.getByTestId("teacher-invite-code").innerText()).trim();
      await inviteDialog.getByRole("button", { name: "复制邀请码" }).click();
      await expect(inviteDialog.getByRole("status").filter({ hasText: "已复制邀请码" })).toBeVisible();
      await inviteDialog.getByRole("button", { name: "重置邀请码" }).click();
      await inviteDialog.getByRole("button", { name: "确认重置" }).click();
      await expect(inviteDialog.getByTestId("teacher-invite-code")).not.toHaveText(oldCode);
      const newCode = (await inviteDialog.getByTestId("teacher-invite-code").innerText()).trim();
      await teacher.page.keyboard.press("Escape");
      await expect(inviteDialog).toHaveCount(0);

      // Student previews and submits join request with rotated invite code
      await student.page.goto("/courses/join");
      await student.page.locator("#b-invite-code").fill(newCode);
      await student.page.getByRole("button", { name: "下一步" }).click();
      await expect(student.page.getByText("软件工程实践").first()).toBeVisible();
      await student.page.getByRole("button", { name: /提交加入申请|确认加入/ }).click();
      await expect.poll(() =>
        course1.joinRequests.some((j) => j.student.id === TW_OUTSIDER_ID && j.status === "pending"),
      ).toBe(true);

      // Teacher approves in Hub 3
      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/actions`);
      await teacher.page.getByRole("button", { name: "同意加入" }).first().click();
      await expect.poll(() => course1.roster.some((s) => s.id === TW_OUTSIDER_ID)).toBe(true);

      // Teacher assigns new student to Group 2 and promotes leader in Team Plaza
      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);
      const pool = teacher.page.getByTestId("ungrouped-pool-dropzone");
      await pool.getByLabel("将 王旁听 分配到").selectOption({ label: "第二组 · 智能评测" });

      const group2Card = teacher.page.getByTestId(`team-card-${TW_GROUP_2_ID}`);
      await expect(group2Card).toContainText("王旁听");

      await pool.getByLabel("将 王同学 分配到").selectOption({ label: "第二组 · 智能评测" });
      await expect(group2Card).toContainText("王同学");
      await group2Card.getByRole("button", { name: "设为队长" }).last().click();
      await expect.poll(() => course1.groups[1].leader_id).not.toBeNull();

      // Teacher opens StudentProfileDrawer from roster and closes with Esc
      const sidebar = await ensureRosterOpen(teacher.page);
      await sidebar.getByTestId(`student-entity-${TW_OUTSIDER_ID}`).click();
      const drawer = teacher.page.getByRole("dialog").filter({ hasText: "王旁听" }).first();
      await expect(drawer).toBeVisible();
      await teacher.page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);

      expect(teacher.errors).toEqual([]);
      expect(student.errors).toEqual([]);
    } finally {
      await teacher.context.close();
      await student.context.close();
    }
  });

  test("T4-3 Scenario 3: Student Project Execution & File Upload -> Teacher Reception & CSV/Markdown Report Export", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const student = await createActorContext(browser, "student", store);
    const teacher = await createActorContext(browser, "teacher", store);

    try {
      // Student inspects project overview & adds material
      await student.page.goto(`/projects/${TW_PROJECT_1_ID}`);
      await expect(student.page.getByRole("heading", { level: 1, name: "智能协作教学平台" })).toBeVisible();
      await assertStudentShellUntouched(student.page);

      await student.page.goto(`/projects/${TW_PROJECT_1_ID}/setup`);
      await student.page.getByLabel(/标题/).fill("迭代验收报告摘要");
      await student.page.getByLabel("正文").fill("已完成接口联调、3步存储上传与贡献快照校验。");
      await student.page.getByRole("button", { name: "添加文本资料" }).click();
      await expect.poll(() =>
        store.projects.get(TW_PROJECT_1_ID)?.materials.some((m) => m.title === "迭代验收报告摘要"),
      ).toBe(true);

      // Student performs 3-step file upload via FileUploadForm UI -> logical file registration
      const uploadTrail: string[] = [];
      student.page.on("request", (req) => {
        const url = req.url();
        if (req.method() === "POST" && url.endsWith("/api/v1/storage/uploads")) uploadTrail.push("init");
        if (req.method() === "PUT" && url.startsWith("https://fixture.invalid/")) uploadTrail.push("put");
        if (req.method() === "POST" && url.endsWith("/complete")) uploadTrail.push("complete");
        if (req.method() === "POST" && url.endsWith(`/api/v1/projects/${TW_PROJECT_1_ID}/files`)) uploadTrail.push("register");
      });

      await student.page.goto(`/projects/${TW_PROJECT_1_ID}/files`);
      await expect(student.page.getByRole("heading", { level: 1, name: "项目资料" })).toBeVisible();
      const uploadFileInput = student.page.getByLabel("选择文件");
      await expect(uploadFileInput).toBeVisible();
      await uploadFileInput.setInputFiles({
        name: "acceptance-report-v2.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4 GroupProof Deliverable Acceptance Report v2"),
      });
      await student.page.getByLabel("新文件分类").selectOption("documents");
      await student.page.getByLabel("版本说明").fill("验收交付物上传");
      const uploadSubmitBtn = student.page.getByRole("button", { name: "上传并保存草稿" });
      await expect(uploadSubmitBtn).toBeEnabled();
      await uploadSubmitBtn.click();

      await expect.poll(() => uploadTrail).toEqual(["init", "put", "complete", "register"]);
      await expect(student.page.getByRole("status").filter({ hasText: "文件草稿版本已保存" })).toBeVisible();
      await expect(student.page.getByText("acceptance-report-v2.pdf").first()).toBeVisible();
      await expect(student.page.getByText("architecture-v1.pdf").first()).toBeVisible();

      // Teacher verifies reception in Projects Monitor, project files drill-down, and Reports CSV/Markdown export
      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);
      await expect(teacher.page.getByText("智能协作教学平台").first()).toBeVisible();
      await teacher.page.getByRole("button", { name: "发送催办" }).first().click();
      await expect(teacher.page.getByRole("status").first()).toBeVisible();

      await teacher.page.goto(`/projects/${TW_PROJECT_1_ID}/files`);
      await expect(teacher.page.getByText("acceptance-report-v2.pdf").first()).toBeVisible();

      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/reports`);
      await expect(teacher.page.getByRole("heading", { level: 1, name: "数据报告中心" })).toBeVisible();
      await expect(teacher.page.getByText("李同学").first()).toBeVisible();
      await expect(teacher.page.getByText("赵同学").first()).toBeVisible();

      const [csvReq] = await Promise.all([
        teacher.page.waitForRequest((req) => req.url().includes("/reports/export") && req.method() === "POST"),
        teacher.page.getByRole("button", { name: "导出 CSV / Excel" }).click(),
      ]);
      expect(csvReq.postDataJSON()).toMatchObject({ format: "csv" });

      const [mdReq] = await Promise.all([
        teacher.page.waitForRequest((req) => req.url().includes("/reports/export") && req.method() === "POST"),
        teacher.page.getByRole("button", { name: "导出 Markdown" }).click(),
      ]);
      expect(mdReq.postDataJSON()).toMatchObject({ format: "markdown" });

      expect(student.errors).toEqual([]);
      expect(teacher.errors).toEqual([]);
    } finally {
      await student.context.close();
      await teacher.context.close();
    }
  });

  test("T4-4 [post-m4] Scenario 4: Student Appeal -> Teacher Adjudication & Share Adjustment + Owner vs TA Permission Gating", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const course1 = store.courses.get(TW_COURSE_1_ID)!;
    const student = await createActorContext(browser, "student", store);
    const owner = await createActorContext(browser, "teacher", store);
    const ta = await createActorContext(browser, "ta", store, {
      taPermissions: { approve_changes: false, manage_files: false, post_announcements: false },
    });

    try {
      // Student submits a contribution appeal
      await student.page.goto("/home");
      await student.page.evaluate(
        async ({ cid, pid }: { cid: string; pid: string }) => {
          const sessRes = await fetch("/api/v1/auth/session", { credentials: "include" });
          const sessJson = (await sessRes.json()) as { data?: { csrfToken?: string } };
          const csrf = sessJson.data?.csrfToken ?? "";
          await fetch(`/api/v1/courses/${cid}/appeals`, {
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
              title: "冲刺阶段前端贡献占比调整申请",
              content: "完成全部组件重构与可访问性验证，请求调整至 60/40。",
              evidence: ["PR-108"],
            }),
          });
        },
        { cid: TW_COURSE_1_ID, pid: TW_PROJECT_1_ID },
      );

      // Restricted TA cannot adjudicate appeal
      await ta.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/appeals`);
      await expect(ta.page.getByText("冲刺阶段前端贡献占比调整申请").first()).toBeVisible();
      await ta.page.getByText("冲刺阶段前端贡献占比调整申请").first().click();
      await expect(ta.page.getByText("PR-108")).toBeVisible();
      const taAcceptBtn = ta.page.getByRole("button", { name: /受理申诉|接受并生成新快照/ }).first();
      if ((await taAcceptBtn.count()) > 0) {
        await expect(taAcceptBtn).toBeDisabled();
      } else {
        await expect(taAcceptBtn).toHaveCount(0);
      }

      // Owner requests supplement, then accepts with 60/40 contribution adjustment
      await owner.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/appeals`);
      await expect(
        owner.page.getByRole("tab", { name: /申诉裁决/ }).or(owner.page.getByRole("link", { name: /申诉裁决/ })).first(),
      ).toBeVisible();
      await owner.page.getByText("冲刺阶段前端贡献占比调整申请").first().click();
      await owner.page.locator("#appeal-reason").fill("请补充联调截图");
      await owner.page.getByRole("button", { name: "要求补充材料" }).click();
      await expect.poll(() =>
        course1.appeals.find((a) => a.title === "冲刺阶段前端贡献占比调整申请")?.status,
      ).toBe("need_supplement");

      const adjustCheckbox = owner.page.getByLabel(/受理时同步调整上方贡献度占比并生成新冻结快照/);
      await expect(adjustCheckbox).toBeVisible();
      await adjustCheckbox.check();
      await expect(adjustCheckbox).toBeChecked();

      const shareInputs = owner.page.locator('input[type="number"]');
      await expect(shareInputs).toHaveCount(2);
      await shareInputs.nth(0).fill("60");
      await shareInputs.nth(1).fill("40");

      await owner.page.locator("#appeal-reason").fill("补充材料核实无误，调整为 60/40 并生成新快照");
      await owner.page.getByRole("button", { name: "接受并生成新快照" }).click();
      await expect.poll(() =>
        course1.appeals.find((a) => a.title === "冲刺阶段前端贡献占比调整申请")?.status,
      ).toBe("accepted");

      const snap = store.projects.get(TW_PROJECT_1_ID)!.contributionSnapshot;
      const stu1Share = snap.items.find((i) => i.user_id === TW_STUDENT_1_ID)?.share;
      const stu2Share = snap.items.find((i) => i.user_id === TW_STUDENT_2_ID)?.share;
      expect(stu1Share).toBe(60);
      expect(stu2Share).toBe(40);

      expect(student.errors).toEqual([]);
      expect(owner.errors).toEqual([]);
      expect(nonHttp4xxErrors(ta.errors)).toEqual([]);
    } finally {
      await student.context.close();
      await owner.context.close();
      await ta.context.close();
    }
  });

  test("T4-5 [post-m2] Scenario 5: Responsive Ergonomics (1440/1280/768/375px), Collapsible Rail/Roster, Cmd/Ctrl+K Switcher & Esc Safety", async ({ page }) => {
    const { errors } = await setupActorPage(page, "teacher");

    for (const route of [
      "/teacher/dashboard",
      "/teacher/courses",
      `/teacher/courses/${TW_COURSE_1_ID}`,
      `/teacher/courses/${TW_COURSE_1_ID}/groups`,
    ]) {
      await page.goto(route);
      await assertNoHorizontalOverflow(page, [1440, 1280, 768, 375]);
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

    // Collapse left navigation rail cleanly
    const railCollapseBtn = page
      .locator('aside.gp-sidebar button[aria-label*="折叠"], aside.gp-sidebar button[aria-label*="收起"], [data-testid="sidebar-collapse-toggle"]')
      .first();
    await expect(railCollapseBtn).toBeVisible();
    const beforeRail = await page.locator("aside.gp-sidebar").boundingBox();
    await railCollapseBtn.click();
    const afterRail = await page.locator("aside.gp-sidebar").boundingBox();
    expect(afterRail?.width ?? 999).toBeLessThan(beforeRail?.width ?? 999);

    // Open & Esc-dismiss StudentProfileDrawer
    const sidebar = await ensureRosterOpen(page);
    await sidebar.getByTestId(`student-entity-${TW_STUDENT_3_ID}`).click();
    const drawer = page.getByRole("dialog").filter({ hasText: "王同学" }).first();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // Input safety: single-key shortcuts do not hijack focused input
    const searchRosterInput = sidebar.getByLabel("搜索班级学生");
    await searchRosterInput.click();
    await page.keyboard.type("jk1");
    await expect(searchRosterInput).toHaveValue("jk1");
    await searchRosterInput.blur();

    // Cmd/Ctrl+K opens Quick Switcher and navigates to Course 2, Esc closes if reopened
    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const switcherDialog = page.getByRole("dialog").first();
    await expect(switcherDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
    const switcherInput = page.getByRole("dialog").first().locator("input").first();
    await switcherInput.fill("人工智能导论");
    await page.getByRole("dialog").first().getByText("人工智能导论").first().click();
    await expect(page).toHaveURL(new RegExp(`/teacher/courses/${TW_COURSE_2_ID}`));

    expect(errors).toEqual([]);
  });

  test("T4-6 [post-m4] Scenario 6: Automated Checklists A-D & Student Non-Regression Visual Audit", async ({ browser }) => {
    const store = createTeacherWorkbenchStore();
    const teacher = await createActorContext(browser, "teacher", store);
    const student = await createActorContext(browser, "student", store);

    try {
      await teacher.page.setViewportSize({ width: 1280, height: 800 });

      // Teacher global & course hubs Checklists A-D
      await teacher.page.goto("/teacher/dashboard");
      await expect(teacher.page.getByText("跨班待处理事项")).toBeVisible();
      await assertTeacherShellTokens(teacher.page);
      await assertIconButtonsAccessible(teacher.page);
      await assertTabularNums(teacher.page.locator("main .gp-stat-value, main .gp-tabular, main [data-testid*='kpi']"));
      const dashHeader = teacher.page.getByRole("link", { name: "管理我的班级" }).locator("..");
      await expect(dashHeader).toBeVisible();
      await assertPrimaryCtaCaps(teacher.page, dashHeader);
      await assertToolbarButtonRadiusConsistent(teacher.page, dashHeader);

      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);
      await expect(teacher.page.getByText("入班学生总数")).toBeVisible();
      await assertTeacherShellTokens(teacher.page);
      await assertSingleRowCourseNav(teacher.page);
      await assertSingleInviteCard(teacher.page);
      await assertIconButtonsAccessible(teacher.page);
      await assertTabularNums(teacher.page.locator("main .gp-stat-value, main .gp-tabular, main [data-testid*='kpi']"));

      const courseBar = teacher.page.locator('[data-testid="teacher-course-nav"]').locator("..");
      await expect(courseBar).toBeVisible();
      await assertPrimaryCtaCaps(teacher.page, courseBar);
      await assertToolbarButtonRadiusConsistent(teacher.page, courseBar);

      const headerContainer = teacher.page.getByRole("link", { name: /进入学生组队广场/ }).locator("..");
      await expect(headerContainer).toBeVisible();
      await assertPrimaryCtaCaps(teacher.page, headerContainer);
      await assertToolbarButtonRadiusConsistent(teacher.page, headerContainer);

      // Checklist C1 + C2 + C4: Open Sheet drawer, assert enabled motion (150-300ms) + reduced motion <= 1ms
      const sidebar = await ensureRosterOpen(teacher.page);
      await sidebar.getByTestId(`student-entity-${TW_STUDENT_3_ID}`).click();
      const profileSheet = teacher.page.getByRole("dialog").filter({ hasText: "王同学" }).first();
      await expect(profileSheet).toBeVisible();
      await assertSheetMotionEnabled(teacher.page, profileSheet);
      await assertMotionAndReducedMotion(teacher.page);
      await teacher.page.keyboard.press("Escape");
      await expect(profileSheet).toHaveCount(0);

      // Bounding-box non-overlap check on course context bar & page header actions
      const overlaps = await teacher.page.evaluate(() => {
        const boxes = Array.from(
          document.querySelectorAll(
            '[data-testid="teacher-course-nav"] button, [data-testid="teacher-course-nav"] a, main header button, main header a, main .gp-panel-header button, main .gp-panel-header a',
          ),
        )
          .map((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return { text: (el.textContent || "").trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          })
          .filter((b) => b.right - b.left > 0 && b.bottom - b.top > 0);
        const issues: string[] = [];
        for (let i = 0; i < boxes.length; i += 1) {
          for (let j = i + 1; j < boxes.length; j += 1) {
            const a = boxes[i];
            const b = boxes[j];
            const intersectX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const intersectY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (intersectX > 2 && intersectY > 2) {
              issues.push(`Overlap between "${a.text}" and "${b.text}" (${intersectX}x${intersectY})`);
            }
          }
        }
        return issues;
      });
      expect(overlaps, overlaps.join("\n")).toEqual([]);

      // Hub 4 (/projects, /reports) & Hub 5 (/settings, /rules, /files) Checklists A-D audit
      for (const hubRoute of [
        `/teacher/courses/${TW_COURSE_1_ID}/projects`,
        `/teacher/courses/${TW_COURSE_1_ID}/reports`,
        `/teacher/courses/${TW_COURSE_1_ID}/settings`,
        `/teacher/courses/${TW_COURSE_1_ID}/rules`,
        `/teacher/courses/${TW_COURSE_1_ID}/files`,
      ]) {
        await teacher.page.goto(hubRoute);
        await assertTeacherShellTokens(teacher.page);
        await assertSingleRowCourseNav(teacher.page);
        await assertIconButtonsAccessible(teacher.page);
        await assertNoHorizontalOverflow(teacher.page, [375, 1280]);
      }

      await teacher.page.goto(`/teacher/courses/${TW_COURSE_1_ID}/reports`);
      await expect(teacher.page.getByText("在研项目总数")).toBeVisible();
      await assertTabularNums(teacher.page.locator("main .gp-stat-value, main .gp-tabular, main [data-testid*='kpi']"));
      const reportsHeader = teacher.page.getByRole("button", { name: /导出 CSV/ }).locator("..");
      await expect(reportsHeader).toBeVisible();
      await assertPrimaryCtaCaps(teacher.page, reportsHeader);
      await assertToolbarButtonRadiusConsistent(teacher.page, reportsHeader);

      // Student non-regression across /home, /courses, and /projects/[id]
      for (const studentRoute of ["/home", "/courses", `/projects/${TW_PROJECT_1_ID}`]) {
        await student.page.goto(studentRoute);
        await assertStudentShellUntouched(student.page);
        await assertNoHorizontalOverflow(student.page, [375, 1280]);
      }

      expect(teacher.errors).toEqual([]);
      expect(student.errors).toEqual([]);
    } finally {
      await teacher.context.close();
      await student.context.close();
    }
  });
});
