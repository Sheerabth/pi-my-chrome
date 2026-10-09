"""Pi extension wiring: use jev-ultrafast as a dep, no user patching.

We rebind names inside jev_ultrafast.agent at runtime (our code does it,
not the user), then drive Agent. Upgrades flow via `uv sync`.
"""

from __future__ import annotations

from typing Callable

import jev_ultrafast.agent as _A
from jev_ultrafast import Agent

from .cloak_adapter import CloakBrowserAdapter
from .text import default_pi_field_text

# Runtime injection — ships with the extension, user never patches.
_A.Browser = CloakBrowserAdapter
_A.field_text = default_pi_field_text


def browser_run(url: str, goal: str, ask_harness: Callable[[str], str]):
    """Run one goal on a CloakBrowser copy of the user's profile.

    ask_harness(prompt) -> str: called only for TYPE_TEXT values and DONE
    verification. Yields state snapshots like Agent.run().
    """
    from .text import make_pi_field_text

    _A.field_text = make_pi_field_text(ask_harness)
    with Agent(url, goal) as agent:
        for state in agent.run():
            yield state
