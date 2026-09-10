type RPC = (method: string, args?: Record<string, unknown>) => Promise<any>;
export interface SpatialScope {
  sessionId: string;
  profile: string;
  root: string;
}
export interface SpatialPacket {
  id: string;
  sessionId: string;
  profile: string;
  root: string;
  createdAt: number;
  title: string;
  intent: string;
  source: string;
  context: Record<string, unknown>;
  image?: string;
  images?: string[];
  handoffId?: string;
  loaded?: boolean;
  status: string;
  digest: string;
  revision: number;
  review?: { excludeImage: boolean; excludeText: boolean; redactions?: Mask[] };
}
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
type Mask = { x: number; y: number; width: number; height: number };
const image = (packet: SpatialPacket, masks: Mask[] = []) =>
  (packet.images ?? (packet.image ? [packet.image] : []))
    .map((value, index) =>
      /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
        ? `<span class="spatial-image"><img src="${escape(value)}" alt="Captured ${escape(packet.source)} context, image ${index + 1}">${masks.map((mask) => `<i aria-hidden="true" style="left:${mask.x * 100}%;top:${mask.y * 100}%;width:${mask.width * 100}%;height:${mask.height * 100}%"></i>`).join("")}</span>`
        : "",
    )
    .join("");
interface Draft {
  intent: string;
  excludeImage: boolean;
  excludeText: boolean;
  dirty: boolean;
  redactions: Mask[];
}
interface State {
  packets: SpatialPacket[];
  drafts: Map<string, Draft>;
  attached: Map<string, number>;
  selected: string;
  open: boolean;
  source: string;
  sourceChosen: boolean;
  deleteConfirm?: { id: string; revision: number };
  sections: string[];
  workflowId: string;
  workflows: any[];
  workflowUnknown: boolean;
  prompt: string;
  after: string;
  tabs: { id: string; title?: string; url?: string }[];
  nodes: { ref: string; role?: string; name?: string }[];
  tabId: string;
  elementRef: string;
  snapshotId: number;
}
/** Local review controller. RPC mutations never dispatch chat or start Helm work. */
export class SpatialView {
  private scope?: SpatialScope;
  private key = "";
  private states = new Map<string, State>();
  private host?: HTMLElement;
  private generation = 0;
  private busy = false;
  private error = "";
  private notice = "";
  private status: any;
  private comparison: any;
  private renderedKey = "";
  private pendingCapture?: SpatialScope;
  private pendingWorkflow?: SpatialScope & {
    tabId: string;
    workflowId?: string;
  };
  constructor(
    private rpc: RPC,
    private changed: () => void,
  ) {}
  setScope(scope?: SpatialScope) {
    const key = scope ? JSON.stringify(scope) : "";
    if (key === this.key) return;
    if (this.state) this.state.deleteConfirm = undefined;
    this.cancelOperations();
    this.generation++;
    this.key = key;
    this.scope = scope;
    this.busy = false;
    this.error = this.notice = "";
    this.comparison = this.status = undefined;
    if (key && !this.states.has(key))
      this.states.set(key, {
        packets: [],
        drafts: new Map(),
        attached: new Map(),
        selected: "",
        open: false,
        source: "desktop",
        sourceChosen: false,
        sections: [],
        workflows: [],
        workflowId: "",
        workflowUnknown: false,
        prompt: "",
        after: "",
        tabs: [],
        nodes: [],
        tabId: "",
        elementRef: "",
        snapshotId: 0,
      });
  }
  private get state() {
    return this.states.get(this.key);
  }
  get attachments() {
    return [...(this.state?.attached ?? [])].map(([id, revision]) => ({
      id,
      revision,
    }));
  }
  sent(items: { id: string; revision: number }[], scope: SpatialScope) {
    const state = this.states.get(JSON.stringify(scope));
    for (const item of items)
      if (state?.attached.get(item.id) === item.revision)
        state.attached.delete(item.id);
  }
  mount(host: HTMLElement) {
    this.host = host;
    this.render();
  }
  async open() {
    if (!this.scope || !this.state) return;
    this.state.open = true;
    this.state.deleteConfirm = undefined;
    await this.perform(async (scope) => {
      const [status, packets] = await Promise.all([
        this.rpc("spatial.status", { ...scope }),
        this.rpc("spatial.list", { ...scope }),
      ]);
      const selectedId = this.state?.selected;
      if (
        selectedId &&
        packets.some((packet: SpatialPacket) => packet.id === selectedId)
      ) {
        const full = await this.rpc("spatial.get", {
          ...scope,
          id: selectedId,
        });
        const index = packets.findIndex(
          (packet: SpatialPacket) => packet.id === selectedId,
        );
        packets[index] = { ...full, loaded: true };
      }
      return () => {
        this.status = status;
        if (!this.state!.sourceChosen) {
          this.state!.source = status.maus?.available
            ? "maus"
            : status.browser?.available
              ? "browser"
              : "desktop";
          this.state!.sourceChosen = true;
        }
        const state = this.state!;
        const previous = state.packets;
        state.packets = packets
          .filter((packet: SpatialPacket) => this.valid(packet))
          .map((packet: SpatialPacket) => {
            const cached = previous.find(
              (item) =>
                item.id === packet.id && item.revision === packet.revision,
            );
            return cached?.loaded ? { ...cached, ...packet } : packet;
          });
        for (const packet of state.packets) {
          if (
            state.attached.has(packet.id) &&
            state.attached.get(packet.id) !== packet.revision
          )
            state.attached.delete(packet.id);
          if (!state.drafts.get(packet.id)?.dirty)
            state.drafts.set(packet.id, {
              intent: packet.intent,
              excludeImage: !!packet.review?.excludeImage,
              excludeText: !!packet.review?.excludeText,
              dirty: false,
              redactions: [],
            });
        }
        for (const id of state.attached.keys())
          if (!state.packets.some((packet) => packet.id === id))
            state.attached.delete(id);
        this.comparison = undefined;
      };
    });
    this.host?.querySelector<HTMLElement>("[data-spatial=close]")?.focus();
  }
  private valid(packet: SpatialPacket) {
    return (
      packet.sessionId === this.scope?.sessionId &&
      packet.profile === this.scope.profile &&
      packet.root === this.scope.root
    );
  }
  private save(packet: SpatialPacket, preserveDraft = false) {
    if (!this.valid(packet))
      throw new Error(
        "Capture belongs to a different conversation or project.",
      );
    packet = { ...packet, loaded: true };
    this.comparison = undefined;
    const state = this.state!;
    state.packets = [
      packet,
      ...state.packets.filter((p) => p.id !== packet.id),
    ];
    state.selected = packet.id;
    state.deleteConfirm = undefined;
    if (!preserveDraft || !state.drafts.get(packet.id)?.dirty)
      state.drafts.set(packet.id, {
        intent: packet.intent,
        excludeImage: !!packet.review?.excludeImage,
        excludeText: !!packet.review?.excludeText,
        dirty: false,
        redactions: [],
      });
  }
  private async perform(work: (scope: SpatialScope) => Promise<() => void>) {
    if (!this.scope || this.busy) return;
    const token = ++this.generation;
    const scope = { ...this.scope };
    this.busy = true;
    this.error = this.notice = "";
    this.render();
    try {
      const apply = await work(scope);
      if (token === this.generation) apply();
    } catch (error) {
      if (token === this.generation)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (token === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }
  private cancelOperations() {
    const capture = this.pendingCapture;
    this.pendingCapture = undefined;
    if (capture)
      void this.rpc("spatial.cancel", { ...capture }).catch(() => {});
    const state = this.state;
    const pending = this.pendingWorkflow;
    this.pendingWorkflow = undefined;
    const active = state?.workflows.find((workflow) =>
      ["recording", "replaying", "running"].includes(workflow.status),
    );
    const request =
      pending ??
      (active && this.scope
        ? {
            ...this.scope,
            tabId: active.tabId ?? state!.tabId,
            workflowId: active.id,
          }
        : undefined);
    if (request) {
      if (state) state.workflowUnknown = true;
      void this.rpc("spatial.workflow", {
        ...request,
        operation: "cancel",
        mode: "human",
      })
        .then((result) => {
          if (state) {
            state.workflows = result.workflows ?? [];
            state.workflowUnknown = false;
          }
        })
        .catch(() => {});
    }
  }
  private render() {
    if (!this.host) return;
    const state = this.state;
    if (state && this.renderedKey === this.key && this.host.childElementCount)
      state.sections = [
        ...this.host.querySelectorAll<HTMLDetailsElement>("details[open]"),
      ].map((el) => el.querySelector("summary")?.textContent ?? "");
    this.renderedKey = this.key;
    if (!state) {
      this.host.innerHTML = "";
      return;
    }
    const selected = state.packets.find((p) => p.id === state.selected);
    const draft = selected
      ? (state.drafts.get(selected.id) ?? {
          intent: selected.intent,
          excludeImage: !!selected.review?.excludeImage,
          excludeText: !!selected.review?.excludeText,
          dirty: false,
          redactions: [],
        })
      : undefined;
    if (selected && draft) state.drafts.set(selected.id, draft);
    const button = (label: string, action: string, extra = "") =>
      `<button type="button" data-spatial="${action}" ${extra}>${label}</button>`;
    const attached = this.attachments
      .map(
        (a) =>
          `<span class="spatial-chip">Reviewed capture · v${a.revision} ${button("Remove", "remove", `data-id="${escape(a.id)}" aria-label="Remove spatial attachment"`)}</span>`,
      )
      .join("");
    this.host.innerHTML = `${attached ? `<div class="spatial-attached" aria-label="Spatial attachments">${attached}</div>` : ""}${
      state.open
        ? `<section class="spatial-panel" aria-label="Review spatial context"><header><div><strong>Point at something</strong><p>Review locally. Attach only what this conversation needs.</p></div>${button("Close", "close")}</header>
      <p class="spatial-scope">Conversation ${escape(this.scope!.sessionId)} · profile ${escape(this.scope!.profile)} · ${escape(this.scope!.root)}</p>
      <div class="spatial-actions"><label>Source<select id="spatial-source"><option value="desktop">Desktop · screen after 3 seconds</option><option value="maus">Maus · point or speak</option><option value="maus-latest">Maus · latest saved capture</option><option value="browser">Hades Browser · page or element</option></select></label>${button("Capture for review", "capture", this.busy ? "disabled" : "")}${button("Refresh captures", "refresh", this.busy ? "disabled" : "")}</div>
      ${state.source === "browser" ? `<div class="spatial-actions">${button("Load browser pages", "targets", this.busy ? "disabled" : "")}<label>Browser page<select id="spatial-tab"><option value="">Choose a page</option>${state.tabs.map((tab) => `<option value="${escape(tab.id)}" ${tab.id === state.tabId ? "selected" : ""}>${escape(tab.title || tab.url || "Untitled page")}</option>`).join("")}</select></label>${button("Inspect selected page", "targets", this.busy || !state.tabId ? "disabled" : "")}</div>${state.snapshotId ? `<label>Observed element<select id="spatial-element"><option value="">Choose an observed element</option>${state.nodes.map((node) => `<option value="${escape(node.ref)}" ${node.ref === state.elementRef ? "selected" : ""}>${escape(node.role || "Element")} · ${escape(node.name || "Unnamed")}</option>`).join("")}</select></label>` : ""}` : ""}
      ${
        state.source === "browser" && state.tabId
          ? `<details><summary>Browser workflows</summary><p class="help">Record your actions in this tab. Replay requires separate approval in Hades Browser; manual steps remain yours.</p><div class="spatial-actions">${button("Record workflow", "workflow-start", this.busy || state.workflowUnknown ? "disabled" : "")}${button("Refresh workflows", "workflow-list", this.busy ? "disabled" : "")}</div><label>Workflow<select id="spatial-workflow"><option value="">Choose a workflow</option>${state.workflows.map((workflow) => `<option value="${escape(workflow.id)}" ${workflow.id === state.workflowId ? "selected" : ""}>${escape(workflow.status)} · ${escape(workflow.url || workflow.id)}</option>`).join("")}</select></label>${
              state.workflowId
                ? `<div class="spatial-actions">${button("Stop recording", "workflow-stop", this.busy ? "disabled" : "")}${button("Cancel workflow", "workflow-cancel", this.busy ? "disabled" : "")}${button("Replay with approval", "workflow-replay", this.busy || state.workflowUnknown ? "disabled" : "")}</div><pre>${escape(
                    JSON.stringify(
                      state.workflows.find(
                        (workflow) => workflow.id === state.workflowId,
                      ),
                      null,
                      2,
                    ),
                  )}</pre>`
                : ""
            }${state.workflowUnknown ? '<p role="status">The previous workflow request has an unknown result. Inspect Browser and refresh workflows before another replay.</p>' : ""}</details>`
          : ""
      }
      <p class="help">Capture may request approval. No access is granted automatically. For Browser, choose a page and an observed element (the page root captures the whole page).</p>
      ${this.status ? `<p class="help">${["desktop", "browser", "maus"].map((key) => `${key === "desktop" ? "Desktop" : key === "maus" ? "Maus" : "Browser"}: ${this.status[key]?.available ? "available" : escape(this.status[key]?.reason || "unavailable")}`).join(" · ")}</p>` : ""}
      <div class="spatial-actions"><button type="button" data-action="nav-computer">Capture access &amp; settings</button><button type="button" data-action="nav-helm">Open Helm drafts</button></div>
      ${this.busy ? `<div role="status">${state.source === "desktop" && this.pendingCapture ? "Switch to the app you want to capture. Capturing in 3 seconds…" : "Working locally…"} ${button("Cancel pending operation", "cancel")}</div>` : ""}
      ${this.error ? `<p role="alert">${escape(this.error)}</p>` : ""}${this.notice ? `<p role="status">${escape(this.notice)}</p>` : ""}
      <label>Saved captures<select id="spatial-packet"><option value="">Choose a capture</option>${state.packets
        .filter((p) => this.valid(p))
        .map(
          (p) =>
            `<option value="${escape(p.id)}" ${p.id === state.selected ? "selected" : ""}>${escape(p.title)} · ${escape(p.status)}</option>`,
        )
        .join("")}</select></label>
      ${
        selected?.loaded && draft
          ? `<article><h3>${escape(selected.title)}</h3><p class="help">${escape(selected.source)} · ${escape(new Date(selected.createdAt).toLocaleString())} · revision ${selected.revision}</p>
      ${!draft.excludeImage ? image(selected, draft.redactions) : '<p class="help">Image excluded from the reviewed packet.</p>'}
      ${!draft.excludeImage && (selected.images?.length ?? (selected.image ? 1 : 0)) === 1 ? `<details><summary>Mask private image regions</summary><p class="help">Add a rectangle using percentages of the image. Masks also exclude captured text to prevent text leakage. Save review to apply the mask.</p><div class="spatial-actions">${["x", "y", "width", "height"].map((key, index) => `<label>${["Left %", "Top %", "Width %", "Height %"][index]}<input type="number" id="spatial-mask-${key}" min="0" max="100" step="1" value="${index < 2 ? 0 : 20}"></label>`).join("")}${button("Add mask", "mask-add", this.busy ? "disabled" : "")}</div>${draft.redactions.length ? `<p>${draft.redactions.length} pending mask(s). Captured text will be excluded.</p>${button("Clear pending masks", "mask-clear", this.busy ? "disabled" : "")}` : ""}</details>` : ""}
      <label>Annotation<textarea id="spatial-intent" rows="3">${escape(draft.intent)}</textarea></label>
      <div class="spatial-actions"><label><input type="checkbox" id="spatial-exclude-image" ${draft.excludeImage ? "checked" : ""}>Exclude image</label><label><input type="checkbox" id="spatial-exclude-text" ${draft.excludeText ? "checked" : ""}>Exclude captured text</label></div>
      ${!draft.excludeText ? `<details><summary>Captured text and metadata</summary><pre>${escape(JSON.stringify(selected.context, null, 2))}</pre></details>` : ""}
      <div class="spatial-actions">${button("Save review", "review", this.busy ? "disabled" : "")}${button("Attach to composer", "attach", this.busy || draft.dirty || selected.status === "captured" ? "disabled" : "")}</div>
      <div class="spatial-actions">${button("Delete capture", "delete", this.busy || selected.status === "attached" || !!selected.handoffId || state.attached.has(selected.id) ? "disabled" : "")}</div>
      ${state.deleteConfirm?.id === selected.id ? `<div role="group" aria-label="Confirm capture deletion"><p>Delete this local capture and its review? This cannot be undone.</p><div class="spatial-actions">${button("Keep capture", "delete-cancel", this.busy ? "disabled" : "")}${button("Delete permanently", "delete-confirm", this.busy ? "disabled" : "")}</div></div>` : ""}
      <p class="help">Save changes before attaching. Saving exclusions removes that data from this local packet. Capture again to restore it.</p>
      <details><summary>Send reviewed context to Helm</summary><label>Coding task<textarea id="spatial-prompt" rows="2" placeholder="Describe the coding task"></textarea></label>${button("Create Helm draft", "handoff", this.busy || draft.dirty || selected.status === "captured" || !!selected.handoffId ? "disabled" : "")}<p class="help">Creates a draft for project and provider review. Does not start a coding task.</p></details>
      <details><summary>Before / after comparison</summary><label>Compare this capture with<select id="spatial-after"><option value="">Choose an after capture</option>${state.packets
        .filter((p) => p.id !== selected.id && this.valid(p))
        .map(
          (p) => `<option value="${escape(p.id)}">${escape(p.title)}</option>`,
        )
        .join(
          "",
        )}</select></label>${button("Compare", "compare", this.busy ? "disabled" : "")}</details>
      ${
        this.comparison
          ? `<div class="spatial-comparison"><strong>Observed differences</strong><div class="spatial-pair">${[
              this.comparison.beforeId,
              this.comparison.afterId,
            ]
              .map((id, index) => {
                const item = state.packets.find(
                  (p) => p.id === id && this.valid(p),
                );
                return item
                  ? `<figure><figcaption>${index === 0 ? "Before" : "After"} · ${escape(item.title)}</figcaption>${image(item)}</figure>`
                  : "";
              })
              .join(
                "",
              )}</div><p>${this.comparison.comparable ? "Comparable captures" : "Different capture scopes"} · ${this.comparison.imageChanged === true ? "Image changed" : this.comparison.imageChanged === false ? "Image unchanged" : "Image not compared"} · ${this.comparison.contextChanged === true ? "Context changed" : this.comparison.contextChanged === false ? "Context unchanged" : "Context not compared"}</p><p>${escape((this.comparison.reasons ?? []).join(" · "))}</p><pre>${escape(JSON.stringify(this.comparison.changes ?? [], null, 2))}</pre><p class="help">Differences are evidence to inspect, not proof that the task is correct.</p></div>`
          : ""
      }</article>`
          : `<p class="help">Capture a screen or choose a saved capture to review it here.</p>`
      }</section>`
        : ""
    }`;
    this.host.querySelectorAll<HTMLButtonElement>("[data-spatial]").forEach(
      (el) =>
        (el.onclick = () => {
          void this.action(el.dataset.spatial!, el.dataset.id);
        }),
    );
    this.host
      .querySelector<HTMLSelectElement>("#spatial-packet")
      ?.addEventListener("change", (event) => {
        state.selected = (event.target as HTMLSelectElement).value;
        state.deleteConfirm = undefined;
        this.comparison = undefined;
        if (!state.selected) {
          this.render();
          return;
        }
        const id = state.selected;
        void this.perform(async (scope) => {
          const packet = await this.rpc("spatial.get", { ...scope, id });
          return () => this.save(packet, true);
        });
      });
    this.host
      .querySelector<HTMLTextAreaElement>("#spatial-intent")
      ?.addEventListener("input", (event) => {
        if (draft) {
          draft.intent = (event.target as HTMLTextAreaElement).value;
          draft.dirty = true;
          this.disableAttach();
        }
      });
    for (const [id, key] of [
      ["spatial-exclude-image", "excludeImage"],
      ["spatial-exclude-text", "excludeText"],
    ] as const)
      this.host
        .querySelector<HTMLInputElement>(`#${id}`)
        ?.addEventListener("change", (event) => {
          if (draft) {
            draft[key] = (event.target as HTMLInputElement).checked;
            draft.dirty = true;
            state.attached.delete(selected!.id);
            this.render();
          }
        });
    for (const [id, key] of [
      ["spatial-source", "source"],
      ["spatial-prompt", "prompt"],
      ["spatial-after", "after"],
    ] as const) {
      const input = this.host.querySelector<HTMLInputElement>(`#${id}`);
      if (input) {
        input.value = state[key];
        input.oninput = () => {
          state[key] = input.value;
          if (key === "source") {
            state.sourceChosen = true;
            this.render();
          }
        };
      }
    }
    this.host
      .querySelector<HTMLSelectElement>("#spatial-workflow")
      ?.addEventListener("change", (event) => {
        state.workflowId = (event.target as HTMLSelectElement).value;
        this.render();
      });
    this.host
      .querySelector<HTMLSelectElement>("#spatial-tab")
      ?.addEventListener("change", (event) => {
        state.tabId = (event.target as HTMLSelectElement).value;
        state.elementRef = state.workflowId = "";
        state.snapshotId = 0;
        state.workflows = [];
        state.nodes = [];
        this.render();
      });
    this.host
      .querySelector<HTMLSelectElement>("#spatial-element")
      ?.addEventListener("change", (event) => {
        state.elementRef = (event.target as HTMLSelectElement).value;
      });
    this.host
      .querySelectorAll<HTMLInputElement>("input,select,textarea")
      .forEach((input) => (input.disabled = this.busy));
    this.host.querySelectorAll<HTMLDetailsElement>("details").forEach((el) => {
      el.open = state.sections.includes(
        el.querySelector("summary")?.textContent ?? "",
      );
    });
    this.host.onkeydown = (event) => {
      if (event.key === "Escape" && state.open) {
        event.stopPropagation();
        void this.action("close");
      }
    };
  }
  private disableAttach() {
    this.state?.attached.delete(this.state.selected);
    this.host
      ?.querySelectorAll<HTMLButtonElement>('[data-spatial="remove"]')
      .forEach((button) => {
        if (button.dataset.id === this.state?.selected)
          button.closest(".spatial-chip")?.remove();
      });
    this.host
      ?.querySelectorAll<HTMLButtonElement>(
        '[data-spatial="attach"],[data-spatial="handoff"]',
      )
      .forEach((el) => (el.disabled = true));
  }
  private async action(action: string, id?: string) {
    const state = this.state;
    if (!state) return;
    const packet = state.packets.find((p) => p.id === state.selected);
    const draft = packet ? state.drafts.get(packet.id) : undefined;
    const value = (id: string) =>
      this.host?.querySelector<HTMLInputElement>(`#${id}`)?.value ?? "";
    if (action === "close" || action === "cancel") {
      state.deleteConfirm = undefined;
      this.cancelOperations();
      this.generation++;
      this.busy = false;
      state.open = action === "cancel";
      this.notice =
        "Cancellation requested. Refresh to inspect any result that completed before cancellation.";
      this.render();
      if (action === "close") this.changed();
      return;
    }
    if (action === "remove") {
      state.attached.delete(id!);
      this.render();
      return;
    }
    if (action === "refresh") {
      await this.open();
      return;
    }
    if (action.startsWith("workflow-")) {
      if (!state.tabId) return;
      const operation = action.slice(9);
      if (
        state.workflowUnknown &&
        (operation === "start" || operation === "replay")
      )
        return;
      if (operation !== "list") state.workflowUnknown = true;
      await this.perform(async (scope) => {
        const pending = {
          ...scope,
          tabId: state.tabId,
          ...(state.workflowId ? { workflowId: state.workflowId } : {}),
        };
        if (operation !== "list") this.pendingWorkflow = pending;
        const result = await this.rpc("spatial.workflow", {
          ...scope,
          tabId: state.tabId,
          operation,
          mode: "human",
          ...(state.workflowId && operation !== "start"
            ? { workflowId: state.workflowId }
            : {}),
        });
        if (this.pendingWorkflow === pending) this.pendingWorkflow = undefined;
        return () => {
          state.workflows = result.workflows ?? [];
          state.workflowUnknown = false;
          if (
            !state.workflowId ||
            !state.workflows.some((w) => w.id === state.workflowId)
          )
            state.workflowId = state.workflows[0]?.id ?? "";
        };
      });
      return;
    }
    if (action === "targets") {
      await this.perform(async (scope) => {
        const result = await this.rpc("spatial.targets", {
          ...scope,
          ...(state.tabId ? { tabId: state.tabId } : {}),
        });
        return () => {
          state.tabs = result.tabs ?? [];
          state.nodes = result.snapshot?.nodes ?? [];
          state.snapshotId = result.snapshot?.snapshotId ?? 0;
          state.elementRef = "";
        };
      });
      return;
    }
    if (action === "capture") {
      const source = state.source === "maus-latest" ? "maus" : state.source;
      if (
        source === "browser" &&
        (!state.tabId || !state.snapshotId || !state.elementRef)
      ) {
        this.error =
          "Inspect a browser page and choose an observed element before capturing.";
        this.render();
        return;
      }
      const options =
        source === "browser"
          ? {
              tabId: state.tabId,
              ...(state.elementRef
                ? { ref: state.elementRef, snapshotId: state.snapshotId }
                : {}),
            }
          : state.source === "maus-latest"
            ? { mode: "latest" }
            : {};
      this.pendingCapture = { ...this.scope! };
      const pending = this.pendingCapture;
      await this.perform(async (scope) => {
        const packet = await this.rpc("spatial.capture", {
          ...scope,
          source,
          ...options,
        });
        return () => this.save(packet);
      });
      if (this.pendingCapture === pending) this.pendingCapture = undefined;
      return;
    }
    if (!packet?.loaded || !draft) return;
    if (action === "delete-cancel") {
      state.deleteConfirm = undefined;
      this.render();
      this.host?.querySelector<HTMLElement>('[data-spatial="delete"]')?.focus();
      return;
    }
    if (action === "delete" || action === "delete-confirm") {
      if (
        packet.status === "attached" ||
        packet.handoffId ||
        state.attached.has(packet.id)
      )
        return;
      if (action === "delete") {
        state.deleteConfirm = { id: packet.id, revision: packet.revision };
        this.render();
        this.host
          ?.querySelector<HTMLElement>('[data-spatial="delete-cancel"]')
          ?.focus();
        return;
      }
      if (
        state.deleteConfirm?.id !== packet.id ||
        state.deleteConfirm.revision !== packet.revision
      )
        return;
      await this.perform(async (scope) => {
        await this.rpc("spatial.remove", {
          ...scope,
          id: packet.id,
          revision: packet.revision,
        });
        return () => {
          state.packets = state.packets.filter((item) => item.id !== packet.id);
          state.drafts.delete(packet.id);
          state.attached.delete(packet.id);
          state.selected = "";
          state.deleteConfirm = undefined;
          if (state.after === packet.id) state.after = "";
          this.comparison = undefined;
          this.notice = "Capture deleted from this local library.";
        };
      });
      return;
    }
    if (action === "mask-add") {
      const [x, y, width, height] = ["x", "y", "width", "height"].map(
        (key) => Number(value(`spatial-mask-${key}`)) / 100,
      );
      if (
        ![x, y, width, height].every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > 1 ||
        y + height > 1 ||
        draft.redactions.length >= 32
      ) {
        this.error =
          "Keep the rectangle inside the image (0–100%), with a positive width and height.";
        this.render();
        return;
      }
      draft.redactions.push({ x, y, width, height });
      draft.excludeText = true;
      draft.dirty = true;
      state.attached.delete(packet.id);
      this.render();
      return;
    }
    if (action === "mask-clear") {
      draft.redactions = [];
      draft.dirty = true;
      state.attached.delete(packet.id);
      this.render();
      return;
    }
    if (action === "attach" && !draft.dirty && packet.status !== "captured") {
      state.attached.set(packet.id, packet.revision);
      this.notice = "Attached locally. Use Send in the composer when ready.";
      this.render();
      return;
    }
    if (action === "review") {
      await this.perform(async (scope) => {
        const updated = await this.rpc("spatial.review", {
          ...scope,
          id: packet.id,
          revision: packet.revision,
          intent: draft.intent,
          excludeImage: draft.excludeImage,
          excludeText: draft.excludeText || draft.redactions.length > 0,
          redactions: draft.redactions,
        });
        return () => {
          state.attached.delete(packet.id);
          this.save(updated);
        };
      });
      return;
    }
    if (
      action === "handoff" &&
      !draft.dirty &&
      packet.status !== "captured" &&
      !packet.handoffId
    ) {
      const prompt = value("spatial-prompt").trim();
      if (!prompt) {
        this.error = "Describe a coding task before creating a Helm draft.";
        this.render();
        return;
      }
      await this.perform(async (scope) => {
        const result = await this.rpc("spatial.handoff", {
          ...scope,
          id: packet.id,
          revision: packet.revision,
          prompt,
        });
        return () => {
          packet.handoffId = result.id;
          this.notice = `Helm draft ${result.id} created. Open Helm → Tasks & context to choose a project and provider.`;
        };
      });
      return;
    }
    if (action === "compare") {
      const afterId = value("spatial-after");
      if (!afterId) return;
      await this.perform(async (scope) => {
        const after = await this.rpc("spatial.get", { ...scope, id: afterId });
        const result = await this.rpc("spatial.compare", {
          ...scope,
          beforeId: packet.id,
          afterId,
        });
        return () => {
          if (!this.valid(after))
            throw new Error(
              "After capture belongs to a different conversation.",
            );
          state.packets = state.packets.map((item) =>
            item.id === after.id ? { ...after, loaded: true } : item,
          );
          this.comparison = result;
        };
      });
    }
  }
}
