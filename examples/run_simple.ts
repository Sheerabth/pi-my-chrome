/** Example: drive the browser by hand. No keys — you pick the actions. */

import { SimpleBrowser, formatPage } from "../src/index.js";
import { question } from "./input.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--url");
  const url = i >= 0 ? args[i + 1] : undefined;
  if (!url) throw new Error("Usage: run_simple --url <url>");

  await using browser = await SimpleBrowser.create(url);
  let page = await browser.observe();
  for (;;) {
    console.log(formatPage(page));
    const actionId = (await question("action id (q to quit): ")).trim();
    if (["q", "quit", "exit"].includes(actionId)) break;
    const action = page.actions.find((a) => a.id === actionId);
    if (!action) {
      console.log(`unknown id ${JSON.stringify(actionId)}`);
      continue;
    }
    const text = action.kind === "fill" ? await question("text to type: ") : undefined;
    try {
      page = await browser.step(actionId, text);
    } catch (err) {
      console.log(`act failed: ${err instanceof Error ? err.message : String(err)}`);
      page = await browser.observe();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
