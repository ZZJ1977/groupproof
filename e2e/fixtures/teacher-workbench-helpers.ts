import { expect, type Locator, type Page } from "@playwright/test";

const EXPECTED_TEACHER_CANVAS_RGB = "rgb(245, 246, 247)";
const EXPECTED_TEACHER_ACTION_RGB = "rgb(51, 112, 255)";
const EXPECTED_STUDENT_CANVAS_RGB = "rgb(248, 250, 252)";
const EXPECTED_STUDENT_ACTION_RGB = "rgb(3, 105, 161)";

function viewportHeightForWidth(width: number): number {
  if (width <= 480) return 812;
  if (width <= 900) return 1024;
  if (width <= 1360) return 800;
  return 900;
}

/**
 * Checklist A4: Assert zero horizontal overflow across responsive widths.
 */
export async function assertNoHorizontalOverflow(
  page: Page,
  widths: number[] = [375, 768, 1280, 1440],
): Promise<void> {
  const originalViewport = page.viewportSize();
  try {
    for (const width of widths) {
      const height = viewportHeightForWidth(width);
      await page.setViewportSize({ width, height });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(
        metrics.scrollWidth,
        `Horizontal overflow detected at ${width}px: scrollWidth (${metrics.scrollWidth}) > innerWidth (${metrics.innerWidth})`,
      ).toBeLessThanOrEqual(metrics.innerWidth);
    }
  } finally {
    if (originalViewport) {
      await page.setViewportSize(originalViewport);
    }
  }
}

/**
 * Checklist A1: Course context nav has <= 6 visible primary items, single-row
 * scrollHeight <= 60px at 1280px, and no duplicated 12-item sidebar nav.
 */
