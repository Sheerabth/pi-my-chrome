/**
 * Agent search: one call, structured results, zero decisions, zero keys.
 *
 * Goes straight at `<engine>/search?q=…` (no typing step), observes once,
 * and returns title+url results with engine redirect wrappers unwrapped.
 * `open()` reads a result as markdown. For interaction mid-task, hand
 * URLs to the Pi navigation tools (navigate/act) — this module only
 * fetches and parses.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBrowserAdapter } from "./browserAdapter.js";
import { runInTab } from "./session.js";
import type { PageSnapshot } from "./types.js";

const MARKDOWN_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "markdown.js"),
  "utf8",
);

export interface SearchResult {
  title: string;
  url: string;
  engine: SearchEngine;
  /** Snippet/description text from the results page, when present. */
  snippet?: string;
  /** Full markdown of the page, only when search depth inlining was asked. */
  content?: string;
}

export type SearchEngine = "google" | "bing" | "youtube" | "reddit" | "github";

export interface BrowserOpts {
  headless?: boolean;
  profileDir?: string;
  proxy?: string;
}

const ENGINES: Record<string, EngineDef> = {
  google: { searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`, homeHost: "google.com" },
  bing: { searchUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, homeHost: "bing.com" },
  youtube: { searchUrl: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, homeHost: "youtube.com", siteSearch: true },
  reddit: { searchUrl: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`, homeHost: "reddit.com", siteSearch: true },
  github: { searchUrl: (q) => `https://github.com/search?q=${encodeURIComponent(q)}&type=repositories`, homeHost: "github.com", siteSearch: true },
};

export interface EngineDef {
  searchUrl: (q: string) => string;
  homeHost: string;
  /** Single-site search (results share the engine host — don't drop them). */
  siteSearch?: boolean;
}

/** Register a custom engine (name + search-URL template). */
export function registerEngine(name: string, def: EngineDef): void {
  ENGINES[name.toLowerCase()] = def;
}

