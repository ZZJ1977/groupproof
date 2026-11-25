import { expect, test, type Page } from "@playwright/test";
import {
  TW_ANNOUNCEMENT_1_ID,
  TW_COURSE_1_ID,
  TW_COURSE_2_ID,
  TW_FOLDER_1_ID,
  TW_PROJECT_1_ID,
  TW_STUDENT_2_ID,
  createTeacherWorkbenchStore,
  installTeacherWorkbenchMocks,
  type InstallTeacherWorkbenchMocksOptions,
  type MockActor,
  type TeacherWorkbenchStore,
} from "./fixtures/teacher-workbench-mock-api";
import {
  assertNoHorizontalOverflow,
  assertPrimaryCtaCaps,
  assertStudentShellUntouched,
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

test.describe("Teacher Workbench Tier 5 — Adversarial Hardening & Regression Suite", () => {
  test("T5-1 Files upload Sheet resets on cancel, folder rename submits on Enter, batch ops & folder delete work", async ({
    page,
  }) => {
    const store = createTeacherWorkbenchStore();
    const emptyFolderId = "60000000-0000-0000-0000-000000000009";
    store.courses.get(TW_COURSE_1_ID)!.folders.push({
      id: emptyFolderId,
      course_id: TW_COURSE_1_ID,
      name: "待重命名目录",
      parent_id: null,
      sort_order: 2,
      created_at: new Date().toISOString(),
    });
    const { errors } = await setupActorPage(page, "teacher", store);
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/files`);

    // 1. Upload Sheet cancel resets uploadName & uploadFile
    await page.getByRole("button", { name: "上传资料" }).click();
    await page.locator("#mat-file-input").setInputFiles({
      name: "first-syllabus.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("first"),
    });
    await expect(page.locator("#mat-name-input")).toHaveValue("first-syllabus.pdf");
    await page.locator("#mat-note-input").fill("待丢弃备注");
    await page.getByRole("button", { name: "取消" }).last().click();

    await page.getByRole("button", { name: "上传资料" }).click();
    await expect(page.locator("#mat-name-input")).toHaveValue("");
    await expect(page.locator("#mat-note-input")).toHaveValue("");
    await page.locator("#mat-file-input").setInputFiles({
      name: "second-homework.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("second"),
    });
    await expect(page.locator("#mat-name-input")).toHaveValue("second-homework.pdf");
    await page.getByRole("button", { name: "确认上传" }).click();
    await expect(page.getByRole("button", { name: "second-homework.pdf" }).first()).toBeVisible();

    // 2. Folder rename Dialog submits cleanly on Enter
    await page.getByLabel("重命名文件夹").last().click();
    const renameDialog = page.getByRole("dialog");
    const renameInput = renameDialog.locator("input");
    await renameInput.fill("归档目录");
    await renameInput.press("Enter");
    await expect(page.getByRole("button", { name: /归档目录/ })).toBeVisible();

    // 3. Empty folder state
    await page.getByRole("button", { name: /归档目录/ }).click();
    await expect(page.getByText("当前目录暂无资料")).toBeVisible();

    // 4. Batch move + visibility + delete
    await page.getByRole("button", { name: "全部资料" }).click();
    await page.getByRole("checkbox", { name: "second-homework.pdf" }).check();
    await page.getByLabel("批量移动目标").selectOption(TW_FOLDER_1_ID);
    await page.getByRole("button", { name: "移动到此处" }).click();
    await expect.poll(() =>
      store.courses.get(TW_COURSE_1_ID)?.materials.find((m) => m.name === "second-homework.pdf")?.folder_id,
    ).toBe(TW_FOLDER_1_ID);

    await page.getByRole("button", { name: /课程大纲与模板/ }).click();
    await page.getByRole("checkbox", { name: "second-homework.pdf" }).check();
    await page.getByRole("button", { name: "设为仅已分组" }).click();
    await expect.poll(() =>
      store.courses.get(TW_COURSE_1_ID)?.materials.find((m) => m.name === "second-homework.pdf")?.visibility,
    ).toBe("grouped");

    await page.getByRole("checkbox", { name: "second-homework.pdf" }).check();
    await page.getByRole("button", { name: "批量删除" }).click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByRole("button", { name: "second-homework.pdf" })).toHaveCount(0);

    // 5. Folder delete (2-step confirm) moves inner material up
    await page.getByRole("button", { name: "全部资料" }).click();
    await page.getByLabel("删除文件夹").first().click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByRole("button", { name: /课程大纲与模板/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "实验指导书.pdf" }).first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("T5-2 Appeals tab switch clears stale selection and AppealDetailPanel guards invalid shares", async ({
    page,
  }) => {
    const store = createTeacherWorkbenchStore();
    const course1 = store.courses.get(TW_COURSE_1_ID)!;
    course1.appeals.push({
      id: "40000000-0000-0000-0000-000000000099",
      course_id: TW_COURSE_1_ID,
      project_id: TW_PROJECT_1_ID,
      project_name: "智能协作教学平台",
      group_name: "第一组 · 飞书协同",
      appellant_id: TW_STUDENT_2_ID,
      appellant_name: "赵同学",
      student_number: "20260002",
      appeal_type: "contribution",
      title: "已受理历史申诉测试项",
      content: "此前已经完成核查并归档的历史申诉内容。",
      supplement_text: null,
      evidence: ["commit-old-01"],
      status: "accepted",
      resolved_by: course1.owner_id,
      resolver_name: "张老师",
      resolved_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      decisions: [],
    });

    const { errors } = await setupActorPage(page, "teacher", store);
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/appeals`);

    // Select pending appeal on 全部 tab
    await page.getByRole("button", { name: /前端重构任务权重核对申诉/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "前端重构任务权重核对申诉" })).toBeVisible();

    // Switch to 已处理 tab -> detail panel must NOT keep stale pending appeal
    await page.getByRole("tab", { name: /已处理/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "已受理历史申诉测试项" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "前端重构任务权重核对申诉" })).toHaveCount(0);

    // Switch back to 待审核 and test invalid share validation
    await page.getByRole("tab", { name: /待审核/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "前端重构任务权重核对申诉" })).toBeVisible();
    await page.locator("#appeal-reason").fill("核对调整贡献占比");
    await page.getByLabel("受理时同步调整上方贡献度占比并生成新冻结快照").check();

    const shareInputs = page.locator('input[type="number"]');
    await expect(shareInputs).toHaveCount(2);
    // Sum != 100
    await shareInputs.nth(0).fill("40");
    await shareInputs.nth(1).fill("40");
    await expect(page.getByText(/贡献度占比合计：80%/)).toBeVisible();
    await expect(page.getByRole("button", { name: "接受并生成新快照" })).toBeDisabled();

    // Negative individual share even when sum === 100
    await shareInputs.nth(0).fill("-10");
    await shareInputs.nth(1).fill("110");
    await expect(page.getByText(/每位成员的贡献占比需在 0%–100% 之间/)).toBeVisible();
    await expect(page.getByRole("button", { name: "接受并生成新快照" })).toBeDisabled();

    // Valid shares sum === 100
    await shareInputs.nth(0).fill("60");
    await shareInputs.nth(1).fill("40");
    const acceptBtn = page.getByRole("button", { name: "接受并生成新快照" });
    await expect(acceptBtn).toBeEnabled();
    await acceptBtn.click();
    await expect.poll(() => course1.appeals[0].status).toBe("accepted");
    expect(errors).toEqual([]);
  });

  test("T5-3 Member-changes satisfies Checklist B1 & B3 at 1280x800 and 375x812", async ({
    page,
  }) => {
    const { errors } = await setupActorPage(page, "teacher");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/member-changes`);

    await expect(page.getByRole("heading", { level: 1, name: "成员变动审批" })).toBeVisible();
    await expect(page.getByTestId("join-request-row").first()).toBeVisible();
    await expect(page.getByTestId("invitation-request-row").first()).toBeVisible();
    await expect(page.getByTestId("membership-request").first()).toBeVisible();
    await expect(page.locator("main .gp-panel")).toHaveCount(0);

    await assertToolbarButtonRadiusConsistent(page, page.locator('main [role="toolbar"]'));
    await assertPrimaryCtaCaps(page, page.locator('main [role="toolbar"]'));
    await assertNoHorizontalOverflow(page, [375, 721, 1280]);
    expect(errors).toEqual([]);
  });

  test("T5-4 Ended course #teacher-course-switcher displays real course name", async ({ page }) => {
    const { errors } = await setupActorPage(page, "teacher");
    await page.goto(`/teacher/courses/${TW_COURSE_2_ID}`);

    await expect(page.getByRole("heading", { level: 1, name: "人工智能导论" })).toBeVisible();
    await expect(page.locator("#teacher-course-switcher")).toContainText("人工智能导论");
    expect(errors).toEqual([]);
  });

  test("T5-5 Rules rejects negative weights and min > max, and supports MilestoneTemplateEditor reorder & deliverables", async ({
    page,
  }) => {
    const { errors } = await setupActorPage(page, "teacher");
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/rules`);

    // Negative weight even though sum === 100
    await page.locator("#rules-task-weight").fill("-10");
    await page.locator("#rules-verification-weight").fill("60");
    await page.locator("#rules-collaboration-weight").fill("50");
    await expect(page.getByText("各项权重需在 0%–100% 之间，且合计为 100%").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "发布规则" })).toBeDisabled();

    // Fix weights, violate min > max
    await page.locator("#rules-task-weight").fill("50");
    await page.locator("#rules-verification-weight").fill("30");
    await page.locator("#rules-collaboration-weight").fill("20");
    await page.locator("#rules-min-group-size").fill("10");
    await page.locator("#rules-max-group-size").fill("2");
    await expect(page.getByText("最小组队人数不能大于最大组队人数").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "发布规则" })).toBeDisabled();

    // Fix min <= max, reorder milestones, add/remove deliverables
    await page.locator("#rules-min-group-size").fill("2");
    await page.locator("#rules-max-group-size").fill("5");
    await expect(page.getByRole("button", { name: "保存草稿" })).toBeEnabled();

    await page.getByRole("button", { name: "添加里程碑" }).click();
    await page.getByRole("button", { name: "添加里程碑" }).click();
    const initialCount = await page.getByLabel("上移阶段").count();
    await page.locator(`#ms-${initialCount - 2}-title`).fill("阶段Alpha");
    await page.locator(`#ms-${initialCount - 1}-title`).fill("阶段Beta");
    await page.getByLabel("上移阶段").last().click();
    await expect(page.locator(`#ms-${initialCount - 2}-title`)).toHaveValue("阶段Beta");
    await page.getByLabel("删除里程碑").last().click();

    await page.locator("#rules-new-deliverable").fill("架构设计说明.pdf");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect(page.getByText("架构设计说明.pdf")).toBeVisible();
    await page.getByLabel("删除交付物要求").last().click();
    await expect(page.getByText("架构设计说明.pdf")).toHaveCount(0);

    await page.getByRole("button", { name: "保存草稿" }).click();
    await expect(page.getByText(/规则草稿已保存/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("T5-6 Create Class #create-class-min-size supports Backspace clearing before typing 3", async ({
    page,
  }) => {
    const { store, errors } = await setupActorPage(page, "teacher");
    await page.goto("/teacher/courses");

    await page.getByRole("button", { name: "创建班级" }).click();
    const minInput = page.locator("#create-class-min-size");
    await minInput.click();
    await minInput.press("Backspace");
    await expect(minInput).toHaveValue("");
    await minInput.pressSequentially("3");
    await expect(minInput).toHaveValue("3");

    const maxInput = page.locator("#create-class-max-size");
    await maxInput.click();
    await maxInput.press("Backspace");
    await expect(maxInput).toHaveValue("");
    await maxInput.pressSequentially("6");
    await expect(maxInput).toHaveValue("6");

    await page.locator("#create-class-name").fill("软件架构实验班");
    await page.getByRole("button", { name: "确认创建并生成邀请码" }).click();
    await expect.poll(() =>
      Array.from(store.courses.values()).some((c) => c.name === "软件架构实验班" && c.min_group_size === 3),
    ).toBe(true);
    expect(errors).toEqual([]);
  });

  test("T5-7 Checklist B2 icon-only buttons have aria-label AND title at 375x812 and inside Sheet/Dialog", async ({
    page,
  }) => {
    const { errors } = await setupActorPage(page, "teacher");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

    const checkIconBtns = async () =>
      page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const style = window.getComputedStyle(el as HTMLElement);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const bad: string[] = [];
        for (const btn of Array.from(document.querySelectorAll("button"))) {
          if (!isVisible(btn)) continue;
          if (btn.closest("nextjs-portal, [data-nextjs-toast], [data-next-badge]")) continue;
          if (btn.hasAttribute("data-next-mark")) continue;
          const text = (btn.innerText || "").trim();
          const hasOnlyIconOrAvatar = text.length === 0 || (text.length <= 2 && btn.querySelector("svg"));
          if (!hasOnlyIconOrAvatar) continue;
          const aria = (btn.getAttribute("aria-label") || "").trim();
          const title = (btn.getAttribute("title") || "").trim();
          if (!aria || !title) {
            bad.push(`${btn.outerHTML.slice(0, 100)} aria="${aria}" title="${title}"`);
          }
        }
        return bad;
      });

    expect(await checkIconBtns()).toEqual([]);

    // Open mobile Roster Sheet -> StudentProfileDrawer -> check Sheet Close X button
    await page.getByTestId("roster-toggle-btn").click();
    await page.getByRole("button", { name: /李同学/ }).first().click();
    const profileDialog = page.locator('[role="dialog"][aria-label="学生资料详情"]');
    await expect(profileDialog).toBeVisible();
    const closeSheetBtn = profileDialog.locator('button[aria-label="关闭"]');
    await expect(closeSheetBtn).toHaveAttribute("title", "关闭");
    await closeSheetBtn.click();
    await expect(profileDialog).toHaveCount(0);
    // Close mobile Roster Sheet if still open before opening Invite Dialog
    if (await page.getByTestId("class-roster-sidebar").isVisible()) {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("class-roster-sidebar")).toHaveCount(0);
    }

    // Open Invite Dialog -> check Dialog Close X button
    await page.getByTitle("点击打开邀请码管理").click();
    const closeDialogBtn = page.getByRole("dialog").getByRole("button", { name: "关闭" }).first();
    await expect(closeDialogBtn).toHaveAttribute("aria-label", "关闭");
    await expect(closeDialogBtn).toHaveAttribute("title", "关闭");
    expect(errors).toEqual([]);
  });

  test("T5-8 Hub 4/5 500 error recovery via 重试 and Announcements unpin & delete", async ({
    page,
  }) => {
    const store = createTeacherWorkbenchStore();
    const { errors } = await setupActorPage(page, "teacher", store);

    for (const subPath of ["projects", "reports", "files", "announcements"]) {
      let failOnce = true;
      const urlPattern =
        subPath === "projects"
          ? "**/api/v1/teacher/classes/*/projects"
          : subPath === "reports"
            ? "**/api/v1/teacher/classes/*/reports/overview"
            : subPath === "files"
              ? "**/api/v1/teacher/classes/*/files**"
              : "**/api/v1/teacher/classes/*/announcements";
      await page.route(urlPattern, async (route) => {
        if (failOnce && route.request().method() === "GET") {
          failOnce = false;
          return route.fulfill({
            status: 500,
            json: { error: { code: "INTERNAL_ERROR", message: "模拟服务端故障" }, meta: { request_id: "t5" } },
          });
        }
        return route.fallback();
      });

      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/${subPath}`);
      const alert = page.locator('main [role="alert"]').first();
      await expect(alert).toBeVisible();
      const retryBtn = alert.getByRole("button", { name: "重试" });
      await expect(retryBtn).toBeVisible();
      await retryBtn.click();
      await expect(alert).toHaveCount(0);
    }

    // Announcements unpin + delete
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/announcements`);
    await page.getByRole("button", { name: "取消置顶" }).first().click();
    await expect.poll(() =>
      store.courses.get(TW_COURSE_1_ID)?.announcements.find((a) => a.id === TW_ANNOUNCEMENT_1_ID)?.is_pinned,
    ).toBe(false);

    await page.getByRole("button", { name: "删除" }).first().click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.getByText("欢迎来到软件工程实践")).toHaveCount(0);
    const unexpectedErrors = errors.filter(
      (msg) => !msg.includes("500") && !msg.includes("Internal Server Error"),
    );
    expect(unexpectedErrors).toEqual([]);
  });

  test("T5-9 QuickSwitcher scrollIntoView, second Cmd/Ctrl+K toggle, /staff entry, Sheet scroll preservation & Tabs keyboard nav", async ({
    page,
  }) => {
    const { errors } = await setupActorPage(page, "teacher");
    await page.setViewportSize({ width: 1280, height: 800 });

    // Segmented tabs ArrowRight / End / Home / ArrowLeft
    await page.goto("/teacher/courses");
    const activeTab = page.getByRole("tab", { name: "进行中" });
    await activeTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "已结课" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "全部" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "进行中" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "全部" })).toHaveAttribute("aria-selected", "true");

    // Ctrl+K ignored inside page search input
    await page.getByLabel("搜索班级名称或代码").focus();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "快速跳转" })).toHaveCount(0);

    // Navigate to course 1 -> QuickSwitcher empty query includes 助教管理, Roster students, and 快捷跳转
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);
    await page.locator("h1").click();
    await page.keyboard.press("Control+k");
    const qsDialog = page.getByRole("dialog", { name: "快速跳转" });
    await expect(qsDialog).toBeVisible();
    await expect(qsDialog.getByRole("option", { name: /助教管理/ })).toBeVisible();
    await expect(qsDialog.getByRole("option", { name: /李同学/ })).toBeVisible();
    await expect(qsDialog.getByRole("option", { name: /教师工作台/ })).toBeVisible();

    // ArrowDown past 360px scroll box -> selected option stays visible inside scroll container
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("ArrowDown");
    }
    const scrollCheck = await qsDialog.evaluate((dialogEl) => {
      const box = dialogEl.querySelector(".overflow-y-auto") as HTMLElement | null;
      const selected = dialogEl.querySelector('[role="option"][aria-selected="true"]') as HTMLElement | null;
      if (!box || !selected) return { ok: false, reason: "missing" };
      const boxRect = box.getBoundingClientRect();
      const optRect = selected.getBoundingClientRect();
      return {
        ok: optRect.top >= boxRect.top - 1 && optRect.bottom <= boxRect.bottom + 1,
        scrollTop: box.scrollTop,
        optTop: optRect.top,
        optBottom: optRect.bottom,
        boxTop: boxRect.top,
        boxBottom: boxRect.bottom,
      };
    });
    expect(scrollCheck.ok, JSON.stringify(scrollCheck)).toBe(true);

    // Second Ctrl+K closes open QuickSwitcher even while focus is inside its input
    await page.keyboard.press("Control+k");
    await expect(qsDialog).toHaveCount(0);

    // Sheet scroll preservation (Esc closes StudentProfileDrawer without jumping scrollY)
    await page.evaluate(() => window.scrollTo(0, 150));
    const beforeScrollY = await page.evaluate(() => window.scrollY);
    await page.getByTestId("roster-toggle-btn").click();
    await page.getByRole("button", { name: /李同学/ }).first().click();
    const profileDrawer = page.locator('[role="dialog"][aria-label="学生资料详情"]');
    await expect(profileDrawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(profileDrawer).toHaveCount(0);
    const afterScrollY = await page.evaluate(() => window.scrollY);
    expect(afterScrollY).toBe(beforeScrollY);

    expect(errors).toEqual([]);
  });

  test("T5-10 Runtime en & zh-Hant zero untranslated leaks at 1280x800 & 721x800, and Student evidence 0 console errors across 4 viewports", async ({
    page,
  }) => {
    const { errors } = await setupActorPage(page, "teacher");

    for (const locale of ["en", "zh-Hant"] as const) {
      await page.context().addCookies([
        { name: "gp_locale", value: locale, url: "http://127.0.0.1:13009" },
      ]);

      for (const vp of [
        { width: 1280, height: 800 },
        { width: 721, height: 800 },
      ]) {
        await page.setViewportSize(vp);
        await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);
        await expect(page.locator(".gp-teacher-shell")).toBeVisible();

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(overflow, `Overflow in ${locale} at ${vp.width}x${vp.height}`).toBe(false);

        const bellTitle = await page
          .locator('header.gp-topbar a[href="/notifications"]')
          .getAttribute("title");
        expect(bellTitle).toBeTruthy();
        expect(bellTitle).not.toMatch(/未读通知|未读数/);

        if (vp.width === 1280) {
          const sidebar = page.getByTestId("class-roster-sidebar");
          if (!(await sidebar.isVisible())) {
            await page.getByTestId("roster-toggle-btn").click();
          }
          await expect(sidebar).toBeVisible();
          await sidebar.getByRole("button", { name: /李同学/ }).first().click();
          const dialog = page.getByRole("dialog");
          await expect(dialog).toBeVisible();
          const ariaLabel = await dialog.getAttribute("aria-label");
          expect(ariaLabel).toBe(locale === "en" ? "Student profile details" : "學生資料詳情");
          await page.keyboard.press("Escape");
          await expect(dialog).toHaveCount(0);
        }
      }
    }

    // Student /projects/[id]/evidence 0 console errors across 4 viewports
    const studentPage = await page.context().newPage();
    try {
      await studentPage.context().addCookies([
        { name: "gp_locale", value: "zh-Hans", url: "http://127.0.0.1:13009" },
        { name: "gp_tw_actor", value: "student", url: "http://127.0.0.1:13009" },
      ]);
      await installTeacherWorkbenchMocks(studentPage, createTeacherWorkbenchStore(), {
        actor: "student",
      });
      const studentErrors = collectConsoleAndPageErrors(studentPage);

      await studentPage.goto(`/projects/${TW_PROJECT_1_ID}/evidence`);
      await expect(studentPage.getByRole("heading", { level: 1, name: "项目证据" })).toBeVisible();
      await assertStudentShellUntouched(studentPage);
      for (const vp of [
        { width: 1440, height: 900 },
        { width: 1280, height: 800 },
        { width: 721, height: 800 },
        { width: 375, height: 812 },
      ]) {
        await studentPage.setViewportSize(vp);
        const overflow = await studentPage.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(overflow, `Student evidence overflow at ${vp.width}x${vp.height}`).toBe(false);
      }
      expect(studentErrors).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await studentPage.close();
    }
  });

  test("T5-11 Hub 5 en loading/500 states have zero overflow at 721x800 & 375x812, Rules Backspace works, and zh-Hant maxGroupSize error renders Traditional Chinese", async ({
    page,
  }) => {
    const { errors } = await setupActorPage(page, "teacher");
    await page.context().addCookies([
      { name: "gp_locale", value: "en", url: "http://127.0.0.1:13009" },
    ]);

    for (const subPath of ["settings", "rules", "staff"] as const) {
      let releaseLoading!: () => void;
      const loadingGate = new Promise<void>((resolve) => {
        releaseLoading = resolve;
      });
      const pattern = `**/api/v1/teacher/classes/*/${subPath}`;
      const handler = async (route: Parameters<Parameters<Page["route"]>[1]>[0]) => {
        if (route.request().method() === "GET") {
          await loadingGate;
          return route.fulfill({
            status: 500,
            json: { error: { code: "INTERNAL_ERROR", message: "Simulated 500" }, meta: { request_id: "t5-11" } },
          });
        }
        return route.fallback();
      };

      await page.route(pattern, handler);
      try {
        await page.setViewportSize({ width: 721, height: 800 });
        await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/${subPath}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("hub5-segmented-tabs")).toBeVisible();
        await expect(page.locator('main [role="status"]').first()).toBeVisible();

        await assertNoHorizontalOverflow(page, [721, 375]);

        releaseLoading();
        await expect(page.locator('main [role="alert"]').first()).toBeVisible();
        await assertNoHorizontalOverflow(page, [375, 721]);
      } finally {
        releaseLoading();
        await page.unroute(pattern, handler);
      }
    }

    // Verify TeacherRulesApiPage numeric Backspace support in en
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/rules`);
    const rulesMin = page.locator("#rules-min-group-size");
    await expect(rulesMin).toBeVisible();
    await rulesMin.click();
    await rulesMin.press("Backspace");
    await expect(rulesMin).toHaveValue("");
    await rulesMin.pressSequentially("2");
    await expect(rulesMin).toHaveValue("2");

    // Verify zh-Hant TeacherClassesApiPage maxGroupSize validation message
    await page.context().addCookies([
      { name: "gp_locale", value: "zh-Hant", url: "http://127.0.0.1:13009" },
    ]);
    await page.goto("/teacher/courses");
    await page.getByRole("button", { name: "建立班級" }).click();
    await page.locator("#create-class-name").fill("繁體驗證班級");
    await page.locator("#create-class-max-size").fill("");
    await page.getByRole("button", { name: "確認建立並生成邀請碼" }).click();
    const formAlert = page.getByRole("dialog").getByRole("alert").first();
    await expect(formAlert).toContainText("最大組隊人數需為 1–50 之間的整數");
    await expect(formAlert).not.toContainText("之间");

    const unexpectedErrors = errors.filter(
      (msg) => !msg.includes("500") && !msg.includes("Internal Server Error"),
    );
    expect(unexpectedErrors).toEqual([]);
  });
});