export async function assertSingleRowCourseNav(page: Page): Promise<void> {
  const originalViewport = page.viewportSize();
  const needsResize = !originalViewport || originalViewport.width < 1280;
  try {
    if (needsResize) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
    }

    const navMetrics = await page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const htmlEl = el as HTMLElement;
        const style = window.getComputedStyle(htmlEl);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const candidateSelectors = [
        '[data-testid="teacher-course-nav"]',
        'nav[aria-label="班级管理子导航"]',
        'nav[aria-label="课程中心导航"]',
        'nav[aria-label*="班级"]',
        'nav[aria-label*="课程"]',
      ];

      let courseNav: HTMLElement | null = null;
      for (const selector of candidateSelectors) {
        const matches = Array.from(document.querySelectorAll(selector));
        const visibleMatch = matches.find((node) => isVisible(node));
        if (visibleMatch) {
          courseNav = visibleMatch as HTMLElement;
          break;
        }
      }

      if (!courseNav) {
        return { found: false as const };
      }

      const rawItems = Array.from(courseNav.querySelectorAll("a, button"));
      const topLevelItems = rawItems.filter((el) => {
        if (!isVisible(el)) return false;
        let parent = el.parentElement;
        while (parent && parent !== courseNav) {
          if (parent.tagName === "A" || parent.tagName === "BUTTON") {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      });

      const sidebarNav = document.querySelector("aside.gp-sidebar nav.gp-nav");
      let sidebarCourseSubLinks = 0;
      if (sidebarNav && isVisible(sidebarNav)) {
        const subRouteRe =
          /^\/teacher\/courses\/[^/]+(?:\/(?:groups|actions|projects|reports|rules|files|announcements|appeals|member-changes|staff|settings))?$/;
        const sidebarLinks = Array.from(sidebarNav.querySelectorAll("a"));
        sidebarCourseSubLinks = sidebarLinks.filter((link) => {
          if (!isVisible(link)) return false;
          const href = link.getAttribute("href") || "";
          const path = href.split("?")[0];
          return subRouteRe.test(path);
        }).length;
      }

      return {
        found: true as const,
        visibleItemCount: topLevelItems.length,
        scrollHeight: courseNav.scrollHeight,
        sidebarCourseSubLinks,
      };
    });

    expect(navMetrics.found, "Expected visible Teacher course context <nav>").toBe(true);
    if (!navMetrics.found) return;

    expect(
      navMetrics.visibleItemCount,
      `Expected <= 6 primary items in course context nav, found ${navMetrics.visibleItemCount}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      navMetrics.visibleItemCount,
      `Expected <= 6 primary items in course context nav, found ${navMetrics.visibleItemCount}`,
    ).toBeLessThanOrEqual(6);

    expect(
      navMetrics.scrollHeight,
      `Expected single-row course nav scrollHeight <= 60px, got ${navMetrics.scrollHeight}px`,
    ).toBeLessThanOrEqual(60);

    expect(
      navMetrics.sidebarCourseSubLinks,
      `Sidebar nav duplicates ${navMetrics.sidebarCourseSubLinks} course sub-links alongside course context bar`,
    ).toBeLessThanOrEqual(6);
  } finally {
    if (needsResize && originalViewport) {
      await page.setViewportSize(originalViewport);
    }
  }
}

/**
 * Checklist A2: At most 1 full InviteCodeCard / [data-testid="teacher-invite-code"]
 * visible simultaneously on Class Home.
 */
export async function assertSingleInviteCard(page: Page): Promise<void> {
  const counts = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = htmlEl.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const inviteCodes = Array.from(
      document.querySelectorAll('[data-testid="teacher-invite-code"]'),
    ).filter(isVisible);

    const inviteCardButtons = Array.from(document.querySelectorAll("button")).filter(
      (btn) => isVisible(btn) && (btn.innerText || "").trim() === "复制加入链接",
    );

    return {
      visibleInviteCodes: inviteCodes.length,
      visibleFullInviteCards: inviteCardButtons.length,
    };
  });

  expect(
    counts.visibleInviteCodes,
    `Expected <= 1 visible [data-testid="teacher-invite-code"], found ${counts.visibleInviteCodes}`,
  ).toBeLessThanOrEqual(1);
  expect(
    counts.visibleFullInviteCards,
    `Expected <= 1 visible full InviteCodeCard ("复制加入链接"), found ${counts.visibleFullInviteCards}`,
  ).toBeLessThanOrEqual(1);
}

/**
 * Checklist B1: <= 1 primary CTA per header/toolbar/card-footer;
 * <= 2 total action buttons/links in any card footer.
 */
export async function assertPrimaryCtaCaps(
  page: Page,
  containerLocator: Locator,
): Promise<void> {
  void page;
  const count = await containerLocator.count();
  expect(count, "Expected at least 1 container for assertPrimaryCtaCaps").toBeGreaterThan(0);

  const violations = await containerLocator.evaluateAll((elements) => {
    const isVisible = (el: Element): boolean => {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      const rect = htmlEl.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const parseRgb = (raw: string): [number, number, number, number] | null => {
      const match = raw.match(
        /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)/i,
      );
      if (!match) return null;
      return [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] !== undefined ? Number(match[4]) : 1,
      ];
    };

    const isPrimaryCta = (el: HTMLElement): boolean => {
      const variant = el.dataset.variant;
      if (variant === "default" || variant === "primary") return true;
      if (
        variant &&
        ["outline", "ghost", "secondary", "tonal", "link", "destructive"].includes(variant)
      ) {
        return false;
      }
      const style = window.getComputedStyle(el);
      const bg = parseRgb(style.backgroundColor);
      const fg = parseRgb(style.color);
      if (!bg || !fg || bg[3] < 0.5) return false;
      const [r, g, b] = bg;
      const [fr, fgC, fb] = fg;
      const isFilledBlue = b > 140 && b > r + 40 && b >= g;
      const isLightText = fr > 200 && fgC > 200 && fb > 200;
      return isFilledBlue && isLightText;
    };

    const issues: string[] = [];

    elements.forEach((root, index) => {
      if (!isVisible(root)) return;
      const rootEl = root as HTMLElement;

      const rootTestId = rootEl.getAttribute("data-testid") || "";
      const isWholeCard =
        rootEl.tagName === "ARTICLE" ||
        rootTestId.includes("card") ||
        rootEl.classList.contains("gp-panel");

      const footerTarget = isWholeCard
        ? (rootEl.querySelector(
            'footer, [data-card-footer], [data-testid*="footer"], .card-footer',
          ) as HTMLElement | null) ||
          (() => {
            const candidateDivs = Array.from(rootEl.children).filter(
              (child) =>
                isVisible(child) &&
                child.tagName !== "HEADER" &&
                child.tagName !== "NAV" &&
                child.querySelectorAll("a, button").length > 0,
            );
            return (candidateDivs[candidateDivs.length - 1] as HTMLElement | undefined) ?? rootEl;
          })()
        : rootEl;

      const isExplicitFooter =
        rootEl.tagName === "FOOTER" ||
        rootEl.hasAttribute("data-card-footer") ||
        rootTestId.includes("footer") ||
        rootEl.className.toString().toLowerCase().includes("footer") ||
        Boolean(rootEl.closest('[data-testid*="card"], article, .gp-panel') && rootEl.tagName !== "HEADER" && rootEl.tagName !== "NAV" && rootEl.getAttribute("role") !== "toolbar");

      const collectActions = (scope: HTMLElement): HTMLElement[] =>
        Array.from(scope.querySelectorAll("a, button")).filter((node) => {
          if (!isVisible(node)) return false;
          if (scope.tagName === "HEADER" && node.closest("nav")) return false;
          if (node.closest('[role="tablist"]')) return false;
          let parent = node.parentElement;
          while (parent && parent !== scope) {
            if (parent.tagName === "A" || parent.tagName === "BUTTON") return false;
            parent = parent.parentElement;
          }
          return true;
        }) as HTMLElement[];

      const headerOrScopeActions = collectActions(rootEl);
      const primaryCount = headerOrScopeActions.filter(isPrimaryCta).length;
      if (primaryCount > 1) {
        issues.push(
          `Container[${index}] (${rootTestId || rootEl.tagName.toLowerCase()}) has ${primaryCount} primary CTAs (expected <= 1)`,
        );
      }

      if (isWholeCard) {
        const footerActions = collectActions(footerTarget);
        const footerPrimary = footerActions.filter(isPrimaryCta).length;
        if (footerPrimary > 1) {
          issues.push(
            `Card[${index}] footer (${rootTestId || rootEl.tagName.toLowerCase()}) has ${footerPrimary} primary CTAs (expected <= 1)`,
          );
        }
        if (footerActions.length > 2) {
          issues.push(
            `Card[${index}] footer (${rootTestId || rootEl.tagName.toLowerCase()}) has ${footerActions.length} actions (expected <= 2)`,
          );
        }
      } else if (isExplicitFooter && headerOrScopeActions.length > 2) {
        issues.push(
          `CardFooter[${index}] (${rootTestId || rootEl.tagName.toLowerCase()}) has ${headerOrScopeActions.length} actions (expected <= 2)`,
        );
      }
    });

    return issues;
  });

  expect(violations, violations.join("\n")).toEqual([]);
}

/**
 * Checklist B2: Every visible icon-only button has a non-empty aria-label.
 */
export async function assertIconButtonsAccessible(page: Page): Promise<void> {
  const missingLabels = await page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = htmlEl.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const offenders: string[] = [];
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      if (btn.closest("nextjs-portal, [data-nextjs-toast], [data-next-badge]")) continue;
      if (btn.hasAttribute("data-next-mark")) continue;
      const visibleText = (btn.innerText || "").trim();
      if (visibleText.length > 0) continue;
      const ariaLabel = (btn.getAttribute("aria-label") || "").trim();
      if (!ariaLabel) {
        const snippet = btn.outerHTML.slice(0, 140).replace(/\s+/g, " ");
        offenders.push(`Icon-only button missing aria-label: ${snippet}`);
      }
    }
    return offenders;
  });

  expect(missingLabels, missingLabels.join("\n")).toEqual([]);
}

/**
 * Checklist B3: Toolbar / header / card-footer action buttons use unified rounded
 * tokens (>= 6px, no 0px/4px unstyled defaults) and consistent border-radius
 * families within the same container (at most 1 standard radius + optional pill).
 */
export async function assertToolbarButtonRadiusConsistent(
  page: Page,
  containerSelector?: string | Locator,
): Promise<void> {
  const defaultSelector =
    'main [role="toolbar"], main header, [data-testid*="toolbar"], [data-testid*="footer"], [data-card-footer], .gp-panel-header';
  const containers =
    containerSelector === undefined
      ? page.locator(defaultSelector)
      : typeof containerSelector === "string"
        ? page.locator(containerSelector)
        : containerSelector;

  const count = await containers.count();
  expect(
    count,
    "Expected at least 1 container for assertToolbarButtonRadiusConsistent",
  ).toBeGreaterThan(0);

  const result = await containers.evaluateAll((elements) => {
    const isVisible = (el: Element): boolean => {
      const htmlEl = el as HTMLElement;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
        return false;
      }
      const rect = htmlEl.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const parseRadiusPx = (raw: string): number => {
      const first = raw.trim().split(/\s+/)[0] || "0px";
      const parsed = Number.parseFloat(first);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const isTransparent = (raw: string): boolean => {
      const v = raw.trim().toLowerCase();
      return v === "transparent" || v === "rgba(0, 0, 0, 0)" || v === "rgba(0,0,0,0)";
    };

    const issues: string[] = [];
    let evaluatedContainers = 0;

    elements.forEach((root, idx) => {
      if (!isVisible(root)) return;
      const rootEl = root as HTMLElement;
      const rootLabel = rootEl.getAttribute("data-testid") || rootEl.tagName.toLowerCase();

      const actionButtons = Array.from(rootEl.querySelectorAll("button, a")).filter((node) => {
        if (!isVisible(node)) return false;
        if (node.closest("nextjs-portal, [data-nextjs-toast], [data-next-badge]")) return false;
        if (node.closest('[role="tablist"]')) return false;
        if (rootEl.tagName === "HEADER" && node.closest("nav")) return false;

        const htmlNode = node as HTMLElement;
        if (htmlNode.dataset.variant === "link") return false;

        const style = window.getComputedStyle(htmlNode);
        const hasVisibleChrome =
          !isTransparent(style.backgroundColor) ||
          Number.parseFloat(style.borderTopWidth || "0") > 0;
        if (htmlNode.tagName === "A" && !hasVisibleChrome && htmlNode.getAttribute("role") !== "button") {
          return false;
        }

        let parent = htmlNode.parentElement;
        while (parent && parent !== rootEl) {
          if (parent.tagName === "A" || parent.tagName === "BUTTON") return false;
          parent = parent.parentElement;
        }
        return true;
      }) as HTMLElement[];

      if (actionButtons.length === 0) return;
      evaluatedContainers += 1;

      const standardRadii = new Set<number>();
      const allFamilies = new Set<string>();

      for (const btn of actionButtons) {
        const style = window.getComputedStyle(btn);
        const rect = btn.getBoundingClientRect();
        const radius = parseRadiusPx(style.borderTopLeftRadius);
        const isPill =
          radius >= 999 || (rect.height > 0 && radius >= rect.height / 2 - 0.5 && radius >= 14);

        if (!isPill && radius < 5.5) {
          const text = (btn.innerText || btn.getAttribute("aria-label") || "").trim().slice(0, 24);
          issues.push(
            `Container[${idx}] (${rootLabel}) button "${text}" has unstyled/small borderRadius=${style.borderTopLeftRadius} (expected >= 6px or pill)`,
          );
          continue;
        }

        if (isPill) {
          allFamilies.add("pill");
        } else {
          const bucket = Math.round(radius * 2) / 2;
          standardRadii.add(bucket);
          allFamilies.add(`${bucket}px`);
        }
      }

      if (standardRadii.size > 1) {
        issues.push(
          `Container[${idx}] (${rootLabel}) mixes inconsistent standard button radii: ${Array.from(standardRadii)
            .map((r) => `${r}px`)
            .join(", ")}`,
        );
      }
      if (allFamilies.size > 2) {
        issues.push(
          `Container[${idx}] (${rootLabel}) uses >2 radius families: ${Array.from(allFamilies).join(", ")}`,
        );
      }
    });

    return { issues, evaluatedContainers };
  });

  if (containerSelector !== undefined) {
    expect(
      result.evaluatedContainers,
      "Expected at least 1 visible container with action buttons for assertToolbarButtonRadiusConsistent",
    ).toBeGreaterThan(0);
  }
  expect(result.issues, result.issues.join("\n")).toEqual([]);
}

/**
 * Checklist D1 (Teacher half): .gp-teacher-shell is present with
 * --gp-canvas (#f5f6f7) and --gp-action (#3370ff).
 */
export async function assertTeacherShellTokens(page: Page): Promise<void> {
  const shell = page.locator(".gp-teacher-shell").first();
  await expect(shell, "Expected .gp-teacher-shell on Teacher route").toBeVisible();

  const tokens = await shell.evaluate((el) => {
    const resolveColor = (rawValue: string): string => {
      const probe = document.createElement("span");
      probe.style.color = rawValue;
      probe.style.display = "none";
      document.body.appendChild(probe);
      const resolved = window.getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };

    const style = window.getComputedStyle(el);
    const canvasRaw = style.getPropertyValue("--gp-canvas").trim();
    const actionRaw = style.getPropertyValue("--gp-action").trim();

    return {
      canvasRaw,
      actionRaw,
      canvasRgb: canvasRaw ? resolveColor(canvasRaw) : "",
      actionRgb: actionRaw ? resolveColor(actionRaw) : "",
    };
  });

  expect(
    tokens.canvasRgb,
    `Expected .gp-teacher-shell --gp-canvas to resolve to ${EXPECTED_TEACHER_CANVAS_RGB} (#f5f6f7), got raw="${tokens.canvasRaw}" (${tokens.canvasRgb})`,
  ).toBe(EXPECTED_TEACHER_CANVAS_RGB);
  expect(
    tokens.actionRgb,
    `Expected .gp-teacher-shell --gp-action to resolve to ${EXPECTED_TEACHER_ACTION_RGB} (#3370ff), got raw="${tokens.actionRaw}" (${tokens.actionRgb})`,
  ).toBe(EXPECTED_TEACHER_ACTION_RGB);
}

/**
 * Checklist D1 (Student half): .gp-teacher-shell count === 0;
 * :root --gp-canvas is #f8fafc and --gp-action is #0369a1.
 */
export async function assertStudentShellUntouched(page: Page): Promise<void> {
  await expect(
    page.locator(".gp-teacher-shell"),
    "Student routes must never render .gp-teacher-shell",
  ).toHaveCount(0);

  const tokens = await page.evaluate(() => {
    const resolveColor = (rawValue: string): string => {
      const probe = document.createElement("span");
      probe.style.color = rawValue;
      probe.style.display = "none";
      document.body.appendChild(probe);
      const resolved = window.getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };

    const style = window.getComputedStyle(document.documentElement);
    const canvasRaw = style.getPropertyValue("--gp-canvas").trim();
    const actionRaw = style.getPropertyValue("--gp-action").trim();

    return {
      canvasRaw,
      actionRaw,
      canvasRgb: canvasRaw ? resolveColor(canvasRaw) : "",
      actionRgb: actionRaw ? resolveColor(actionRaw) : "",
    };
  });

  expect(
    tokens.canvasRgb,
    `Expected Student :root --gp-canvas to remain ${EXPECTED_STUDENT_CANVAS_RGB} (#f8fafc), got raw="${tokens.canvasRaw}" (${tokens.canvasRgb})`,
  ).toBe(EXPECTED_STUDENT_CANVAS_RGB);
  expect(
    tokens.actionRgb,
    `Expected Student :root --gp-action to remain ${EXPECTED_STUDENT_ACTION_RGB} (#0369a1), got raw="${tokens.actionRaw}" (${tokens.actionRgb})`,
  ).toBe(EXPECTED_STUDENT_ACTION_RGB);
}

/**
 * Checklist C2: When prefers-reduced-motion is NOT reduced, an open Sheet / Dialog
 * ([role="dialog"] or [data-state="open"]) has non-zero computed transitionDuration
 * or animationDuration (150ms–300ms per Gemini physics).
 */
export async function assertSheetMotionEnabled(
  page: Page,
  locator?: Locator,
): Promise<void> {
  const target =
    locator ??
    page
      .locator('[role="dialog"][data-state="open"], [data-state="open"][role="dialog"], [role="dialog"]')
      .first();

  await expect(target, "Expected open Sheet/Dialog for assertSheetMotionEnabled").toBeVisible();

  const motion = await target.evaluate((el) => {
    const parseDurationListMaxMs = (raw: string): number => {
      const parts = raw
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean);
      let maxMs = 0;
      for (const part of parts) {
        if (part.endsWith("ms")) {
          const num = Number(part.slice(0, -2));
          if (Number.isFinite(num)) maxMs = Math.max(maxMs, num);
        } else if (part.endsWith("s")) {
          const num = Number(part.slice(0, -1));
          if (Number.isFinite(num)) maxMs = Math.max(maxMs, num * 1000);
        }
      }
      return maxMs;
    };

    const isReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const candidates = [
      el as HTMLElement,
      ...(Array.from(el.querySelectorAll('[data-state="open"]')) as HTMLElement[]),
    ];

    let maxTransMs = 0;
    let maxAnimMs = 0;
    for (const node of candidates) {
      const style = window.getComputedStyle(node);
      maxTransMs = Math.max(maxTransMs, parseDurationListMaxMs(style.transitionDuration));
      maxAnimMs = Math.max(maxAnimMs, parseDurationListMaxMs(style.animationDuration));
    }

    const rootStyle = window.getComputedStyle(el);
    return {
      isReduced,
      maxTransMs,
      maxAnimMs,
      maxDurationMs: Math.max(maxTransMs, maxAnimMs),
      transitionDuration: rootStyle.transitionDuration,
      animationDuration: rootStyle.animationDuration,
      dataState: el.getAttribute("data-state"),
    };
  });

  expect(
    motion.isReduced,
    "assertSheetMotionEnabled must run when prefers-reduced-motion is NOT reduced",
  ).toBe(false);
  expect(
    motion.maxDurationMs,
    `Expected open Sheet/Dialog non-zero motion duration (150ms–300ms), got transitionDuration="${motion.transitionDuration}", animationDuration="${motion.animationDuration}"`,
  ).toBeGreaterThanOrEqual(150);
  expect(
    motion.maxDurationMs,
    `Expected open Sheet/Dialog motion duration <= 300ms, got ${motion.maxDurationMs}ms`,
  ).toBeLessThanOrEqual(300);
}