/** Unwrap engine redirect links (/url?q=, /goto?url=, /l/?uddg=). Pure. */
export function unwrapUrl(href: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const wrappers: [path: string, param: string][] = [
    ["/url", "q"],
    ["/goto", "url"],
  ];
  for (const [path, param] of wrappers) {
    if (u.pathname === path) {
      const v = u.searchParams.get(param);
      if (v) return v;
    }
  }
  // Bing /ck/a?u=a1<base64url> — strip the a1 prefix and decode.
  if (u.pathname.startsWith("/ck")) {
    const coded = u.searchParams.get("u") ?? "";
    const b64 = coded.startsWith("a1") ? coded.slice(2) : coded;
    try {
      const decoded = Buffer.from(b64, "base64url").toString("utf8");
      if (/^https?:\/\//.test(decoded)) return decoded;
    } catch {
      // Fall through to the raw href.
    }
  }
  if (u.pathname.startsWith("/l")) {
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
  }
  return u.href;
}

/** Does this href smell like an engine redirect worth click-resolving?
 *  (Plain same-host nav and #anchors can never yield an external URL.) */
export function looksRedirect(href: string): boolean {
  let u: URL;
  try {
    u = new URL(href, "http://placeholder");
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.pathname === "/url" || u.pathname === "/goto" || u.pathname.startsWith("/l")) return true;
  return ["q", "url", "uddg", "u"].some((k) => /^https?:\/\//.test(u.searchParams.get(k) ?? ""));
}
/** Drop engine-internal links (nav, accounts, policies, more searches). Pure. */
export function isJunkResult(url: string, homeHost: string, siteSearch = false): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (!u.hostname.endsWith(homeHost)) return false;
  if (!siteSearch) return true;
  // Site search: results live on the same host — drop only chrome paths.
  const chrome = new Set([
    "/", "/search", "/login", "/signin", "/signup", "/settings", "/help",
    "/about", "/explore", "/topics", "/collections", "/policies", "/preferences",
    "/advanced_search", "/account", "/notifications", "/feed",
    "/results", "/trending", "/shorts", "/premium", "/support",
    "/search/advanced", "/music",
    "/gaming", "/podcasts", "/movies", "/live",
  ]);
  if (u.pathname.startsWith("/feed/") || u.pathname.startsWith("/t/")) return true;
  return chrome.has(u.pathname.replace(/\/$/, "") || "/");
}

/** Fixed, code-owned metadata script: meta tags, OpenGraph, JSON-LD. */
const META_JS = `(() => {
  const meta = (sel, attr) => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute(attr || 'content') || '').trim() : '';
  };
  let author = meta('meta[name="author"]') || meta('meta[property="article:author"]');
  let published = meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || meta('meta[name="publish-date"]') || meta('time[datetime]', 'datetime');
  let description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  try {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      const blobs = JSON.parse(s.textContent);
      for (const b of Array.isArray(blobs) ? blobs : [blobs]) {
        const g = b['@graph'] || [b];
        for (const n of (Array.isArray(g) ? g : [g])) {
          if (!n || typeof n !== 'object') continue;
          const au = n.author;
          if (!author && au) author = typeof au === 'string' ? au : (au.name || (Array.isArray(au) && au[0] && au[0].name) || '');
          if (!published && n.datePublished) published = n.datePublished;
          if (!description && n.description) description = String(n.description).slice(0, 300);
          if (author && published && description) break;
        }
      }
    }
  } catch (e) {}
  return { author, published, description };
})()`;
const RESULTS_JS = `(() => {
  const out = [];
  const seen = new Set();
  const NAV = 'header,footer,nav,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"]';
  for (const a of document.querySelectorAll('a[href]')) {
    if (out.length >= 300) break;
    if (a.closest(NAV)) continue;
    const href = a.getAttribute('href');
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const r = a.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (!a.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const title = (a.innerText || '').trim().replace(/\\s+/g, ' ');
    if (title.length < 10 || title.length > 300) continue;
    let snippet = '';
    let el = a.parentElement;
    for (let d = 0; d < 4 && el && !snippet; d++, el = el.parentElement) {
      const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t.length > title.length + 40) snippet = t.replace(title, '').trim().slice(0, 300);
    }
    out.push({ title, href, snippet });
  }
  return out;
})()`;

export interface OpenedPage {
  url: string;
  title: string;
  /** Readable content: markdown by default, else plain visible text. */
  text: string;
  format: "text" | "markdown";
  /** Article metadata (author/date/description) when the page publishes it. */
  author?: string;
  published?: string;
  description?: string;
}

/**
 * Open a page and read it, like a human following a search result.
 * No decisions, no keys — just the readable content of one page.
 * Markdown (default) keeps headings, links with URLs, and lists;
 * cleanup mirrors browser-use's markdown preprocessing (JSON-blob
 * stripping, whitespace compression).
 */
export async function open(
  url: string,
  opts: BrowserOpts & { format?: "text" | "markdown"; maxChars?: number } = {},
): Promise<OpenedPage> {
  const format = opts.format ?? "markdown";
  return runInTab(
    url,
    async (b) => {
      let page: PageSnapshot = await b.observe();
      // Wall recovery (same as search): accept consent, retry sorry/blocked once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const wall = detectWall({ url: page.url, title: page.title, text: page.text || "", actions: page.actions.length });
        if (wall === null || wall === "home") break;
        if (wall === "consent") {
          const accept = page.actions.find(
            (a) => a.kind === "click" && /accept|agree|i agree|got it/i.test(String(a.label)),
          );
          if (!accept) break;
          const fresh = await b.observe();
          const target = fresh.actions.find((x) => x.id === accept.id) ?? accept;
          await b.act(target, fresh);
          page = await b.observe();
        } else {
          await sleep(6000);
          await b.goto(url);
          page = await b.observe();
        }
      }
      const withMeta = <T extends Record<string, unknown>>(base: T, meta: Record<string, string>): T & Partial<Record<string, string>> => {
        const out: Record<string, unknown> = { ...base };
        for (const [k, v] of Object.entries(meta)) if (v) out[k] = v;
        return out as T & Partial<Record<string, string>>;
      };
      if (format === "text") {
        const meta0 = await b.evaluate<{ author: string; published: string; description: string }>(META_JS);
        return withMeta({ url: page.url, title: page.title, text: page.text || "", format }, meta0);
      }
      const raw = await b.evaluate<string>(MARKDOWN_JS);
      const meta = await b.evaluate<{ author: string; published: string; description: string }>(META_JS);
      return withMeta({ url: page.url, title: page.title, text: cleanMarkdown(raw, opts.maxChars ?? 8000), format }, meta);
    },
    opts,
  );
}

