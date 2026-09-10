import { parseBrowserTask, type BrowserTask } from './browser-task';
/** Native, local-only Hades Browser protocol 1.0 transport. No credentials or
 * browser content are persisted here. The caller owns admission and approvals. */
import { randomUUID } from 'node:crypto';

export const BROWSER_PROTOCOL = '1.0.0';
export const BROWSER_TOOL_NAMES = [
  'browser.listWorkspaces', 'browser.listTabs', 'browser.openTab', 'browser.closeTab', 'browser.focusTab',
  'browser.navigate', 'browser.readPage', 'browser.capture', 'browser.findInPage',
  'collections.list', 'collections.read', 'collections.search', 'collections.addPage', 'collections.create',
  'workflow.control', 'activity.digest', 'page.spatialContext', 'page.snapshot', 'page.extract', 'page.waitFor', 'page.click', 'page.hover', 'page.type',
  'page.press', 'page.select', 'page.scroll', 'page.screenshot', 'context.write', 'context.search', 'context.list',
] as const;
export type BrowserToolName = typeof BROWSER_TOOL_NAMES[number];
const MUTATING = new Set<string>(['workflow.control','browser.openTab', 'browser.closeTab', 'browser.focusTab', 'browser.navigate',
  'collections.addPage', 'collections.create', 'page.click', 'page.hover', 'page.type', 'page.press', 'page.select', 'page.scroll', 'context.write']);
export const BROWSER_TOOL_SPECS = BROWSER_TOOL_NAMES.map(name => ({ name, mutating: MUTATING.has(name), description:
  name === 'page.snapshot' ? 'Inspect page elements and fresh refs before acting. Old refs are refused.' :
  name === 'page.type' ? 'Type into an observed page field. Browser permissions and sensitive-field checks apply.' :
  name === 'page.waitFor' ? 'Wait for text, URL, a named element or network idle; avoid repeated snapshot polling.' :
  name.replaceAll('.', ' ') }));
export interface BrowserAgentBinding { id: string; profile: string; name: string; description?: string; allowedTools: readonly BrowserToolName[] }
export interface BrowserAuthority { profile: string; agentId: string; signal: AbortSignal }
export interface BrowserAdmission { ok: true; threadId?: string; runId?: string }
export interface BrowserChat { text: string; threadId?: string; context?: Record<string, unknown>; task?: BrowserTask }
export interface BrowserCapture { threadId?: string; capture: Record<string, unknown>; prompt?: string; context?: Record<string, unknown> }
export interface BrowserControl { runId: string; action: 'pause' | 'resume' | 'cancel' | 'answer' | 'extend'; budget?: {maxTokens:number;maxDurationMs:number}; answer?: string; questionId?: string; reason?: string }
export interface BrowserToolResult { callId: string; ok: boolean; value?: unknown; error?: { code: string; message: string } }
export interface HadesBrowserOptions {
  endpoint: string; token: string; agents: readonly BrowserAgentBinding[];
  onChat?: (authority: BrowserAuthority, payload: BrowserChat) => Promise<BrowserAdmission>;
  onCapture?: (authority: BrowserAuthority, payload: BrowserCapture) => Promise<BrowserAdmission>;
  onTaskControl?: (authority: BrowserAuthority, payload: BrowserControl) => void | Promise<void>;
  onDisconnect?: (reason: string) => void;
  onRequest?: (authority: BrowserAuthority, type: string, payload: Record<string, unknown>) => Promise<unknown>;
  requestTimeoutMs?: number;
}
type Envelope = { id: string; protocol: string; kind: 'request' | 'response' | 'event'; type: string; at: number;
  payload: any; replyTo?: string; sessionId?: string };
