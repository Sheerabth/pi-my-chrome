/**
 * Browser daemon runner: launched detached by ensureDaemon(), never by hand.
 *
 * Spawns ONE raw Chromium (the shared engine) on a persistent profile dir
 * with remote debugging enabled, publishes { cdpUrl, pid, startedAt,
 * headless } to <agentRoot>/daemon.json, then supervises until SIGTERM/
 * SIGINT (kills the browser, removes rendezvous, exits).
 *
 * Everyone shares this browser's single default context: the user in their
 * tabs, agents in theirs. No copies, no keychains, no bridges — one jar.
 *
 * Idle watchdog: with zero `page` targets (real CDP /json/list) for
 * idleRounds consecutive checks (default 30s x 20 = 10 min), the daemon
 * exits itself and cleans up. Warm sessions and user tabs count as active.
 * idleMs/idleRounds exist for fast testing.
 *
 * Usage: node daemonRunner.mjs <agentRoot> [headless|headed] [idleMs idleRounds]
 * Plain .mjs: stock node, no loaders.
 */

import { readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { chromium } from "patchright";

const root = process.argv[2];
const headless = process.argv[3] !== "headed";
const IDLE_MS = Number(process.argv[4]) || 30_000;
const IDLE_ROUNDS = Number(process.argv[5]) || 20;
if (!root) {
  console.error("daemonRunner: missing agent root");
  process.exit(2);
}

const profileDir = join(root, "browser");

// Declared up top: ensureKeeper()/idleCheck() run before the rendezvous is
// published, and `await`ed calls below must never hit a TDZ.
let idleRounds = 0;
let failRounds = 0;
let keeperBrowser = null;
let keeperPage = null;
let child = null;
let childExit = "";
// A fresh browser always carries its own birth tab. Only real destinations
// count as activity — blank/newtab means nobody is actually browsing.
// Unreachable endpoint means the browser is dead — but confirm over rounds
// (a single failed fetch must never kill a healthy daemon), then exit.
const BIRTH_URLS = new Set(["about:blank", "chrome://newtab/", "chrome://new-tab-page/", "chrome-search://local-ntp/local-ntp.html"]);

/** Chromium's own singleton files survive unclean deaths and wedge the next
 *  launch in profile-in-use limbo. With no live browser on this profile
 *  they are debris — clear them (plus the stray socket dir they point at).
 *  A live browser means hands off, always. */
function clearChromiumSingletons() {
  if (liveBrowserOnProfile()) return;
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const file = join(profileDir, name);
    // Separate the symlink read from the removal: a non-symlink singleton
    // file (regular file left by a crash) must still be removed even when
    // readlink throws ENOINVALID.
    let target = "";
    try {
      target = readlinkSync(file);
    } catch {
      target = "";
    }
    try {
      rmSync(file, { force: true });
    } catch {
      // Best-effort.
    }
    if (target) {
      const dir = target.startsWith("/") ? target.replace(/\/SingletonSocket$/, "") : "";
      if (dir.startsWith("/tmp/")) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Best-effort.
        }
      }
    }
  }
}

/** True when a live Chromium holds --user-data-dir=<profileDir>.
 *  Exact match on the /proc cmdline (NUL-bounded arg, chrome in cmdline,
 *  skipping self and parent); pgrep -f fallback excludes our own pid so we
 *  never self-match. Fail-closed: cannot tell => assume live. */
function liveBrowserOnProfile() {
  const exact = `--user-data-dir=${profileDir}`;
  const viaProc = liveBrowserOnProfileProc(exact);
  if (viaProc !== null) return viaProc;
  return liveBrowserOnProfilePgrep(exact);
}

