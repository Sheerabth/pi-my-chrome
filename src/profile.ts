/**
 * Profile manager: snapshot the live Chrome Default into a throwaway dir.
 *
 * Never launches on the real dir (SingletonLock). The agent browser always
 * runs on the copy, so the user's open Chrome is untouched and sees nothing.
 *
 * Selective copy: the agent Chromium (CloakBrowser) may be older than the
 * system Chrome. A full Default/ copy carries version-skewed state that can
 * crash the older binary on startup. We copy only login-relevant files and
 * let the agent browser create everything else fresh.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function candidateDefaults(): string[] {
  const home = homedir();
  return [
    join(home, ".config/google-chrome/Default"), // Linux
    join(home, ".config/chromium/Default"), // Linux (Chromium)
    join(home, "Library/Application Support/Google/Chrome/Default"), // macOS
  ];
}

export function realDefault(override?: string): string {
  if (override) return override;
  if (process.env.PI_MY_CHROME_REAL) return process.env.PI_MY_CHROME_REAL;
  for (const cand of candidateDefaults()) {
    if (existsSync(cand)) return cand;
  }
  return candidateDefaults()[0];
}

export function agentRoot(override?: string): string {
  return override ?? process.env.PI_MY_CHROME_DIR ?? "/tmp/agent-chrome";
}

export function agentDefault(): string {
  return join(agentRoot(), "Default");
}

/** Login-relevant entries, relative to Default/. Journals ride along when present. */
const AUTH_ENTRIES = [
  "Cookies",
  "Login Data",
  "Login Data For Account",
  "Web Data",
  "Preferences",
  "Secure Preferences",
  "Account Web Data",
  "Local Storage",
  "Session Storage",
];

/** Never copy: process locks, caches, heavy history, extensions (stealth risk). */
const SKIP_NAMES = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "CacheStorage",
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "History",
  "Extensions",
]);

function haveRsync(): boolean {
  try {
    execFileSync("rsync", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function ensureProfileCopy(opts: { real?: string; root?: string } = {}): string {
  const real = realDefault(opts.real);
  const root = agentRoot(opts.root);
  const dest = join(root, "Default");
  if (!existsSync(real)) {
    throw new Error(`real Chrome profile not found: ${real}`);
  }
  mkdirSync(dest, { recursive: true });

  if (haveRsync()) {
    for (const entry of AUTH_ENTRIES) {
      const src = join(real, entry);
      if (!existsSync(src)) continue;
      const args = ["-a"];
      // Directories: copy contents, skipping volatile/heavy names.
      if (statSync(src).isDirectory()) {
        for (const skip of SKIP_NAMES) args.push("--exclude", skip);
        args.push(`${src}/`, `${join(dest, entry)}/`);
      } else {
        args.push(src, join(dest, entry));
      }
      try {
        execFileSync("rsync", args, { stdio: "pipe", timeout: 120_000 });
      } catch (err) {
        throw new Error(`profile copy failed for ${entry}: ${String(err).slice(0, 300)}`);
      }
      const journal = `${entry}-journal`;
      if (existsSync(join(real, journal))) {
        try {
          execFileSync("rsync", ["-a", join(real, journal), join(dest, journal)], { stdio: "pipe", timeout: 30_000 });
        } catch {
          // Journals are best-effort.
        }
      }
    }
  } else {
    for (const entry of AUTH_ENTRIES) {
      const src = join(real, entry);
      if (!existsSync(src)) continue;
      cpSync(src, join(dest, entry), {
        recursive: true,
        filter: (p) => !SKIP_NAMES.has(p.split("/").pop() ?? "") && !p.endsWith(".log"),
      });
      const journal = join(real, `${entry}-journal`);
      if (existsSync(journal)) cpSync(journal, join(dest, `${entry}-journal`));
    }
  }

  for (const stale of SKIP_NAMES) {
    try {
      unlinkSync(join(dest, stale));
    } catch {
      // Absent, or a directory — either way not a stale lock file.
    }
  }
  chmodSync(root, 0o700);
  return root;
}

export function wipeProfileCopy(): void {
  rmSync(agentRoot(), { recursive: true, force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cross-process lock: two Chromium instances on one profile dir corrupt it.
 *  Atomic mkdir + stale-owner detection. Pair with the in-process mutex. */
export async function acquireProfileLock(root?: string, timeoutMs = 120_000): Promise<() => void> {
  const dir = `${root ?? agentRoot()}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(dir, { recursive: true, force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      try {
        const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
        if (!Number.isFinite(pid) || !pidAlive(pid)) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Unreadable lock — retry until timeout.
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for profile lock ${dir}; another agent run may be active.`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
