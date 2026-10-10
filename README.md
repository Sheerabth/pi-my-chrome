# pi-my-chrome

[![Node 22+](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Pi browses websites the way you do — through your real Chrome profile.**

`pi-my-chrome` is a TypeScript package + native Pi extension. Your Chrome login
state is snapshotted to a throwaway dir and driven headless through
[CloakBrowser](https://github.com/CloakHQ/CloakBrowser) stealth Chromium.
No re-login, no visible window, your open Chrome untouched. No API keys —
Pi itself is the agent loop; this package is its hands.

## The whole product: search, open, navigate

```ts
import { search, open } from "pi-my-chrome";

const hits = await search("population of Zurich", { maxResults: 5 });
// [{ title, url, engine, snippet? }, …] — no keys, ~5s
// Engines: google, bing, youtube, reddit, github (+registerEngine for more).
// Options: depth (inline top-N page bodies), maxResults (to 50).

const page = await open(hits[0].url);
// { url, title, text } — read like following a result by hand
```

As Pi tools (installed via `pi install <this-dir>`), Pi navigates step by
step on one persistent session:

| Tool | What Pi does with it |
|---|---|
| `browser_search` | search the web → structured title+url results |
| `browser_open` | open a URL in the session, read it as markdown |
| `browser_navigate` | go anywhere, get text + clickable action ids |
| `browser_read` | re-observe without touching anything (live updates, no reload state loss) |
| `browser_act` | click/type/**upload** by action id (uploads sandboxed to cwd+tmp), then re-observe |
| `browser_press` | press Escape/Enter/Tab/arrows, then re-observe |
| `browser_screenshot` | JPEG to Pi vision (canvas/maps/visual fallback) |
| `browser_click_at` | click at viewport x/y — vision-grounded fallback for what the DOM can't see |
| `browser_video_seek` | seek session video to N seconds + screenshot the frame |
| `browser_video_transcript` | YouTube captions as timestamped text (InnerTube iOS, loud errors) |
| `browser_tabs` / `browser_tab_switch` | operated tabs: list, switch, re-observe |
| `browser_pdf` | save current page as PDF, returns path |
| `browser_downloads` | files downloaded this session (name/path/source) |
| `browser_find` | scroll first text match into view, re-observe |
| `browser_search_page` | regex/text search over page text with context (no navigation) |
| `browser_wait` | fixed wait 0–30s, then re-observe |
| `browser_tab_close` | close one tab (never the last) |
| `browser_back` / `browser_forward` | history navigation + re-observe |
| `browser_close` | close the session (reopens on next navigate) |
| `browser_reset` | close session + wipe profile copy (poisoned state, endless walls) |
| `/chrome-config` | show resolved config (nothing secret exists to leak) |

```bash
npx tsx examples/run.ts --query "population of Zurich" --engine google
```

## How it works

```
search(query) → [{title, url}]     direct /search?q= URLs, redirect unwrapping,
                                   click-resolve for opaque links
open(url)     → {title, text}      one observe on the profile copy
navigate/act  → PageSnapshot       shared session, serialized ops, freshness-
                                   checked acts; profile lock queues processes
```

| File | Job |
|---|---|
| `src/search.ts` | `search()` → structured results; `open()` → page as **markdown** (headings, links, lists; SPA noise stripped) |
| `src/session.ts` | one persistent session: lazy open, serialized ops, clean close |
| `src/cloakAdapter.ts` | `observe/fresh/act/back/forward/goto/close` on CloakBrowser — **iframe-aware**: each frame snapshotted (cross-origin included), actions merged into one indexed space with freshness guards per frame |
| `src/profile.ts` | selective login-state copy → `/tmp/agent-chrome/`, cross-process lock |
| `src/simple.ts` | `SimpleBrowser` — manual driving for scripts |
| `vendor/shadow-supplement.js` | open-shadow-DOM + `[onclick]`/label/file-input controls, shared node identity |
| `vendor/markdown.js` | dependency-free page-side HTML→Markdown (approach ported from browser-use) |
| `src/config.ts` | profile dir, headless, locale/timezone/proxy (there are no keys) |
| `pi-extension/my-chrome.ts` | the Pi tools + `/chrome-config` |

## Installation

Prereqs: Node 22+, Google Chrome (logged in).

```bash
git clone <this-repo>
cd pi-my-chrome
npm install
pi install ./pi-my-chrome
```

CloakBrowser's binary auto-downloads on first launch. No browser extension, no `--remote-debugging-port` setup.

### Configuration

```jsonc
// ~/.pi/agent/settings.json
{ "myChrome": { "headless": true, "profileDir": "…", "locale": "en-US", "timezone": "Europe/Zurich" } }
```

Precedence: tool args > Pi settings `myChrome` > env (`PI_MY_CHROME_DIR`,
`PI_MY_CHROME_REAL`, `AGENTSEARCH_HEADLESS`, `PI_MY_CHROME_LOCALE/TIMEZONE/PROXY`) > `.env` (auto-loaded) >
defaults. Your real profile is a **read-only source** — never launched on
(SingletonLock), only login files copied from it.

## Limits

Frames (even cross-origin) are traversed and clickable; open shadow DOM the
same way; `[onclick]` divs, label-wrapped controls, and file **uploads** work;
keys and screenshots cover dialogs and visual fallbacks. Password fields are
never observed or typed — secrets must not enter model context. Still out:
closed shadow roots (unreadable from page JS, for everyone), drag-and-drop,
hover sequences, wait-for-condition, permissions/mobile emulation. Behavioral walls
and human-body proofs stay adversarial. Automated browsing may violate some sites'
ToS — use your own profile at your own risk, and prefer a dedicated agent
Chrome profile for high-value accounts.

## Acknowledgements

* [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT) — `snapshot.js` (vendored at `1231850a`), freshness-guard design.
* [browser-use/browser-use](https://github.com/browser-use/browser-use) (MIT) — ported mechanics: shadow traversal, markdown extraction, combobox settle, upload/find/wait/tab/pdf/download actions.
* [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser) — stealth Chromium.

## Contributing

PRs welcome. Verify with `npx tsc --noEmit`, a live `npx tsx examples/run.ts`, and `npx tsx examples/probe.ts`. No unit tests by policy — real browser runs are the test suite.

## License

MIT — see [LICENSE](LICENSE).