function liveBrowserOnProfileProc(exact) {
  let ents;
  try {
    ents = readdirSync("/proc");
  } catch {
    return null;
  }
  try {
    const me = new Set([process.pid, process.ppid]);
    for (const e of ents) {
      if (!/^\d+$/.test(e)) continue;
      const pid = Number(e);
      if (me.has(pid)) continue;
      let raw;
      try {
        raw = readFileSync(`/proc/${pid}/cmdline`);
      } catch {
        continue;
      }
      const args = String(raw).split("\0");
      if (!args.some((a) => a === exact)) continue;
      if (!/chrome/i.test(args.join(" "))) continue;
      return true;
    }
    return false;
  } catch {
    return null;
  }
}

function liveBrowserOnProfilePgrep(exact) {
  try {
    // Anchor the marker so /tmp/pr never matches /tmp/pr-other, and skip
    // our own pid: pgrep lists pids, we filter self out before deciding.
    const out = execFileSync("pgrep", ["-af", `user-data-dir=${profileDir}`], { encoding: "utf8" });
    const lines = out.split("\n").filter(Boolean);
    const me = new Set([String(process.pid), String(process.ppid)]);
    for (const line of lines) {
      const pid = line.split(" ")[0];
      if (me.has(pid)) continue;
      if (!line.includes(exact)) continue;
      if (!/chrome/i.test(line)) continue;
      return true;
    }
    return false;
  } catch (err) {
    if ((err && err.status) === 1) return false;
    return true;
  }
}
clearChromiumSingletons();
const rendezvous = join(root, "daemon.json");
const errorLog = join(root, "daemon.error.log");

