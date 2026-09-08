import { createHash } from 'node:crypto';
/** Browser task authority and evidence. Page data can never widen this policy. */
export interface BrowserTask {
  goal: string;
  plan: { id: string; text: string; status: "pending" | "done" }[];
  budget: { maxTokens: number; maxDurationMs: number };
  allowedOrigins?: string[];
  workspaceId?: string;
  recipeId?: string;
  readOnly?: boolean;
  recovery?: { previousRunId: string };
}
export interface BrowserSource { label: string; url: string; tabId?: string; excerpt: string; retrievedAt: number }
export interface BrowserArtifact { kind: "tab" | "collection" | "context"; id: string; label: string; url?: string }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const bounded = (v: unknown, n: number) => typeof v === "string" && v.trim().length > 0 && v.length <= n && !v.includes("\0");
export function parseBrowserTask(value: unknown): BrowserTask | undefined {
  if (value === undefined) return;
  if (!record(value) || !bounded(value.goal, 20000) || !Array.isArray(value.plan) || value.plan.length > 50 ||
    value.plan.some((p: unknown) => !record(p) || !bounded(p.id, 128) || !bounded(p.text, 1000) || !["pending", "done"].includes(p.status)) ||
    new Set(value.plan.map((p: any) => p.id)).size !== value.plan.length || !record(value.budget) ||
    !Number.isSafeInteger(value.budget.maxTokens) || value.budget.maxTokens < 1000 || value.budget.maxTokens > 2000000 ||
    !Number.isSafeInteger(value.budget.maxDurationMs) || value.budget.maxDurationMs < 1000 || value.budget.maxDurationMs > 86400000)
    throw new Error("Invalid browser task plan or budget");
  for (const key of ["workspaceId", "recipeId"]) if (value[key] !== undefined && !bounded(value[key], 128)) throw new Error("Invalid browser task identity");
  if (value.readOnly !== undefined && typeof value.readOnly !== "boolean") throw new Error("Invalid browser task mode");
  if (value.allowedOrigins !== undefined && (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length > 100 || value.allowedOrigins.some((url: unknown) => {
    try { const parsed = new URL(String(url)); return !["http:", "https:"].includes(parsed.protocol) || parsed.origin !== url; } catch { return true; }
  }))) throw new Error("Invalid browser task origins");
  if (value.recovery !== undefined && (!record(value.recovery) || !bounded(value.recovery.previousRunId, 128))) throw new Error("Invalid browser recovery");
  return structuredClone(value) as BrowserTask;
}
/** Reads plus navigation to obtain a page; no form, script, memory or collection writes. */
export const READ_ONLY_BROWSER_TOOLS = new Set(["browser.listWorkspaces", "browser.listTabs", "browser.openTab", "browser.navigate", "browser.readPage", "browser.findInPage", "page.snapshot", "page.extract", "page.waitFor", "page.screenshot", "browser.capture", "collections.list", "collections.read", "collections.search", "activity.digest", "context.search", "context.list"]);
function evidenceExcerpt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n[Excerpt shortened]\n";
  if (limit <= marker.length) return marker.slice(0,limit);
  const head = Math.ceil((limit-marker.length)*0.7), tail = limit-marker.length-head;
  return value.slice(0,head)+marker+(tail ? value.slice(-tail) : "");
}
export class BrowserEvidence {
  readonly sources: BrowserSource[] = [];
  private hashes = new Map<string, string>();
  private observations = new Map<string, {priority:number;base:string;focused:Map<string,{label:string;excerpt:string;hash:string}>}>();
  fingerprint() { return createHash("sha256").update(JSON.stringify([...this.hashes].sort(([a],[b])=>a.localeCompare(b)))).digest("hex"); }
  readonly artifacts: BrowserArtifact[] = [];
  observe(name: string, value: unknown, now = Date.now(), args: Record<string, unknown> = {}) {
    if (!record(value)) return;
    if (["browser.readPage", "page.extract"].includes(name) && typeof value.url === "string") {
      let url: URL; try { url = new URL(value.url); } catch { return; }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
      const excerpt = typeof value.content === "string" ? value.content : typeof value.text === "string" ? value.text : "";
      const index = this.sources.findIndex(source => source.url === url.href);
      if (excerpt && (index >= 0 || this.sources.length < 100)) {
        const selector = typeof args.selector === "string" ? args.selector : "";
        const priority = name === "browser.readPage" ? 3 : !args.ref && (!selector || ["body","html"].includes(selector)) ? 2 : 1;
        const previous = this.observations.get(url.href);
        let observed = previous;
        if (!observed || priority > observed.priority || (priority === observed.priority && priority > 1)) {
          observed = {priority,base:priority > 1 ? evidenceExcerpt(excerpt,2000) : "",focused:new Map()};
          this.observations.set(url.href,observed);
          if (priority > 1) this.hashes.set(url.href,createHash("sha256").update(excerpt).digest("hex"));
        }
        if (priority === 1 || priority < observed.priority) {
          const hash = createHash("sha256").update(excerpt).digest("hex");
          // Snapshot refs are ephemeral. Without a stable selector, identity is
          // the actual content, so identical reads deduplicate across snapshots.
          const key = selector ? "selector:"+selector : "content:"+hash;
          if (observed.focused.has(key) || observed.focused.size < 10) observed.focused.set(key,{label:selector ? evidenceExcerpt(selector,128) : "observed content",excerpt:evidenceExcerpt(excerpt,400),hash});
        }
        if (observed.priority === 1) this.hashes.set(url.href,createHash("sha256").update(JSON.stringify([...observed.focused].map(([key,value])=>[key,value.hash]).sort(([a],[b])=>a.localeCompare(b)))).digest("hex"));
        const supplement = [...observed.focused.values()].map(value=>"Focused extract ("+value.label+"): "+value.excerpt).join("\n");
        const focusedDisplay = evidenceExcerpt(supplement,observed.base ? 800 : 2000);
        const broadDisplay = observed.base ? evidenceExcerpt(observed.base,2000-(focusedDisplay ? focusedDisplay.length+2 : 0)) : "";
        const combined = [broadDisplay,focusedDisplay].filter(Boolean).join("\n\n");
        const source = {url:url.href,label:String(value.title || this.sources[index]?.label || url.hostname).slice(0,300),excerpt:combined,retrievedAt:now,
          ...(typeof value.tabId === "string" ? {tabId:value.tabId} : this.sources[index]?.tabId ? {tabId:this.sources[index].tabId} : {})};
        if (index < 0) this.sources.push(source); else this.sources[index] = source;
      }
    }
    const target = name === "context.write" ? value.record : name === "collections.create" ? value.collection : name === "browser.openTab" ? value.tab : undefined;
    if (record(target) && bounded(target.id, 128) && this.artifacts.length < 100) {
      const kind = name === "context.write" ? "context" : name === "collections.create" ? "collection" : "tab";
      if (!this.artifacts.some(a => a.kind === kind && a.id === target.id)) this.artifacts.push({ kind, id: target.id, label: String(target.title || target.name || "Saved output").slice(0, 300), ...(typeof target.url === "string" ? {url: target.url} : {}) });
    }
  }
}

/** Every browser turn receives this through the system tool catalog, including resumes and watches. */
export const BROWSER_RESEARCH_OUTPUT_GUIDANCE = "Successful final answers with observed page sources are sent to Browser for automatic ResearchNotebook storage. Return the research answer directly; notebook saving is handled by the host, outside your tools. Do not call context.write to save research output: context.write creates separate workspace memory and is unavailable in read-only tasks. A refused memory write does not mean ResearchNotebook saving failed. Report the findings and source uncertainties; Browser shows the actual notebook persistence state, so do not claim storage success or failure without a host receipt.";
