"""Profile manager: snapshot the live Chrome Default into a throwaway dir.

Never launches on the real dir (SingletonLock). The agent browser always
runs on the copy, so the user's open Chrome is untouched and sees nothing.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

REAL_DEFAULT = Path.home() / "Library/Application Support/Google/Chrome/Default"
AGENT_ROOT = Path(os.environ.get("PI_MY_CHROME_DIR", "/tmp/agent-chrome"))
AGENT_DEFAULT = AGENT_ROOT / "Default"

EXCLUDES = ["Cache", "Code Cache", "GPUCache", "*.log", "CacheStorage"]


def ensure_profile_copy() -> Path:
    """rsync live Default -> /tmp/agent-chrome/Default, return agent user-data dir."""
    if not REAL_DEFAULT.exists():
        raise FileNotFoundError(f"real Chrome profile not found: {REAL_DEFAULT}")
    AGENT_DEFAULT.parent.mkdir(parents=True, exist_ok=True)
    if shutil.which("rsync"):
        cmd = ["rsync", "-a", "--delete"]
        for ex in EXCLUDES:
            cmd += ["--exclude", ex]
        cmd += [f"{REAL_DEFAULT}/", f"{AGENT_DEFAULT}/"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(f"rsync profile copy failed: {r.stderr[:500]}")
    else:  # fallback: full copy (slower, first run only ideally)
        if AGENT_DEFAULT.exists():
            shutil.rmtree(AGENT_DEFAULT)
        shutil.copytree(REAL_DEFAULT, AGENT_DEFAULT, ignore=shutil.ignore_patterns(*EXCLUDES))
    os.chmod(AGENT_ROOT, 0o700)
    return AGENT_ROOT


def wipe_profile_copy() -> None:
    """Remove the throwaway copy (cookies on disk). Best-effort."""
    shutil.rmtree(AGENT_ROOT, ignore_errors=True)
