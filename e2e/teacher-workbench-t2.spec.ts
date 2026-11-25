import { expect, test, type Page } from "@playwright/test";
import {
  TW_ANNOUNCEMENT_1_ID,
  TW_COURSE_1_ID,
  TW_COURSE_2_ID,
  TW_GROUP_1_ID,
  TW_JOIN_REQ_1_ID,
  TW_PROJECT_1_ID,
  TW_STUDENT_1_ID,
  TW_STUDENT_3_ID,
  createTeacherWorkbenchStore,
  installTeacherWorkbenchMocks,
  type InstallTeacherWorkbenchMocksOptions,
  type MockActor,
  type TeacherWorkbenchStore,
} from "./fixtures/teacher-workbench-mock-api";
import {
  assertMotionAndReducedMotion,
  assertNoHorizontalOverflow,
  assertStudentShellUntouched,
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

function nonHttp4xxErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.includes("Failed to load resource"));
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

test.describe("Teacher Workbench Tier 2 — Boundary & Corner Cases", () => {
  test.describe("F1: Shell, Empty States, Shortcuts & Responsive Boundaries", () => {
    test("F1-T2-1 Empty teacher dashboard with zero classes renders safely", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      store.courses.clear();
      store.projects.clear();
      const { errors } = await setupActorPage(page, "teacher", store);

      await page.goto("/teacher/dashboard");
      await expect(page.getByRole("heading", { level: 1, name: "教师工作台" })).toBeVisible();
      await expect(page.getByText("0").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F1-T2-2 Long course name renders without breaking layout or throwing errors", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      const longName = "超长课程名称测试_分布式高并发微服务架构与云原生工程实践综合实训课程_2026秋季学期_计算机科学与工程学院";
      store.courses.get(TW_COURSE_1_ID)!.name = longName;
      const { errors } = await setupActorPage(page, "teacher", store);

      await page.goto("/teacher/courses");
      await expect(page.getByText(longName).first()).toBeVisible();
      await page.goto("/teacher/dashboard");
      await expect(page.getByText(longName).first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F1-T2-3 [post-m2] Cmd/Ctrl+K and single-key j/k/1 do not hijack focused inputs", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto("/teacher/courses");

      const searchInput = page.getByLabel("搜索班级名称或代码");
      await searchInput.click();
      await page.keyboard.type("jk1");
      await expect(searchInput).toHaveValue("jk1");
      await expect(page).toHaveURL(/\/teacher\/courses$/);

      await searchInput.blur();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      await expect(page.getByRole("dialog").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F1-T2-4 [post-m2] Teacher routes have zero horizontal overflow at 375/768/1280/1440px", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      for (const route of [
        "/teacher/dashboard",
        `/teacher/courses/${TW_COURSE_1_ID}`,
        `/teacher/courses/${TW_COURSE_1_ID}/groups`,
      ]) {
        await page.goto(route);
        await assertNoHorizontalOverflow(page, [375, 768, 1280, 1440]);
      }
      expect(errors).toEqual([]);
    });

    test("F1-T2-5 [post-m2] All legacy teacher course routes including member-changes and files?version=1 render inside Teacher layout", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      const subRoutes = [
        "",
        "/groups",
        `/groups/${TW_GROUP_1_ID}`,
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

      for (const sub of subRoutes) {
        const res = await page.goto(`/teacher/courses/${TW_COURSE_1_ID}${sub}`);
        expect(res?.status() ?? 0).toBeLessThan(400);
        await expect(page.locator(".gp-teacher-shell").first()).toBeVisible();
        await expect(page.getByText("页面不存在")).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    });
  });

  test.describe("F2: Class Creation Validation, 409 Conflicts, Esc & Empty Roster", () => {
    test("F2-T2-1 Create-class rejects missing required fields and min > max group size", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      const beforeCount = store.courses.size;
      await page.goto("/teacher/courses");

      await page.getByRole("button", { name: "创建班级" }).click();
      await page.getByRole("button", { name: "确认创建并生成邀请码" }).click();
      expect(store.courses.size).toBe(beforeCount);

      await page.locator("#create-class-name").fill("边界测试班级");
      await page.locator("#create-class-term").fill("2026-Autumn");
      await page.locator("#create-class-college").fill("计算机学院");
      await page.locator("#create-class-min-size").fill("5");
      await page.locator("#create-class-max-size").fill("2");
      await page.locator("#create-class-project-deadline").fill("2027-01-20T23:59");
      await page.getByRole("button", { name: "确认创建并生成邀请码" }).click();

      expect(store.courses.size).toBe(beforeCount);
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F2-T2-2 Create-class surfaces 409 COURSE_CODE_CONFLICT error", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto("/teacher/courses");

      await page.getByRole("button", { name: "创建班级" }).click();
      await page.locator("#create-class-name").fill("冲突课程");
      await page.locator("#create-class-term").fill("2026-Autumn");
      await page.locator("#create-class-college").fill("计算机学院");
      await page.locator("#create-class-code").fill("SE-2026-01");
      await page.locator("#create-class-project-deadline").fill("2027-01-20T23:59");
      await page.getByRole("button", { name: "确认创建并生成邀请码" }).click();

      await expect(page.getByRole("alert").filter({ hasText: /班级编码已存在|冲突/ })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F2-T2-3 [post-m3] Invite code rotate handles 409 VERSION_CONFLICT with visible error", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher", createTeacherWorkbenchStore(), {
        errorOverrides: {
          [`POST /api/v1/teacher/classes/${TW_COURSE_1_ID}/invite-code/rotate`]: {
            status: 409,
            code: "VERSION_CONFLICT",
            message: "班级版本已变更",
          },
        },
      });
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      const invitePill = page.locator('button[title*="邀请码"]').first();
      await expect(invitePill).toBeVisible();
      await invitePill.click();

      const dialog = page.getByRole("dialog").filter({ hasText: "邀请码" }).first();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "重置邀请码" }).click();
      await dialog.getByRole("button", { name: "确认重置" }).click();
      await expect(dialog.getByRole("alert").filter({ hasText: /版本|冲突/ })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F2-T2-4 [post-m2] Esc closes StudentProfileDrawer and Quick Switcher dialog", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      const sidebar = await ensureRosterOpen(page);
      await sidebar.getByTestId(`student-entity-${TW_STUDENT_3_ID}`).click();
      const drawer = page.getByRole("dialog").filter({ hasText: "王同学" }).first();
      await expect(drawer).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);

      await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
      await expect(page.getByRole("dialog").first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test("F2-T2-5 Empty roster search and empty class roster render clean empty states", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      const sidebar = await ensureRosterOpen(page);
      await sidebar.getByLabel("搜索班级学生").fill("不存在的学生XYZ");
      await expect(sidebar.locator('[data-testid^="student-entity-"]')).toHaveCount(0);

      await page.goto(`/teacher/courses/${TW_COURSE_2_ID}`);
      const sidebar2 = await ensureRosterOpen(page);
      await expect(sidebar2).toContainText("共 0 人");
      expect(errors).toEqual([]);
    });
  });

  test.describe("F3: Team Plaza & Group Detail Boundary Cases", () => {
    test("F3-T2-1 Empty Team Plaza renders empty groups and ungrouped pool cleanly", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_2_ID}/groups`);

      await expect(page.getByRole("heading", { level: 1, name: "学生组队广场" })).toBeVisible();
      await expect(page.locator('[data-testid^="team-card-"]')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test("F3-T2-2 Duplicate group name surfaces 409 GROUP_NAME_TAKEN", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);

      await expect(page.getByRole("heading", { level: 1, name: "学生组队广场" })).toBeVisible();
      const toggleBtn = page.getByRole("button", { name: "新建队伍" });
      await expect(toggleBtn).toBeVisible();
      await toggleBtn.click();

      const groupNameInput = page.locator("#plaza-new-group-name");
      await expect(groupNameInput).toBeVisible();
      await groupNameInput.fill("第一组 · 飞书协同");
      await page.getByRole("button", { name: "确认创建队伍" }).click();

      await expect(page.getByRole("alert").filter({ hasText: /小组名称已存在|冲突/ })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F3-T2-3 Assign and setLeader surface 409 VERSION_CONFLICT errors", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher", createTeacherWorkbenchStore(), {
        errorOverrides: {
          [`POST /api/v1/teacher/classes/${TW_COURSE_1_ID}/assignments`]: {
            status: 409,
            code: "VERSION_CONFLICT",
            message: "目标小组版本冲突",
          },
          [`POST /api/v1/teacher/classes/${TW_COURSE_1_ID}/groups/${TW_GROUP_1_ID}/leader`]: {
            status: 409,
            code: "VERSION_CONFLICT",
            message: "小组版本冲突",
          },
        },
      });
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);

      const pool = page.getByTestId("ungrouped-pool-dropzone");
      await pool.getByLabel("将 王同学 分配到").selectOption({ label: "第二组 · 智能评测" });
      await expect(page.getByRole("alert").filter({ hasText: /版本冲突|刚被更新|请重试/ })).toBeVisible();

      const group1Card = page.getByTestId(`team-card-${TW_GROUP_1_ID}`);
      await group1Card.getByRole("button", { name: "设为队长" }).first().click();
      await expect(page.getByRole("alert").filter({ hasText: /版本冲突|刚被更新|请重试/ })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F3-T2-4 [post-m3] Team Plaza and Group Detail render visible non-sr-only role=\"status\" feedback", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);

      const pool = page.getByTestId("ungrouped-pool-dropzone");
      await pool.getByLabel("将 王同学 分配到").selectOption({ label: "第二组 · 智能评测" });

      const statusBoxes = await page.locator('[role="status"]').evaluateAll((els) =>
        els
          .filter((el) => !el.classList.contains("sr-only"))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { text: (el.textContent || "").trim(), width: r.width, height: r.height };
          })
          .filter((x) => x.width > 0 && x.height > 0 && x.text.length > 0),
      );
      expect(statusBoxes.length).toBeGreaterThan(0);

      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups/${TW_GROUP_1_ID}`);
      await page.getByRole("button", { name: "设为队长" }).first().click();
      const detailStatusBoxes = await page.locator('[role="status"]').evaluateAll((els) =>
        els
          .filter((el) => !el.classList.contains("sr-only"))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { text: (el.textContent || "").trim(), width: r.width, height: r.height };
          })
          .filter((x) => x.width > 0 && x.height > 0 && x.text.length > 0),
      );
      expect(detailStatusBoxes.length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    });

    test("F3-T2-5 Frozen roster group blocks reassignment in Team Plaza", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      const group1 = store.courses.get(TW_COURSE_1_ID)!.groups[0];
      group1.roster_frozen = true;
      group1.locked_reason = "已立项冻结";
      const { errors } = await setupActorPage(page, "teacher", store);

      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/groups`);
      const group1Card = page.getByTestId(`team-card-${TW_GROUP_1_ID}`);
      await expect(group1Card).toContainText(/冻结|锁定/);

      const select = page.getByTestId("ungrouped-pool-dropzone").getByLabel("将 王同学 分配到");
      await expect(select).toBeVisible();
      const optionExists = await select.locator(`option[value="${TW_GROUP_1_ID}"]:not([disabled])`).count();
      expect(optionExists).toBe(0);
      expect(errors).toEqual([]);
    });
  });

  test.describe("F4: Hub 3 — Actions & Appeals Validation & Failure Cases", () => {
    test("F4-T2-1 Empty Actions Center and Appeals Center render empty states", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_2_ID}/actions`);
      await expect(page.getByRole("heading", { level: 1, name: "审批与操作中心" })).toBeVisible();

      await page.goto(`/teacher/courses/${TW_COURSE_2_ID}/appeals`);
      await expect(page.getByRole("heading", { level: 1, name: "申诉与争议处理" })).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F4-T2-2 Rejecting an action without reason is blocked by validation", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/actions`);

      await page.getByRole("button", { name: "拒绝" }).first().click();
      await page.locator("#action-reason-input").fill("   ");
      await expect(page.getByRole("button", { name: "确认提交" })).toBeDisabled();
      expect(store.courses.get(TW_COURSE_1_ID)?.joinRequests[0].status).toBe("pending");
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F4-T2-3 Handling an already-decided join request surfaces 409 JOIN_REQUEST_DECIDED", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher", createTeacherWorkbenchStore(), {
        errorOverrides: {
          [`POST /api/v1/teacher/classes/${TW_COURSE_1_ID}/actions/join:${TW_JOIN_REQ_1_ID}/handle`]: {
            status: 409,
            code: "JOIN_REQUEST_DECIDED",
            message: "入班申请已处理",
          },
        },
      });
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/actions`);

      await page.getByRole("button", { name: "同意加入" }).first().click();
      await expect(
        page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /已处理|JOIN_REQUEST_DECIDED/ }).first(),
      ).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F4-T2-4 Appeal adjudication toggles contribution share inputs via checkbox and blocks empty/whitespace reason", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/appeals`);

      await expect(page.getByRole("heading", { level: 1, name: "申诉与争议处理" })).toBeVisible();
      await page.getByText("前端重构任务权重核对申诉").first().click();

      const adjustCheckbox = page.getByLabel(/受理时同步调整上方贡献度占比并生成新冻结快照/);
      await expect(adjustCheckbox).toBeVisible();

      const shareInputs = page.locator('input[type="number"]');
      await expect(shareInputs).toHaveCount(0);

      await adjustCheckbox.check();
      await expect(shareInputs.first()).toBeVisible();
      expect(await shareInputs.count()).toBeGreaterThanOrEqual(2);
      await shareInputs.nth(0).fill("40");
      await shareInputs.nth(1).fill("40");

      await page.locator("#appeal-reason").fill("   ");
      const acceptBtn = page.getByRole("button", { name: /受理申诉|接受并生成新快照/ }).first();
      await expect(acceptBtn).toBeDisabled();
      await expect(page.getByRole("button", { name: "驳回申诉" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "要求补充材料" })).toBeDisabled();

      expect(store.courses.get(TW_COURSE_1_ID)?.appeals[0].status).toBe("pending");
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F4-T2-5 Batch action reports partial failure summary when one item is already decided", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      const course1 = store.courses.get(TW_COURSE_1_ID)!;
      course1.joinRequests[0].status = "approved";
      course1.actions.push({
        id: "notification:tw-notif-1",
        source_id: "tw-notif-1",
        type: "notification",
        priority: "normal",
        status: "pending",
        title: "周报提交提醒通知",
        description: "系统提醒查看本周项目周报摘要",
        course_id: TW_COURSE_1_ID,
        group_id: null,
        project_id: null,
        subject_user_id: null,
        href: `/teacher/courses/${TW_COURSE_1_ID}/actions`,
        available_actions: [
          { key: "mark_read", label: "标为已读", requires_reason: false, confirm_text: null, style: "secondary" },
        ],
        created_at: new Date().toISOString(),
        handled_at: null,
        handled_by: null,
        decision: null,
        decision_reason: null,
      });
      const { errors } = await setupActorPage(page, "teacher", store);
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/actions`);

      await expect(page.getByRole("heading", { level: 1, name: "审批与操作中心" })).toBeVisible();
      const checkboxes = page.locator('input[type="checkbox"][aria-label^="选择 "]');
      await expect(checkboxes.first()).toBeVisible();
      const cbCount = await checkboxes.count();
      expect(cbCount).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < cbCount; i += 1) {
        await checkboxes.nth(i).check();
      }
      const batchBtn = page.getByRole("button", { name: /全部标记已读|批量同意|批量批准|批量通过/ }).first();
      await expect(batchBtn).toBeVisible();
      await batchBtn.click();
      await expect(
        page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /批量处理完成：成功 [1-9]\d* 项，未完成 [1-9]\d* 项/ }).first(),
      ).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });
  });

  test.describe("F5: Hub 4 — Projects & Reports Edge Cases", () => {
    test("F5-T2-1 Empty Projects risk filter renders empty state cleanly", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      const proj = store.projects.get(TW_PROJECT_1_ID)!;
      proj.risk_level = "low";
      for (const m of proj.milestones) {
        m.overdue = false;
      }
      const { errors } = await setupActorPage(page, "teacher", store);
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);

      await page.getByRole("tab", { name: /风险预警/ }).first().click();
      await expect(page.getByText("智能协作教学平台")).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test("F5-T2-2 Uninitialized group displays 催促立项 button and sends reminder", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      const group2 = store.courses.get(TW_COURSE_1_ID)!.groups[1];
      group2.member_ids = [TW_STUDENT_3_ID];
      group2.leader_id = TW_STUDENT_3_ID;
      const { errors } = await setupActorPage(page, "teacher", store);
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);

      const urgeBtn = page.getByRole("button", { name: "催促立项" }).first();
      await expect(urgeBtn).toBeVisible();
      await urgeBtn.click();
      await expect(page.getByRole("status").first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F5-T2-3 Projects remind error displays role=\"alert\" cleanly", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher", createTeacherWorkbenchStore(), {
        errorOverrides: {
          [`POST /api/v1/teacher/classes/${TW_COURSE_1_ID}/projects/${TW_GROUP_1_ID}/remind`]: {
            status: 403,
            code: "PERMISSION_DENIED",
            message: "无权发送项目催办",
          },
        },
      });
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/projects`);

      await page.getByRole("button", { name: "发送催办" }).first().click();
      await expect(page.getByRole("alert").filter({ hasText: "无权发送项目催办" })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F5-T2-4 Reports Center on empty class with 0 students avoids NaN or Infinity", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_2_ID}/reports`);

      await expect(page.getByRole("heading", { level: 1, name: "数据报告中心" })).toBeVisible();
      const bodyText = await page.locator("main").innerText();
      expect(bodyText).not.toContain("NaN");
      expect(bodyText).not.toContain("Infinity");
      expect(errors).toEqual([]);
    });

    test("F5-T2-5 Reports export error displays role=\"alert\" cleanly", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher", createTeacherWorkbenchStore(), {
        errorOverrides: {
          [`POST /api/v1/teacher/classes/${TW_COURSE_1_ID}/reports/export`]: {
            status: 403,
            code: "PERMISSION_DENIED",
            message: "缺少导出报告权限",
          },
        },
      });
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/reports`);

      await page.getByRole("button", { name: "导出 CSV / Excel" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "缺少导出报告权限" })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });
  });

  test.describe("F6: Hub 5 — Rules Validation & Settings Danger/Conflict Guards", () => {
    test("F6-T2-1 [post-m4] Rules weight sum != 100% disables Save/Publish with inline hint", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/rules`);

      await expect(page.getByRole("heading", { level: 1, name: "课程规则与评分模板" })).toBeVisible();
      const weightInputs = page
        .locator('#rules-task-weight, #rules-verification-weight, #rules-collaboration-weight, input[name*="weight"]')
        .or(page.getByLabel(/任务完成权重|验收质量权重|协作活跃权重/));
      await expect(weightInputs.first()).toBeVisible();
      expect(await weightInputs.count()).toBeGreaterThanOrEqual(1);
      await weightInputs.first().fill("10");

      await expect(
        page.getByText(/60%|还差\s*40%|差\s*40%|不等于\s*100%|!= 100%|未达\s*100%/).first(),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "保存草稿" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "发布规则" })).toBeDisabled();
      expect(errors).toEqual([]);
    });

    test("F6-T2-2 Rules validates min_group_size > max_group_size and deadline order", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/rules`);

      await expect(page.getByRole("heading", { level: 1, name: "课程规则与评分模板" })).toBeVisible();
      const minInput = page
        .locator('input[name="min_group_size"], #rules-min-group-size')
        .or(page.locator("div").filter({ hasText: /^最小人数$/ }).locator("input"))
        .first();
      const maxInput = page
        .locator('input[name="max_group_size"], #rules-max-group-size')
        .or(page.locator("div").filter({ hasText: /^最大人数$/ }).locator("input"))
        .first();
      await expect(minInput).toBeVisible();
      await expect(maxInput).toBeVisible();
      await minInput.fill("6");
      await maxInput.fill("2");
      await expect(page.getByText(/最小组队人数不能大于最大组队人数|最小人数不能大于最大人数/).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "保存草稿" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "发布规则" })).toBeDisabled();
      expect(store.courses.get(TW_COURSE_1_ID)?.draftRuleVersion).toBeNull();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F6-T2-3 Settings delete course blocks confirm when typed class name mismatches", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);

      await page.getByRole("button", { name: "删除课程" }).click();
      const confirmInput = page.locator("#confirm-class-name-input");
      await expect(confirmInput).toBeVisible();
      await confirmInput.fill("错误的班级名称");

      const confirmDeleteBtn = page.getByRole("button", { name: /确认删除|永久删除/ }).last();
      await expect(confirmDeleteBtn).toBeDisabled();
      expect(store.courses.has(TW_COURSE_1_ID)).toBe(true);

      await confirmInput.fill("软件工程实践");
      await expect(confirmDeleteBtn).toBeEnabled();
      expect(errors).toEqual([]);
    });

    test("F6-T2-4 Settings save surfaces 409 VERSION_CONFLICT cleanly", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher", createTeacherWorkbenchStore(), {
        errorOverrides: {
          [`PATCH /api/v1/teacher/classes/${TW_COURSE_1_ID}/settings`]: {
            status: 409,
            code: "VERSION_CONFLICT",
            message: "设置版本已变更",
          },
        },
      });
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);

      await page.getByRole("button", { name: "保存修改" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "设置版本已变更" })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F6-T2-5 Non-owner TA cannot delete course in Settings", async ({ page }) => {
      const { errors } = await setupActorPage(page, "ta");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/settings`);

      await expect(page.getByRole("heading", { level: 1, name: "班级设置" })).toBeVisible();
      const deleteBtn = page.getByRole("button", { name: "删除课程" });
      if ((await deleteBtn.count()) > 0) {
        await expect(deleteBtn).toBeDisabled();
      } else {
        await expect(deleteBtn).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    });
  });

  test.describe("F7: Hub 5 — Files/Announcements/Staff Guards & Pending Safety", () => {
    test("F7-T2-1 Duplicate folder returns 409 FOLDER_NAME_DUPLICATE and empty course shows empty state", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/files`);

      await page.getByRole("button", { name: "新建文件夹" }).click();
      await page.getByLabel("新文件夹名称").fill("课程大纲与模板");
      await page.getByRole("button", { name: "确认创建" }).click();

      await expect(page.getByRole("alert").filter({ hasText: "同名文件夹已存在" })).toBeVisible();

      await page.goto(`/teacher/courses/${TW_COURSE_2_ID}/files`);
      await expect(page.getByRole("heading", { level: 1, name: "课程资料中心" })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F7-T2-2 [post-m4] Course Files 2-step delete confirm keeps file on Cancel and deletes on Confirm", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/files`);

      await page.getByRole("button", { name: /课程大纲与模板/ }).click();
      const fileBtn = page.getByRole("button", { name: "实验指导书.pdf" }).first();
      await expect(fileBtn).toBeVisible();
      await fileBtn.click();

      const deleteBtn = page.getByRole("button", { name: "删除资料" }).first();
      await expect(deleteBtn).toBeVisible();
      await deleteBtn.click();
      await expect(page.getByRole("button", { name: "确认删除" }).last()).toBeVisible();
      await page.getByRole("button", { name: "取消" }).last().click();
      await expect(page.getByRole("heading", { name: "实验指导书.pdf" })).toBeVisible();
      expect(store.courses.get(TW_COURSE_1_ID)?.materials.length).toBe(1);

      await deleteBtn.click();
      await page.getByRole("button", { name: "确认删除" }).last().click();
      await expect(page.getByText("实验指导书.pdf")).toHaveCount(0);
      await expect.poll(() => store.courses.get(TW_COURSE_1_ID)?.materials.length).toBe(0);
      expect(errors).toEqual([]);
    });

    test("F7-T2-3 [post-m4] Pending mutation buttons disable during latencyMs=600 preventing double-submit", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      const { errors } = await setupActorPage(page, "teacher", store, { latencyMs: 600 });

      let postCount = 0;
      page.on("request", (req) => {
        if (req.url().includes("/announcements") && req.method() === "POST") postCount += 1;
      });

      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/announcements`);
      await page.getByRole("button", { name: "发布新公告" }).click();
      await page.getByLabel("公告标题").fill("防抖测试公告");
      await page.getByLabel("公告正文").fill("验证按钮在请求期间处于禁用状态。");
      const publishBtn = page.getByRole("button", { name: "立即发布" });
      await publishBtn.click();
      await expect(publishBtn).toBeDisabled();

      await expect.poll(() => postCount).toBe(1);
      expect(errors).toEqual([]);
    });

    test("F7-T2-4 Announcements rejects empty title or empty content", async ({ page }) => {
      const { store, errors } = await setupActorPage(page, "teacher");
      const before = store.courses.get(TW_COURSE_1_ID)!.announcements.length;
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/announcements`);

      await page.getByRole("button", { name: "发布新公告" }).click();
      await expect(page.getByRole("button", { name: "立即发布" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "存为草稿" })).toBeDisabled();
      expect(store.courses.get(TW_COURSE_1_ID)!.announcements.length).toBe(before);
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F7-T2-5 Non-owner TA is blocked from Staff owner management actions", async ({ page }) => {
      const { errors } = await setupActorPage(page, "ta");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}/staff`);

      await expect(page.getByRole("heading", { level: 1, name: "助教管理" })).toBeVisible();
      const inviteBtn = page.getByRole("button", { name: "发送邀请" });
      if ((await inviteBtn.count()) > 0) {
        await expect(inviteBtn).toBeDisabled();
      } else {
        await expect(inviteBtn).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    });
  });

  test.describe("F8: Student-Side Boundary Cases & Reduced Motion", () => {
    test("F8-T2-1 Student /courses/join displays role=\"alert\" on empty or invalid invite code", async ({ page }) => {
      const { errors } = await setupActorPage(page, "student");
      await page.goto("/courses/join");

      await page.getByRole("button", { name: "下一步" }).click();
      await expect(page.getByRole("alert").first()).toBeVisible();

      await page.locator("#b-invite-code").fill("INVALID-999");
      await page.getByRole("button", { name: "下一步" }).click();
      await expect(page.getByRole("alert").filter({ hasText: /邀请码无效|未找到|操作失败/ })).toBeVisible();
      expect(nonHttp4xxErrors(errors)).toEqual([]);
    });

    test("F8-T2-2 Student /courses empty search shows zero matching cards cleanly", async ({ page }) => {
      const { errors } = await setupActorPage(page, "student");
      await page.goto("/courses");

      await page.locator("#b-course-search").fill("NO_SUCH_COURSE_XYZ");
      await page.getByRole("button", { name: "搜索" }).click();
      await expect(page.getByText("当前筛选下暂无课程")).toBeVisible();
      expect(errors).toEqual([]);
    });

    test("F8-T2-3 Student AnnouncementBanner stays hidden when 0 unread announcements exist", async ({ page }) => {
      const store = createTeacherWorkbenchStore();
      const ann = store.courses.get(TW_COURSE_1_ID)!.announcements.find((a) => a.id === TW_ANNOUNCEMENT_1_ID)!;
      ann.read_by[TW_STUDENT_1_ID] = "2026-11-22T10:00:00Z";
      const { errors } = await setupActorPage(page, "student", store);

      await page.goto("/home");
      await expect(page.getByRole("heading", { level: 1, name: "首页" })).toBeVisible();
      await expect(page.getByRole("button", { name: /展开查看|收起并标为已读/ })).toHaveCount(0);

      await page.goto("/courses");
      await expect(page.getByRole("heading", { level: 1, name: "我的课程" })).toBeVisible();
      await expect(page.getByRole("button", { name: /展开查看|收起并标为已读/ })).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test("F8-T2-4 Student shell isolation holds across /home, /courses, and /projects/[id]", async ({ page }) => {
      const { errors } = await setupActorPage(page, "student");
      for (const route of ["/home", "/courses", `/projects/${TW_PROJECT_1_ID}`]) {
        await page.goto(route);
        await assertStudentShellUntouched(page);
      }
      expect(errors).toEqual([]);
    });

    test("F8-T2-5 [post-m2] Teacher motion tokens and prefers-reduced-motion collapse durations <= 1ms", async ({ page }) => {
      const { errors } = await setupActorPage(page, "teacher");
      await page.goto(`/teacher/courses/${TW_COURSE_1_ID}`);

      await assertMotionAndReducedMotion(page);
      expect(errors).toEqual([]);
    });
  });
});
