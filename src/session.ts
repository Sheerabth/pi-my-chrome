/**
 * One persistent browser session per process.
 *
 * Pi navigates step by step across many tool calls; launching a browser per
 * call (~2s + profile copy each) would be absurd. The session opens lazily
 * on first use, serializes concurrent operations (tool calls in one message
 * run in parallel; Playwright must not interleave acts), and closes on
 * `closeSession()` — or stays warm until the process ends.
 *
 * Options on the first call win; later calls reuse the open session.
 * The profile lock still applies underneath: a second *process* queues.
 */

import { CloakBrowserAdapter } from "./cloakAdapter.js";
import type { LaunchOpts } from "./cloakAdapter.js";
import { ensureEnv } from "./config.js";
import { wipeProfileCopy } from "./profile.js";
import type { PageSnapshot } from "./types.js";

export interface SessionOpts extends Omit<LaunchOpts, "userDataDir"> {
  profileDir?: string;
}
// NOTE: options apply at session creation (first call wins). Later calls with
// different opts reuse the open session — use browser_reset for a clean slate.

let session: CloakBrowserAdapter | null = null;
let inFlight: Promise<void> = Promise.resolve();

/** Run fn exclusively (no two adapter operations interleave).
 *  On crashed-browser errors, drop the dead session and run once more
 *  against a fresh relaunch before giving up.
 *  Every operation also gets a hard deadline: on timeout the mutex
 *  releases and the session is dropped, so one wedged call can never
 *  starve later ones. (A timeout means unknown browser state — relaunch
 *  is the only safe answer.) */
const OP_DEADLINE_MS = 150_000;
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const runOnce = async (): Promise<T> => {
    const prev = inFlight;
    let release!: () => void;
    inFlight = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Browser operation timed out after 150s")), OP_DEADLINE_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  };
  try {
    return await runOnce();
  } catch (err) {
    // Timeout: unknown browser state, and the wedged op might still land
    // later — so drop the session but do NOT retry (no double-acts).
    if (err instanceof Error && err.message.includes("timed out after")) {
      try {
        await Promise.race([session?.close(), new Promise((r) => setTimeout(r, 20000))]);
      } catch {
        // Best-effort.
      }
      session = null;
      throw err;
    }
    if (await reviveIfDead(err)) return runOnce();
    throw err;
  }
}

async function ensureSession(url?: string, opts: SessionOpts = {}): Promise<CloakBrowserAdapter> {
  ensureEnv();
  if (!session) {
    session = await CloakBrowserAdapter.create(url ?? "about:blank", {
      userDataDir: opts.profileDir,
      realProfile: opts.realProfile,
      headless: opts.headless,
      proxy: opts.proxy,
      locale: opts.locale,
      timezone: opts.timezone,
      userAgent: opts.userAgent,
      geolocation: opts.geolocation,
      permissions: opts.permissions,
    });
  } else if (url) {
    await session.goto(url);
  }
  return session;
}

/** Drop a dead session (crashed browser) so the next call relaunches. */
async function reviveIfDead(err: unknown): Promise<boolean> {
  const msg = err instanceof Error ? err.message : String(err);
  if (/closed|crashed|terminated|browser has been closed|Target closed|Connection closed|Protocol error/i.test(msg)) {
    try {
      await session?.close();
    } catch {
      // Best-effort.
    }
    session = null;
    return true;
  }
  return false;
}

/** Navigate the session (opening it on first use) and observe. */
export async function navigate(url: string, opts: SessionOpts = {}, screenshot = false): Promise<PageSnapshot> {
  return exclusive(async () => (await ensureSession(url, opts)).observe(screenshot));
}

/** Re-observe the current page without navigating. */
export async function read(screenshot = false): Promise<PageSnapshot> {
  return exclusive(async () => (await ensureSession()).observe(screenshot));
}

