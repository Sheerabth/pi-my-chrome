# pi-shadow-browser

[![Node 22+](https://img.shields.io/badge/Node-22+-green.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Pi browses websites through its own stealth browser — a separate agent identity.**

`pi-shadow-browser` is a TypeScript package + native Pi extension. Pi drives a
persistent agent profile headless through
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (open-source
stealth Chromium fork, Apache-2.0). Log in once inside the agent browser and
the session persists — your own Chrome is never touched. No API keys —
Pi itself is the agent loop; this package is its hands.

## The whole product: search, open, navigate

```ts
import { search, open } from "pi-shadow-browser";

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
_Postscript: data tools (`browser_search`, `browser_open`, `browser_video_transcript_) return dual-channel results — readable text for the model plus typed `structuredContent` (declared `outputSchema`) for codemode scripts. No JSON parsing by the model._
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
| `/browser-reset` | close everything, stop the daemon, wipe the agent home (fresh login required after) |
| `/browser-config` | show or change config (`/browser-config [key value \| reset [key]]`) |
| `/browser-open` | open a focused blank tab in the shared window for manual use (log in by hand) |
| `/browser-shutdown` | stop the shared browser daemon |

_Data tools (`browser_search`, `browser_open`, `browser_video_transcript`) return dual-channel results: readable text for the model plus typed `structuredContent` (declared `outputSchema`) for codemode scripts. No JSON parsing by the model._

```bash
npx tsx examples/run.ts --query "population of Zurich" --engine google
```

## How it works

```
search(query) → [{title, url}]     direct /search?q= URLs, redirect unwrapping,
                                   click-resolve for opaque links
open(url)     → {title, text}      one observe on the shared daemon
navigate/act  → PageSnapshot       per-process session on its own context
                                   (concurrent agents coexist), serialized
                                   ops, freshness-checked acts
```

| File | Job |
|---|---|
| `src/search.ts` | `search()` → structured results; `open()` → page as **markdown** (headings, links, lists; SPA noise stripped) |
| `src/session.ts` | per-process session on its own daemon context: lazy attach, serialized ops, clean close |
| `src/daemon.ts` + `src/daemonRunner.mjs` | one shared stealth Chromium (CDP server, rendezvous file, supervised lifecycle) |
| `src/browserAdapter.ts` | `observe/fresh/act/back/forward/goto/close` on Patchright stealth Chromium — **iframe-aware**: each frame snapshotted (cross-origin included), actions merged into one indexed space with freshness guards per frame |
| `src/profile.ts` | agent home (`/tmp/agent-chrome/`, 0700): rendezvous, downloads + daemon-singleton lock |
| `src/simple.ts` | `SimpleBrowser` — manual driving for scripts |
| `vendor/shadow-supplement.js` | open-shadow-DOM + `[onclick]`/label/file-input controls, shared node identity |
| `vendor/markdown.js` | dependency-free page-side HTML→Markdown (approach ported from browser-use) |
| `src/config.ts` | profile dir, headless, locale/timezone/proxy (there are no keys) |
| `pi-extension/shadow-browser.ts` | the Pi tools + `/browser-config`, `/browser-open`, `/browser-reset`, `/browser-shutdown` |

## Installation

Prereqs: Node 22+.

```bash
git clone <this-repo>
cd pi-shadow-browser
npm install
npx patchright install chromium   # one-time stealth-browser download
pi install ./pi-shadow-browser
```

No browser extension, no `--remote-debugging-port` setup. One visible browser
shared by you and every agent: run `/browser-open` for a blank tab, sign in
yourself — credentials never touch the agent — and every session sees the
same logged-in window (`/browser-reset` wipes it).

### Configuration

```jsonc
// ~/.pi/agent/settings.json
{ "shadowBrowser": { "headless": true, "profileDir": "…", "locale": "en-US", "timezone": "Asia/Kolkata" } }
```

Precedence: tool args > `shadowBrowser` settings > defaults. One daemon serves
the one shared browser every agent (and you) drives together;
`/browser-shutdown` stops it, `/browser-reset` wipes everything. Prefer a
dedicated agent account over your primary logins for high-value sites.

## Limits

Frames (even cross-origin) are traversed and clickable; open shadow DOM the
same way; `[onclick]` divs, label-wrapped controls, and file **uploads** work;
keys and screenshots cover dialogs and visual fallbacks. Password fields are
never observed or typed — secrets must not enter model context. Still out:
closed shadow roots (unreadable from page JS, for everyone), drag-and-drop,
hover sequences, wait-for-condition, permissions/mobile emulation. Behavioral walls
and human-body proofs stay adversarial. Automated browsing may violate some sites'
ToS — browse at your own risk, and prefer a dedicated agent account (not
your primary logins) for high-value sites.

## Acknowledgements

* [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT) — `snapshot.js` (vendored at `1231850a`), freshness-guard design.
* [browser-use/browser-use](https://github.com/browser-use/browser-use) (MIT) — ported mechanics: shadow traversal, markdown extraction, combobox settle, upload/find/wait/tab/pdf/download actions.
* [Kaliiiiiiiiii-Vinyzu/patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (Apache-2.0) — stealth Playwright fork driving the agent browser.

## Contributing

PRs welcome. Verify with `npx tsc --noEmit`, a live `npx tsx examples/run.ts`, and `npx tsx examples/probe.ts`. No unit tests by policy — real browser runs are the test suite.

## License

MIT — see [LICENSE](LICENSE).
