# pi-my-chrome

[![Python 3.12+](https://img.shields.io/badge/Python-3.12+-blue.svg)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Let your AI agent browse with *your* Chrome logins. No re-login, no visible window, no token blowup.**

`pi-my-chrome` is a [Pi](https://github.com/badlogic/pi-mono) extension that gives Pi (and Claude, via MCP) a real, logged-in browser: your Chrome `Default` profile snapshotted to a throwaway dir, driven headlessly through [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) stealth Chromium, decided by [TypeSafe Jev](https://docs.typesafe.ai/introduction) ([`jev-ultrafast`](https://github.com/browser-use/jev-ultrafast) policy: one typed decision per cycle, indexed action space).

## Why

* **Logged in by default** — Gmail, X, Reddit, Amazon, LinkedIn work with zero login scripting. Cookies come from your own profile.
* **Bot-resistant** — real profile + CloakBrowser C++ fingerprint patches + `humanize=True`, instead of fresh headless Chromium that Cloudflare flags instantly.
* **Token-cheap** — Jev picks `operation + element [1..N]` in one 70–500 ms request. Pi only wakes to supply `TYPE_TEXT` and verify `DONE`. No 30k-token DOM dumps into Claude.
* **Hidden** — runs on `/tmp/agent-chrome`, background tabs with focus emulation. Your open Chrome is untouched.
* **No forks** — `jev-ultrafast` and `cloakbrowser` are dependencies, not vendored code. Upstream fixes (shadow-DOM, iframes, …) flow via version bump.

## How it works

```
Pi extension (in-proc, hot path)
  └─ browser_run(url, goal)
       ├─ observe  → snapshot.js (visible controls only, indexed [1..N])
       ├─ choose   → Jev: Choice(operation) + Choice(click/type/select_target), 1 POST
       ├─ act      → CloakBrowser CDP on copied profile (node handles, freshness-checked)
       └─ text     → Pi/Claude supplies TYPE_TEXT value (no tiny side-LLM)
```

| File | Job |
|---|---|
| `pi_my_chrome/profile.py` | rsync live `Default/` → `/tmp/agent-chrome/Default/` (minus Cache), `chmod 700`, wipe on exit |
| `pi_my_chrome/cloak_adapter.py` | `CloakBrowserAdapter`: same `observe/fresh/act/close` shape `Agent` uses, reuses upstream `snapshot.js` |
| `pi_my_chrome/text.py` | `make_pi_field_text(ask)` — harness-backed `field_text`, same signature/validation as upstream |
| `pi_my_chrome/extension.py` | runtime wiring (`A.Browser`, `A.field_text`), no user patching |

## Installation

Prereqs: Python 3.12+, Google Chrome (logged in), [`uv`](https://docs.astral.sh/uv/) (or pip), a [TypeSafe API key](https://docs.typesafe.ai/introduction).

```bash
git clone git@pgithub.com:Sheerabth/pi-my-chrome.git
cd pi-my-chrome
uv sync            # or: pip install -e .
cp .env.example .env  # then add TYPESAFE_API_KEY
```

CloakBrowser's binary auto-downloads on first launch. No browser extension, no `--remote-debugging-port` setup.

### Environment

| Var | Required | Default | What |
|---|---|---|---|
| `TYPESAFE_API_KEY` | yes | — | Jev System-One decisions |
| `PI_MY_CHROME_DIR` | no | `/tmp/agent-chrome` | throwaway profile copy |
| `AGENTSEARCH_HEADLESS` | no | `1` | set `0` to watch the run |

Your real profile is **read-only source** (`~/Library/Application Support/Google/Chrome/Default/`). We never launch on it (SingletonLock) — only rsync from it.

## Quickstart

```bash
export TYPESAFE_API_KEY=...
uv run python examples/run.py \
  --url "https://www.google.com/travel/flights?hl=en" \
  --goal "Find one-way flights from Zurich to London on Sep 20 2026 for 1 adult economy. Stop when options visible."
```

Library use (Pi supplies text):

```python
from pi_my_chrome import browser_run

def ask(prompt: str) -> str:
    return my_pi_llm(prompt)  # return ONLY the string to type

for state in browser_run(url, goal, ask):
    print(state["elapsed_ms"], state["status"])  # ready → predicted → done/blocked
```

## Pi vs MCP

* **Pi** — use this repo directly (in-proc extension, ~0 ms overhead, holds the CDP session).
* **Claude Desktop / Cursor** — wrap the same three calls (`observe/choose/act`) in a stdio MCP server. The core stays identical; only the transport changes.

## Limits

Inherited from the `jev-ultrafast` MVP: no shadow-DOM / iframes / canvas / file uploads / multi-tab popups / nested scroll yet. `DONE` always needs independent verification (Pi re-observes). Automated browsing may violate some sites' ToS — use your own profile at your own risk, and prefer a dedicated agent Chrome profile for high-value accounts.

## Acknowledgements

* [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT) — agent loop, `snapshot.js`, indexed action space.
* [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser) — stealth Chromium fork.
* [TypeSafe AI Jev](https://docs.typesafe.ai/introduction) — System-One decision model.

## Contributing

PRs welcome. Keep the rule: **depend, don't fork** — upstream improvements should arrive via version bump, not vendored copies. `uv run ruff check . && uv run pytest`.

## License

MIT — see [LICENSE](LICENSE).