/** Port of browser-use's markdown _preprocess: drop SPA JSON blobs + squeeze space. */
export function cleanMarkdown(content: string, maxChars = 8000): string {
  let out = content.replace(/`\{["\w].*?\}`/gs, "");
  out = out.replace(/\{"\$type":[^}]{100,}\}/g, "");
  out = out.replace(/\{"[^"]{5,":\{[^}]{100,}\}/g, "");
  out = out.replace(/\n{4,}/g, "\n\n\n");
  const kept: string[] = [];
  for (const line of out.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (stripped.length > 100 && (stripped[0] === "{" || stripped[0] === "[")) {
      try {
        JSON.parse(stripped);
        continue;
      } catch {
        // Not JSON — keep.
      }
    }
    kept.push(line);
  }
  const full = kept.join("\n").trim();
  return full.slice(0, maxChars) + (full.length > maxChars ? "\n[…truncated]" : "");
}

/**
 * Search and return structured results. Opens the browser on the throwaway
 * profile copy (logged-in state applies), observes once, closes.
 *
 * Links that unwrap directly (most engines) resolve instantly. Opaque
 * redirect links (Google's tokenized /goto) resolve by clicking through in
 * the live session and going back. The DOM is re-read after every
 * navigation — never scroll-harvest then resolve, infinite scroll mutates
 * the list out from under stored titles.
 */
/** What stands between us and results, if anything. Pure. */
export function detectWall(page: { url: string; title: string; text: string; actions?: number }):
  | "sorry" | "consent" | "home" | "blocked" | null {
  const url = page.url || "";
  if (url.includes("/sorry/")) return "sorry";
  if (url.includes("consent.") || /\/consent($|[?/])/.test(url)) return "consent";
  try {
    const u = new URL(url);
    if ((u.hostname.endsWith("google.com") || u.hostname.endsWith("bing.com")) && (u.pathname === "/" || u.pathname === "")) {
      return "home";
    }
  } catch {
    // Fall through.
  }
  // Generic robot wall: sparse actions + challenge wording on any engine.
  if ((page.actions ?? 99) <= 2 && /captcha|verify you|unusual traffic|access denied|robot check|are you human|not a robot|forbidden|request blocked/i.test(`${page.title}\n${(page.text || "").slice(0, 2000)}`)) {
    return "blocked";
  }
  return null;
}

/** Minimum gap between searches: hammering triggers walls. */
let lastSearchAt = 0;
async function respectRateLimit(): Promise<void> {
  const wait = 4000 - (Date.now() - lastSearchAt);
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

/**
 * Fan-out: run several queries sequentially (one browser per profile dir
 * forbids true parallelism) and merge URL-deduped in order. Failures
 * surface per query — never another engine's results in disguise.
 */
export async function searchMany(
  queries: string[],
  opts: { engine?: SearchEngine; maxResults?: number; headless?: boolean; profileDir?: string; proxy?: string; depth?: number } = {},
): Promise<{ results: SearchResult[]; errors: { query: string; error: string }[] }> {
  const results: SearchResult[] = [];
  const errors: { query: string; error: string }[] = [];
  const seen = new Set<string>();
  const maxResults = opts.maxResults ?? 10;
  for (const query of queries) {
    try {
      const batch = await search(query, opts);
      for (const r of batch) {
        if (results.length >= maxResults || seen.has(r.url)) continue;
        seen.add(r.url);
        results.push(r);
      }
    } catch (err) {
      errors.push({ query, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, errors };
}

export async function search(
  query: string,
  opts: { engine?: SearchEngine; maxResults?: number; headless?: boolean; profileDir?: string; proxy?: string; depth?: number } = {},
): Promise<SearchResult[]> {
  // One engine, as asked. No silent fallback: an empty result or a thrown
  // error lets the caller (Pi) decide to retry, rephrase, or switch engines.
  return runEngine(query, opts.engine ?? "google", opts);
}

async function runEngine(
  query: string,
  engine: SearchEngine,
  opts: { maxResults?: number; headless?: boolean; profileDir?: string; proxy?: string; depth?: number },
): Promise<SearchResult[]> {
  await respectRateLimit();
  const def = ENGINES[engine];
  if (!def) throw new Error(`Unknown engine ${JSON.stringify(engine)}; known: ${Object.keys(ENGINES).join(", ")}`);
  const maxResults = opts.maxResults ?? 10;
  const homeHost = def.homeHost;
  const siteSearch = !!def.siteSearch;
  const junk = (u: string) => isJunkResult(u, homeHost, siteSearch);
  const searchUrl = def.searchUrl(query);
  return runInTab(
    searchUrl,
    async (b) => {
    let page = await b.observe();
    // Wall recovery (Google): consent accepts, sorry/blocked retries once after a
    // pause, homepage-bounce searches through the box like a human would.
    for (let attempt = 0; attempt < 2; attempt++) {
      const wall = detectWall({ url: page.url, title: page.title, text: page.text || "", actions: page.actions.length });
      if (wall === null) break;
      if (wall === "consent") {
        const accept = page.actions.find(
          (a) => a.kind === "click" && /accept|agree|i agree|got it/i.test(String(a.label)),
        );
        if (!accept) break;
        const fresh = await b.observe();
        await b.act(fresh.actions.find((x) => x.id === accept.id) ?? accept, fresh);
        page = await b.observe();
      } else if (wall === "sorry" || wall === "blocked") {
        await sleep(6000);
        await b.goto(searchUrl);
        page = await b.observe();
      } else {
        const box = page.actions.find((a) => a.kind === "fill");
        if (!box) break;
        const fresh = await b.observe();
        const field = fresh.actions.find((x) => x.id === box.id) ?? box;
        await b.act(field, fresh, query);
        await b.press("Enter");
        page = await b.observe();
      }
    }
    // Let late layout (AI overviews, lazy blocks) settle, then nudge once
    // so content-visibility subtrees render — without reaching infinite scroll.
    await sleep(1000);
    await b.evaluate("(() => window.scrollBy(0, 400))()");
    await sleep(400);
    await b.evaluate("(() => window.scrollTo(0, 0))()");
    await sleep(300);
    if (def.siteSearch) {
      // App-shell pages (YouTube polymer etc.) render result text late:
      // wait until the count of texty anchors stops growing.
      let lastCount = -1;
      let stableRounds = 0;
      for (let i = 0; i < 8 && stableRounds < 2; i++) {
        const n = await b.evaluate<number>(
          "(() => { let c = 0; for (const a of document.querySelectorAll('a[href]'))" +
            " { const t = (a.innerText || '').trim(); if (t.length >= 10) c++; } return c; })()",
        );
        if (n === lastCount) stableRounds++;
        else {
          stableRounds = 0;
          lastCount = n;
        }
        await sleep(700);
      }
    }

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    const attempted = new Set<string>();
    const push = (title: string, url: string, snippet?: string) => {
      if (results.length >= maxResults || seen.has(url) || junk(url)) return false;
      seen.add(url);
      results.push({ title, url, engine, ...(snippet ? { snippet } : {}) });
      return true;
    };
    let guard = 0;
    const debug = !!process.env.PI_SHADOW_DEBUG;
    while (results.length < maxResults && guard++ < maxResults * 3 + 5) {
      const batch = (await b.evaluate(RESULTS_JS)) as { title: string; href: string; snippet: string }[];
      if (debug) console.log(`[search] iter=${guard} batch=${batch.length} have=${results.length}`);
      let progressed = false;
      for (const item of batch) {
        if (results.length >= maxResults) break;
        const url = unwrapUrl(item.href, b.currentUrl());
        if (url && !seen.has(url) && !junk(url)) {
          push(item.title, url, item.snippet);
          progressed = true;
          continue;
        }
        if (!looksRedirect(item.href) || attempted.has(item.title)) continue;
        attempted.add(item.title);
        const resolved = await resolveByClick(b, searchUrl, item.title, homeHost, siteSearch);
        if (resolved) push(item.title, resolved, item.snippet);
        progressed = true;
        break; // back-nav rebuilt the DOM; re-read fresh next round
      }
      if (batch.length === 0 && guard < 3) {
        await sleep(2500);
        continue;
      }
      if (debug && !progressed) console.log(`[search] no progress, stopping`);
      if (!progressed) break;
    }
    // Depth inlining (--depth equivalent): open top-N in the same tab and
    // attach content. Sequential, bounded, restores the results page after.
    const depth = Math.min(opts.depth ?? 0, results.length);
    for (let i = 0; i < depth; i++) {
      try {
        await b.goto(results[i].url);
        await b.observe();
        const raw = await b.evaluate<string>(MARKDOWN_JS);
        results[i].content = cleanMarkdown(raw).slice(0, 2000);
      } catch {
        // One bad page must not sink the batch.
      }
    }
    if (depth > 0) {
      await b.goto(searchUrl).catch(() => undefined);
    }
    return results;
    },
    opts,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Click an opaque redirect link (matched by title), read where it lands.
 *  Handles same-tab navigation and target=_blank popups. Restores tabs. */
async function resolveByClick(
  browser: AgentBrowserAdapter,
  searchUrl: string,
  title: string,
  homeHost: string,
  siteSearch = false,
): Promise<string | null> {
  const norm = title.trim().replace(/\s+/g, " ");
  const debug = !!process.env.PI_SHADOW_DEBUG;
  const before = browser.currentUrl();
  // Snapshot THIS window's tabs before clicking: restore closes only tabs
  // that appeared in-window after the click (never pre-existing tabs,
  // never another agent's window). Redirecting popups still get cleaned.
  const clicked = await browser.evaluate<string>(
    `((t) => { const a = [...document.querySelectorAll('a[href]')]` +
      `.find((x) => (x.innerText || '').trim().replace(/\\s+/g, ' ') === t);` +
      ` if (!a) return 'missing'; a.click(); return 'clicked'; })(${JSON.stringify(norm)})`,
  );
  if (clicked !== "clicked") {
    if (debug) console.log(`[resolve] missing: ${norm.slice(0, 50)}`);
    return null;
  }
  // Either the tab navigated or a popup opened — poll for both.
  // Only URLs unseen before the click count (stale tabs must not match).
  const knownBefore = await browser.tabUrlsInWindow().catch(() => browser.tabUrls());
  const known = new Set([before, ...knownBefore]);
  let landed = "";
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    try {
      const current = browser.currentUrl();
      if (!known.has(current) && !isJunkResult(current, homeHost, siteSearch)) {
        landed = current;
        break;
      }
      const urls = await browser.tabUrlsInWindow().catch(() => browser.tabUrls());
      const popup = urls
        .find((u) => u && !u.startsWith("about:") && !known.has(u) && !isJunkResult(u, homeHost, siteSearch));
      if (popup) {
        landed = popup;
        break;
      }
    } catch {
      return null;
    }
  }
  try {
    // Restore: back out of same-tab navs, close only the popup we opened
    // in THIS window (never pre-existing tabs, never another agent's
    // window — closeTabWithUrl is window-scoped). A click can both
    // navigate and pop, so sweep the landed popup even after backing out.
    if (browser.currentUrl() !== before) await browser.back();
    if (landed && landed !== before) await browser.closeTabWithUrl(landed);
    for (let i = 0; i < 10; i++) {
      const n = await browser.evaluate<number>("(() => document.querySelectorAll('a[href]').length)()");
      if (n > 10) break;
      await sleep(300);
    }
    // Deterministic recovery: history-back can land on interstitials or
    // blank pages — re-going to the search URL always restores the list.
    const restored = browser.currentUrl();
    const anchorCount = await browser.evaluate<number>("(() => document.querySelectorAll('a[href]').length)()");
    if (!restored.startsWith(searchUrl.split("?")[0]) || anchorCount === 0) {
      await browser.goto(searchUrl);
      for (let i = 0; i < 10; i++) {
        const n = await browser.evaluate<number>("(() => document.querySelectorAll('a[href]').length)()");
        if (n > 10) break;
        await sleep(300);
      }
    }
  } catch {
    // Best-effort restore; the run still closes cleanly.
  }
  if (debug) console.log(`[resolve] ${norm.slice(0, 40)} -> ${landed.slice(0, 80) || "(none)"}`);
  return landed || null;
}
