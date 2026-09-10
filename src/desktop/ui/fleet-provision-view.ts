/**
 * Hades desktop fleet PROVISION view — the renderer-side panel that lets an
 * operator provision a new fleet worker and see what a crash-recovery
 * restore turned up on startup.
 *
 * Unlike `fleet-view.ts` (a pure `render(state) -> HTML string` function the
 * shell mounts and diffs externally), this view owns its own small slice of
 * interaction: it is handed a live `host` element and a `wire` (send a
 * `FleetProvisionCommand`, subscribe to `FleetProvisionEvent`s) and builds +
 * updates real DOM directly, the way a keyboard-first form naturally wants
 * to. It stays framework-free by the same house rule everywhere else in
 * `src/desktop/ui/`: no virtual DOM, no reactive library, just
 * `document.createElement` and targeted mutations — every dynamic value is
 * written through `textContent` (never `innerHTML`), so a hostile worker id
 * or error message can never execute as markup, only display as inert text.
 *
 * Layout:
 *   - A provision form (worker id, optional image, capability chips,
 *     exclude-backend chips, a "require hibernate" toggle, an optional cost
 *     ceiling). Enter submits (except inside a chip input, where Enter
 *     commits the chip instead); Escape resets the form. Every control is a
 *     native `<input>`/`<button>`/`<label>` in natural document order, so
 *     it is reachable by Tab with no custom tabindex plumbing.
 *   - A "Pending" lane keyed by `requestId`: submitting adds a spinner row,
 *     which resolves in place to a worker row (`fleet.provisioned`) or an
 *     inline error row (`fleet.provision.error`) — the row for one
 *     `requestId` is never confused with another's.
 *   - A "Restored" lane, visually distinct from the pending lane, rendered
 *     from `fleet.restored`: every restored worker with an "adopted" badge
 *     when its id is in `adoptedIds`, and every dropped worker with its
 *     reason, verbatim.
 *
 * `destroy()` unsubscribes from `wire` (the one listener that would
 * otherwise outlive this view — everything else is DOM attached to nodes
 * this view itself discards) and empties `host`.
 */

import type {
  FleetProvisionCommand,
  FleetProvisionEvent,
  FleetProvisionRequirements,
  FleetRestoredDrop,
} from "../ipc/fleet-provision-contract";
import type { FleetWorkerView } from "../ipc/fleet-contract";

export type {
  FleetProvisionCommand,
  FleetProvisionEvent,
  FleetProvisionSpec,
  FleetProvisionRequirements,
  FleetProvisionRouting,
  FleetRestoredDrop,
} from "../ipc/fleet-provision-contract";

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

export interface FleetProvisionWire {
  send(cmd: FleetProvisionCommand): void;
  onEvent(cb: (e: FleetProvisionEvent) => void): () => void;
}

