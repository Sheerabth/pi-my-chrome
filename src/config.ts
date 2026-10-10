/**
 * Configuration: profile location, headless mode, locale/timezone/proxy.
 *
 * Pi decides and acts through tools, so there are no model keys here —
 * deciding happens in Pi's own model call, acting needs no credentials.
 * Precedence: explicit code options > process env > `.env` (auto-loaded,
 * managed keys only) > defaults.
 *
 * Managed env keys: PI_MY_CHROME_DIR, PI_MY_CHROME_REAL, AGENTSEARCH_HEADLESS.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ChromeConfig {
  profileDir?: string;
  realProfile?: string;
  headless?: boolean;
  locale?: string;
  timezone?: string;
  proxy?: string;
}

/** Only these env prefixes are ever read from `.env` files. */
export const MANAGED_PREFIXES = ["PI_MY_CHROME_", "AGENTSEARCH_"];

/** Minimal .env parser: KEY=value, quotes, `export ` prefix, `#` comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** Load a .env file into process.env without overriding existing vars. */
export function loadDotEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(path, "utf8")))) {
    if (!MANAGED_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** Auto-load `./.env` (cwd) if present. Called by entry points. */
export function ensureEnv(): void {
  loadDotEnvFile(join(process.cwd(), ".env"));
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return !["0", "false", "no", ""].includes(raw.toLowerCase());
}

/** Resolve the full typed config. */
export function loadConfig(overrides: Partial<ChromeConfig> = {}): ChromeConfig {
  ensureEnv();
  return {
    profileDir: overrides.profileDir ?? process.env.PI_MY_CHROME_DIR,
    realProfile: overrides.realProfile ?? process.env.PI_MY_CHROME_REAL,
    headless: overrides.headless ?? envFlag("AGENTSEARCH_HEADLESS", true),
    locale: overrides.locale ?? process.env.PI_MY_CHROME_LOCALE,
    timezone: overrides.timezone ?? process.env.PI_MY_CHROME_TIMEZONE,
    proxy: overrides.proxy ?? process.env.PI_MY_CHROME_PROXY,
  };
}

/** Log-safe summary for status reporting. */
export function redacted(config: ChromeConfig): Record<string, unknown> {
  return {
    profileDir: config.profileDir ?? "/tmp/agent-chrome",
    realProfile: config.realProfile ?? "auto-detected",
    headless: config.headless ?? true,
    locale: config.locale ?? "default",
    timezone: config.timezone ?? "default",
    proxy: config.proxy ? "set" : "unset",
  };
}
