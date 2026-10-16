/**
 * Patchright backend behind the agent's Browser interface.
 *
 * The agent loop only uses 4 methods: observe / fresh / act / close.
 * Implemented on Patchright's stealth Chromium (open-source Playwright fork
 * with fingerprint patches) over a persistent agent profile, while reusing
 * the vendored upstream snapshot.js verbatim — no fork of the DOM reader.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { chromium } from "patchright";
import type { BrowserContext, CDPSession, Download, ElementHandle, Frame, Page } from "patchright";

import { ensureDaemon } from "./daemon.js";
import { agentRoot } from "./profile.js";
import type { PageAction, PageSnapshot } from "./types.js";

export class StalePage extends Error {
  constructor(message = "Page changed since this decision. Observe again.") {
    super(message);
    this.name = "StalePage";
  }
}

const SNAPSHOT_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "snapshot.js"),
  "utf8",
);
const SHADOW_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "shadow-supplement.js"),
  "utf8",
);

/** Canonical JSON: sorted keys, matching Python's json.dumps(sort_keys=True). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function fingerprint(state: PageSnapshot): string {
  const content = { url: state.url, text: state.text, actions: state.actions, scroll: state.scroll };
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

export interface FrameSnap {
  url: string;
  snap: PageSnapshot;
}

const MAX_ACTIONS = 250;
const MAX_FRAMES = 12;

/**
 * Merge per-frame snapshots into one indexed action space. Pure (tested).
 * Node ids collide across frames (separate windows), so guards are keyed
 * `frame:node` and every action carries its `frame` index + host label.
 */
export function mergeFrameSnapshots(main: PageSnapshot, frames: FrameSnap[]): PageSnapshot {
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  const take = (snap: PageSnapshot, frame: number, host: string | null): PageAction[] =>
    snap.actions
      .filter((a) => a.kind !== "scroll" && a.kind !== "wait")
      .map((a) => ({
        ...a,
        frame,
        label: host ? `${a.label} [in ${host}]` : a.label,
      }));
  let actions = take(main, 0, null);
  for (let i = 0; i < frames.length; i++) {
    actions = actions.concat(take(frames[i].snap, i + 1, hostOf(frames[i].url)));
  }
  const omitted = Math.max(0, actions.length - MAX_ACTIONS);
  actions = actions.slice(0, MAX_ACTIONS);
  actions.forEach((a, i) => {
    a.id = `e${i + 1}`;
  });
  actions.push({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 });
  actions.push({ id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 });
  actions.push({ id: "wait", kind: "wait", label: "Wait for the page to update" });

  const guards: Record<string, unknown> = {};
  const guardSrc = (snap: PageSnapshot, frame: number) => {
    for (const [node, guard] of Object.entries((snap.guards ?? {}) as Record<string, unknown>)) {
      guards[`${frame}:${node}`] = guard;
    }
  };
  guardSrc(main, 0);
  frames.forEach((f, i) => guardSrc(f.snap, i + 1));

  let text = main.text || "";
  for (const f of frames) {
    const t = (f.snap.text || "").trim();
    if (t) text += `\n--- frame ${f.url} ---\n${t.slice(0, 500)}`;
  }
  return {
    url: main.url,
    title: main.title,
    text: text.slice(0, 6000),
    scroll: main.scroll,
    actions,
    marker: main.marker,
    page_key: main.page_key,
    guards,
    frameUrls: frames.map((f) => f.url),
    omitted_actions: (main.omitted_actions ?? 0) + omitted,
  };
}

/** Match text in a capped worker: pathological patterns die by timeout,
 *  never by hanging the tab or this process. Plain data in and out. */