/**
 * Checklist C1 + C2 + C4: Verify M3/Gemini easing & duration tokens on .gp-teacher-shell,
 * verify any currently open Sheet/Dialog has enabled motion (150ms–300ms),
 * and confirm prefers-reduced-motion collapses transition/animation durations to <= 1ms.
 */
export async function assertMotionAndReducedMotion(page: Page): Promise<void> {
  const tokenCheck = await page.evaluate(() => {
    const target =
      (document.querySelector(".gp-teacher-shell") as HTMLElement | null) ??
      document.documentElement;
    const style = window.getComputedStyle(target);
    const norm = (value: string): string => value.trim().replace(/\s+/g, "");

    const parseMs = (raw: string): number | null => {
      const val = raw.trim().toLowerCase();
      if (!val) return null;
      if (val.endsWith("ms")) {
        const num = Number(val.slice(0, -2));
        return Number.isFinite(num) ? num : null;
      }
      if (val.endsWith("s")) {
        const num = Number(val.slice(0, -1));
        return Number.isFinite(num) ? num * 1000 : null;
      }
      return null;
    };

    return {
      hasTeacherShell: Boolean(document.querySelector(".gp-teacher-shell")),
      easeStandard: norm(style.getPropertyValue("--gp-ease-standard")),
      easeEnter: norm(style.getPropertyValue("--gp-ease-enter")),
      easeExit: norm(style.getPropertyValue("--gp-ease-exit")),
      durMicro: parseMs(style.getPropertyValue("--gp-dur-micro")),
      durUi: parseMs(style.getPropertyValue("--gp-dur-ui")),
      durEnter: parseMs(style.getPropertyValue("--gp-dur-enter")),
      durExit: parseMs(style.getPropertyValue("--gp-dur-exit")),
    };
  });

  expect(tokenCheck.hasTeacherShell, "Expected .gp-teacher-shell for motion token check").toBe(
    true,
  );
  expect(tokenCheck.easeStandard).toBe("cubic-bezier(0.2,0,0,1)");
  expect(tokenCheck.easeEnter).toBe("cubic-bezier(0.05,0.7,0.1,1)");
  expect(tokenCheck.easeExit).toBe("cubic-bezier(0.3,0,0.8,0.15)");

  expect(tokenCheck.durMicro, "--gp-dur-micro must be 150-260ms").not.toBeNull();
  expect(tokenCheck.durMicro!).toBeGreaterThanOrEqual(150);
  expect(tokenCheck.durMicro!).toBeLessThanOrEqual(260);

  expect(tokenCheck.durEnter, "--gp-dur-enter must be 150-260ms").not.toBeNull();
  expect(tokenCheck.durEnter!).toBeGreaterThanOrEqual(150);
  expect(tokenCheck.durEnter!).toBeLessThanOrEqual(260);

  if (tokenCheck.durUi !== null) {
    expect(tokenCheck.durUi).toBeGreaterThanOrEqual(150);
    expect(tokenCheck.durUi).toBeLessThanOrEqual(260);
  }
  if (tokenCheck.durExit !== null) {
    expect(tokenCheck.durExit).toBeGreaterThanOrEqual(150);
    expect(tokenCheck.durExit).toBeLessThanOrEqual(260);
  }

  const openDialogs = page.locator('[role="dialog"][data-state="open"]');
  if ((await openDialogs.count()) > 0 && (await openDialogs.first().isVisible())) {
    await assertSheetMotionEnabled(page, openDialogs.first());
  }

  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const violations = await page.evaluate(() => {
      const parseDurationListMaxMs = (raw: string): number => {
        const parts = raw
          .split(",")
          .map((part) => part.trim().toLowerCase())
          .filter(Boolean);
        let maxMs = 0;
        for (const part of parts) {
          if (part.endsWith("ms")) {
            const num = Number(part.slice(0, -2));
            if (Number.isFinite(num)) maxMs = Math.max(maxMs, num);
          } else if (part.endsWith("s")) {
            const num = Number(part.slice(0, -1));
            if (Number.isFinite(num)) maxMs = Math.max(maxMs, num * 1000);
          }
        }
        return maxMs;
      };

      const probe = document.createElement("div");
      probe.className = "gp-transition gp-fade-in gp-slide-in";
      document.body.appendChild(probe);

      const issues: string[] = [];
      try {
        const candidates = [
          probe,
          ...Array.from(
            document.querySelectorAll(
              'button, a, .gp-transition, .gp-fade-in, .gp-slide-in, [role="dialog"]',
            ),
          ),
        ];

        for (const el of candidates) {
          const style = window.getComputedStyle(el);
          const transMs = parseDurationListMaxMs(style.transitionDuration);
          const animMs = parseDurationListMaxMs(style.animationDuration);
          if (transMs > 1.01) {
            issues.push(
              `Reduced motion transitionDuration=${style.transitionDuration} (${transMs}ms > 1ms) on <${el.tagName.toLowerCase()}>`,
            );
          }
          if (animMs > 1.01) {
            issues.push(
              `Reduced motion animationDuration=${style.animationDuration} (${animMs}ms > 1ms) on <${el.tagName.toLowerCase()}>`,
            );
          }
          if (issues.length >= 10) break;
        }
      } finally {
        probe.remove();
      }

      return issues;
    });

    expect(violations, violations.join("\n")).toEqual([]);
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
}

