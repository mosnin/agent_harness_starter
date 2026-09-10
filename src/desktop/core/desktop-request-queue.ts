export type DesktopRequestLane = "serial" | "inspection" | "control";
export interface DesktopQueuedRequest { id: string; method: string; args?: unknown }
export interface DesktopRequestContext { signal: AbortSignal }
export class DesktopQueueError extends Error {
  constructor(public readonly code: "closed" | "capacity" | "cancelled_before_admission", message: string) { super(message); this.name = "DesktopQueueError"; }
}
interface Entry<R> { request: R; controller: AbortController; run: (context: DesktopRequestContext) => Promise<unknown>; resolve: (result: unknown) => void; reject: (error: unknown) => void }
/** Scheduling only: the host still authenticates every request in its handler.
 * Every caller must observe the returned promise and send one correlated reply. */
export class DesktopRequestQueue<R extends DesktopQueuedRequest = DesktopQueuedRequest> {
  private waiting: Entry<R>[] = [];
  private active = new Set<Entry<R>>();
  private counts = { serial: 0, inspection: 0, control: 0 };
  private serialActive = false;
  private closed = false;
  private drains: Array<() => void> = [];
  constructor(private readonly limits = { serial: 256, inspection: 32, control: 16 }) {
    for (const limit of Object.values(limits)) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid desktop queue capacity");
  }
  submit<T>(request: R, lane: DesktopRequestLane, handler: (request: R, context: DesktopRequestContext) => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new DesktopQueueError("closed", "Desktop request queue is closed"));
    if (!(lane in this.counts) || this.counts[lane] >= this.limits[lane]) return Promise.reject(new DesktopQueueError("capacity", "Too many pending desktop requests in this lane"));
    this.counts[lane]++;
    return new Promise<T>((resolve, reject) => {
      const entry: Entry<R> = {request,controller:new AbortController(),run:async context => handler(request,context),resolve:result=>resolve(result as T),reject};
      if (lane === "serial") { this.waiting.push(entry); this.pump(); }
      else this.launch(entry,lane);
    });
  }
  /** Cancels only unstarted serial requests. The predicate is trusted host code,
   * never a client-selected forwarding rule. Active or previously completed
   * duplicate identities are deliberately not inferred absent or stopped. */
  cancelQueued(predicate: (request: Readonly<R>) => boolean): { cancelledBeforeAdmission: number; requestIds: string[] } {
    const matches = this.waiting.filter(entry => predicate(entry.request));
    const selected = new Set(matches); this.waiting = this.waiting.filter(entry => !selected.has(entry));
    for (const entry of matches) {
      this.counts.serial--; entry.controller.abort();
      entry.reject(new DesktopQueueError("cancelled_before_admission", "Request cancelled before handler admission; existing worker state is unknown"));
    }
    this.notifyDrained();
    return {cancelledBeforeAdmission:matches.length,requestIds:matches.map(entry=>entry.request.id)};
  }
  private pump() {
    if (this.closed || this.serialActive) return;
    const next = this.waiting.shift(); if (next) { this.serialActive = true; this.launch(next,"serial"); }
  }
  private launch(entry: Entry<R>, lane: DesktopRequestLane) {
    this.active.add(entry);
    // Synchronous admission makes Stop unable to mistake a launched request for
    // an unstarted one. Handler throws are contained without poisoning the queue.
    void entry.run({signal:entry.controller.signal}).then(entry.resolve,entry.reject).finally(() => {
      this.active.delete(entry); this.counts[lane]--;
      if (lane === "serial") { this.serialActive = false; this.pump(); }
      this.notifyDrained();
    });
  }
  private notifyDrained() { if (!this.active.size && !this.waiting.length) this.drains.splice(0).forEach(resolve=>resolve()); }
  drain(): Promise<void> { return !this.active.size && !this.waiting.length ? Promise.resolve() : new Promise(resolve=>this.drains.push(resolve)); }
  /** Abort is cooperative. Drain waits for every admitted handler to settle;
   * the host must cancel owned resources rather than treating abort as proof. */
  close(): Promise<void> {
    this.closed = true;
    for (const entry of this.active) entry.controller.abort();
    const waiting = this.waiting.splice(0);
    for (const entry of waiting) { this.counts.serial--; entry.controller.abort(); entry.reject(new DesktopQueueError("closed", "Desktop closed before handler admission")); }
    this.notifyDrained(); return this.drain();
  }
}