function matchInWorker(
  text: string,
  pattern: string,
  opts: { regex?: boolean; caseSensitive?: boolean; contextChars?: number; maxResults?: number },
  timeoutMs = 5000,
): Promise<{ text: string; context: string }[] | { error: string }> {
  const workerCode = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const { text, source, flags, ctxN, maxN } = workerData;",
    "let out;",
    "try {",
    "  const re = new RegExp(source, flags);",
    "  out = [];",
    "  let m; re.lastIndex = 0;",
    "  while (out.length < maxN && (m = re.exec(text)) !== null) {",
    "    if (m[0].length === 0) { re.lastIndex++; continue; }",
    "    const s = Math.max(0, m.index - ctxN);",
    "    out.push({ text: m[0].slice(0, 200),",
    "      context: text.slice(s, m.index + m[0].length + ctxN).replace(/\\s+/g, ' ').trim().slice(0, 500) });",
    "    if (re.lastIndex === m.index) re.lastIndex++;",
    "  }",
    "} catch (e) { out = { error: 'invalid pattern' }; }",
    "parentPort.postMessage(out);",
  ].join("\n");
  const flags = opts.caseSensitive ? "g" : "gi";
  const source = opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (v: { text: string; context: string }[] | { error: string }) => {
      if (done) return;
      done = true;
      resolvePromise(v);
    };
    let worker: Worker;
    try {
      worker = new Worker(workerCode, {
        eval: true,
        workerData: { text, source, flags, ctxN: opts.contextChars ?? 100, maxN: opts.maxResults ?? 10 },
      });
    } catch {
      finish({ error: "matcher unavailable" });
      return;
    }
    const timer = setTimeout(() => {
      void worker.terminate().catch(() => undefined);
      finish({ error: "pattern timed out" });
    }, timeoutMs);
    worker.on("message", (v) => {
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      finish(v as { text: string; context: string }[] | { error: string });
    });
    worker.on("error", () => {
      clearTimeout(timer);
      finish({ error: "matcher failed" });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split a proxy URL into Playwright's {server, username, password} shape. */
function parseProxy(raw: string): { server: string; username?: string; password?: string } {
  try {
    const u = new URL(raw);
    const out: { server: string; username?: string; password?: string } = {
      server: `${u.protocol}//${u.host}`,
    };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: raw };
  }
}

export const BIRTH_URLS = new Set([
  "about:blank",
  "chrome://newtab/",
  "chrome://new-tab-page/",
  "chrome-search://local-ntp/local-ntp.html",
]);

/** In-page flag marking a birth tab already owned by an agent window.
 *  Prevents two sequential AgentBrowserAdapter.create() calls from
 *  adopting the same initial birth window. */
const CLAIM_JS = "window.__piShadowClaimed === true";
const CLAIM_SET_JS = "window.__piShadowClaimed = true";
/** Same-process guard: targetIds claimed as birth windows by a concurrent
 *  create() in this process (CDP + page-flag checks race across processes). */
const claimedBirthTargets = new Set<string>();

export interface LaunchOpts {
  /** Engine home: the shared browser lives here (one engine per path).
   *  The first starter's headless/proxy config wins; later mismatches
   *  fail loudly (below) so traffic never goes somewhere unconfigured. */
  userDataDir?: string;
  headless?: boolean;
  proxy?: string;
  locale?: string;
  timezone?: string;
  userAgent?: string;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  permissions?: string[];
}

export class AgentBrowserAdapter {
  private closed = false;
  /** Frames from the last observe, aligned with action `frame` indices. */
  private frames: Frame[] = [];
  /** The session's main tab. Survives tab switches; never closed by cleanup. */
  private mainPage: Page | null = null;
  private downloads: { name: string; path: string; url: string }[] = [];
  private failedRequests: { url: string; status: number }[] = [];
  private diagnosed = new Set<Page>();
  /** This agent's OS window on the shared engine (CDP windowId). Every tab
   *  op is scoped to pages in this window — never another agent's. */
  private windowId: number | null = null;
  private browserSession: CDPSession | null = null;
  private downloadListener: ((download: Download) => void) | null = null;
  /** Sync best-effort membership for window tabs created through this
   *  adapter (adopted + opened in-window). Async windowPages() via CDP is
   *  authoritative; this set lets the sync tabUrls() stay window-scoped. */
  private owned = new Set<Page>();

  private constructor(
    private ctx: BrowserContext,
    private page: Page,
  ) {}

  static async create(url: string, opts: LaunchOpts = {}): Promise<AgentBrowserAdapter> {
    // One shared engine per profileDir: attach over CDP to its default
    // context (contexts[0]) and own ONE window (CDP windowId) on it.
    // Never launch, never touch another agent's window/tabs.
    let proxyServer: string | undefined;
    if (opts.proxy) {
      const parsed = parseProxy(opts.proxy);
      if (parsed.username || parsed.password) {
        throw new Error("Authenticated proxies are not supported on the shared browser — use an unauthenticated proxy URL.");
      }
      proxyServer = parsed.server;
    }
    const root = agentRoot(opts.userDataDir);
    const { cdpUrl, headless: daemonHeadless, proxyServer: daemonProxy } = await ensureDaemon({
      headless: opts.headless ?? true,
      root,
      ...(proxyServer ? { proxyServer } : {}),
    });
    if (opts.headless !== undefined && opts.headless !== daemonHeadless) {
      throw new Error(
        opts.headless
          ? "Shared browser is headed (first starter set headed) — /browser-shutdown it and retry for a headless one."
          : "Shared browser is headless (first starter set headless) — /browser-shutdown it and retry for a visible one.",
      );
    }
    if (opts.proxy && proxyServer !== daemonProxy) {
      throw new Error(
        `Shared browser runs ${daemonProxy ? "with a different proxy" : "without a proxy"} — /browser-shutdown it and retry for ${proxyServer}.`,
      );
    }
    // connectOverCDP has no built-in timeout: a wedged-but-listening daemon
    // would hang the caller (and the whole TUI awaiting the command) forever.
    const browser = await Promise.race([
      chromium.connectOverCDP(cdpUrl),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`CDP connect timed out after 30s (${cdpUrl}) — daemon is wedged; /browser-shutdown it and retry.`)),
          30_000,
        ),
      ),
    ]);
    const contexts = browser.contexts();
    const ctx = contexts[0] ?? (await browser.newContext());
    const seed = ctx.pages()[0] ?? (await ctx.newPage());
    const adapter = new AgentBrowserAdapter(ctx, seed);
    // Browser-level CDP drives window management (getWindowForTarget /
    // createTarget). One session per adapter; detached on close().
    adapter.browserSession = await browser.newBrowserCDPSession();
    await adapter.claimWindow(url);
    adapter.watchDownloads(join(root, "downloads"));
    // Listeners before first navigation: early console errors and
    // failed responses would otherwise fire before anyone listens.
    adapter.watchDiagnostics();
    if (url && !BIRTH_URLS.has(url)) {
      await adapter.page.goto(url);
      await adapter.page.waitForLoadState("domcontentloaded");
    } else if (url) {
      // Birth URL: stay on the owned blank tab (no extra navigation).
      try {
        if (!BIRTH_URLS.has(adapter.page.url())) await adapter.page.goto("about:blank");
      } catch {
        // Best-effort.
      }
    }
    return adapter;
  }

  /** Claim this adapter's ONE window on the shared engine.
   *  Cold start: adopt the daemon's single unclaimed birth tab/window so no
   *  extra unused birth window is left behind. Otherwise open a brand-new
   *  full-UI browser window via CDP Target.createTarget(newWindow:true)
   *  (never a chromeless popup) and operate strictly inside it. */
  private async claimWindow(_url: string): Promise<void> {
    const session = this.browserSession;
    if (!session) throw new Error("Browser session not established.");
    const pages = this.ctx.pages();
    // Resolve window per page (best-effort each; dead tabs skip).
    const entries: { page: Page; targetId: string | null; windowId: number | null; birth: boolean; claimed: boolean }[] = [];
    for (const p of pages) {
      const targetId = await this.targetIdOf(p);
      let windowId: number | null = null;
      if (targetId) {
        try {
          const r = (await session.send("Browser.getWindowForTarget", { targetId })) as { windowId?: number };
          windowId = typeof r.windowId === "number" ? r.windowId : null;
        } catch {
          windowId = null;
        }
      }
      let u = "";
      try {
        u = p.url();
      } catch {
        continue;
      }
      let claimed = true;
      try {
        claimed = (await p.evaluate(CLAIM_JS)) === true;
      } catch {
        claimed = true;
      }
      if (targetId && claimedBirthTargets.has(targetId)) claimed = true;
      entries.push({ page: p, targetId, windowId, birth: BIRTH_URLS.has(u), claimed });
    }
    const byWindow = new Map<number, typeof entries>();
    for (const e of entries) {
      if (e.windowId === null) continue;
      const list = byWindow.get(e.windowId) ?? [];
      list.push(e);
      byWindow.set(e.windowId, list);
    }
    // Adoptable: exactly one window on the engine, every tab a birth URL,
    // none claimed by another agent. First agent takes it; everyone after
    // opens their own window.
    let adopt: (typeof entries)[number] | null = null;
    if (byWindow.size === 1) {
      const [[, list]] = [...byWindow.entries()];
      if (list.length > 0 && list.every((e) => e.birth && !e.claimed)) adopt = list[0];
    }
    if (adopt && adopt.windowId !== null) {
      this.windowId = adopt.windowId;
      this.page = adopt.page;
      this.mainPage = adopt.page;
      this.owned.add(adopt.page);
      try {
        await adopt.page.evaluate(CLAIM_SET_JS);
      } catch {
        // Best-effort.
      }
      if (adopt.targetId) claimedBirthTargets.add(adopt.targetId);
      await this.focusWindow();
      return;
    }
    // Open our own full-UI window. Verified headed: newWindow:true creates
    // a normal browser window (distinct windowId), not a popup.
    const beforeIds = new Set(entries.map((e) => e.targetId).filter(Boolean) as string[]);
    let newTargetId = "";
    try {
      const res = (await session.send("Target.createTarget", { url: "about:blank", newWindow: true })) as { targetId?: string };
      newTargetId = res.targetId ?? "";
    } catch (err) {
      throw new Error(`Could not open a browser window: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!newTargetId) throw new Error("Could not open a browser window: empty targetId.");
    let newWindowId: number | null = null;
    try {
      const r = (await session.send("Browser.getWindowForTarget", { targetId: newTargetId })) as { windowId?: number };
      newWindowId = typeof r.windowId === "number" ? r.windowId : null;
    } catch {
      newWindowId = null;
    }
    if (newWindowId === null) throw new Error("Could not determine the new browser window id.");
    // Find the Page object for the new target (poll: Playwright learns it async).
    let owned: Page | null = null;
    const deadline = Date.now() + 10_000;
    for (;;) {
      for (const p of this.ctx.pages()) {
        const tid = await this.targetIdOf(p);
        if (tid === newTargetId) {
          owned = p;
          break;
        }
        if (tid && !beforeIds.has(tid)) {
          // Fallback match by fresh windowId when targetIds are opaque.
          try {
            const r = (await session.send("Browser.getWindowForTarget", { targetId: tid })) as { windowId?: number };
            if (r.windowId === newWindowId) {
              owned = p;
              break;
            }
          } catch {
            // Keep looking.
          }
        }
      }
      if (owned || Date.now() > deadline) break;
      await sleep(150);
    }
    if (!owned) throw new Error("New browser window opened but its tab never appeared.");
    this.windowId = newWindowId;
    this.page = owned;
    this.mainPage = owned;
    this.owned.add(owned);
    try {
      await owned.evaluate(CLAIM_SET_JS);
    } catch {
      // Best-effort.
    }
    claimedBirthTargets.add(newTargetId);
    // Fresh-daemon leftover: if the engine had exactly one unclaimed birth
    // tab and we opened a new window instead of adopting (concurrent
    // create race), close that orphan so cold start leaves no unused birth
    // window. Never touches claimed or non-birth tabs.
    try {
      if (entries.length === 1 && entries[0].birth && !entries[0].claimed) {
        await entries[0].page.close().catch(() => undefined);
      }
    } catch {
      // Best-effort.
    }
    await this.focusWindow();
  }

  /** Resolve the CDP targetId for a page (internal id first, CDP fallback). */
  private async targetIdOf(page: Page): Promise<string | null> {
    try {
      const t =
        (page as unknown as { _delegate?: { _target?: { _targetId?: string } } })._delegate?._target?._targetId ??
        (page as unknown as { _targetId?: string })._targetId;
      if (typeof t === "string" && t) return t;
    } catch {
      // Fall through to CDP.
    }
    try {
      const s = await this.ctx.newCDPSession(page);
      try {
        const info = (await s.send("Target.getTargetInfo", {})) as { targetInfo?: { targetId?: string }; targetId?: string };
        return info.targetInfo?.targetId ?? info.targetId ?? null;
      } finally {
        await s.detach().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }

  /** Pages strictly in THIS adapter's window (authoritative via CDP). */
  private async windowPages(): Promise<Page[]> {
    if (this.windowId === null) return [...this.ctx.pages()];
    const session = this.browserSession;
    const out: Page[] = [];
    for (const p of this.ctx.pages()) {
      try {
        const tid = await this.targetIdOf(p);
        if (!tid || !session) continue;
        const r = (await session.send("Browser.getWindowForTarget", { targetId: tid })) as { windowId?: number };
        if (r.windowId === this.windowId) out.push(p);
      } catch {
        // Dead tab — skip.
      }
    }
    return out;
  }

  /** Open a tab guaranteed inside this window (window.open from an owned
   *  page stays in-window by construction; verified via getWindowForTarget
   *  with a CDP Target.createTarget(windowId) fallback). */
  private async newPageInWindow(url = "about:blank"): Promise<Page> {
    if (this.windowId === null) {
      const p = await this.ctx.newPage();
      return p;
    }
    const before = new Set(this.ctx.pages());
    try {
      await this.page.evaluate((u: string) => {
        window.open(u, "_blank");
      }, url);
    } catch {
      // evaluate failed (dead page?) — fall through to CDP.
    }
    const session = this.browserSession;
    const deadline = Date.now() + 10_000;
    for (;;) {
      for (const p of this.ctx.pages()) {
        if (before.has(p)) continue;
        try {
          const tid = await this.targetIdOf(p);
          if (tid && session) {
            const r = (await session.send("Browser.getWindowForTarget", { targetId: tid })) as { windowId?: number };
            if (r.windowId === this.windowId) {
              this.owned.add(p);
              return p;
            }
          } else if (!tid) {
            this.owned.add(p);
            return p;
          }
        } catch {
          // Keep looking.
        }
      }
      if (Date.now() > deadline) break;
      await sleep(150);
    }
    // Fallback: CDP createTarget aimed at our window (param name varies by
    // build: try windowId, then window), verified the same way.
    if (session) {
      const sendRaw = session.send as unknown as (method: string, params?: unknown) => Promise<{ targetId?: string }>;
      for (const params of [{ url, windowId: this.windowId }, { url, window: this.windowId }]) {
        try {
          const res = await sendRaw("Target.createTarget", params);
          if (!res.targetId) continue;
          const inner = Date.now() + 10_000;
          for (;;) {
            for (const p of this.ctx.pages()) {
              if (before.has(p)) continue;
              try {
                if ((await this.targetIdOf(p)) === res.targetId) {
                  this.owned.add(p);
                  return p;
                }
              } catch {
                // Keep looking.
              }
            }
            if (Date.now() > inner) break;
            await sleep(150);
          }
        } catch {
          // Try the next param shape.
        }
      }
    }
    // Last resort: plain newPage + verify (window-focus usually lands it
    // in-window; still verify before returning).
    const fallback = await this.ctx.newPage();
    try {
      if (url && fallback.url() !== url) await fallback.goto(url);
    } catch {
      // Best-effort.
    }
    this.owned.add(fallback);
    return fallback;
  }

  /** Focus this window/tab (best-effort; headless has no front). */
  private async focusWindow(): Promise<void> {
    try {
      await this.page.bringToFront();
    } catch {
      // Best-effort.
    }
    try {
      if (this.windowId !== null) {
        await this.browserSession?.send("Browser.setWindowBounds", {
          windowId: this.windowId,
          bounds: { windowState: "normal" },
        });
      }
    } catch {
      // Best-effort.
    }
  }

  /** /browser-open on THIS session's window: focus an existing blank/birth
   *  tab when one exists, else open one blank tab in-window and focus it.
   *  Never duplicates blanks, never touches another agent's window. */
  async openBlankTab(): Promise<string> {
    const pages = await this.windowPages();
    // Current operated tab already blank → just focus, no duplicate.
    try {
      if (BIRTH_URLS.has(this.page.url())) {
        await this.focusWindow();
        return this.page.url();
      }
    } catch {
      // Dead page — fall through to window scan.
    }
    for (const p of pages) {
      if (p === this.page) continue;
      try {
        if (BIRTH_URLS.has(p.url())) {
          this.page = p;
          this.watchDiagnostics();
          await this.focusWindow();
          return p.url();
        }
      } catch {
        // Skip dead tabs.
      }
    }
    const tab = await this.newPageInWindow("about:blank");
    this.page = tab;
    if (!this.mainPage || this.mainPage.isClosed()) this.mainPage = tab;
    this.watchDiagnostics();
    await this.focusWindow();
    return tab.url();
  }

  async observe(screenshot = false): Promise<PageSnapshot> {
    // Diagnostics accumulate between observes; each observe reports + resets.
    const failedRequests = this.failedRequests;
    this.failedRequests = [];
    // Main frame, with retries across navigations.
    let main: PageSnapshot | null = null;
    for (let i = 0; i < 10; i++) {
      try {
        main = (await this.page.evaluate(SNAPSHOT_JS)) as PageSnapshot | null;
      } catch {
        main = null;
      }
      if (main !== null) break;
      await sleep(50);
    }
    if (main === null) throw new StalePage("Document is navigating");
    // JS-rendered pages often have no text at domcontentloaded. One bounded
    // re-read when thin — costs nothing on server-rendered pages.
    // (Runs before the supplement so a replaced snapshot loses nothing.)
    if (main.text.trim().length < 200) {
      await sleep(1200);
      try {
        const second = (await this.page.evaluate(SNAPSHOT_JS)) as PageSnapshot | null;
        if (second !== null && second.text.trim().length > main.text.trim().length) main = second;
      } catch {
        // Keep the first snapshot.
      }
    }
    await this.addShadowActions(this.page.mainFrame(), main);
    // Child frames, best-effort each (detached/navigating frames skip).
    // Playwright evaluates inside frames even cross-origin. Capped: ad-heavy
    // pages can host dozens of tracking frames; beyond MAX_FRAMES we skip.
    const frames: Frame[] = [this.page.mainFrame()];
    const snaps: FrameSnap[] = [];
    let traversed = 0;
    for (const f of this.page.frames()) {
      if (f === this.page.mainFrame()) continue;
      if (traversed >= MAX_FRAMES) break;
      traversed++;
      try {
        const snap = (await f.evaluate(SNAPSHOT_JS)) as PageSnapshot | null;
        if (snap === null) continue;
        await this.addShadowActions(f, snap);
        if (snap.actions.length === 0 && (snap.text || "").trim().length === 0) continue;
        frames.push(f);
        snaps.push({ url: f.url(), snap });
      } catch {
        // Detached or navigating — skip.
      }
    }
    this.frames = frames;
    const info = mergeFrameSnapshots(main, snaps);
    info.fingerprint = fingerprint(info);
    info.failedRequests = failedRequests;
    if (screenshot) {
      try {
        const raw = await this.page.screenshot({ type: "jpeg", quality: 72 });
        info.screenshot = raw.toString("base64");
      } catch {
        // Screenshots are best-effort.
      }
    }
    return info;
  }

  private frameOf(action: PageAction): Frame | undefined {
    return this.frames[action.frame ?? 0];
  }

  /**
   * Supplement snapshot with open-shadow-DOM controls. Runs in the frame
   * after snapshot.js (needs its __jevFast cache), appends actions + guards.
   * Retries once after a settle: script failures are transient (teardown
   * races), never deterministic — an empty first pass proves nothing.
   */
  private async addShadowActions(
    frame: Frame,
    snap: PageSnapshot,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(300);
      let extra: PageAction[];
      try {
        extra = (await frame.evaluate(SHADOW_JS)) as PageAction[];
      } catch (err) {
        if (process.env.PI_SHADOW_DEBUG) {
          console.log(`[shadow] evaluate failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
        }
        continue;
      }
      if (!extra || extra.length === 0) continue;
      // Drop anything snapshot.js already registered (same node) — the
      // supplement only adds what snapshot.js cannot see or skips.
      const snapNodes = new Set((snap.actions ?? []).map((a) => (a as PageAction).node));
      const novel = extra.filter((a) => typeof a.node === "number" && !snapNodes.has(a.node));
      if (novel.length === 0) return;
      const nodes = novel.map((a) => a.node).filter((n): n is number => typeof n === "number");
      let fetched: Record<string, unknown> = {};
      try {
        fetched = (await frame.evaluate(
          `(() => { const c = window.__jevFast; const g = {};` +
            ` for (const n of ${JSON.stringify(nodes)}) g[n] = c.guard(c.nodes.get(n)); return g; })()`,
        )) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const a of novel) snap.actions.push(a);
      snap.guards = { ...(snap.guards as Record<string, unknown>), ...fetched };
      return;
    }
  }

  async fresh(page: PageSnapshot, action?: PageAction): Promise<boolean> {
    try {
      // Any action bound to an observed node validates that node (+page key).
      // Precise and immune to unrelated page churn; the marker path below is
      // only for nodeless actions (scroll/wait).
      if (action && typeof action.node === "number") {
        const frame = this.frameOf(action);
        if (!frame) return false;
        // NB: Playwright evaluates strings as expressions (never invoking
        // arrow functions with args), so the node id is embedded, not passed.
        const current = (await frame.evaluate(
          `(() => { const c = window.__jevFast; const node = ${action.node};
            return c ? [c.pageKey(), c.guard(c.nodes.get(node))] : null; })()`,
        )) as unknown;
        const key = `${action.frame ?? 0}:${action.node}`;
        const guards = page.guards as Record<string, unknown>;
        return JSON.stringify(current) === JSON.stringify([page.page_key, guards[key]]);
      }
      const current = (await this.page.evaluate(SNAPSHOT_JS)) as PageSnapshot | null;
      if (current === null) return false;
      if (JSON.stringify(current.marker) !== JSON.stringify(page.marker)) return false;
      // frameUrls holds child frames only (main is index 0, implicit) —
      // compare against live child frames the same way, or every scroll
      // and wait permanently reports stale (found live).
      const main = this.page.mainFrame();
      const liveUrls = this.page.frames().flatMap((f) => {
        if (f === main) return [];
        try {
          return [f.url()];
        } catch {
          return [""];
        }
      });
      return JSON.stringify(liveUrls) === JSON.stringify(page.frameUrls ?? []);
    } catch {
      return false;
    }
  }

  async act(action: PageAction, page: PageSnapshot, text?: string, files?: string[]): Promise<{ executed: string }> {
    if (!(await this.fresh(page, action))) {
      throw new StalePage("Page changed since this decision. Observe again.");
    }
    const kind = action.kind;
    if (kind === "wait") {
      await sleep(100);
      return { executed: action.id };
    }
    if (kind === "upload") {
      // Browser-use parity: set files directly on the observed node — but
      // sandboxed (their FileSystem rule): paths must stay inside the
      // working directory or the OS temp dir, never escape it silently.
      if (!files || files.length === 0) throw new Error("upload needs files=[...] — pass local file paths.");
      const roots = [process.cwd(), tmpdir()].map((d) => resolve(d));
      for (const f of files) {
        const abs = resolve(f);
        if (!roots.some((r) => abs === r || abs.startsWith(r + "/"))) {
          throw new Error(`Refusing to upload ${JSON.stringify(f)}: outside working directory and temp dir.`);
        }
      }
      if (typeof action.node !== "number") throw new Error("Invalid observed node");
      const frame = this.frameOf(action);
      if (!frame) throw new StalePage("Target frame is gone. Observe again.");
      // evaluateHandle CAN return DOM elements (only string arrows take no args).
      const el = await frame.evaluateHandle(
        `(() => window.__jevFast.nodes.get(${action.node}))()`,
      );
      try {
        const element = el.asElement() as ElementHandle | null;
        if (!element) throw new Error("Upload target is gone. Observe again.");
        await element.setInputFiles(files);
      } finally {
        await el.dispose().catch(() => undefined);
      }
      return { executed: action.id };
    }
    if (kind === "scroll") {
      const delta = typeof action.delta === "number" ? action.delta : 560;
      try {
        await this.page.mouse.wheel(0, delta);
      } catch {
        await this.page.evaluate((d: number) => window.scrollBy(0, d), delta);
      }
      return { executed: action.id };
    }
    if (typeof action.node !== "number") throw new Error("Invalid observed node");
    const frame = this.frameOf(action);
    if (!frame) throw new StalePage("Target frame is gone. Observe again.");
    const frameIndex = action.frame ?? 0;

    // Resolve + validate target inside its own frame (occlusion, disabled,
    // coverage). Returns in-frame center coords or null — model output never
    // becomes selectors. The action travels via window (real fn arg), since
    // string arrows take no args.
    await frame.evaluate((a) => {
      (window as unknown as Record<string, unknown>).__jevAction = a;
    }, { ...action });
    const target = (await frame.evaluate(
      `(() => {
        const action = window.__jevAction;
        const e = window.__jevFast?.nodes.get(action.node);
        if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
            !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
        if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
        try { e.scrollIntoView({ block: 'center' }); } catch (err) {}
        const r = e.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
        if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
        // elementFromPoint retargets shadow content to its host — accept both.
        const pt = document.elementFromPoint(x, y);
        const root = e.getRootNode();
        const inShadow = root instanceof ShadowRoot;
        const hit = pt && (e.contains(pt) ||
          (inShadow && root.host && (pt === root.host || root.host.contains(pt))));
        if (!hit) return null;
        if (action.kind==='select') {
          if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
              !o.disabled && !o.closest('optgroup[disabled]'))) return null;
          e.value = action.value;
          e.dispatchEvent(new Event('input',{bubbles:true}));
          e.dispatchEvent(new Event('change',{bubbles:true}));
        }
        return {x, y};
      })()`,
    )) as { x: number; y: number } | null;

    if (target === null) {
      if (kind === "select") throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
      throw new StalePage("Target changed or is covered. Observe again.");
    }
    if (kind === "select") return { executed: action.id };

    // Translate in-frame coords to page coords for child frames, verifying
    // the iframe itself isn't covered by page-level content.
    let pageX = target.x;
    let pageY = target.y;
    if (frameIndex !== 0) {
      const handle = await frame.frameElement().catch(() => null);
      const box = handle ? await handle.boundingBox().catch(() => null) : null;
      if (!box) throw new StalePage("Target frame moved. Observe again.");
      pageX = box.x + target.x;
      pageY = box.y + target.y;
      const covering = (await this.page.evaluate(
        `(() => { let el = document.elementFromPoint(${pageX}, ${pageY});` +
          ` while (el && el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') el = el.parentElement;` +
          ` return el ? el.tagName : null; })()`,
      )) as string | null;
      if (covering === null) throw new StalePage("Target is covered by page content. Observe again.");
    }

    await this.page.mouse.click(pageX, pageY);
    if (kind === "fill") {
      if (text === undefined) throw new Error("fill needs text");
      await this.page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
      await this.page.keyboard.type(text);
      // Combobox settle (ported from jev-ultrafast): after typing, wait for
      // autocomplete suggestions to visibly render before the next observe.
      await this.settleAfterFill(frame, action);
    }
    return { executed: action.id };
  }

  /** Wait for post-type suggestions (combobox) or a paint (else). Never fails. */
  private async settleAfterFill(frame: Frame, action: PageAction): Promise<void> {
    try {
      await frame.evaluate(
        `(() => { const node = ${action.node}; return new Promise((resolve) => {` +
          ` const field = window.__jevFast?.nodes.get(node);` +
          ` const isCombo = field?.getAttribute && field.getAttribute('role') === 'combobox';` +
          ` const limit = isCombo ? 800 : 50; const t0 = Date.now(); let frames = 0;` +
          ` const step = () => {` +
          ` if (Date.now() - t0 >= limit) return resolve(false);` +
          ` let visible = true;` +
          ` if (isCombo) {` +
          ` const ids = ((field.getAttribute('aria-controls') || field.getAttribute('aria-owns') || '').split(/\\s+/).filter(Boolean));` +
          ` const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document];` +
          ` visible = roots.flatMap((root) => [...root.querySelectorAll('[role="option"]')]).some((e) => {` +
          ` try { const r = e.getBoundingClientRect();` +
          ` return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&` +
          ` e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });` +
          ` } catch (err) { return false; } });` +
          ` }` +
          ` if (visible && ++frames >= 2) return resolve(true);` +
          ` requestAnimationFrame(step); };` +
          ` requestAnimationFrame(step); }); })()`,
      );
    } catch {
      // Settle is best-effort; the act already succeeded.
    }
  }

  /** Run a code-owned read script in the page. Internal use (e.g. result
   *  extraction): model output must never reach this — pass it through act(). */
  async evaluate<T>(expression: string): Promise<T> {
    return (await this.page.evaluate(expression)) as T;
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async screenshot(fullPage = false): Promise<{ data: string; mimeType: string }> {
    const raw = await this.page.screenshot({ type: "jpeg", quality: 72, fullPage });
    return { data: raw.toString("base64"), mimeType: "image/jpeg" };
  }

  /** Drive the page's <video>: seek, play, report state. Time is data. */
  async videoSeek(seconds: number): Promise<{ currentTime: number; duration: number; paused: boolean }> {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Seek needs seconds >= 0.");
    const found = await this.page.evaluate(
      `(() => { const v = document.querySelector('video'); if (!v) return false;` +
        ` try { v.currentTime = ${seconds}; } catch (e) {}` +
        ` try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}` +
        ` return true; })()`,
    );
    if (!found) throw new Error("No video element on this page — navigate to a watch page first.");
    await sleep(800);
    const state = await this.page.evaluate(
      `(() => { const v = document.querySelector('video');` +
        ` return v ? { currentTime: v.currentTime, duration: v.duration || 0, paused: v.paused } : null; })()`,
    );
    if (!state) throw new Error("Video element vanished.");
    return state as { currentTime: number; duration: number; paused: boolean };
  }

  currentUrl(): string {
    return this.page.url();
  }

  /** Capture failed requests for breakage diagnosis. Reset per observe.
   *  NOTE: console-error capture was tried and removed — this Chromium
   *  build does not deliver CDP console events (verified: load-time throws,
   *  explicit console.error, post-load evaluates all silent). Network
   *  responses arrive fine, so failures surface here instead. */
  private watchDiagnostics(): void {
    if (this.diagnosed.has(this.page)) return;
    this.diagnosed.add(this.page);
    this.page.on("response", (res) => {
      try {
        const st = res.status();
        if (st >= 400) {
          this.failedRequests.push({ url: res.url().slice(0, 200), status: st });
          if (this.failedRequests.length > 20) this.failedRequests.shift();
        }
      } catch {
        // Listener must never throw.
      }
    });
  }

  /** Track downloads: save into the profile dir, remember name/path/url.
   *  Only records downloads triggered by pages in this adapter's window;
   *  the listener is removed on close() so the shared contexts[0] never
   *  accumulates dead listeners. */
  private watchDownloads(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort (saveAs will surface real failures).
    }
    this.downloadListener = (download: Download) => {
      void (async () => {
        try {
          // Attribute to this window only: ignore other agents' downloads
          // on the shared context.
          const src = download.page();
          if (src && this.windowId !== null && this.browserSession) {
            try {
              const tid = await this.targetIdOf(src);
              if (tid) {
                const r = (await this.browserSession.send("Browser.getWindowForTarget", { targetId: tid })) as { windowId?: number };
                if (r.windowId !== this.windowId) return;
              }
            } catch {
              // Attribute-check failed — record anyway rather than lose it.
            }
          }
          const safe = download.suggestedFilename().replace(/[^\w.\-]+/g, "_").slice(0, 120) || "download";
          const path = join(dir, `${Date.now()}-${safe}`);
          await download.saveAs(path);
          this.downloads.push({ name: download.suggestedFilename(), path, url: download.url() });
        } catch {
          // Best-effort.
        }
      })();
    };
    this.ctx.on("download", this.downloadListener);
  }

  downloadList(): { name: string; path: string; url: string }[] {
    return [...this.downloads];
  }

  /** Coordinate click in page CSS pixels (vision-grounded fallback). */
  async clickAt(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }

  /** Save the current page as PDF. Headed/headless Chromium both serve printToPDF. */
  async savePdf(path?: string): Promise<string> {
    const out = path ?? join(tmpdir(), `page-${Date.now()}.pdf`);
    await this.page.pdf({ path: out });
    return out;
  }

  /** Operated tabs: index + url + title for tabs in THIS window only. */
  async tabList(): Promise<{ index: number; url: string; title: string }[]> {
    const out: { index: number; url: string; title: string }[] = [];
    const pages = await this.windowPages();
    for (let i = 0; i < pages.length; i++) {
      let url = "";
      let title = "";
      try {
        url = pages[i].url();
      } catch {
        // Skip dead tabs.
      }
      try {
        title = await pages[i].title();
      } catch {
        // Title is best-effort.
      }
      out.push({ index: i, url, title });
    }
    return out;
  }

  /** Switch the operated page (this window only). Next observe/act uses it. */
  async switchTo(index: number): Promise<void> {
    const pages = await this.windowPages();
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      throw new Error(`No tab ${index} — see browser_tabs for the list.`);
    }
    this.page = pages[index];
    try {
      await this.page.bringToFront();
    } catch {
      // Best-effort (headless has no front).
    }
    this.watchDiagnostics();
  }

  /** Close one tab in this window (never the last — use close() instead). */
  async closeTab(index: number): Promise<void> {
    const pages = await this.windowPages();
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      throw new Error(`No tab ${index} — see browser_tabs for the list.`);
    }
    if (pages.length <= 1) {
      throw new Error("Only one tab open — use browser_close to end the session instead.");
    }
    const target = pages[index];
    await target.close().catch(() => undefined);
    if (target === this.page || this.page.isClosed()) {
      const rest = await this.windowPages();
      if (rest.length > 0) {
        this.page = rest[0];
        try {
          await this.page.bringToFront();
        } catch {
          // Best-effort.
        }
      }
    }
  }

  /** Scroll the first visible match into view. Ported from find_text. */
  async findText(text: string): Promise<boolean> {
    if (!text) return false;
    const found = await this.page.evaluate(
      `(() => { const want = ${JSON.stringify(text.toLowerCase())};` +
        ` const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);` +
        ` let node;` +
        ` while ((node = walker.nextNode())) {` +
        ` const t = (node.textContent || '').toLowerCase();` +
        ` if (t.includes(want)) { const el = node.parentElement; if (!el) continue;` +
        ` const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) continue;` +
        ` try { el.scrollIntoView({ block: 'center' }); } catch (e) {}` +
        ` return true; } } return false; })()`,
    );
    return found === true;
  }

  /** Regex/text search over visible text with context. No navigation. */
  async searchPageText(
    pattern: string,
    opts: { regex?: boolean; caseSensitive?: boolean; contextChars?: number; maxResults?: number } = {},
  ): Promise<{ text: string; context: string }[] | { error: string }> {
    // Matching runs in Node, never in the page: a hostile pattern can only
    // burn a capped worker, never the tab (ReDoS-proof by timeout).
    let text: string;
    try {
      text = await this.page.evaluate(
        "(() => (document.body ? document.body.innerText : '').slice(0, 300000))()",
      );
    } catch {
      return { error: "could not read page text" };
    }
    if (typeof text !== "string") return { error: "could not read page text" };
    return matchInWorker(text, pattern, opts);
  }
  /**
   * Run fn with a throwaway tab as the operated page, then restore.
   * One-shots (search/open) share the session browser instead of launching
   * a second instance — Chromium forbids two on one profile dir, and a
   * second launch would queue on the file lock, not run in parallel.
   * fn must use adapter methods directly (never session fns — deadlock).
   */
  async withTab<R>(url: string, fn: (b: AgentBrowserAdapter) => Promise<R>): Promise<R> {
    const prev = this.page;
    // Throwaway tab lives in THIS window (keeps mainPage at about:blank so
    // closing the throwaway never closes the agent's last-tab window).
    const tab = await this.newPageInWindow("about:blank");
    this.page = tab;
    this.watchDiagnostics();
    try {
      await tab.goto(url);
      await tab.waitForLoadState("domcontentloaded");
      return await fn(this);
    } finally {
      this.page = prev;
      await tab.close().catch(() => undefined);
    }
  }
  /** URLs of open tabs in THIS window only. Sync best-effort: tabs the
   *  adapter adopted or opened in-window (plus the operated page); prunes
   *  closed pages. Async tabUrlsInWindow() via CDP is authoritative. */
  tabUrls(): string[] {
    const live = new Set(this.ctx.pages());
    for (const p of [...this.owned]) {
      try {
        if (!live.has(p) || p.isClosed()) this.owned.delete(p);
      } catch {
        this.owned.delete(p);
      }
    }
    if (this.windowId === null || this.owned.size === 0) {
      return this.ctx.pages().map((p) => {
        try {
          return p.url();
        } catch {
          return "";
        }
      });
    }
    const include = new Set(this.owned);
    include.add(this.page);
    if (this.mainPage) include.add(this.mainPage);
    return this.ctx.pages()
      .filter((p) => include.has(p))
      .map((p) => {
        try {
          return p.url();
        } catch {
          return "";
        }
      });
  }

  /** Async window-scoped URLs (authoritative via CDP). Prefer over tabUrls
   *  when an await is affordable. */
  async tabUrlsInWindow(): Promise<string[]> {
    const out: string[] = [];
    for (const p of await this.windowPages()) {
      try {
        out.push(p.url());
      } catch {
        out.push("");
      }
    }
    return out;
  }

  /** Close one tab by exact URL in THIS window only (popup cleanup).
   *  Never touches the operated or main tab. Returns true when closed. */
  async closeTabWithUrl(url: string): Promise<boolean> {
    if (!url) return false;
    for (const p of await this.windowPages()) {
      if (p === this.page || p === this.mainPage) continue;
      let u = "";
      try {
        u = p.url();
      } catch {
        continue;
      }
      if (u === url) {
        try {
          await p.close();
        } catch {
          // Best-effort.
        }
        return true;
      }
    }
    return false;
  }

  async back(): Promise<void> {
    await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }

  async forward(): Promise<void> {
    await this.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
    await this.page.waitForLoadState("domcontentloaded");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // This agent's window only: close every tab in our windowId (closing
    // the last tab closes our window cleanly). Shared context, browser,
    // and every other agent's window stay exactly as they were. Never
    // browser.close() — that handle is shared with the daemon.
    try {
      if (this.downloadListener) this.ctx.off("download", this.downloadListener);
    } catch {
      // Best-effort.
    }
    this.downloadListener = null;
    try {
      const owned = await this.windowPages();
      for (const p of owned) {
        try {
          await Promise.race([p.close(), new Promise((r) => setTimeout(r, 5000))]);
        } catch {
          // Best-effort per tab.
        }
      }
    } catch {
      // Best-effort.
    }
    this.mainPage = null;
    this.owned.clear();
    try {
      await this.browserSession?.detach().catch(() => undefined);
    } catch {
      // Best-effort.
    }
    this.browserSession = null;
    // Drop our CDP connection without stopping the shared browser.
    // (browser.close() over connectOverCDP would kill the daemon's
    // browser — never call it here.)
  }
}