/** Act on an observed action id, then re-observe. */
export async function act(actionId: string, text?: string, files?: string[]): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    // One internal retry: pages still settling (images shifting layout)
    // fail freshness spuriously. Safe — StalePage throws before anything
    // executes, so the retry cannot double-act. (Same shape as upstream's
    // tick-level recovery, one layer down.)
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await browser.observe();
      const action = page.actions.find((a) => a.id === actionId);
      if (!action) throw new Error(`Unknown action id ${JSON.stringify(actionId)} — read again for fresh ids.`);
      if (action.kind === "fill" && text === undefined) {
        throw new Error("That field needs text — pass text='...'.");
      }
      if (action.kind === "upload" && !files?.length) {
        throw new Error("That input needs files=[...] — pass local file paths.");
      }
      try {
        await browser.act(action, page, text, files);
        return browser.observe();
      } catch (err) {
        if (attempt === 0 && err instanceof Error && err.name === "StalePage") continue;
        throw err;
      }
    }
    throw new Error("Unreachable");
  });
}

export async function back(): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.back();
    return browser.observe();
  });
}

export async function forward(): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.forward();
    return browser.observe();
  });
}

/** Coordinate click in page CSS pixels (vision-grounded fallback). */
export async function clickAt(x: number, y: number): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.clickAt(x, y);
    return browser.observe();
  });
}

/** Save the current page as PDF; returns the file path. */
export async function savePdf(path?: string): Promise<string> {
  return exclusive(async () => (await ensureSession()).savePdf(path));
}

/** Files downloaded in this session (name/path/source url). */
export async function downloads(): Promise<{ name: string; path: string; url: string }[]> {
  return exclusive(async () => (await ensureSession()).downloadList());
}

/** List open tabs (index/url/title) for operated switching. */
export async function tabList(): Promise<{ index: number; url: string; title: string }[]> {
  return exclusive(async () => (await ensureSession()).tabList());
}

/** Switch the operated tab, then re-observe. */
export async function tabSwitch(index: number): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.switchTo(index);
    return browser.observe();
  });
}

/** Close one tab (never the last), then re-observe. */
export async function tabClose(index: number): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.closeTab(index);
    return browser.observe();
  });
}

/** Scroll the first visible match into view, then re-observe. */
export async function find(text: string): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    const found = await browser.findText(text);
    if (!found) throw new Error(`Text not found on this page: ${JSON.stringify(text.slice(0, 80))}`);
    return browser.observe();
  });
}

/** Regex/text search over visible text with context. No navigation. */
export async function searchPage(
  pattern: string,
  opts: { regex?: boolean; caseSensitive?: boolean; contextChars?: number; maxResults?: number } = {},
): Promise<{ text: string; context: string }[] | { error: string }> {
  return exclusive(async () => (await ensureSession()).searchPageText(pattern, opts));
}

/** Fixed wait (capped at 30s, like upstream), then re-observe. */
export async function wait(seconds: number): Promise<PageSnapshot> {
  const ms = Math.min(Math.max(seconds, 0), 30) * 1000;
  await new Promise((r) => setTimeout(r, ms));
  return exclusive(async () => (await ensureSession()).observe());
}

/** Press a key (Escape, Enter, Tab, arrows…) on the focused element. */
export async function press(key: string): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.press(key);
    return browser.observe();
  });
}

/** Seek the session video, then re-observe. */
export async function videoSeek(seconds: number): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.videoSeek(seconds);
    return browser.observe();
  });
}

/** Screenshot the current page (viewport, or fullPage for long/maps pages). */
export async function screenshot(fullPage = false): Promise<{ data: string; mimeType: string }> {
  return exclusive(async () => (await ensureSession()).screenshot(fullPage));
}

export async function closeSession(): Promise<void> {
  await exclusive(async () => {
    if (session) {
      await session.close();
      session = null;
    }
  });
}

/** Reset everything: close the session and wipe the throwaway profile copy.
 *  Next navigation starts from a fresh copy of the real profile. */
export async function resetSession(): Promise<void> {
  await exclusive(async () => {
    if (session) {
      await session.close();
      session = null;
    }
    wipeProfileCopy();
  });
}

/** True while a session is open (for status reporting). */
export function hasSession(): boolean {
  return session !== null;
}

/**
 * Run fn with a throwaway tab in the session browser (creating the session
 * if needed). One-shots share the browser instead of launching a second
 * instance — Chromium forbids two on one profile dir. fn must use the
 * adapter directly, never session fns (reentrancy deadlock).
 */
export async function runInTab<T>(
  url: string,
  fn: (b: CloakBrowserAdapter) => Promise<T>,
  opts: SessionOpts = {},
): Promise<T> {
  return exclusive(async () => {
    const browser = await ensureSession(undefined, opts);
    return browser.withTab(url, fn);
  });
}
