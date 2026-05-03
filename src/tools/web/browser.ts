/**
 * Parallel agentic browser tool.
 *
 * Supports two modes controlled by BROWSERBASE_API_KEY:
 *   - Hosted: Browserbase (https://www.browserbase.com) — scalable, parallel, headless
 *   - Local: Playwright (for dev/testing)
 *
 * To run pages in parallel, call `runBrowserTasks` with an array of tasks.
 */

import { z } from "zod";
import { registerTool } from "../registry";
import { config } from "@/lib/config";

async function scrapeWithBrowserbase(url: string, signal?: AbortSignal) {
  const Browserbase = (await import("@browserbasehq/sdk")).default;
  const bb = new Browserbase({ apiKey: config.browserbase.apiKey });

  const session = await bb.sessions.create({
    projectId: config.browserbase.projectId,
  });

  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30_000 });

  try {
    const [page] = browser.contexts()[0]?.pages() ?? [];
    const p = page ?? (await browser.contexts()[0].newPage());
    await p.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const title = await p.title();
    const text = await p.evaluate(() => document.body.innerText);
    return { title, text: text.slice(0, 8000), url };
  } finally {
    await browser.close();
    await bb.sessions.update(session.id, { status: "REQUEST_RELEASE" });
  }
}

async function scrapeWithPlaywright(url: string) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    return { title, text: text.slice(0, 8000), url };
  } finally {
    await browser.close();
  }
}

export const browserScrapeTool = registerTool({
  name: "browser_scrape",
  description:
    "Open a URL in a real browser and return its visible text content. Use for pages that require JavaScript rendering.",
  parameters: z.object({
    url: z.string().url().describe("The URL to visit"),
  }),
  async execute({ url }, { signal }) {
    if (config.browserbase.apiKey) {
      return scrapeWithBrowserbase(url, signal);
    }
    return scrapeWithPlaywright(url);
  },
});

/**
 * Run multiple browser scrape tasks in parallel.
 * Returns results in the same order as the input URLs.
 */
export async function runBrowserTasksParallel(
  urls: string[]
): Promise<Array<{ title: string; text: string; url: string; error?: string }>> {
  const tasks = urls.map(async (url) => {
    try {
      if (config.browserbase.apiKey) {
        return await scrapeWithBrowserbase(url);
      }
      return await scrapeWithPlaywright(url);
    } catch (err) {
      return { url, title: "", text: "", error: String(err) };
    }
  });
  return Promise.all(tasks);
}

export const browserParallelTool = registerTool({
  name: "browser_scrape_parallel",
  description:
    "Scrape multiple URLs in parallel using real browser sessions. Returns content for all URLs simultaneously. More efficient than scraping one at a time.",
  parameters: z.object({
    urls: z
      .array(z.string().url())
      .min(1)
      .max(10)
      .describe("List of URLs to scrape in parallel (max 10)"),
  }),
  async execute({ urls }) {
    return runBrowserTasksParallel(urls);
  },
});