export interface FleetProvisionViewHandle {
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Small field builders — plain DOM, no framework
// ---------------------------------------------------------------------------

interface TextFieldRefs {
  field: HTMLDivElement;
  input: HTMLInputElement;
}

function buildField(
  kind: "text" | "number",
  opts: { id: string; label: string; placeholder?: string }
): TextFieldRefs {
  const field = document.createElement("div");
  field.className = "fleet-provision-field";

  const label = document.createElement("label");
  label.className = "fleet-provision-field__label";
  label.htmlFor = opts.id;
  label.textContent = opts.label;

  const input = document.createElement("input");
  input.type = kind;
  input.id = opts.id;
  input.className = "field fleet-provision-field__input";
  if (opts.placeholder !== undefined) input.placeholder = opts.placeholder;
  if (kind === "number") {
    input.min = "0";
    input.step = "0.0001";
  }

  field.append(label, input);
  return { field, input };
}

interface CheckboxRefs {
  field: HTMLDivElement;
  input: HTMLInputElement;
}

function buildCheckboxField(opts: { id: string; label: string }): CheckboxRefs {
  const field = document.createElement("div");
  field.className = "fleet-provision-field fleet-provision-field--toggle";

  const label = document.createElement("label");
  label.className = "fleet-provision-toggle";
  label.htmlFor = opts.id;

  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = opts.id;
  input.className = "fleet-provision-toggle__input";

  const text = document.createElement("span");
  text.className = "fleet-provision-toggle__text";
  text.textContent = opts.label;

  label.append(input, text);
  field.append(label);
  return { field, input };
}

interface ChipFieldRefs {
  field: HTMLDivElement;
  input: HTMLInputElement;
  /** Re-renders the chip list from the (mutable, shared-by-reference) backing array. */
  rerender: () => void;
}

/**
 * A labeled chip-input field: `list` is the live backing array (mutated in
 * place by add/remove), `rerender()` redraws the chip row from it. Enter or
 * `,` inside the field's own `<input>` commits the current text as a chip
 * and clears the input — it does NOT bubble up as a form submission (the
 * keydown handler calls `preventDefault()`), so typing a capability and
 * hitting Enter never accidentally provisions a worker mid-edit. Backspace
 * on an empty input pops the most recently added chip, mirroring how chip
 * inputs behave in the wild.
 */
function buildChipField(opts: {
  id: string;
  label: string;
  placeholder: string;
  list: string[];
  maxChips: number;
}): ChipFieldRefs {
  const field = document.createElement("div");
  field.className = "fleet-provision-field";

  const label = document.createElement("label");
  label.className = "fleet-provision-field__label";
  label.htmlFor = opts.id;
  label.textContent = opts.label;

  const chips = document.createElement("div");
  chips.className = "fleet-provision-chips";
  chips.setAttribute("role", "list");

  const input = document.createElement("input");
  input.type = "text";
  input.id = opts.id;
  input.className = "field fleet-provision-field__input";
  input.placeholder = opts.placeholder;

  function rerender(): void {
    chips.textContent = "";
    opts.list.forEach((value, index) => {
      const chip = document.createElement("span");
      chip.className = "fleet-provision-chip";
      chip.setAttribute("role", "listitem");

      const text = document.createElement("span");
      text.className = "fleet-provision-chip__text";
      text.textContent = value;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "fleet-provision-chip__remove";
      remove.setAttribute("aria-label", `Remove ${value}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        opts.list.splice(index, 1);
        rerender();
      });

      chip.append(text, remove);
      chips.append(chip);
    });
  }
  rerender();

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === ",") {
      ev.preventDefault();
      const value = input.value.trim();
      if (value.length > 0 && !opts.list.includes(value) && opts.list.length < opts.maxChips) {
        opts.list.push(value);
        rerender();
      }
      input.value = "";
    } else if (ev.key === "Backspace" && input.value.length === 0 && opts.list.length > 0) {
      ev.preventDefault();
      opts.list.pop();
      rerender();
    }
  });

  field.append(label, chips, input);
  return { field, input, rerender };
}

/** Commits whatever text is still sitting uncommitted in a chip input, so pressing the global submit control never silently drops the last thing typed. */
function commitChip(chip: ChipFieldRefs, list: string[], maxChips: number): void {
  const value = chip.input.value.trim();
  if (value.length > 0 && !list.includes(value) && list.length < maxChips) {
    list.push(value);
    chip.rerender();
  }
  chip.input.value = "";
}

// ---------------------------------------------------------------------------
// Pending lane rows
// ---------------------------------------------------------------------------

function fillPendingRow(li: HTMLLIElement, workerId: string): void {
  li.className = "fleet-provision-pending__row fleet-provision-pending__row--pending";
  li.textContent = "";

  const spinner = document.createElement("span");
  spinner.className = "fleet-provision-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "fleet-provision-pending__label";
  label.append(document.createTextNode("Provisioning "));
  const code = document.createElement("code");
  code.textContent = workerId;
  label.append(code, document.createTextNode("…"));

  li.append(spinner, label);
}

function fillSuccessRow(li: HTMLLIElement, worker: FleetWorkerView, backend: string): void {
  li.className = "fleet-provision-pending__row fleet-provision-pending__row--success";
  li.textContent = "";

  const idEl = document.createElement("code");
  idEl.className = "fleet-provision-pending__id";
  idEl.textContent = worker.workerId;

  const backendEl = document.createElement("span");
  backendEl.className = "fleet-provision-pending__backend";
  backendEl.textContent = backend;

  const badge = document.createElement("span");
  badge.className = "fleet-provision-badge fleet-provision-badge--state";
  badge.textContent = worker.state;

  li.append(idEl, backendEl, badge);
}

function fillErrorRow(li: HTMLLIElement, message: string): void {
  li.className = "fleet-provision-pending__row fleet-provision-pending__row--error";
  li.textContent = "";

  const msg = document.createElement("span");
  msg.className = "fleet-provision-pending__error";
  msg.setAttribute("role", "alert");
  msg.textContent = message;

  li.append(msg);
}

// ---------------------------------------------------------------------------
// Restored lane
// ---------------------------------------------------------------------------

interface RestoredPayload {
  workers: FleetWorkerView[];
  adoptedIds: string[];
  dropped: FleetRestoredDrop[];
}

function renderRestoredLane(container: HTMLElement, restored: RestoredPayload | null): void {
  container.textContent = "";

  if (restored === null) {
    const empty = document.createElement("p");
    empty.className = "fleet-provision-empty";
    empty.textContent = "No restore has run yet.";
    container.append(empty);
    return;
  }

  if (restored.workers.length === 0 && restored.dropped.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fleet-provision-empty";
    empty.textContent = "Restore ran with nothing to recover.";
    container.append(empty);
    return;
  }

  const adopted = new Set(restored.adoptedIds);

  if (restored.workers.length > 0) {
    const list = document.createElement("ul");
    list.className = "fleet-provision-restored__list";
    for (const worker of restored.workers) {
      const li = document.createElement("li");
      li.className = "fleet-provision-restored__row";
      li.dataset.workerId = worker.workerId;

      const idEl = document.createElement("code");
      idEl.className = "fleet-provision-restored__id";
      idEl.textContent = worker.workerId;
      li.append(idEl);

      if (adopted.has(worker.workerId)) {
        const badge = document.createElement("span");
        badge.className = "fleet-provision-badge fleet-provision-badge--adopted";
        badge.textContent = "adopted";
        li.append(badge);
      }

      const backend = document.createElement("span");
      backend.className = "fleet-provision-restored__backend";
      backend.textContent = worker.backend;
      li.append(backend);

      const state = document.createElement("span");
      state.className = "fleet-provision-badge fleet-provision-badge--state";
      state.textContent = worker.state;
      li.append(state);

      list.append(li);
    }
    container.append(list);
  }

  if (restored.dropped.length > 0) {
    const droppedList = document.createElement("ul");
    droppedList.className = "fleet-provision-restored__dropped";
    for (const drop of restored.dropped) {
      const li = document.createElement("li");
      li.className = "fleet-provision-restored__dropped-row";
      li.dataset.workerId = drop.workerId;

      const idEl = document.createElement("code");
      idEl.className = "fleet-provision-restored__id";
      idEl.textContent = drop.workerId;

      const reason = document.createElement("span");
      reason.className = "fleet-provision-restored__dropped-reason";
      reason.textContent = drop.reason;

      li.append(idEl, reason);
      droppedList.append(li);
    }
    container.append(droppedList);
  }
}

// ---------------------------------------------------------------------------
// requestId generation
// ---------------------------------------------------------------------------

function generateRequestId(counter: { n: number }): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  counter.n += 1;
  return `req-${counter.n}-${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

const MAX_CHIPS = 64;

/**
 * Mounts the provision view into `host` and wires it to `wire`. Returns a
 * handle whose `destroy()` unsubscribes from `wire` and empties `host`.
 * Safe to call once per `host`; mounting a second view into the same host
 * without destroying the first is not supported (matches every other
 * `create*View` in this directory).
 */
export function createFleetProvisionView(host: HTMLElement, wire: FleetProvisionWire): FleetProvisionViewHandle {
  host.textContent = "";
  host.classList.add("fleet-provision-view");

  const capabilities: string[] = [];
  const excludeList: string[] = [];
  const pendingRows = new Map<string, HTMLLIElement>();
  const requestIdCounter = { n: 0 };
  let suggestionCounter = 1;

  // -- Header -----------------------------------------------------------
  const header = document.createElement("header");
  header.className = "fleet-provision-view__header";
  const title = document.createElement("h2");
  title.className = "fleet-provision-view__title";
  title.textContent = "Provision worker";
  header.append(title);

  // -- Form ---------------------------------------------------------------
  const form = document.createElement("form");
  form.className = "fleet-provision-form";
  form.noValidate = true;

  const workerIdField = buildField("text", {
    id: "fleet-provision-worker-id",
    label: "Worker ID",
    placeholder: "worker-1",
  });
  workerIdField.input.value = `worker-${suggestionCounter}`;

  const imageField = buildField("text", {
    id: "fleet-provision-image",
    label: "Image (optional)",
    placeholder: "ghcr.io/org/image:tag",
  });

  const capabilitiesField = buildChipField({
    id: "fleet-provision-capability-input",
    label: "Capabilities",
    placeholder: "Type a capability, press Enter",
    list: capabilities,
    maxChips: MAX_CHIPS,
  });

  const excludeField = buildChipField({
    id: "fleet-provision-exclude-input",
    label: "Exclude backends",
    placeholder: "Type a backend to exclude, press Enter",
    list: excludeList,
    maxChips: MAX_CHIPS,
  });

  const requireHibernateField = buildCheckboxField({
    id: "fleet-provision-require-hibernate",
    label: "Require hibernate support",
  });

  const maxCostField = buildField("number", {
    id: "fleet-provision-max-cost",
    label: "Max running $/h (optional)",
    placeholder: "0.50",
  });

  const validationMessage = document.createElement("p");
  validationMessage.className = "fleet-provision-validation";
  validationMessage.setAttribute("role", "alert");
  validationMessage.hidden = true;

  const footer = document.createElement("div");
  footer.className = "fleet-provision-footer";
  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "btn btn-primary";
  submitButton.textContent = "Provision";
  const hintEnter = document.createElement("span");
  hintEnter.className = "fleet-provision-kbd";
  hintEnter.textContent = "Enter to submit";
  const hintEsc = document.createElement("span");
  hintEsc.className = "fleet-provision-kbd";
  hintEsc.textContent = "Esc to clear";
  footer.append(submitButton, hintEnter, hintEsc);

  form.append(
    workerIdField.field,
    imageField.field,
    capabilitiesField.field,
    excludeField.field,
    requireHibernateField.field,
    maxCostField.field,
    validationMessage,
    footer
  );

  // -- Pending lane ---------------------------------------------------------
  const pendingSection = document.createElement("section");
  pendingSection.className = "fleet-provision-view__section";
  const pendingTitle = document.createElement("h3");
  pendingTitle.className = "fleet-provision-view__section-title";
  pendingTitle.textContent = "Pending";
  const pendingList = document.createElement("ul");
  pendingList.className = "fleet-provision-pending";
  pendingSection.append(pendingTitle, pendingList);

  // -- Restored lane --------------------------------------------------------
  const restoredSection = document.createElement("section");
  restoredSection.className = "fleet-provision-view__section fleet-provision-view__section--restored";
  const restoredTitle = document.createElement("h3");
  restoredTitle.className = "fleet-provision-view__section-title";
  restoredTitle.textContent = "Restored";
  const restoredLane = document.createElement("div");
  restoredLane.className = "fleet-provision-restored";
  restoredSection.append(restoredTitle, restoredLane);
  renderRestoredLane(restoredLane, null);

  host.append(header, form, pendingSection, restoredSection);

  // -- Form behavior --------------------------------------------------------

  function showValidation(message: string): void {
    validationMessage.textContent = message;
    validationMessage.hidden = false;
  }

  function hideValidation(): void {
    validationMessage.textContent = "";
    validationMessage.hidden = true;
  }

  function resetForm(): void {
    suggestionCounter += 1;
    workerIdField.input.value = `worker-${suggestionCounter}`;
    imageField.input.value = "";
    capabilities.length = 0;
    capabilitiesField.rerender();
    capabilitiesField.input.value = "";
    excludeList.length = 0;
    excludeField.rerender();
    excludeField.input.value = "";
    requireHibernateField.input.checked = false;
    maxCostField.input.value = "";
    hideValidation();
  }

  function addPendingRow(requestId: string, workerId: string): void {
    const li = document.createElement("li");
    li.dataset.requestId = requestId;
    fillPendingRow(li, workerId);
    pendingRows.set(requestId, li);
    pendingList.insertBefore(li, pendingList.firstChild);
  }

  function rowFor(requestId: string): HTMLLIElement {
    const existing = pendingRows.get(requestId);
    if (existing !== undefined) return existing;
    // Defensive path: an event referencing a requestId this view never
    // submitted (e.g. issued by another view instance, or delivered after a
    // remount). Rather than silently dropping real information, it gets its
    // own row instead of being discarded.
    const li = document.createElement("li");
    li.dataset.requestId = requestId;
    pendingRows.set(requestId, li);
    pendingList.insertBefore(li, pendingList.firstChild);
    return li;
  }

  function onSubmit(ev: SubmitEvent): void {
    ev.preventDefault();
    hideValidation();

    commitChip(capabilitiesField, capabilities, MAX_CHIPS);
    commitChip(excludeField, excludeList, MAX_CHIPS);

    const workerId = workerIdField.input.value.trim();
    if (workerId.length === 0) {
      showValidation("Worker ID is required.");
      workerIdField.input.focus();
      return;
    }

    const image = imageField.input.value.trim();

    const requirements: FleetProvisionRequirements = {};
    if (requireHibernateField.input.checked) requirements.requireHibernate = true;
    if (excludeList.length > 0) requirements.exclude = excludeList.slice();

    const maxRaw = maxCostField.input.value.trim();
    if (maxRaw.length > 0) {
      const parsed = Number(maxRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        showValidation("Max running $/h must be a non-negative number.");
        maxCostField.input.focus();
        return;
      }
      requirements.maxRunningHourUsd = parsed;
    }

    const requestId = generateRequestId(requestIdCounter);
    const cmd: FleetProvisionCommand = {
      kind: "fleet.provision",
      requestId,
      spec: {
        workerId,
        capabilities: capabilities.slice(),
        ...(image.length > 0 ? { image } : {}),
      },
      ...(Object.keys(requirements).length > 0 ? { requirements } : {}),
    };

    addPendingRow(requestId, workerId);
    wire.send(cmd);
    resetForm();
    workerIdField.input.focus();
  }

  function onFormKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      resetForm();
      workerIdField.input.focus();
    }
  }

  form.addEventListener("submit", onSubmit);
  form.addEventListener("keydown", onFormKeydown);

  // -- Wire subscription ------------------------------------------------

  let restoredState: RestoredPayload | null = null;

  const unsubscribe = wire.onEvent((event: FleetProvisionEvent) => {
    switch (event.kind) {
      case "fleet.provisioned": {
        const row = rowFor(event.requestId);
        fillSuccessRow(row, event.worker, event.backend);
        break;
      }
      case "fleet.provision.error": {
        const row = rowFor(event.requestId);
        fillErrorRow(row, event.message);
        break;
      }
      case "fleet.restored": {
        restoredState = {
          workers: event.workers,
          adoptedIds: event.adoptedIds,
          dropped: event.dropped,
        };
        renderRestoredLane(restoredLane, restoredState);
        break;
      }
      default: {
        // Exhaustiveness guard: a new FleetProvisionEvent kind added
        // upstream without a case here fails to compile.
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  });

  workerIdField.input.focus();

  return {
    destroy(): void {
      unsubscribe();
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("keydown", onFormKeydown);
      host.textContent = "";
      host.classList.remove("fleet-provision-view");
    },
  };
}