function fail(message) {
  try {
    writeFileSync(errorLog, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Nowhere to report — the launcher will time out with its own message.
  }
  // Never orphan the browser or claim readiness on the way out: kill the
  // child we spawned (if still alive) and remove OUR rendezvous only.
  try {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  } catch {
    // Best-effort.
  }
  try {
    const cur = JSON.parse(readFileSync(rendezvous, "utf8"));
    if (cur && cur.pid === process.pid) rmSync(rendezvous, { force: true });
  } catch {
    // Best-effort (gone already, or never ours).
  }
  process.exit(1);
}

process.on("uncaughtException", (err) => fail(`uncaught: ${err instanceof Error ? err.message : String(err)}`));

async function shutdown(signal) {
  try {
    if (child && child.exitCode === null) child.kill("SIGTERM");
  } catch {
    // Best-effort.
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!child || child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    if (child && child.exitCode === null) child.kill("SIGKILL");
  } catch {
    // Gone.
  }
  try {
    // Only remove OUR rendezvous: a successor may have claimed the file
    // after our browser died. Deleting theirs orphans a live daemon.
    const cur = JSON.parse(readFileSync(rendezvous, "utf8"));
    if (cur && cur.pid === process.pid) rmSync(rendezvous, { force: true });
  } catch {
    // Best-effort (gone already, or never ours).
  }
  if (signal === "CHILD" || signal === "DEAD") {
    try {
      writeFileSync(errorLog, `${new Date().toISOString()} browser gone (${childExit || "unknown"}), daemon exiting\n`);
    } catch {
      // Best-effort.
    }
  }
  process.exit(signal === "SIGINT" ? 1 : 0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

let executable;
try {
  executable = chromium.executablePath({ channel: "chromium" });
} catch (err) {
  fail(`no chromium binary: ${err instanceof Error ? err.message : String(err)}`);
}

/** A standing blank tab so the browser never idles itself out from under
 *  us: headless Chromium with zero tabs and zero clients exits on its own.
 *  Recreated whenever missing (user closed it); excluded from idle math.
 *  Never browser.close() here — that connection is shared with everyone. */
async function ensureKeeper() {
  // Headed browsers manage their own lifetime (closing the last window
  // exits, visibly and correctly). The keeper exists only for headless
  // mode, where an empty browser can vanish silently mid-launch.
  if (!headless) return;
  try {
    if (keeperPage && !keeperPage.isClosed()) return;
  } catch {
    keeperPage = null;
    keeperBrowser = null;
  }
  keeperPage = null;
  try {
    if (!keeperBrowser) keeperBrowser = await chromium.connectOverCDP(cdpUrl);
    const pages = keeperBrowser.contexts().flatMap((c) => {
      try {
        return c.pages();
      } catch {
        return [];
      }
    });
    // Adopt a blank/birth tab when one exists — never navigate or create
    // over real content, and never add tabs the user didn't ask for.
    for (const p of pages) {
      try {
        if (BIRTH_URLS.has(p.url())) {
          keeperPage = p;
          break;
        }
      } catch {
        // Dead tab — keep looking.
      }
    }
    if (!keeperPage) {
      keeperPage = await keeperBrowser.newPage();
      await keeperPage.goto("about:blank").catch(() => undefined);
    }
  } catch {
    keeperPage = null;
    keeperBrowser = null;
  }
}

const proxyArg = process.argv.find((a) => a.startsWith("--proxy="));
const proxyServer = proxyArg ? proxyArg.slice("--proxy=".length) : "";
const args = [
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--disable-dev-shm-usage",
  "--disable-popup-blocking",
  ...(headless ? ["--headless=new"] : []),
  ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
];
// DevToolsActivePort appears once the debugger is listening: "<port>\n<token>".
// It MUST be deleted before spawning: a stale file from the previous
// generation reads as a live port, and the whole launch then validates
// against a corpse (every close-then-reopen cycle failed exactly this way).
const portFile = join(profileDir, "DevToolsActivePort");
try {
  rmSync(portFile, { force: true });
} catch {
  // Best-effort.
}
child = spawn(executable, args, { detached: false, stdio: "ignore" });
child.on("error", (err) => fail(`spawn failed: ${err.message}`));
child.on("exit", (code, signal) => {
  childExit = signal ? `signal ${signal}` : `code ${code}`;
  // Any browser death (clean close, crash, kill) ends supervision: a daemon
  // without a browser serves no one. Exit at once so the next launch starts
  // clean instead of polling a corpse.
  void shutdown("CHILD");
});

let cdpUrl = "";
{
  const deadline = Date.now() + 45_000;
  const { readFileSync, existsSync } = await import("node:fs");
  for (;;) {
    try {
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, "utf8").split("\n")[0].trim());
        if (Number.isFinite(port) && port > 0) {
          cdpUrl = `http://127.0.0.1:${port}`;
          break;
        }
      }
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) fail("debugger port file never appeared");
    await new Promise((r) => setTimeout(r, 300));
  }
}
// Hold one blank tab from birth: an empty headless browser may exit on its
// own before the first agent attaches, racing every cold open. Fail fast
// here instead of serving a corpse later. Daemon.json is published only
// after the browser is proven ready — never before.
if (headless) {
  try {
    await ensureKeeper();
    if (!keeperPage) throw new Error("keeper tab not established");
  } catch (err) {
    fail(`keeper tab failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
try {
  writeFileSync(
    rendezvous,
    JSON.stringify({ cdpUrl, pid: process.pid, startedAt: Date.now(), headless, proxyServer }) + "\n",
  );
} catch (err) {
  fail(`rendezvous write failed: ${err instanceof Error ? err.message : String(err)}`);
}
async function idleCheck() {
  await ensureKeeper();
  let pages = -1;
  try {
    const res = await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(8000) });
    const targets = res.ok ? await res.json() : null;
    if (Array.isArray(targets)) {
      pages = targets.filter((t) => t && t.type === "page" && !BIRTH_URLS.has(t.url)).length;
    }
  } catch {
    pages = -1;
  }
  if (pages < 0) {
    failRounds += 1;
    if (failRounds >= 3) await shutdown("DEAD");
    return;
  }
  failRounds = 0;
  if (pages > 0) {
    idleRounds = 0;
    return;
  }
  idleRounds += 1;
  if (idleRounds >= IDLE_ROUNDS) await shutdown("IDLE");
}
setInterval(() => void idleCheck(), IDLE_MS);
