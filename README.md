# pi-my-chrome

Agent browses with **your** Chrome profile. No re-login, no visible window.

Stack: **CloakBrowser** (stealth Chromium, persistent profile) + **jev-ultrafast** (Jev System-One decisions, indexed action space) + **Pi/Claude** (System-Two brain, supplies `TYPE_TEXT`, verifies `DONE`).

## How it works

```
Pi extension (in-proc) -> Jev (op+target, 1 trip) -> CloakBrowser (copied Default, hidden)
```

* `profile.py` — rsync `~/Library/Application Support/Google/Chrome/Default/` → `/tmp/agent-chrome/Default/` (minus Cache). Never touches your live Chrome.
* `cloak_adapter.py` — `CloakBrowserAdapter` with the same 4 methods `jev-ultrafast.Agent` uses (`observe/fresh/act/close`). Reuses upstream `snapshot.js`, no fork.
* `text.py` — `pi_field_text()` asks Pi/Claude for `TYPE_TEXT` values. No tiny LLM needed.
* `extension.py` — runtime wiring (no user patching): `A.Browser = CloakBrowserAdapter; A.field_text = pi_field_text`, exposes `browser_run(url, goal)`.

## Setup

```bash
cd pi-my-chrome
uv sync  # or: pip install -e .
export TYPESAFE_API_KEY=...   # Jev key, required
# CloakBrowser binary auto-downloads on first launch
```

## Use

```bash
uv run python examples/run.py --url "https://www.google.com/travel/flights?hl=en" \
  --goal "Find one-way flights from Zurich to London on Sep 20 2026 for 1 adult economy. Stop when options visible."
```

## Ports / paths

* Agent profile copy: `/tmp/agent-chrome/Default/`
* Real profile (read-only source): `~/Library/Application Support/Google/Chrome/Default/`
* Inspector (upstream demo): `http://127.0.0.1:8766` via `uv run jev`

## Limits (inherited from jev-ultrafast MVP)

No shadow-DOM / iframes / canvas / uploads / popups / nested scroll yet. Upstream fixes flow via version bump — we depend, not fork.