/**
 * Checklist D4: Numeric stat counters (.gp-stat-value, .gp-tabular, or [data-testid*='kpi'])
 * use font-variant-numeric: tabular-nums. Accepts a Locator or Page.
 */
export async function assertTabularNums(target: Locator | Page): Promise<void> {
  const isPage = "locator" in target && typeof (target as Page).goto === "function";
  const locator = isPage
    ? (target as Page).locator(".gp-stat-value, .gp-tabular, [data-testid*='kpi']")
    : (target as Locator);

  const count = await locator.count();
  expect(count, "Expected at least 1 element for assertTabularNums").toBeGreaterThan(0);

  const result = await locator.evaluateAll((elements) => {
    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = (el as HTMLElement).getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const failures: string[] = [];
    let checkedCount = 0;

    elements.forEach((el, idx) => {
      if (!isVisible(el)) return;
      const style = window.getComputedStyle(el);
      const fvn = style.fontVariantNumeric || "";
      if (fvn.includes("tabular-nums")) {
        checkedCount += 1;
        return;
      }

      const nestedNumeric = Array.from(
        el.querySelectorAll(".gp-stat-value, .gp-tabular"),
      ).filter(isVisible);

      if (nestedNumeric.length > 0) {
        for (const child of nestedNumeric) {
          checkedCount += 1;
          const childFvn = window.getComputedStyle(child).fontVariantNumeric || "";
          if (!childFvn.includes("tabular-nums")) {
            failures.push(
              `Element[${idx}] nested stat ("${(child.textContent || "").trim().slice(0, 40)}") has font-variant-numeric="${childFvn}"`,
            );
          }
        }
        return;
      }

      checkedCount += 1;
      failures.push(
        `Element[${idx}] ("${(el.textContent || "").trim().slice(0, 40)}") has font-variant-numeric="${fvn}"`,
      );
    });

    return { failures, checkedCount };
  });

  expect(
    result.checkedCount,
    "Expected at least 1 visible element for assertTabularNums",
  ).toBeGreaterThan(0);
  expect(result.failures, result.failures.join("\n")).toEqual([]);
}

/**
 * Attach console.error, uncaught pageerror, and HTTP >= 500 listeners to page,
 * returning the live array of collected errors.
 */
export function collectConsoleAndPageErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`[console.error] ${msg.text()}`);
    }
  });

  page.on("pageerror", (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });

  page.on("response", (response) => {
    if (response.status() >= 500) {
      errors.push(`[http ${response.status()}] ${response.url()}`);
    }
  });

  return errors;
}
