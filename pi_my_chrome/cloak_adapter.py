"""CloakBrowser backend behind the jev-ultrafast Browser interface.

jev-ultrafast.Agent only uses 4 methods: observe / fresh / act / close.
We implement the same shape on top of CloakBrowser (stealth + persistent
profile) while reusing upstream snapshot.js verbatim — no fork, so upstream
fixes (shadow-DOM, iframes, …) flow via version bump.
"""

from __future__ import annotations

import importlib.resources as resources

import cloakbrowser

from .profile import ensure_profile_copy


def _snapshot_js() -> str:
    # Read the DOM reader from the installed jev-ultrafast package.
    return (resources.files("jev_ultrafast") / "snapshot.js").read_text()


class CloakBrowserAdapter:
    """Drop-in replacement for jev_ultrafast.browser.Browser."""

    def __init__(self, url: str):
        root = ensure_profile_copy()
        self._browser = cloakbrowser.launch(
            headless=False,  # Cloak handles stealth; keep headed for hardest targets
            humanize=True,
            user_data_dir=str(root),
        )
        self._page = self._browser.new_page()
        self._snapshot = _snapshot_js()
        self._page.goto(url)
        self._page.wait_for_load_state("domcontentloaded")

    # -- interface used by Agent -------------------------------------------
    def observe(self, screenshot: bool = False):
        # One atomic in-page read: visible controls + indexed refs, no full dump.
        return self._page.evaluate(f"(() => {{ const s = (() => {{{self._snapshot}}})(); return s.observe(); }})()")

    def fresh(self, page, action=None) -> bool:
        try:
            return bool(self._page.evaluate(
                "(p, a) => window.__jevFast ? window.__jevFast.isFresh(p, a) : false",
                page, action,
            ))
        except Exception:
            return False

    def act(self, action, page, text: str | None = None):
        # Executor resolves the observed DOM node; model output never becomes
        # selectors / JS. Freshness + occlusion rechecked just before input.
        return self._page.evaluate(
            "(a, t) => window.__jevFast.act(a, t)",
            action, text,
        )

    def close(self):
        try:
            self._browser.close()
        except Exception:
            pass
