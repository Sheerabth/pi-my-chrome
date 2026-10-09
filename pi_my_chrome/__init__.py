"""pi-my-chrome: agent uses your Chrome profile. Re-exports the public entrypoint."""

from .extension import browser_run

__all__ = ["browser_run"]
