/**
 * Pi extension: Pi navigates websites itself, step by step.
 *
 * No decision models, no micro-loops, no keys. Pi is the agent loop; this
 * package is its hands: search, open, observe-with-actions, act, back,
 * forward — on one persistent session over the user's Chrome profile copy.
 *
 * Install as a Pi package (`pi install <this-dir>`) or load directly:
 * `pi --extension ./pi-extension/my-chrome.ts`.
 *
 * Registers: browser_search, browser_open, browser_navigate, browser_act,
 * browser_press, browser_screenshot, browser_click_at, browser_tabs,
 * browser_tab_switch, browser_tab_close, browser_pdf, browser_downloads,
 * browser_find, browser_search_page, browser_wait, browser_back,
 * browser_forward, browser_close, browser_reset — plus /chrome-config.
 *
 * Settings (highest precedence first):
 *   1. tool arguments (`headless` where offered)
 *   2. Pi settings `myChrome` section (`~/.pi/agent/settings.json`):
 *      `{ "myChrome": { "headless": true, "profileDir": "…", "locale": "…" } }`
 *   3. process environment (`PI_MY_CHROME_DIR`, `PI_MY_CHROME_REAL`,
 *      `AGENTSEARCH_HEADLESS`, `PI_MY_CHROME_LOCALE/TIMEZONE/PROXY`)
 *   4. `.env` in Pi's working directory (auto-loaded, managed keys only)
 *   5. built-in defaults
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  act,
  back,
  clickAt,
  closeSession,
  downloads,
  ensureEnv,
  find,
  forward,
  hasSession,
  loadConfig,
  navigate,
  press,
  read,
  redacted,
  resetSession,
  savePdf,
  screenshot,
  search,
  searchPage,
  tabClose,
  tabList,
  tabSwitch,
  videoSeek,
  videoTranscript,
  wait,
} from "../src/index.js";import type { ChromeConfig } from "../src/index.js";

/**
 * Map the Pi settings `myChrome` section to config overrides.
 * Pure — tested without Pi. Unknown/mistyped fields are ignored.
 */
export function myChromeOverrides(settings: unknown): Partial<ChromeConfig> {
  const section =
    typeof settings === "object" && settings !== null
      ? (settings as { myChrome?: unknown }).myChrome
      : undefined;
  if (typeof section !== "object" || section === null) return {};
  const get = (k: string) => (section as Record<string, unknown>)[k];
  const out: Partial<ChromeConfig> = {};
  if (typeof get("profileDir") === "string") out.profileDir = get("profileDir") as string;
  if (typeof get("realProfile") === "string") out.realProfile = get("realProfile") as string;
  if (typeof get("headless") === "boolean") out.headless = get("headless") as boolean;
  if (typeof get("locale") === "string") out.locale = get("locale") as string;
  if (typeof get("timezone") === "string") out.timezone = get("timezone") as string;
  if (typeof get("proxy") === "string") out.proxy = get("proxy") as string;
  return out;
}

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function failed(tool: string, err: unknown, details: unknown) {
  return textResult(`${tool} failed: ${err instanceof Error ? err.message : String(err)}`, details);
}

