import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * 浏览器验证设施（阶段 14/15 验收用，非业务运行时依赖）。
 * 使用系统 Chrome（headless）+ CDP：真实鼠标/键盘事件、截图、视口与减少动效模拟。
 * 夹具（账号/前置状态）通过 localStorage 注入；被验收操作通过界面事件执行。
 */

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const BASE = process.env.GP_BASE_URL ?? "http://localhost:3000";
const SHOTS = "docs/design/screenshots";

let chromeProc = null;

export async function launchChrome() {
  mkdirSync(SHOTS, { recursive: true });
  chromeProc = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--user-data-dir=/tmp/gp-ux-chrome-profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: "ignore" });
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error("Chrome 调试端口未就绪");
}

export function closeChrome() {
  chromeProc?.kill("SIGTERM");
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Tab {
  constructor(ws, id) {
    this.ws = ws;
    this.id = id;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "evaluate failed");
    return result.result?.value;
  }

  async goto(url) {
    await this.send("Page.navigate", { url: `${BASE}${url}` });
    await sleep(650);
    await this.waitFor("document.body && document.body.innerText.length > 0");
  }

  async reload() {
    await this.send("Page.reload");
    await sleep(700);
    await this.waitFor("document.body && document.body.innerText.length > 0");
  }

  async waitFor(expression, timeout = 6000) {
    const start = Date.now();
    for (;;) {
      const value = await this.evaluate(expression).catch(() => false);
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`等待超时：${expression}`);
      await sleep(120);
    }
  }

  async setViewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await sleep(250);
  }

  async setReducedMotion(enabled) {
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: enabled ? "reduce" : "no-preference" }],
    });
    await sleep(150);
  }

  /** 真实鼠标点击（元素中心） */
  async click(selector) {
    const rect = await this.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", behavior: "instant" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!rect) throw new Error(`未找到元素：${selector}`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await sleep(320);
  }

  /** 表单输入（触发 React 受控更新） */
  async type(selector, value) {
    await this.waitForHydration(selector);
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await sleep(180);
  }

  async pressTab(times = 1) {
    for (let i = 0; i < times; i += 1) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await sleep(80);
    }
    return this.evaluate("document.activeElement ? (document.activeElement.getAttribute('aria-label') || document.activeElement.textContent || document.activeElement.tagName).trim().slice(0, 40) : null");
  }


  /** 按可见文本点击（button/a），真实鼠标事件 */
  async clickByText(text, tag = "button") {
    // 元素/水合就绪前重试（覆盖开发模式冷编译），找不到仍报错
    let rect = null;
    for (let i = 0; i < 20; i += 1) {
      rect = await this.evaluate(`(() => {
        const els = Array.from(document.querySelectorAll(${JSON.stringify(tag)}));
        const el = els.find((e) => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled) || els.find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}) && !e.disabled);
        if (!el) return null;
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (rect) break;
      await sleep(400);
    }
    if (!rect) throw new Error(`未找到可点击文本：${text}`);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    await sleep(360);
  }

  /** 在包含 labelText 的 label 内输入（表单字段定位）；字段未渲染时短暂重试 */
  async typeInLabeled(labelText, value) {
    for (let i = 0; i < 20; i += 1) {
      const done = await this._typeInLabeledOnce(labelText, value);
      if (done) return true;
      await sleep(400);
    }
    return false;
  }

  async _typeInLabeledOnce(labelText, value) {
    await this.waitForHydration("label");
    return this.evaluate(`(() => {
      const labels = Array.from(document.querySelectorAll("label"));
      const label = labels.find((l) => l.textContent.includes(${JSON.stringify(labelText)}));
      const el = label && (label.querySelector("input, textarea, select") || (label.nextElementSibling && label.nextElementSibling.matches("input, textarea, select") ? label.nextElementSibling : null));
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await sleep(320);
  }

  /** 等待目标元素完成 React 水合（fiber 已挂载），避免事件监听未就绪时输入丢失 */
  async waitForHydration(selector, timeout = 8000) {
    const start = Date.now();
    for (;;) {
      const ready = await this.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return !!el && Object.keys(el).some((k) => k.startsWith("__react"));
      })()`);
      if (ready) return true;
      if (Date.now() - start > timeout) return false;
      await sleep(250);
    }
  }

  async hasText(text) {
    // 首次编译/水合较慢时重试（覆盖开发模式冷编译；不改变断言语义）
    for (let i = 0; i < 24; i += 1) {
      if ((await this.text()).includes(text)) return true;
      await sleep(500);
    }
    return false;
  }

  async text() {
    return this.evaluate("document.body.innerText");
  }

  async screenshot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
    return `${SHOTS}/${name}.png`;
  }
}

export async function openTab() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  const tab = new Tab(ws, target.id);
  await tab.send("Page.enable");
  await tab.send("Runtime.enable");
  return tab;
}

/**
 * 夹具：注入完整工作区状态（Node 侧准备），被验收操作仍经界面执行。
 * 存储键按当前会话用户隔离（真实门禁下需先登录）；同时写旧键以便兼容读取。
 */
export async function injectWorkspace(tab, data) {
  await tab.goto("/");
  await tab.evaluate(`(async () => {
    let scope = "anonymous";
    try { const d = await (await fetch("/api/v1/auth/session")).json(); scope = d?.user?.id || "anonymous"; } catch {}
    const payload = ${JSON.stringify(JSON.stringify(data))};
    localStorage.setItem("groupproof-v1-workspace:" + scope, payload);
    localStorage.setItem("groupproof-v1-workspace", payload);
    return "ok";
  })()`);
  await sleep(200);
}

/** 原地覆写工作区夹具（不导航，保留页面输入）；写用户隔离键并兼容旧键 */
export async function writeWorkspace(tab, data) {
  await tab.evaluate(`(async () => {
    let scope = "anonymous";
    try { const d = await (await fetch("/api/v1/auth/session")).json(); scope = d?.user?.id || "anonymous"; } catch {}
    const payload = ${JSON.stringify(JSON.stringify(data))};
    localStorage.setItem("groupproof-v1-workspace:" + scope, payload);
    localStorage.setItem("groupproof-v1-workspace", payload);
    return "ok";
  })()`);
  await sleep(200);
}

export async function readWorkspace(tab) {
  return JSON.parse(await tab.evaluate(`(async () => {
    let scope = "anonymous";
    try { const d = await (await fetch("/api/v1/auth/session")).json(); scope = d?.user?.id || "anonymous"; } catch {}
    return localStorage.getItem("groupproof-v1-workspace:" + scope) || localStorage.getItem("groupproof-v1-workspace");
  })()`));
}

/**
 * 确保浏览器处于已激活会话（真实门禁下业务页需要 active + full）。
 * 走真实接口完成三步注册、资料与学校邮箱验证（隔离开发环境），再把会话 Cookie
 * 注入浏览器（CDP）。验证码仅从开发邮件捕获器读取；真实收件验证另行人工联调。
 */
export async function ensureSignedIn(tab) {
  const base = process.env.GP_BASE_URL ?? "http://localhost:3000";
  const stamp = Date.now().toString().slice(-8);
  const email = `ux-${stamp}@example.com`;
  const username = `ux${stamp}`;
  const password = "correct-horse-battery-1";
  const schoolEmail = `20991${stamp}@student.must.edu.mo`;
  const jar = [];
  const call = async (path, body, csrf, method) => {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body ? "POST" : "GET"),
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Origin: base,
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...(jar.length ? { Cookie: jar.join("; ") } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(";")[0];
      const name = pair.split("=")[0];
      const idx = jar.findIndex((item) => item.startsWith(name + "="));
      if (idx >= 0) jar[idx] = pair; else jar.push(pair);
    }
    return res;
  };

  const created = await (await call("/api/v1/auth/email/registrations", { email, locale: "zh-Hans" })).json();
  await call(`/api/v1/auth/email/registrations/${created.id}/verify`, { code: readCapturedCode(email) });
  await call(`/api/v1/auth/email/registrations/${created.id}/complete`, { username, password });
  const session = await (await call("/api/v1/auth/session")).json();
  const csrf = session.csrfToken;
  await call("/api/v1/me/profile", {
    name: "UX走查用户", username, studentId: `20991${stamp}`, requestedIdentity: "student",
    schoolEmail, expectedVersion: 1,
  }, csrf, "PATCH");
  const challenge = await (await call("/api/v1/me/school-email/challenges", {}, csrf)).json();
  await call("/api/v1/me/school-email/verify", { challengeId: challenge.challengeId, code: readCapturedCode(schoolEmail) }, csrf);

  const sessionCookie = jar.find((item) => item.startsWith("gp_session=") || item.startsWith("__Host-gp_session="));
  assert(sessionCookie, "未取得会话 Cookie");
  const [name, value] = sessionCookie.split("=");
  await tab.send("Network.setCookie", { url: base, name, value, path: "/", httpOnly: true, sameSite: "Lax" });
  await tab.goto("/home");
}

/** 仅隔离开发环境：从邮件捕获器读取验证码（生产无任何读码通道） */
export function readCapturedCode(email) {
  const body = execSync(
    `docker exec gp-pg-test psql -U gp -d gp_dev -t -A -c "SELECT body FROM email_outbox WHERE to_email='${email}' ORDER BY id DESC LIMIT 1"`,
    { encoding: "utf8" },
  );
  const match = /(\d{6})/.exec(body);
  return match ? match[1] : "";
}

/** 模拟存储失败（夹具）：下一次 setItem 抛错，用于验证保存失败反馈 */
export async function armStorageFailure(tab, times = 1) {
  await tab.evaluate(`(() => {
    window.__gpFailSaves = ${times};
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) {
      if (window.__gpFailSaves > 0) { window.__gpFailSaves -= 1; throw new Error("storage unavailable"); }
      return original.apply(this, args);
    };
    return "ok";
  })()`);
}
