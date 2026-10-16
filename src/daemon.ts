/**
 * Browser daemon client: one shared visible Chromium for user and agents.
 *
 * First starter launches it (headed by default — visibility is the point);
 * everyone else attaches over CDP to the SAME default context: same tabs,
 * same cookie jar, no copies, no bridges. Rendezvous lives at
 * `<agentRoot>/daemon.json` ({ cdpUrl, pid, startedAt, headless }).
 * `shutdownDaemon()` stops it (explicit user intent only).
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
// join needed for exact --user-data-dir markers (root/browser + root fallback).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentRoot, ensureAgentRoot, isProfileInUse } from "./profile.js";

export interface DaemonInfo {
  cdpUrl: string;
  pid: number;
  startedAt: number;
  headless: boolean;
  proxyServer: string;
}

function rendezvousFile(root?: string): string {
  return join(root ?? agentRoot(), "daemon.json");
}

function readRendezvous(root?: string): DaemonInfo | null {
  try {
    const raw = readFileSync(rendezvousFile(root), "utf8");
    const info = JSON.parse(raw) as Partial<DaemonInfo>;
    if (typeof info.cdpUrl !== "string" || typeof info.pid !== "number") return null;
    return {
      cdpUrl: info.cdpUrl,
      pid: info.pid,
      startedAt: info.startedAt ?? 0,
      headless: info.headless ?? false,
      proxyServer: typeof info.proxyServer === "string" ? info.proxyServer : "",
    };
  } catch {
    return null;
  }
}

/** Is this daemon endpoint actually answering? Pure transport check. */
export function isDaemonAlive(info: DaemonInfo): boolean {
  try {
    execFileSync(
      process.execPath,
      ["-e", `fetch(${JSON.stringify(`${info.cdpUrl}/json/version`)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`],
      { stdio: "ignore", timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Plain-JS runner script: stock node runs it in dev and prod, no loaders. */
export function daemonRunnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "daemonRunner.mjs"), join(here, "..", "..", "src", "daemonRunner.mjs")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(here, "daemonRunner.mjs");
}

/**
 * Return a live daemon endpoint, starting the daemon when needed.
 * Headed by default (visibility is the point); headless only when the
 * first starter configures it. Concurrent first-launchers serialize on
 * the profile lock, so only one daemon wins; losers re-read rendezvous.
 */
/** Wait until no browser process uses this profile (bounded). */
async function waitForProfileFree(root: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProfileInUse(root)) {
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** SIGTERM any live browser on this profile dir. Call ONLY after verifying
 *  its debugger endpoint is dead (a live endpoint means live agents — never
 *  touch those). A wedged browser serves no one; leaving it wedges every
 *  future launch on profile locks. Matches the exact
 *  --user-data-dir=<root>/browser (plus --user-data-dir=<root> fallback)
 *  NUL-bounded in /proc cmdline, skipping self and parent, requiring chrome
 *  in cmdline so /tmp/pr never matches /tmp/pr-other and never matches a
 *  shell command merely containing the string. Returns pids touched. */
function reapBrowserProcesses(root: string): number[] {
  const exactBrowser = `--user-data-dir=${join(root, "browser")}`;
  const exactRoot = `--user-data-dir=${root}`;
  const me = new Set([process.pid, process.ppid]);
  const touched: number[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return touched;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    if (me.has(pid)) continue;
    let args: string[];
    try {
      args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    if (!args.some((a) => a === exactBrowser || a === exactRoot)) continue;
    if (!/chrome/i.test(args.join(" "))) continue;
    try {
      process.kill(pid, "SIGTERM");
      touched.push(pid);
    } catch {
      // Already gone — exactly what we want.
    }
  }
  return touched;
}

export async function ensureDaemon(opts: { headless?: boolean; root?: string; proxyServer?: string } = {}): Promise<DaemonInfo> {
  const root = ensureAgentRoot(opts.root);
  const { acquireProfileLock } = await import("./profile.js");
  const release = await acquireProfileLock(root);
  try {
    const existing = readRendezvous(root);
    if (existing && isDaemonAlive(existing)) return existing;
    try {
      rmSync(rendezvousFile(root), { force: true });
    } catch {
      // Best-effort.
    }
    // A just-closed browser shuts down async: endpoint dead, profile still
    // held. Wedged strays go first (endpoint dead = serves no one), then
    // wait out a normal teardown. Bounded throughout — never the failure.
    reapBrowserProcesses(root);
    await waitForProfileFree(root, 15_000);
    // Fresh error log per launch: a stale daemon.error.log from a previous
    // generation would otherwise be blamed for this launch's failure.
    try {
      rmSync(join(root, "daemon.error.log"), { force: true });
    } catch {
      // Best-effort.
    }
    const headless = opts.headless ?? false;
    const child = spawn(
      process.execPath,
      [daemonRunnerPath(), root, headless ? "headless" : "headed", ...(opts.proxyServer ? [`--proxy=${opts.proxyServer}`] : [])],
      {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    // Fast fail: an early runner exit (bad binary, bad flags) must surface
    // at once with the logged reason — never burn the full 10s polling.
    let childExited = false;
    child.on("exit", () => {
      childExited = true;
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const info = readRendezvous(root);
      if (info && isDaemonAlive(info)) return info;
      if (childExited || existsSync(join(root, "daemon.error.log"))) {
        const cur = readRendezvous(root);
        if (!cur || !isDaemonAlive(cur)) {
          let detail = "check for a conflicting browser process";
          try {
            const logged = readFileSync(join(root, "daemon.error.log"), "utf8").trim().split("\n").pop();
            if (logged) detail = logged.slice(0, 300);
          } catch {
            // No error log — generic guidance stands.
          }
          throw new Error(`Browser daemon did not come up within 10s (${detail}).`);
        }
        if (cur) return cur;
      }
      if (Date.now() > deadline) {
        let detail = "check for a conflicting browser process";
        try {
          const logged = readFileSync(join(root, "daemon.error.log"), "utf8").trim().split("\n").pop();
          if (logged) detail = logged.slice(0, 300);
        } catch {
          // No error log — generic guidance stands.
        }
        throw new Error(`Browser daemon did not come up within 10s (${detail}).`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    release();
  }
}

/** Daemon state for UI decisions, or null when none is running. Never throws. */
export function daemonStatus(root?: string): { running: boolean; headless: boolean } | null {
  const info = readRendezvous(root);
  if (!info || !isDaemonAlive(info)) return null;
  return { running: true, headless: info.headless };
}

/** Stop the daemon if one is running. Returns true when something stopped.
 *  Orphan cleanup always runs: even with no daemon.json (or a dead pid),
 *  stray Chromium processes on <root>/browser are reaped and the profile
 *  is awaited free, so a crashed generation never wedges the next launch. */
export async function shutdownDaemon(root?: string): Promise<boolean> {
  const resolved = root ?? agentRoot();
  const info = readRendezvous(root);
  let stopped = false;
  if (info) {
    stopped = true;
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      // Already gone — fall through to cleanup.
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        process.kill(info.pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    try {
      process.kill(info.pid, "SIGKILL");
    } catch {
      // Gone.
    }
    try {
      rmSync(rendezvousFile(root), { force: true });
    } catch {
      // Best-effort.
    }
  }
  // Always reap strays on this engine's browser dir, even with no rendezvous.
  const reaped = reapBrowserProcesses(resolved);
  if (reaped.length > 0) stopped = true;
  await waitForProfileFree(resolved, 10_000);
  return stopped;
}