/** Render an observed page the way Pi navigates by: text + action ids. */
function renderPage(page: { url: unknown; title: unknown; text: unknown; actions: { id: string; label: string; kind: string }[] }): string {
  const lines = [`URL: ${String(page.url)}`, `Title: ${String(page.title)}`, ""];
  if (typeof page.text === "string" && page.text) lines.push(page.text.slice(0, 3000), "");
  lines.push("Actions (pass the id to browser_act):");
  for (const a of page.actions) lines.push(`  ${a.id}: [${a.kind}] ${a.label}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Settings are read lazily per call: ExtensionAPI methods like
  // getSettings() cannot run during extension loading, only after startup.
  const settingsOverrides = (): Partial<ChromeConfig> => {
    try {
      return myChromeOverrides(pi.getSettings());
    } catch {
      return {};
    }
  };
  const sessionOpts = () => loadConfig(settingsOverrides());

  pi.registerTool({
    name: "browser_search",
    label: "Search the web",
    description:
      "Search the web (Google, Bing, DuckDuckGo, Brave) through the user's stealth browser and get " +
      "structured title+url results. No keys, fast. Follow with browser_open to read a result.",
    promptGuidelines: [
      "Prefer browser_search for public-web questions; it needs no login.",
      "Use the navigate/act tools instead when the task needs logins, forms, or judging pages mid-task.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      engine: Type.Optional(Type.Union(
        [Type.Literal("google"), Type.Literal("bing"),
         Type.Literal("youtube"), Type.Literal("reddit"), Type.Literal("github")],
        { description: "Search engine. Default google." },
      )),
      maxResults: Type.Optional(Type.Number({ description: "How many results. Default 5, max 50 (large counts are slow)." })),
      depth: Type.Optional(Type.Number({ description: "Inline full content for the top N results. Default 0 (titles only)." })),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const cfg = loadConfig(settingsOverrides());
        const results = await search(params.query, {
          engine: (params.engine ?? "google") as "google",
          maxResults: Math.min(params.maxResults ?? 5, 50),
          depth: Math.min(params.depth ?? 0, 5),
          headless: cfg.headless,
          profileDir: cfg.profileDir,
        });
        const lines = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}` +
          (r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : "") +
          (r.content ? `\n   --- content ---\n${r.content.slice(0, 1500)}` : ""),
        );
        return textResult(
          lines.length > 0 ? lines.join("\n") : "No results found.",
          { query: params.query, results },
        );
      } catch (err) {
        return failed("browser_search", err, { query: params.query, results: [] });
      }
    },
  });

  pi.registerTool({
    name: "browser_open",
    label: "Open a page",
    description:
      "Open one URL in the shared browser session and read its visible text, like following a search " +
      "result by hand. Logged-in state applies. No keys.",
    promptGuidelines: [
      "Use browser_open to read a browser_search result in full.",
      "Use browser_navigate + browser_act when the page needs interaction (clicks, forms).",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to open and read." }),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const page = await navigate(params.url, sessionOpts());
        return textResult(`Title: ${page.title}\nURL: ${page.url}\n\n${page.text.slice(0, 4000)}`, page);
      } catch (err) {
        return failed("browser_open", err, { url: params.url });
      }
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Go to URL in session",
    description:
      "Navigate the shared browser session to a URL and observe: visible text plus the action ids " +
      "browser_act can use. Starts the session on first use.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to." }),
      headless: Type.Optional(Type.Boolean({ description: "Headless mode (applies when opening the session)." })),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const fromSettings = settingsOverrides();
        const cfg = loadConfig({ ...fromSettings, headless: params.headless ?? fromSettings.headless });
        const page = await navigate(params.url, {
          headless: cfg.headless,
          profileDir: cfg.profileDir,
          locale: cfg.locale,
          timezone: cfg.timezone,
          proxy: cfg.proxy,
        });
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_navigate", err, { url: params.url });
      }
    },
  });

  pi.registerTool({
    name: "browser_act",
    label: "Click or type in session",
    description:
      "Act on an observed action id in the shared session (click a link/button, type into a field, " +
      "scroll, wait), then re-observe. Get ids from browser_navigate output or a prior act.",
    promptGuidelines: [
      "Pass text only for fill actions (fields); clicks need just the id.",
      "After acting, read the fresh observation before choosing the next action.",
    ],
    parameters: Type.Object({
      actionId: Type.String({ description: "Action id, e.g. e3, scroll_down, wait." }),
      text: Type.Optional(Type.String({ description: "Text to type (fill actions only)." })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Local file paths (upload actions only)." })),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const page = await act(params.actionId, params.text, params.files);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_act", err, { actionId: params.actionId });
      }
    },
  });

  pi.registerTool({
    name: "browser_press",
    label: "Press a key in session",
    description:
      "Press a keyboard key (Escape, Enter, Tab, ArrowDown, …) on the focused element in the shared " +
      "session, then re-observe. For dismissing dialogs and keyboard-driven controls.",
    parameters: Type.Object({
      key: Type.String({ description: "Key name, e.g. Escape, Enter, Tab, ArrowDown, a." }),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const page = await press(params.key);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_press", err, { key: params.key });
      }
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Screenshot session page",
    description:
      "Capture a JPEG screenshot of the current session page for vision — use when the DOM " +
      "observation is empty or ambiguous (canvas apps, maps, visual layout). Pass fullPage for long pages.",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page. Default false (viewport)." })),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const shot = await screenshot(params.fullPage ?? false);
        return {
          content: [{ type: "image" as const, data: shot.data, mimeType: shot.mimeType }],
          details: { mimeType: shot.mimeType, bytes: shot.data.length },
        };
      } catch (err) {
        return failed("browser_screenshot", err, {});
      }
    },
  });

  pi.registerTool({
    name: "browser_back",
    label: "Go back in session",
    description: "Go back one history entry in the shared session and re-observe.",
    parameters: Type.Object({}),
    execute: async () => {
      ensureEnv();
      try {
        const page = await back();
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_back", err, {});
      }
    },
  });

  pi.registerTool({
    name: "browser_forward",
    label: "Go forward in session",
    description: "Go forward one history entry in the shared session and re-observe.",
    parameters: Type.Object({}),
    execute: async () => {
      ensureEnv();
      try {
        const page = await forward();
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_forward", err, {});
      }
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Close browser session",
    description: "Close the shared browser session and release the profile. The next navigation reopens it.",
    parameters: Type.Object({}),
    execute: async () => {
      await closeSession();
      return textResult("Browser session closed.", { open: hasSession() });
    },
  });

  pi.registerTool({
    name: "browser_click_at",
    label: "Click at coordinates",
    description:
      "Click at page CSS-pixel coordinates (x, y) in the shared session, then re-observe. " +
      "Vision-grounded fallback: screenshot first — coordinates match the screenshot 1:1 — then click " +
      "what the DOM cannot see (canvas apps, maps, custom widgets).",
    parameters: Type.Object({
      x: Type.Number({ description: "Horizontal CSS pixel in the current viewport." }),
      y: Type.Number({ description: "Vertical CSS pixel in the current viewport." }),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const page = await clickAt(params.x, params.y);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_click_at", err, { x: params.x, y: params.y });
      }
    },
  });

  pi.registerTool({
    name: "browser_tabs",
    label: "List session tabs",
    description: "List open tabs (index/url/title) in the shared session for browser_tab_switch.",
    parameters: Type.Object({}),
    execute: async () => {
      ensureEnv();
      try {
        const tabs = await tabList();
        const lines = tabs.map((t) => `${t.index}: ${t.title || "(no title)"}\n   ${t.url}`);
        return textResult(lines.length > 0 ? lines.join("\n") : "No tabs open.", { tabs });
      } catch (err) {
        return failed("browser_tabs", err, { tabs: [] });
      }
    },
  });

  pi.registerTool({
    name: "browser_tab_switch",
    label: "Switch session tab",
    description: "Switch the operated tab in the shared session (see browser_tabs), then re-observe.",
    parameters: Type.Object({
      index: Type.Number({ description: "Tab index from browser_tabs." }),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const page = await tabSwitch(params.index);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_tab_switch", err, { index: params.index });
      }
    },
  });

  pi.registerTool({
    name: "browser_pdf",
    label: "Save page as PDF",
    description: "Save the current session page as a PDF file. Returns the file path.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Where to save. Default: a temp file." })),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const path = await savePdf(params.path);
        return textResult(`Saved PDF to ${path}`, { path });
      } catch (err) {
        return failed("browser_pdf", err, {});
      }
    },
  });

  pi.registerTool({
    name: "browser_downloads",
    label: "List session downloads",
    description: "List files downloaded in this session (name, saved path, source url).",
    parameters: Type.Object({}),
    execute: async () => {
      ensureEnv();
      try {
        const files = await downloads();
        const lines = files.map((f) => `${f.name}\n   ${f.path}`);
        return textResult(lines.length > 0 ? lines.join("\n") : "No downloads yet.", { files });
      } catch (err) {
        return failed("browser_downloads", err, { files: [] });
      }
    },
  });

  pi.registerTool({
    name: "browser_find",
    label: "Find text in session",
    description: "Scroll the first visible match of the given text into view in the shared session, then re-observe.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to find (case-insensitive)." }),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const page = await find(params.text);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_find", err, { text: params.text });
      }
    },
  });

  pi.registerTool({
    name: "browser_search_page",
    label: "Search page text",
    description:
      "Regex/text search over the session page's visible text with surrounding context. No navigation. " +
      "Use to locate content without scrolling the page.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text or regex pattern." }),
      regex: Type.Optional(Type.Boolean({ description: "Treat pattern as regex. Default false (literal)." })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive match. Default false." })),
      contextChars: Type.Optional(Type.Number({ description: "Context characters around each hit. Default 100." })),
      maxResults: Type.Optional(Type.Number({ description: "Max hits. Default 10." })),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const out = await searchPage(params.pattern, {
          regex: params.regex,
          caseSensitive: params.caseSensitive,
          contextChars: params.contextChars,
          maxResults: params.maxResults,
        });
        if ("error" in out) return failed("browser_search_page", out.error, { pattern: params.pattern });
        const lines = out.map((h) => `- ${h.text}\n  …${h.context}…`);
        return textResult(lines.length > 0 ? lines.join("\n") : "No matches on this page.", { pattern: params.pattern, hits: out });
      } catch (err) {
        return failed("browser_search_page", err, { pattern: params.pattern });
      }
    },
  });

  pi.registerTool({
    name: "browser_wait",
    label: "Wait in session",
    description: "Wait a fixed number of seconds (max 30, for loading content), then re-observe.",
    parameters: Type.Object({
      seconds: Type.Number({ description: "Seconds to wait, 0–30." }),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const page = await wait(params.seconds);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_wait", err, { seconds: params.seconds });
      }
    },
  });

  pi.registerTool({
    name: "browser_tab_close",
    label: "Close session tab",
    description: "Close one tab by index (see browser_tabs); never the last — browser_close ends the session.",
    parameters: Type.Object({
      index: Type.Number({ description: "Tab index from browser_tabs." }),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        const page = await tabClose(params.index);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_tab_close", err, { index: params.index });
      }
    },
  });

  pi.registerTool({
    name: "browser_reset",
    label: "Reset browser state",
    description:
      "Close the session and wipe the throwaway profile copy. Next navigation starts fresh from the " +
      "real profile. Use for poisoned state, endless walls, or a clean slate.",
    parameters: Type.Object({}),
    execute: async () => {
      ensureEnv();
      try {
        await resetSession();
        return textResult("Browser session closed and profile copy wiped. Next navigation starts fresh.", { open: hasSession() });
      } catch (err) {
        return failed("browser_reset", err, {});
      }
    },
  });

  pi.registerTool({
    name: "browser_read",
    label: "Re-read session page",
    description:
      "Re-observe the current session page without navigating, acting, or waiting. " +
      "Use when the page may have changed by itself (live updates, timers) or to check " +
      "freshness without losing form or app state to a reload.",
    parameters: Type.Object({}),
    execute: async () => {
      ensureEnv();
      try {
        const page = await read();
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_read", err, {});
      }
    },
  });

  pi.registerTool({
    name: "browser_video_transcript",
    label: "Get video transcript",
    description:
      "Fetch a YouTube video's captions as timestamped text — the fastest way to " +
      "understand a video without watching it. No keys. Fails clearly when a video " +
      "has no published captions.",
    parameters: Type.Object({
      url: Type.String({ description: "YouTube watch/share/shorts URL." }),
      lang: Type.Optional(Type.String({ description: "Caption language code. Default en." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const t = await videoTranscript(params.url, params.lang ?? "en");
        const stamp = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
        const lines = t.segments.map((s) => `[${stamp(s.start)}] ${s.text}`);
        const body = lines.join("\n");
        return textResult(
          `${t.title || "Untitled"} (${t.lang}${t.autoGenerated ? ", auto-generated" : ""}, ${t.segments.length} lines)\n\n` +
            (body.length > 6000 ? body.slice(0, 6000) + "\n[…truncated]" : body),
          { videoId: t.videoId, segments: t.segments },
        );
      } catch (err) {
        return failed("browser_video_transcript", err, { url: params.url });
      }
    },
  });

  pi.registerTool({
    name: "browser_video_seek",
    label: "Seek session video",
    description:
      "Seek the session page's video to N seconds and screenshot the frame — " +
      "look at a specific moment. Navigate to a watch page first. Returns the " +
      "frame image plus player state.",
    parameters: Type.Object({
      seconds: Type.Number({ description: "Timestamp to seek to, in seconds." }),
    }),
    execute: async (_toolCallId, params) => {
      ensureEnv();
      try {
        await videoSeek(params.seconds);
        const shot = await screenshot();
        return {
          content: [
            { type: "image" as const, data: shot.data, mimeType: shot.mimeType },
            { type: "text" as const, text: `Seeked to ${params.seconds}s.` },
          ],
          details: { seconds: params.seconds },
        };
      } catch (err) {
        return failed("browser_video_seek", err, { seconds: params.seconds });
      }
    },
  });

  pi.registerCommand("chrome-config", {
    description: "Show the resolved my-chrome configuration (no secrets exist to leak).",
    handler: async (_args, ctx) => {
      ensureEnv();
      const summary = redacted(loadConfig(settingsOverrides()));
      const text = Object.entries(summary)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n");
      ctx.ui.notify(`my-chrome config (Pi settings myChrome > env > .env):\n${text}`, "info");
    },
  });
}