type Pending = { type: string; runId?: string; resolve: (payload: any) => void; reject: (error: Error) => void; cleanup: () => void };
type BoundRun = { profile: string; agentId: string; state: 'running' | 'paused' | 'cancelled' | 'finished' };
const MAX_INBOUND = 8 * 1024 * 1024, MAX_OUTBOUND = 1024 * 1024, MAX_PENDING = 32;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
function string(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('Invalid browser ' + label);
  return value;
}
export function validateBrowserEndpoint(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Browser endpoint must be a local WebSocket URL'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Browser endpoint must be ws://127.0.0.1:PORT or ws://[::1]:PORT without credentials or a path');
  return url.toString();
}

export class HadesBrowserClient {
  private readonly endpoint: string;
  private readonly agents: BrowserAgentBinding[];
  private readonly lifetime = new AbortController();
  private socket?: WebSocket;
  private connection?: Promise<void>;
  private sessionId?: string;
  private connected = false;
  private closed = false;
  private pending = new Map<string, Pending>();
  private seen = new Set<string>();
  private runs = new Map<string, BoundRun>();
  private callbacks = 0;
  private tabOwners = new Map<string, string>();
  private capabilities: string[] = [];
  private readonly timeout: number;
  constructor(private readonly options: HadesBrowserOptions) {
    this.endpoint = validateBrowserEndpoint(options.endpoint);
    if (!/^[A-Za-z0-9_-]{16,512}$/.test(options.token)) throw new Error('Invalid browser pairing token');
    if (!options.agents.length || options.agents.length > 32) throw new Error('Register between 1 and 32 browser agents');
    const ids = new Set<string>(), profiles = new Set<string>();
    this.agents = options.agents.map(agent => {
      if (!identifier(agent.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(agent.profile) || ids.has(agent.id) || profiles.has(agent.profile))
        throw new Error('Browser agent identities and profiles must be unique');
      ids.add(agent.id); profiles.add(agent.profile);
      if (!Array.isArray(agent.allowedTools) || agent.allowedTools.some(name => !BROWSER_TOOL_NAMES.includes(name))) throw new Error('Unknown browser tool');
      return { id: agent.id, profile: agent.profile, name: string(agent.name, 100, 'agent name'),
        ...(agent.description ? { description: string(agent.description, 500, 'agent description') } : {}), allowedTools: [...new Set(agent.allowedTools)] };
    });
    this.timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeout) || this.timeout < 10 || this.timeout > 120_000) throw new Error('Invalid browser request timeout');
  }
  status() { return { connected: this.connected, endpoint: this.endpoint, protocol: BROWSER_PROTOCOL,
    agents: this.agents.map(({ id, profile, name }) => ({ id, profile, name })), capabilities: [...this.capabilities] }; }
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Browser connection is closed; reconnect explicitly with a new client'));
    return this.connection ??= this.open();
  }
  private async open() {
    const url = new URL(this.endpoint); url.searchParams.set('token', this.options.token);
    try {
      const socket = this.socket = new WebSocket(url);
      socket.addEventListener('message', event => { void this.receive(event.data).catch(() => this.close('Invalid browser protocol frame')); });
      socket.addEventListener('close', () => this.close('Browser disconnected; pending actions have unknown outcomes and were not replayed'));
      socket.addEventListener('error', () => this.close('Browser connection failed'));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Browser connection timed out')); }, this.timeout);
        const opened = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(new Error('Browser connection closed')); };
        const cleanup = () => { clearTimeout(timer); socket.removeEventListener('open', opened); this.lifetime.signal.removeEventListener('abort', aborted); };
        socket.addEventListener('open', opened, { once: true }); this.lifetime.signal.addEventListener('abort', aborted, { once: true });
      });
      const ack = await this.request('handshake', { protocol: BROWSER_PROTOCOL, client: 'hades-desktop', clientVersion: '0.1.0',
        capabilities: ['tools', 'capture', 'runs', 'context', 'page', 'chat'] });
      if (!object(ack) || ack.ok !== true || ack.protocol !== BROWSER_PROTOCOL || !identifier(ack.sessionId) ||
        !Array.isArray(ack.serverCapabilities) || ack.serverCapabilities.length > 64 || ack.serverCapabilities.some((v: unknown) => typeof v !== 'string' || v.length > 100))
        throw new Error('Browser handshake rejected or protocol is incompatible');
      this.sessionId = ack.sessionId; this.capabilities = [...ack.serverCapabilities];
      const announced = await this.request('agents.announce', { agents: this.agents.map(({ profile: _profile, ...agent }) => agent) });
      if (!object(announced) || announced.ok !== true) throw new Error('Browser agent registration was refused');
      this.connected = true;
    } catch { this.close('Browser pairing failed'); throw new Error('Could not pair with Hades Browser. Check its local endpoint and pairing token.'); }
  }
  close(reason = 'Browser connection closed') {
    if (this.closed) return;
    reason = reason.replaceAll(this.options.token, '[redacted]').slice(0, 500);
    this.closed = true; this.connected = false; this.lifetime.abort();
    for (const [id, pending] of this.pending) { this.pending.delete(id); pending.cleanup(); pending.reject(new Error(reason)); }
    try { this.socket?.close(1000, 'Hades disconnected'); } catch { /* Already closed. */ }
    for (const run of this.runs.values()) run.state = 'cancelled';
    this.tabOwners.clear();
    try { this.options.onDisconnect?.(reason); } catch { /* Observer cannot prevent revocation. */ }
  }
  revoke(profile: string) { this.agent(profile); this.close('Browser access revoked'); }
  private agent(profile: string) {
    const agent = this.agents.find(a => a.profile === profile); if (!agent) throw new Error('Profile is not bound to this browser connection'); return agent;
  }
  private requireConnected() { if (!this.connected || this.closed) throw new Error('Hades Browser is not connected'); }
  async call(profile: string, name: BrowserToolName, args: Record<string, unknown>, options: { runId?: string; signal?: AbortSignal } = {}): Promise<BrowserToolResult> {
    this.requireConnected(); const agent = this.agent(profile); options.signal?.throwIfAborted();
    if (!agent.allowedTools.includes(name) || !object(args)) throw new Error('Browser tool is not available to this profile');
    if (MUTATING.has(name) && !options.runId) throw new Error('Browser changes require an active registered run');
    if (options.runId) {
      const run = this.runs.get(options.runId);
      if (!run || run.profile !== profile || run.state !== 'running') throw new Error('Browser run is not active for this profile');
    }
    const tabId = args.tabId;
    if (typeof tabId === 'string') {
      const owner = this.tabOwners.get(tabId);
      if (owner && owner !== options.runId) throw new Error('Another browser run owns this tab; wait for it to finish');
      if (options.runId) this.tabOwners.set(tabId, options.runId);
    }
    const callId = randomUUID();
    const result = await this.request('tool.call', { callId, agentId: agent.id, name, args, ...(options.runId ? { runId: options.runId } : {}) }, options);
    if (!object(result) || result.callId !== callId || typeof result.ok !== 'boolean' ||
      (!result.ok && (!object(result.error) || typeof result.error.code !== 'string' || typeof result.error.message !== 'string')))
      { this.close('Invalid browser tool response'); throw new Error('Invalid browser tool response; action was not replayed'); }
    if (result.ok && name === 'browser.openTab' && options.runId && object(result.value) && object(result.value.tab) && identifier(result.value.tab.id))
      this.tabOwners.set(result.value.tab.id, options.runId);
    return result as BrowserToolResult;
  }
  emit(profile: string, type: 'agent.message' | 'task.started' | 'task.step' | 'task.needsInput' | 'task.finished' | 'notebook.deliver' | 'task.paused' | 'task.resumed', payload: Record<string, unknown>) {
    this.requireConnected(); const agent = this.agent(profile);
    if (!object(payload)) throw new Error('Invalid browser event');
    if (payload.agentId !== undefined && payload.agentId !== agent.id) throw new Error('Browser event agent does not match profile');
    if (type === "notebook.deliver") {
      if (!identifier(payload.runId) || !object(payload.notebook)) throw new Error("Invalid notebook delivery");
      this.send({id:randomUUID(),protocol:BROWSER_PROTOCOL,kind:"event",type,at:Date.now(),sessionId:this.sessionId,payload:{...payload,agentId:agent.id}}); return;
    }
    let run: BoundRun | undefined;
    if (type !== 'agent.message') {
      if (!identifier(payload.runId)) throw new Error('Invalid browser run identity');
      run = this.runs.get(payload.runId);
      if (type === 'task.started') {
        if (run || this.runs.size >= 256) throw new Error('Browser run already exists or run limit reached');
        string(payload.title, 500, 'run title');
      } else if (!run || run.profile !== profile || run.state === 'finished' || (run.state === 'cancelled' && (type !== 'task.finished' || payload.status !== 'cancelled'))) throw new Error('Browser run is not owned by this profile');
    } else {
      string(payload.content, 256_000, 'message');
      if (payload.runId !== undefined && this.runs.get(String(payload.runId))?.profile !== profile) throw new Error('Browser message run is not owned by profile');
    }
    const body = { ...payload, ...(type === 'task.started' || type === 'agent.message' ? { agentId: agent.id } : {}) };
    this.send({ id: randomUUID(), protocol: BROWSER_PROTOCOL, kind: 'event', type, at: Date.now(), sessionId: this.sessionId, payload: body });
    if (type === 'task.started') this.runs.set(String(payload.runId), { profile, agentId: agent.id, state: 'running' });
    if (type === 'task.paused' && run) run.state = 'paused';
    if (type === 'task.resumed' && run) run.state = 'running';
    if (type === 'task.finished' && run) { run.state = 'finished'; this.releaseTabs(String(payload.runId)); }
  }
  private releaseTabs(runId: string) { for (const [tab, owner] of this.tabOwners) if (owner === runId) this.tabOwners.delete(tab); }
  private send(envelope: Envelope) {
    const text = JSON.stringify(envelope);
    if (Buffer.byteLength(text) > MAX_OUTBOUND) throw new Error('Browser request exceeds the message limit');
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Browser connection is closed');
    this.socket.send(text);
  }
  private request(type: string, payload: unknown, options: { runId?: string; signal?: AbortSignal } = {}): Promise<any> {
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many pending browser requests'));
    options.signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const aborted = () => this.close('Browser action cancelled; outcome may be unknown and was not replayed');
      const timer = setTimeout(() => this.close('Browser request timed out; outcome may be unknown and was not replayed'), this.timeout);
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', aborted); };
      this.pending.set(id, { type, runId: options.runId, resolve, reject, cleanup });
      options.signal?.addEventListener('abort', aborted, { once: true });
      try { this.send({ id, protocol: BROWSER_PROTOCOL, kind: 'request', type, at: Date.now(), sessionId: this.sessionId, payload }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  private async receive(data: unknown) {
    if (this.closed) return;
    if (typeof data !== 'string' || Buffer.byteLength(data) > MAX_INBOUND) throw new Error('Oversized or binary browser frame');
    const e: Envelope = JSON.parse(data);
    if (!object(e) || !identifier(e.id) || e.protocol !== BROWSER_PROTOCOL || !['event', 'request', 'response'].includes(e.kind) ||
      !identifier(e.type) || !Number.isFinite(e.at) || !('payload' in e) || (this.sessionId && e.sessionId !== this.sessionId)) throw new Error('Invalid browser envelope');
    if (e.kind === 'response') {
      const pending = e.replyTo ? this.pending.get(e.replyTo) : undefined;
      if (!pending) return;
      if (e.type !== pending.type + '.result' && e.type !== pending.type + '.error') throw new Error('Mismatched browser response type');
      this.pending.delete(e.replyTo!); pending.cleanup();
      if (object(e.payload) && typeof e.payload.error === 'string') pending.reject(new Error('Browser request refused'));
      else pending.resolve(e.payload);
      return;
    }
    if (!this.connected || !this.sessionId) throw new Error('Browser sent requests before pairing completed');
    if (this.seen.has(e.id)) { if (e.kind === 'request') this.reply(e, undefined, 'Duplicate browser request'); return; }
    if (this.seen.size >= 4096) throw new Error('Browser connection request limit reached');
    this.seen.add(e.id);
    if (e.type === 'task.control') return this.control(e);
    if (['recipe.schedule', 'recipe.list', 'recipe.cancel', 'notebook.ack'].includes(e.type) && e.kind === 'request') {
      try {
        if (!object(e.payload) || !this.options.onRequest) throw new Error('Unavailable browser request');
        const agent = this.agents.length === 1 ? this.agents[0] : this.agents.find(a => a.id === e.payload.agentId);
        if (!agent) throw new Error('Unknown browser agent');
        this.reply(e, await this.options.onRequest({profile: agent.profile, agentId: agent.id, signal: this.lifetime.signal}, e.type, e.payload));
      } catch (error) { if (!this.closed) this.reply(e, undefined, error instanceof Error ? error.message.slice(0, 300).replaceAll(this.options.token, '[redacted]') : 'Browser routine request failed'); }
      return;
    }
    if (!['chat.send', 'capture.submit'].includes(e.type) || e.kind !== 'request') { if (e.kind === 'request') this.reply(e, undefined, 'Unsupported browser request'); return; }
    if (this.callbacks >= 8) { this.reply(e, undefined, 'Browser admission queue is full'); return; }
    this.callbacks++;
    const admission = new AbortController();
    const admissionSignal = AbortSignal.any([this.lifetime.signal, admission.signal]);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const admitted = <T>(callback: Promise<T>) => Promise.race([callback, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { admission.abort(); reject(new Error('Browser admission timed out')); }, this.timeout);
      admissionSignal.addEventListener('abort', () => reject(new Error('Browser admission cancelled')), { once: true });
    })]);
    try {
      if (!object(e.payload)) throw new Error('Invalid browser admission');
      const agent = e.payload.agentId === undefined && this.agents.length === 1 ? this.agents[0] : this.agents.find(a => a.id === e.payload.agentId);
      if (!agent) throw new Error('Unknown browser agent');
      const authority = { profile: agent.profile, agentId: agent.id, signal: admissionSignal };
      const context = e.payload.context;
      if (context !== undefined && (!object(context) || Buffer.byteLength(JSON.stringify(context)) > 512_000)) throw new Error('Invalid attached browser context');
      let result: BrowserAdmission;
      if (e.type === 'chat.send') {
        if (!this.options.onChat) throw new Error('Browser chat is not available');
        if (e.payload.threadId !== undefined && !identifier(e.payload.threadId)) throw new Error('Invalid browser thread');
        result = await admitted(this.options.onChat(authority, { text: string(e.payload.text, 64_000, 'chat'),
          ...(e.payload.threadId ? { threadId: e.payload.threadId } : {}), ...(context ? { context } : {}), ...(e.payload.task === undefined ? {} : { task: parseBrowserTask(e.payload.task) }) }));
      } else {
        if (!this.options.onCapture || !object(e.payload.capture)) throw new Error('Browser capture is not available');
        if (e.payload.threadId !== undefined && !identifier(e.payload.threadId)) throw new Error('Invalid browser capture thread');
        const capture = e.payload.capture;
        if (!identifier(capture.id) || !['screen', 'window', 'tab', 'tab-fullpage', 'region'].includes(capture.kind) ||
          typeof capture.dataUrl !== 'string' || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(capture.dataUrl) ||
          !Number.isInteger(capture.width) || capture.width < 1 || capture.width > 32768 ||
          !Number.isInteger(capture.height) || capture.height < 1 || capture.height > 32768 || !Number.isFinite(capture.capturedAt))
          throw new Error('Invalid browser capture');
        result = await admitted(this.options.onCapture(authority, { capture, ...(e.payload.threadId ? { threadId: e.payload.threadId } : {}),
          ...(e.payload.prompt ? { prompt: string(e.payload.prompt, 64_000, 'capture prompt') } : {}), ...(context ? { context } : {}) }));
      }
      if (this.closed) return;
      if (!object(result) || result.ok !== true) throw new Error('Browser admission was not accepted');
      this.reply(e, { ok: true, ...(result.threadId ? { threadId: result.threadId } : {}), ...(result.runId ? { runId: result.runId } : {}) });
    } catch { if (!this.closed) this.reply(e, undefined, 'Hades could not admit this browser request'); }
    finally { if (deadline) clearTimeout(deadline); this.callbacks--; }
  }
  private reply(e: Envelope, payload?: unknown, error?: string) {
    this.send({ id: randomUUID(), protocol: BROWSER_PROTOCOL, kind: 'response', type: e.type + (error ? '.error' : '.result'),
      at: Date.now(), sessionId: this.sessionId, replyTo: e.id, payload: error ? { error } : payload });
  }
  private async control(e: Envelope) {
    const p = e.payload;
    if (!object(p) || !identifier(p.runId) || !['pause', 'resume', 'cancel', 'answer', 'extend'].includes(p.action) ||
      (p.questionId !== undefined && !identifier(p.questionId)) ||
      (p.answer !== undefined && (typeof p.answer !== 'string' || p.answer.length > 64_000))) { if (e.kind === 'request') this.reply(e, undefined, 'Invalid browser control'); return; }
    if (p.action === 'extend' && (!object(p.budget) || !Number.isSafeInteger(p.budget.maxTokens) || !Number.isSafeInteger(p.budget.maxDurationMs) || p.budget.maxTokens < 0 || p.budget.maxDurationMs < 0 || !(p.budget.maxTokens || p.budget.maxDurationMs))) { if (e.kind === 'request') this.reply(e, undefined, 'Invalid additional task budget'); return; }
    const run = this.runs.get(p.runId);
    if (!run || run.state === 'finished' || run.state === 'cancelled') { if (e.kind === 'request') this.reply(e, undefined, 'Unknown or finished browser run'); return; }
    const previousState = run.state;
    if (p.action === 'pause' || p.action === 'cancel') {
      run.state = p.action === 'pause' ? 'paused' : 'cancelled';
      if (p.action === 'cancel') this.releaseTabs(p.runId);
      for (const [id, pending] of this.pending) if (pending.runId === p.runId) { this.pending.delete(id); pending.cleanup(); pending.reject(new Error('Browser run ' + p.action + 'd; pending action was not replayed')); }
    }
    // Only the explicit browser resume/answer action clears a pause.
    if (p.action === 'resume' || p.action === 'answer' || p.action === 'extend') run.state = 'running';
    try {
      await this.options.onTaskControl?.({ profile: run.profile, agentId: run.agentId, signal: this.lifetime.signal },
        { runId: p.runId, action: p.action, ...(p.budget ? {budget:p.budget} : {}), ...(p.answer !== undefined ? { answer: p.answer } : {}), ...(p.questionId ? { questionId: p.questionId } : {}), ...(typeof p.reason === 'string' ? { reason: p.reason.slice(0,100) } : {}) });
      if (e.kind === 'request' && !this.closed) this.reply(e, { ok: true });
    } catch { if (!this.closed) run.state = previousState; if (e.kind === 'request' && !this.closed) this.reply(e, undefined, 'Hades could not apply browser control'); }
  }
}
