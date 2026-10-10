/**
 * Capability probe: which kinds of websites break this setup, and how.
 *
 * For each URL: navigate, observe, and count what the agent can vs cannot
 * see (iframes, shadow roots, big canvases, file inputs), plus robot-wall
 * keywords. Kept in repo — re-run anytime to re-map the boundary.
 *
 * Usage: npx tsx examples/probe.ts
 */

import { SimpleBrowser } from "../src/index.js";

const SITES: { url: string; expect: string }[] = [
  { url: "https://example.com/", expect: "control: works" },
  { url: "https://en.wikipedia.org/wiki/Zurich", expect: "control content: works" },
  { url: "https://www.google.com/recaptcha/api2/demo", expect: "iframe checkbox now visible as framed action (observe only)" },
  { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", expect: "shadow DOM + canvas player: PARTIAL expected" },
  { url: "https://www.google.com/maps", expect: "canvas map + DOM mix: PARTIAL expected" },
  { url: "https://www.amazon.com/", expect: "bot-wall prone: OK or captcha?" },
  { url: "https://github.com/login", expect: "plain login form: works?" },
  { url: "https://tus.io/demo", expect: "file input observed; upload supported" },
  { url: "https://stripe.com/", expect: "marketing page: works?" },
  { url: "https://www.figma.com/", expect: "marketing page: works? (the app itself is canvas)" },
];

const PROBE_JS = `(() => {
  const all = [...document.querySelectorAll('*')];
  return {
    iframes: document.querySelectorAll('iframe').length,
    shadowRoots: all.filter((e) => e.shadowRoot).length,
    bigCanvases: [...document.querySelectorAll('canvas')]
      .filter((c) => { const r = c.getBoundingClientRect(); return r.width > 100 && r.height > 100; }).length,
    fileInputs: document.querySelectorAll('input[type=file]').length,
  };
})()`;

const WALL_RE = /captcha|verify you are (a )?human|access denied|unusual traffic|i'm not a robot|robot check|are you human|challenge|enable javascript and cookies|forbidden|request blocked/i;

async function main(): Promise<void> {
  const browser = await SimpleBrowser.create("about:blank");
  try {
    for (const site of SITES) {
      const t0 = Date.now();
      try {
        await browser.goto(site.url);
        const page = await browser.observe();
        const dom = await browser.evaluate<Record<string, number>>(PROBE_JS);
        const wall = WALL_RE.test(`${page.title}\n${(page.text || "").slice(0, 2000)}`);
        console.log(`### ${site.url}`);
        console.log(`    title: ${(page.title || "").slice(0, 70)}`);
        console.log(`    actions=${page.actions.length} iframes=${dom.iframes} shadow=${dom.shadowRoots} canvas=${dom.bigCanvases} fileInputs=${dom.fileInputs} wall=${wall} (${Date.now() - t0}ms)`);
        console.log(`    expect: ${site.expect}`);
      } catch (err) {
        console.log(`### ${site.url}\n    ERROR: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
