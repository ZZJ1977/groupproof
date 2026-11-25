import { expect, test, type Page } from "@playwright/test";
import {
  TW_COURSE_1_ID,
  TW_COURSE_2_ID,
  TW_GROUP_1_ID,
  TW_GROUP_2_ID,
  TW_OUTSIDER_ID,
  TW_PROJECT_1_ID,
  TW_STUDENT_3_ID,
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
  assertTabularNums,
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

test.describe("Teacher Workbench Tier 1 — Feature Coverage", () => {
  test.describe("F1: Global Teacher Shell, 5-Hub Consolidation & Quick Switcher", () => {
    test("F1-T1-1 Teacher dashboard renders KPIs and navigates to class home", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto("/teacher/dashboard");

      await expect(page.getByRole("heading", { level: 1, name: "教师工作台" })).toBeVisible();
      await expect(page.getByText("跨班待处理事项")).toBeVisible();
      await expect(page.getByText("我管理的班级")).toBeVisible();
      await expect(page.getByText("在研项目总数")).toBeVisible();
      await expect(page.getByText("全局风险队伍")).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "授课班级概览" })).toBeVisible();

      const classLink = page.locator(`a[href="/teacher/courses/${TW_COURSE_1_ID}"]`).first();
      await expect(classLink).toBeVisible();
      await classLink.click();
      await expect(page).toHaveURL(new RegExp(`/teacher/courses/${TW_COURSE_1_ID}$`));
      await expect(page.getByRole("heading", { level: 1, name: "软件工程实践" })).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F1-T1-2 Teacher courses page supports status tabs and search filtering", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto("/teacher/courses");

      await expect(page.getByRole("heading", { level: 1, name: "我的班级" })).toBeVisible();
      const card1 = page.getByTestId(`teacher-class-card-${TW_COURSE_1_ID}`);
      const card2 = page.getByTestId(`teacher-class-card-${TW_COURSE_2_ID}`);
      await expect(card1).toBeVisible();

      await page.getByRole("tab", { name: "全部" }).click();
      await expect(card1).toBeVisible();
      await expect(card2).toBeVisible();

      await page.getByRole("tab", { name: "已结课" }).click();
      await expect(card2).toBeVisible();
      await expect(card1).toHaveCount(0);

      await page.getByRole("tab", { name: "进行中" }).click();
      await expect(card1).toBeVisible();
      await expect(card2).toHaveCount(0);

      await page.getByRole("tab", { name: "全部" }).click();
      await page.getByLabel("搜索班级名称或代码").fill("SE-2026-01");
      await expect(card1).toBeVisible();
      await expect(card2).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test("F1-T1-3 [post-m2] Course context navigation consolidates into <= 6 single-row hubs", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      await assertTeacherShellTokens(page);
      await assertSingleRowCourseNav(page);
      await assertIconButtonsAccessible(page);

      for (const hubLabel of ["概览", "组队与名单", "审批与申诉", "项目与报告", "课程设置|课程配置"]) {
        await expect(page.getByRole("link", { name: new RegExp(hubLabel) }).first()).toBeVisible();
      }
      expect(errors).toEqual([]);
    });

    test("F1-T1-4 [post-m2] Interactive Course Switcher switches course and rail collapses cleanly", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      store.courses.get(TW_COURSE_2_ID)!.status = "active";
      const { errors } = await setupActorPage(page, "teacher", store);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      const switcher = page
        .getByRole("button", { name: /切换班级/ })
        .or(page.locator('[data-testid="course-switcher"], button[aria-haspopup="listbox"], button[aria-haspopup="menu"]').filter({ hasText: "软件工程实践" }))
        .first();
      await expect(switcher).toBeVisible();
      await switcher.click();

      const targetItem = page
        .getByRole("menuitem", { name: /人工智能导论/ })
        .or(page.getByRole("option", { name: /人工智能导论/ }))
        .or(page.getByRole("button", { name: /人工智能导论/ }))
        .or(page.getByRole("link", { name: /人工智能导论/ }));
      await targetItem.first().click();
      await expect(page).toHaveURL(new RegExp(`/teacher/courses/${TW_COURSE_2_ID}`));

      const collapseBtn = page
        .locator('aside.gp-sidebar button[aria-label*="折叠"], aside.gp-sidebar button[aria-label*="收起"], [data-testid="sidebar-collapse-toggle"]')
        .first();
      await expect(collapseBtn).toBeVisible();
      const beforeBox = await page.locator("aside.gp-sidebar").boundingBox();
      await collapseBtn.click();
      const afterBox = await page.locator("aside.gp-sidebar").boundingBox();
      expect(afterBox?.width ?? 999).toBeLessThan(beforeBox?.width ?? 999);
      expect(errors).toEqual([]);
    });

    test("F1-T1-5 [post-m2] Cmd/Ctrl+K opens quick switcher and navigates to selected course", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto("/teacher/dashboard");

      await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      const dialog = page.getByRole("dialog").first();
      await expect(dialog).toBeVisible();
      const searchInput = dialog.locator("input").first();
      await expect(searchInput).toBeFocused();
      await searchInput.fill("人工智能导论");
      await dialog.getByText("人工智能导论").first().click();

      await expect(page).toHaveURL(new RegExp(`/teacher/courses/${TW_COURSE_2_ID}`));
      expect(errors).toEqual([]);
    });
  });

  test.describe("F2: Class Creation, Collapsible Roster, Student Drawer & Invite Deduplication", () => {
    test("F2-T1-1 Create class flow generates invite banner and adds class card", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto("/teacher/courses");

      await page.getByRole("button", { name: "创建班级" }).click();
      await page.locator("#create-class-name").fill("分布式系统");
      await page.locator("#create-class-term").fill("2026-Autumn");
      await page.locator("#create-class-college").fill("计算机学院");
      await page.locator("#create-class-code").fill("DS-2026-01");
      await page.locator("#create-class-min-size").fill("2");
      await page.locator("#create-class-max-size").fill("4");
      await page.locator("#create-class-project-deadline").fill("2027-01-20T23:59");
      await page.getByRole("button", { name: "确认创建并生成邀请码" }).click();

      const banner = page.getByTestId("newly-created-class-banner");
      await expect(banner).toBeVisible();
      await expect(banner.getByTestId("teacher-invite-code")).toContainText("TW-DS-202");
      await expect(page.getByText("分布式系统").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F2-T1-2 [post-m3] Create-class form opens in right-side Sheet drawer without scroll jump", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      for (let i = 1; i <= 8; i += 1) {
        const cid = store.nextUuid("10000000");
        const base = store.courses.get(TW_COURSE_1_ID)!;
        store.courses.set(cid, {
          ...base,
          id: cid,
          code: `EX-2026-0${i}`,
          name: `扩展课程 ${i}`,
          invite_code: `TW-EX0${i}`,
          roster: [],
          groups: [],
        });
      }
      const { errors } = await setupActorPage(page, "teacher", store);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto("/teacher/courses");

      await page.evaluate(() => window.scrollTo(0, 260));
      const scrollBefore = await page.evaluate(() => window.scrollY);
      expect(scrollBefore).toBeGreaterThan(200);

      await page.getByRole("button", { name: "创建班级" }).evaluate((el: HTMLElement) => el.click());
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();
      await expect(sheet.locator("#create-class-name")).toBeVisible();

      const scrollDuring = await page.evaluate(() => window.scrollY);
      expect(Math.abs(scrollDuring - scrollBefore)).toBeLessThanOrEqual(24);
      expect(errors).toEqual([]);
    });

    test("F2-T1-3 ClassRosterSidebar filters students by search and grouping status", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      const sidebar = await ensureRosterOpen(page);
      await expect(sidebar).toContainText("共 3 人");

      await sidebar.getByRole("button", { name: /未组队/ }).click();
      await expect(sidebar.getByTestId(`student-entity-${TW_STUDENT_3_ID}`)).toBeVisible();
      await expect(sidebar.locator('[data-testid^="student-entity-"]')).toHaveCount(1);

      await sidebar.getByRole("button", { name: /已组队/ }).click();
      await expect(sidebar.locator('[data-testid^="student-entity-"]')).toHaveCount(2);

      await sidebar.getByRole("button", { name: /全部/ }).click();
      await sidebar.getByLabel("搜索班级学生").fill("赵同学");
      await expect(sidebar.locator('[data-testid^="student-entity-"]')).toHaveCount(1);
      await expect(sidebar).toContainText("赵同学");
      expect(errors).toEqual([]);
    });

    test("F2-T1-4 StudentProfileDrawer displays student details and removes ungrouped student", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      const sidebar = await ensureRosterOpen(page);
      await sidebar.getByTestId(`student-entity-${TW_STUDENT_3_ID}`).click();

      const drawer = page.getByRole("dialog").filter({ hasText: "王同学" }).first();
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText("student3@student.must.edu.mo");
      await expect(drawer).toContainText("未组队");

      await drawer.getByRole("button", { name: "移出班级" }).click();
      await drawer.locator("#remove-student-reason").fill("学生申请退选");
      await drawer.getByRole("button", { name: "确认移出" }).click();

      await expect(drawer).toHaveCount(0);
      await expect(sidebar).toContainText("共 2 人");
      await expect(sidebar.getByTestId(`student-entity-${TW_STUDENT_3_ID}`)).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test("F2-T1-5 [post-m3] Class Home renders single InviteCodeCard and supports copy and rotate", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      await expect(page.locator('main [data-testid="teacher-invite-code"]')).toHaveCount(0);
      await assertSingleInviteCard(page);

      const invitePill = page.locator('button[title*="邀请码"]').first();
      await expect(invitePill).toBeVisible();
      await invitePill.click();

      const dialog = page.getByRole("dialog").filter({ hasText: "邀请码" }).first();
      await expect(dialog).toBeVisible();
      await assertSingleInviteCard(page);
      await expect(dialog.getByTestId("teacher-invite-code")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "复制加入链接" })).toBeVisible();

      await dialog.getByRole("button", { name: "复制邀请码" }).click();
      await expect(dialog.getByRole("status").filter({ hasText: "已复制邀请码" })).toBeVisible();

      const oldCode = await dialog.getByTestId("teacher-invite-code").innerText();
      await dialog.getByRole("button", { name: "重置邀请码" }).click();
      await dialog.getByRole("button", { name: "确认重置" }).click();
      await expect(dialog.getByTestId("teacher-invite-code")).not.toHaveText(oldCode);
      expect(errors).toEqual([]);
    });
  });

  test.describe("F3: Class Home & Team Plaza / Group Detail", () => {
    test("F3-T1-1 Class Home renders 4 KPIs and team progress overview", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      await expect(page.getByRole("heading", { level: 1, name: "软件工程实践" })).toBeVisible();
      for (const label of ["入班学生总数", "已组队学生", "未组队学生", "当前队伍数"]) {
        await expect(page.getByText(label).first()).toBeVisible();
      }
      await expect(page.getByRole("heading", { level: 2, name: "班级队伍进度总览" })).toBeVisible();
      await expect(page.getByText("第一组 · 飞书协同").first()).toBeVisible();
      await expect(page.getByText("第二组 · 智能评测").first()).toBeVisible();

      await page.getByRole("link", { name: /进入学生组队广场/ }).first().click();
      await expect(page).toHaveURL(new RegExp(`/teacher/courses/${TW_COURSE_1_ID}/groups$`));
      expect(errors).toEqual([]);
    });

    test("F3-T1-2 Team Plaza creates a new group card", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);

      await expect(page.getByRole("heading", { level: 1, name: "学生组队广场" })).toBeVisible();
      const toggleBtn = page.getByRole("button", { name: "新建队伍" });
      await expect(toggleBtn).toBeVisible();
      await toggleBtn.click();
      await page.locator("#plaza-new-group-name").fill("第三组 · 云原生");
      await page.locator("#plaza-new-group-direction").fill("微服务与容器化");
      await page.getByRole("button", { name: "确认创建队伍" }).click();

      await expect(page.getByText("第三组 · 云原生").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F3-T1-3 Team Plaza assigns ungrouped student into group via select", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);

      const pool = page.getByTestId("ungrouped-pool-dropzone");
      await expect(pool).toContainText("王同学");

      const assignSelect = pool.getByLabel("将 王同学 分配到");
      await assignSelect.selectOption({ label: "第二组 · 智能评测" });

      const group2Card = page.getByTestId(`team-card-${TW_GROUP_2_ID}`);
      await expect(group2Card).toContainText("王同学");
      expect(errors).toEqual([]);
    });

    test("F3-T1-4 Team Plaza promotes member to leader", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);

      const group1Card = page.getByTestId(`team-card-${TW_GROUP_1_ID}`);
      await expect(group1Card).toContainText("赵同学");
      await group1Card.getByRole("button", { name: "设为队长" }).first().click();

      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.groups[0].leader_id).not.toBe(
        store.actors.teacher.id,
      );
      await expect(group1Card).toContainText("赵同学");
      expect(errors).toEqual([]);
    });

    test("F3-T1-5 Group Detail renders member table, milestones, and promotes leader", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups/${TW_GROUP_1_ID}`);

      await expect(page.getByText("第一组 · 飞书协同").first()).toBeVisible();
      const memberTable = page.getByRole("table", { name: "队伍成员列表" });
      await expect(memberTable.getByText("李同学")).toBeVisible();
      await expect(memberTable.getByText("赵同学")).toBeVisible();
      await expect(page.getByText("需求基线与立项").first()).toBeVisible();
      await expect(page.getByText("核心功能实现").first()).toBeVisible();

      const promoteBtn = page.getByRole("button", { name: "设为队长" }).first();
      await expect(promoteBtn).toBeVisible();
      await promoteBtn.click();

      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.groups[0].leader_id).toBe(
        "00000000-0000-0000-0000-000000000202",
      );
      expect(errors).toEqual([]);
    });
  });

  test.describe("F4: Hub 3 — Actions Center, Member Changes & Appeals", () => {
    test("F4-T1-1 Actions Center filters pending items and approves join request", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/actions`);

      await expect(page.getByRole("heading", { level: 1, name: "审批与操作中心" })).toBeVisible();
      await expect(page.getByText("王旁听申请加入软件工程实践")).toBeVisible();

      await page.getByRole("button", { name: "同意加入" }).first().click();
      await expect.poll(() =>
        store.courses.get(TW_COURSE_1_ID)?.roster.some((s) => s.id === TW_OUTSIDER_ID),
      ).toBe(true);
      expect(errors).toEqual([]);
    });

    test("F4-T1-2 Actions Center rejects item with reason and verifies handled status", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/actions`);

      await page.getByRole("button", { name: "拒绝" }).first().click();
      await page.locator("#action-reason-input").fill("班级人数已满");
      await page.getByRole("button", { name: "确认提交" }).click();

      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.joinRequests[0].status).toBe("rejected");
      await page.getByRole("radio", { name: "已处理" }).check();
      await expect(page.getByText("王旁听申请加入软件工程实践")).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F4-T1-3 [post-m3] Hub 3 unifies Actions & Appeals tabs, risk/notification filters, and member-changes layout", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/actions`);

      const actionsTab = page.getByRole("tab", { name: /待办审批/ }).or(
        page.getByRole("link", { name: /待办审批/ }),
      );
      const appealsTab = page.getByRole("tab", { name: /申诉裁决/ }).or(
        page.getByRole("link", { name: /申诉裁决/ }),
      );
      await expect(actionsTab.first()).toBeVisible();
      await expect(appealsTab.first()).toBeVisible();

      const riskCheckbox = page.getByRole("checkbox", { name: /风险|预警/ }).first();
      const notifCheckbox = page.getByRole("checkbox", { name: /通知/ }).first();
      await expect(riskCheckbox).toBeVisible();
      await expect(notifCheckbox).toBeVisible();
      await riskCheckbox.check();
      await expect(riskCheckbox).toBeChecked();
      await riskCheckbox.uncheck();
      await notifCheckbox.check();
      await expect(notifCheckbox).toBeChecked();
      await notifCheckbox.uncheck();

      await appealsTab.first().click();
      await expect(page.getByText("前端重构任务权重核对申诉")).toBeVisible();

      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/member-changes`);
      await expect(page.locator(".gp-teacher-shell")).toBeVisible();
      await ensureRosterOpen(page);
      await expect(page.getByTestId("class-roster-sidebar")).toBeVisible();
      await expect(page.getByText("任务交接").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F4-T1-4 Appeals Center filters by status and opens AppealDetailPanel", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/appeals`);

      await expect(page.getByRole("heading", { level: 1, name: "申诉与争议处理" })).toBeVisible();
      for (const tabLabel of ["全部", "待审核", "待补充", "已处理"]) {
        await expect(page.getByRole("button", { name: new RegExp(tabLabel) }).or(
          page.getByRole("tab", { name: new RegExp(tabLabel) }),
        ).first()).toBeVisible();
      }

      await page.getByText("前端重构任务权重核对申诉").first().click();
      await expect(page.getByText("commit-abc123")).toBeVisible();
      await expect(page.getByText("实现前端工作台视图")).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F4-T1-5 Appeals Center adjudicates with request_supplement and accept", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/appeals`);

      await page.getByText("前端重构任务权重核对申诉").first().click();
      await page.locator("#appeal-reason").fill("请补充 PR-42 测试记录");
      await page.getByRole("button", { name: "要求补充材料" }).click();

      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.appeals[0].status).toBe("need_supplement");

      await page.locator("#appeal-reason").fill("核对后确认贡献占比调整");
      const acceptBtn = page.getByRole("button", { name: /受理申诉|接受并生成新快照/ }).first();
      await acceptBtn.click();

      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.appeals[0].status).toBe("accepted");
      expect(errors).toEqual([]);
    });
  });

  test.describe("F5: Hub 4 — Projects Monitor & Reports Center", () => {
    test("F5-T1-1 Projects Monitor filters group cards by status pills", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);

      await expect(page.getByRole("heading", { level: 1, name: "项目总览与督办" })).toBeVisible();
      for (const pill of ["全部小组", "已立项", "未立项", "风险预警"]) {
        await expect(page.getByRole("tab", { name: new RegExp(pill) }).first()).toBeVisible();
      }

      await expect(page.getByText("智能协作教学平台")).toBeVisible();
      await expect(page.getByText("第二组 · 智能评测")).toBeVisible();

      await page.getByRole("tab", { name: /未立项/ }).first().click();
      await expect(page.getByText("第二组 · 智能评测")).toBeVisible();
      await expect(page.getByText("智能协作教学平台")).toHaveCount(0);

      await page.getByRole("tab", { name: /已立项/ }).first().click();
      await expect(page.getByText("智能协作教学平台")).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F5-T1-2 Projects Monitor sends reminder and exposes project detail link", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);

      const detailLink = page.locator(`a[href="/projects/${TW_PROJECT_1_ID}"]`).first();
      await expect(detailLink).toBeVisible();

      await page.getByRole("button", { name: "发送催办" }).first().click();
      await expect(page.getByRole("status").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F5-T1-3 Reports Center renders KPIs, progress overview, activity, and contribution tables", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/reports`);

      await expect(page.getByRole("heading", { level: 1, name: "数据报告中心" })).toBeVisible();
      await expect(page.getByText("第一组 · 飞书协同").first()).toBeVisible();
      await expect(page.getByText("李同学").first()).toBeVisible();
      await expect(page.getByText("赵同学").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F5-T1-4 Reports Center exports CSV and Markdown cleanly", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/reports`);

      const [csvReq] = await Promise.all([
        page.waitForRequest((req) => req.url().includes("/reports/export") && req.method() === "POST"),
        page.getByRole("button", { name: "导出 CSV / Excel" }).click(),
      ]);
      expect(csvReq.postDataJSON()).toMatchObject({ format: "csv" });

      const [mdReq] = await Promise.all([
        page.waitForRequest((req) => req.url().includes("/reports/export") && req.method() === "POST"),
        page.getByRole("button", { name: "导出 Markdown" }).click(),
      ]);
      expect(mdReq.postDataJSON()).toMatchObject({ format: "markdown" });
      expect(errors).toEqual([]);
    });

    test("F5-T1-5 [post-m4] Hub 4 unifies Projects Monitor and Reports Center with deduplicated KPIs", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);

      const monitorTab = page.getByRole("tab", { name: /项目监控/ }).or(
        page.getByRole("link", { name: /项目监控/ }),
      );
      const reportTab = page.getByRole("tab", { name: /班级数据报告/ }).or(
        page.getByRole("link", { name: /班级数据报告/ }),
      );
      await expect(monitorTab.first()).toBeVisible();
      await expect(reportTab.first()).toBeVisible();

      await reportTab.first().click();
      await expect(page).toHaveURL(/\/reports/);
      await expect(page.getByRole("heading", { level: 1, name: "数据报告中心" })).toBeVisible();
      await expect(page.getByText("在研项目总数")).toBeVisible();
      await assertTabularNums(
        page.locator("main .gp-stat-value, main .gp-tabular, main [data-testid*='kpi']"),
      );
      const reportsActionContainer = page
        .getByRole("button", { name: /导出 CSV/ })
        .locator("..");
      await expect(reportsActionContainer).toBeVisible();
      await assertPrimaryCtaCaps(page, reportsActionContainer);
      expect(errors).toEqual([]);
    });
  });

  test.describe("F6: Hub 5 — Settings, Lifecycle, Rules & Milestone Templates", () => {
    test("F6-T1-1 Class Settings edits basic metadata and saves", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);

      await expect(page.getByRole("heading", { level: 1, name: "班级设置" })).toBeVisible();
      const nameInput = page.locator("input").first();
      await nameInput.fill("软件工程实践（卓越班）");
      await page.getByRole("button", { name: "保存修改" }).click();

      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.name).toBe("软件工程实践（卓越班）");
      expect(errors).toEqual([]);
    });

    test("F6-T1-2 Class Settings transitions lifecycle through end, reopen, and archive", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);

      await page.getByRole("button", { name: "结束课程" }).click();
      const endDialog = page.getByRole("dialog");
      await expect(endDialog).toBeVisible();
      await endDialog.getByLabel("结课原因").fill("学期结束");
      await endDialog.getByLabel(/请输入班级名称/).fill("软件工程实践");
      await endDialog.getByRole("button", { name: "确认结束课程" }).click();
      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.status).toBe("ended");

      const reopenReason = page.getByPlaceholder("重开原因");
      await expect(reopenReason).toBeVisible();
      await reopenReason.fill("补交验收材料");
      await page.getByRole("button", { name: "重新开启课程" }).click();
      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.status).toBe("active");

      await page.getByRole("button", { name: "归档课程" }).click();
      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.status).toBe("ended");
      await expect.poll(() => Boolean(store.courses.get(TW_COURSE_1_ID)?.archived_at)).toBe(true);
      expect(errors).toEqual([]);
    });

    test("F6-T1-3 Course Rules edits milestone templates and policies", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/rules`);

      await expect(page.getByRole("heading", { level: 1, name: "课程规则与评分模板" })).toBeVisible();
      await expect(page.locator('input[value="需求基线与立项"]').or(page.getByText("需求基线与立项")).first()).toBeVisible();
      await expect(page.locator('input[value="核心功能实现"]').or(page.getByText("核心功能实现")).first()).toBeVisible();

      const addMilestoneBtn = page.getByRole("button", { name: /添加里程碑|新增阶段/ }).first();
      await expect(addMilestoneBtn).toBeVisible();
      await addMilestoneBtn.click();
      await expect(
        page.locator('input[value="阶段里程碑 3"]').or(page.getByText("阶段里程碑 3")).first(),
      ).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F6-T1-4 Course Rules saves draft, publishes new version, and opens snapshot", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/rules`);

      await page.getByRole("button", { name: "保存草稿" }).click();
      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.draftRuleVersion?.status).toBe("draft");

      await page.getByRole("button", { name: "发布规则" }).click();
      await page.locator("#rules-publish-summary").fill("补充中期评审规则");
      await page.getByRole("button", { name: "确认发布" }).click();

      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.publishedRuleVersion?.version_no).toBe(2);
      await page.getByRole("button", { name: "查看快照" }).first().click();
      const snapDialog = page.getByRole("dialog");
      await expect(snapDialog).toBeVisible();
      await expect(snapDialog).toContainText("规则版本快照 v2");
      await expect(snapDialog).toContainText("补充中期评审规则");
      expect(errors).toEqual([]);
    });

    test("F6-T1-5 [post-m4] Hub 5 unifies 5 tabs, tracks SaveState dirty state, and uses Sheet for Rules publish", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);

      for (const tabLabel of ["基础设置", "规则与模板", "课程资料", "课程公告", "助教管理"]) {
        await expect(
          page.getByRole("tab", { name: new RegExp(tabLabel) }).or(
            page.getByRole("link", { name: new RegExp(tabLabel) }),
          ).first(),
        ).toBeVisible();
      }

      const firstInput = page.locator("main input").first();
      await firstInput.fill("软件工程实践（修订）");
      await expect(page.getByText(/未保存|待保存/)).toBeVisible();
      await page.getByRole("button", { name: "保存修改" }).click();
      await expect(page.locator(".gp-save-state").filter({ hasText: /已保存/ })).toBeVisible();

      await page.getByRole("tab", { name: /规则与模板/ }).or(
        page.getByRole("link", { name: /规则与模板/ }),
      ).first().click();
      await page.getByRole("button", { name: "发布规则" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });

  test.describe("F7: Hub 5 — Course Files, Announcements & Staff Permissions", () => {
    test("F7-T1-1 Course Files creates, renames, and navigates folder breadcrumbs", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/files`);

      await expect(page.getByRole("heading", { level: 1, name: "课程资料中心" })).toBeVisible();
      await expect(page.getByText("课程大纲与模板")).toBeVisible();

      await page.getByRole("button", { name: "新建文件夹" }).click();
      await page.getByLabel("新文件夹名称").fill("实验模板");
      await page.getByRole("button", { name: "确认创建" }).click();

      await expect(page.getByText("实验模板")).toBeVisible();
      expect(store.courses.get(TW_COURSE_1_ID)?.folders.some((f) => f.name === "实验模板")).toBe(true);

      await page.getByLabel("重命名文件夹").last().click();
      const renameInput = page.locator('input[value="实验模板"]').or(page.getByRole("textbox").last()).first();
      await renameInput.fill("实验模板V2");
      await page.getByRole("button", { name: /保存|确认/ }).last().click();
      await expect(page.getByText("实验模板V2")).toBeVisible();

      await page.getByRole("button", { name: /课程大纲与模板/ }).click();
      await expect(page.getByText("实验指导书.pdf")).toBeVisible();
      await page.getByRole("button", { name: "全部资料" }).click();
      expect(errors).toEqual([]);
    });

    test("F7-T1-2 Course Files uploads material, filters, adds new version, and updates visibility", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/files`);

      await page.getByRole("button", { name: /课程大纲与模板/ }).click();
      await expect(page.getByText("实验指导书.pdf")).toBeVisible();

      await page.getByRole("button", { name: "上传资料" }).click();
      const fileInput = page.locator('#mat-file-input');
      await fileInput.setInputFiles({
        name: "lab-guide-v2.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("GroupProof lab specification"),
      });
      const submitUpload = page.getByRole("button", { name: "确认上传" }).last();
      await expect(submitUpload).toBeVisible();
      await submitUpload.click();

      await expect.poll(() =>
        store.courses.get(TW_COURSE_1_ID)?.materials.some((m) => m.name.includes("lab-guide-v2")),
      ).toBe(true);
      await expect(page.getByRole("button", { name: "lab-guide-v2.txt" }).first()).toBeVisible();

      // Append new version
      await page.getByPlaceholder("版本更新说明（选填）").fill("补充单元测试要求");
      await page.getByRole("button", { name: "发布新版" }).click();
      await expect.poll(() =>
        store.courses.get(TW_COURSE_1_ID)?.materials.find((m) => m.name.includes("lab-guide-v2"))?.versions.length,
      ).toBe(2);

      // Update visibility and filter by visibility + search
      await page.getByLabel("修改资料可见范围").selectOption("grouped");
      await expect.poll(() =>
        store.courses.get(TW_COURSE_1_ID)?.materials.find((m) => m.name.includes("lab-guide-v2"))?.visibility,
      ).toBe("grouped");

      await page.getByLabel("按可见范围筛选").selectOption("grouped");
      await expect(page.getByRole("button", { name: "lab-guide-v2.txt" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "实验指导书.pdf" })).toHaveCount(0);

      await page.getByPlaceholder("搜索资料名称").fill("不存在关键字");
      await expect(page.getByText("当前目录暂无资料")).toBeVisible();
      await page.getByPlaceholder("搜索资料名称").fill("lab-guide");
      await expect(page.getByRole("button", { name: "lab-guide-v2.txt" }).first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F7-T1-3 Announcements creates draft, publishes, and toggles pin", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/announcements`);

      await expect(page.getByRole("heading", { level: 1, name: "课程公告" })).toBeVisible();
      await expect(page.getByText("欢迎来到软件工程实践")).toBeVisible();

      await page.getByRole("button", { name: "发布新公告" }).click();
      await page.getByLabel("公告标题").fill("中期答辩安排");
      await page.getByLabel("公告正文").fill("下周三下午两点准时开始答辩。");
      await page.getByRole("button", { name: "存为草稿" }).click();

      await expect(page.getByText("中期答辩安排")).toBeVisible();
      await expect
        .poll(
          () =>
            store.courses
              .get(TW_COURSE_1_ID)
              ?.announcements.find((a) => a.title === "中期答辩安排")?.status,
        )
        .toBe("draft");

      const publishDraftBtn = page.getByRole("button", { name: "正式发布" }).first();
      await expect(publishDraftBtn).toBeVisible();
      await publishDraftBtn.click();
      await expect
        .poll(
          () =>
            store.courses
              .get(TW_COURSE_1_ID)
              ?.announcements.find((a) => a.title === "中期答辩安排")?.status,
        )
        .toBe("published");
      await expect(page.getByRole("button", { name: "正式发布" })).toHaveCount(0);

      const pinBtn = page.getByRole("button", { name: "置顶", exact: true }).first();
      await expect(pinBtn).toBeVisible();
      await pinBtn.click();
      await expect
        .poll(
          () =>
            store.courses
              .get(TW_COURSE_1_ID)
              ?.announcements.find((a) => a.title === "中期答辩安排")?.is_pinned,
        )
        .toBe(true);
      expect(errors).toEqual([]);
    });

    test("F7-T1-4 Announcements shows read receipts and reminds unread students", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/announcements`);

      await page.getByRole("button", { name: "阅读统计" }).first().click();
      await expect(page.getByText("赵同学").first()).toBeVisible();
      await expect(page.getByText("李同学").first()).toBeVisible();

      const remindBtn = page.getByRole("button", { name: "催读未读学生" }).first();
      await expect(remindBtn).toBeVisible();
      await remindBtn.click();
      await expect(page.getByRole("status").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F7-T1-5 Course Staff invites TA, edits 6 permissions, and removes staff", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/staff`);

      await expect(page.getByRole("heading", { level: 1, name: "助教管理" })).toBeVisible();
      await expect(page.getByText("陈助教")).toBeVisible();

      await page.locator('input[type="email"], input[placeholder*="邮箱"]').first().fill("new_ta@must.edu.mo");
      await page.getByRole("button", { name: "发送邀请" }).click();
      await expect(page.getByText("new_ta@must.edu.mo").or(page.getByText("new_ta")).first()).toBeVisible();

      await page.getByRole("button", { name: "编辑权限" }).first().click();
      const permCheckboxes = page.locator('input[type="checkbox"]');
      expect(await permCheckboxes.count()).toBeGreaterThanOrEqual(6);
      await page.getByRole("button", { name: /保存权限|确认保存/ }).first().click();

      await page.getByRole("button", { name: "移除" }).last().click();
      const rmReason = page.getByLabel("移出原因").or(page.locator("#remove-staff-reason")).first();
      await expect(rmReason).toBeVisible();
      await rmReason.fill("助教工作交接完成");
      await page.getByRole("button", { name: /确认移除|确定/ }).last().click();

      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.staff.length).toBe(2);
      expect(errors).toEqual([]);
    });
  });

  test.describe("F8: Student-Side Non-Regression & Student->Backend->Teacher Flows", () => {
    test("F8-T1-1 Student /home renders baseline panels with untouched student shell", async ({ page }) => {
      const { errors } = await setupActorPage(page, "student");
      await page.goto("/home");

      await expect(page.getByRole("heading", { level: 1, name: "首页" })).toBeVisible();
      await expect(page.getByText("我的项目").first()).toBeVisible();
      await expect(page.getByText("我的课程").first()).toBeVisible();
      await expect(page.getByRole("link", { name: "加入课程" }).first()).toBeVisible();
      await assertStudentShellUntouched(page);
      expect(errors).toEqual([]);
    });

    test("F8-T1-2 Student /courses renders tabs, search filtering, and untouched shell", async ({ page }) => {
      const { errors } = await setupActorPage(page, "student");
      await page.goto("/courses");

      await expect(page.getByRole("heading", { level: 1, name: "我的课程" })).toBeVisible();
      for (const tab of ["全部课程", "进行中", "已结束"]) {
        await expect(page.getByRole("tab", { name: new RegExp(tab) })).toBeVisible();
      }
      await expect(page.getByText("软件工程实践").first()).toBeVisible();

      await page.locator("#b-course-search").fill("SE-2026-01");
      await page.getByRole("button", { name: "搜索" }).click();
      await expect(page.getByText("软件工程实践").first()).toBeVisible();
      await assertStudentShellUntouched(page);
      expect(errors).toEqual([]);
    });

    test("F8-T1-3 Student /courses/join completes 3-step invite preview and join flow", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      store.courses.get(TW_COURSE_1_ID)!.joinRequests = [];
      const { errors } = await setupActorPage(page, "outsider", store);
      await page.goto("/courses/join");

      await expect(page.getByRole("heading", { level: 1, name: "加入课程" })).toBeVisible();
      await expect(page.locator('ol[aria-label="加入步骤"]')).toBeVisible();

      await page.locator("#b-invite-code").fill("TW-SE01");
      await page.getByRole("button", { name: "下一步" }).click();

      await expect(page.getByText("软件工程实践").first()).toBeVisible();
      await page.getByRole("button", { name: /确认加入/ }).click();

      await expect(page.getByRole("heading", { name: /已加入《软件工程实践》/ })).toBeVisible();
      await expect(page.getByRole("link", { name: "开始组队" })).toBeVisible();
      expect(store.courses.get(TW_COURSE_1_ID)?.roster.some((s) => s.id === TW_OUTSIDER_ID)).toBe(true);
      await assertStudentShellUntouched(page);
      expect(errors).toEqual([]);
    });

    test("F8-T1-4 Student /projects/[id] and /setup render Setup Center and add text material", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "student");
      await page.goto(`/projects/${TW_PROJECT_1_ID}`);

      await expect(page.getByRole("heading", { level: 1, name: "智能协作教学平台" })).toBeVisible();
      await expect(page.getByText("项目状态").first()).toBeVisible();
      await expect(page.locator("#project-members")).toBeVisible();
      await assertStudentShellUntouched(page);

      await page.goto(`/projects/${TW_PROJECT_1_ID}/setup`);
      await expect(page.getByText("项目立项说明").first()).toBeVisible();
      await page.getByLabel(/标题/).fill("架构补充说明");
      await page.getByLabel("正文").fill("新增前后端分离契约描述。");
      await page.getByRole("button", { name: "添加文本资料" }).click();
      await expect.poll(() => store.projects.get(TW_PROJECT_1_ID)?.materials.length).toBeGreaterThanOrEqual(2);
      expect(errors).toEqual([]);
    });

    test("F8-T1-5 Student /projects/[id]/files renders filter controls and file list", async ({ page }) => {
      const { errors } = await setupActorPage(page, "student");
      await page.goto(`/projects/${TW_PROJECT_1_ID}/files`);

      await expect(page.getByRole("heading", { level: 1, name: "项目资料" })).toBeVisible();
      await expect(page.getByText("architecture-v1.pdf")).toBeVisible();
      await expect(page.getByLabel("资料分类")).toBeVisible();
      await expect(page.getByLabel("版本状态")).toBeVisible();
      await expect(page.getByRole("button", { name: "查询资料" })).toBeVisible();
      await expect(page.getByRole("button", { name: "重置" })).toBeVisible();
      await assertStudentShellUntouched(page);
      expect(errors).toEqual([]);
    });
  });
});
