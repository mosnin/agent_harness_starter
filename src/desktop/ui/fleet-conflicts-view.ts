/**
 * Hades desktop fleet CONFLICTS lane — the renderer-side panel that surfaces
 * `../core/fleet-conflicts.ts`'s `ConflictsLaneModel` (live-registry
 * conflicts, terminal drops, and corrected-state notes from restart
 * recovery) plus the placeholder-manager-credentials banner
 * `extractPlaceholderNotice` lifts out of a provision's routing reason.
 *
 * Framework-free DOM, in the `fleet-provision-view.ts` style: real
 * `document.createElement` nodes, every dynamic value written through
 * `textContent` (never `innerHTML`), one delegated click listener so
 * `destroy()` has exactly one listener to tear down. This view NEVER calls
 * a service directly — every actionable row wires straight to the optional
 * `FleetConflictsViewCallbacks`, and central integration is the only place
 * that turns those callbacks into real `fleet.*` commands.
 *
 * Layout:
 *   - A credential banner (`role="status"`), present in the DOM only when
 *     `update()` is called with a `credentialNotice`, absent otherwise.
 *   - A header with the lane title and a live conflict/dropped/corrected
 *     count summary.
 *   - The lane body: one row per `ConflictItem` (severity badge, worker id,
 *     reason) with an action button only when `suggestedAction !== "none"`,
 *     or an explicit "no conflicts" empty state when `model.items` is empty.
 */

import type { ConflictsLaneModel, ConflictItem } from "../core/fleet-conflicts";

export type { ConflictsLaneModel, ConflictItem, ConflictSeverity } from "../core/fleet-conflicts";

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface FleetConflictsViewCallbacks {
  /** A conflict row's "rename and provision" action was activated. */
  onRename?(workerId: string, suggested: string): void;
  /** A row's "terminate the live worker first" action was activated. */
  onTerminate?(workerId: string): void;
}

export interface FleetConflictsViewHandle {
  /** Fully replaces the lane's rows and the credential banner from `model`
   *  (and `credentialNotice`, when set). Idempotent: safe to call
   *  repeatedly, always leaves the DOM matching exactly the latest call. */
  update(model: ConflictsLaneModel, credentialNotice?: string): void;
  /** Removes the delegated click listener and every child node from `root`. */
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Attribute names (delegation contract between render + the click handler)
// ---------------------------------------------------------------------------

const ATTR_ACTION = "data-fleet-conflicts-action";
const ATTR_WORKER_ID = "data-worker-id";
const ATTR_SUGGESTED_ID = "data-suggested-worker-id";

function severityLabel(severity: ConflictItem["severity"]): string {
  switch (severity) {
    case "conflict":
      return "conflict";
    case "dropped":
      return "dropped";
    case "corrected":
      return "corrected";
    default: {
      const _exhaustive: never = severity;
      return _exhaustive;
    }
  }
}

/** `"N conflict"` / `"N conflicts"` — the only one of the three counts that
 *  is a genuine count noun needing pluralization; `"dropped"`/`"corrected"`
 *  are adjectival and never take an "s" (see the two call sites below). */
function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

function buildActionButton(item: ConflictItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "fleet-conflicts-row__action btn btn-sm";
  button.setAttribute(ATTR_ACTION, item.suggestedAction);
  button.setAttribute(ATTR_WORKER_ID, item.workerId);

  if (item.suggestedAction === "rename-and-provision") {
    const suggested = item.suggestedWorkerId ?? "";
    if (suggested.length > 0) button.setAttribute(ATTR_SUGGESTED_ID, suggested);
    button.textContent = suggested.length > 0 ? `Rename to ${suggested}` : "Rename and provision";
    button.setAttribute(
      "aria-label",
      suggested.length > 0
        ? `Rename ${item.workerId} to ${suggested} and provision`
        : `Rename ${item.workerId} and provision`
    );
  } else if (item.suggestedAction === "terminate-live-first") {
    button.textContent = "Terminate live worker first";
    button.setAttribute("aria-label", `Terminate live worker ${item.workerId} first`);
  }

  return button;
}

function buildRow(item: ConflictItem): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `fleet-conflicts-row fleet-conflicts-row--${item.severity}`;
  li.setAttribute(ATTR_WORKER_ID, item.workerId);

  const badge = document.createElement("span");
  badge.className = `fleet-conflicts-badge fleet-conflicts-badge--${item.severity}`;
  badge.textContent = severityLabel(item.severity);
  li.append(badge);

  const idEl = document.createElement("code");
  idEl.className = "fleet-conflicts-row__id";
  idEl.textContent = item.workerId;
  li.append(idEl);

  const reasonEl = document.createElement("span");
  reasonEl.className = "fleet-conflicts-row__reason";
  reasonEl.textContent = item.reason;
  li.append(reasonEl);

  if (item.suggestedAction !== "none") {
    li.append(buildActionButton(item));
  }

  return li;
}

function renderBody(body: HTMLElement, model: ConflictsLaneModel): void {
  body.textContent = "";

  if (model.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fleet-conflicts-empty";
    empty.textContent = "No conflicts.";
    body.append(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "fleet-conflicts-list";
  for (const item of model.items) {
    list.append(buildRow(item));
  }
  body.append(list);

  if (model.notices.length > 0) {
    const notices = document.createElement("ul");
    notices.className = "fleet-conflicts-notices";
    for (const notice of model.notices) {
      const li = document.createElement("li");
      li.className = "fleet-conflicts-notices__item";
      li.textContent = notice;
      notices.append(li);
    }
    body.append(notices);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Mounts the conflicts lane into `root`. Returns a handle whose `update()`
 * fully redraws the lane from a fresh `ConflictsLaneModel` (and, optionally,
 * a credential-placeholder notice string — typically
 * `extractPlaceholderNotice(routing).notice`) and whose `destroy()` removes
 * the view's one delegated listener and empties `root`. Safe to call once
 * per `root`; mounting a second view into the same root without destroying
 * the first is not supported (matches every other view in this directory).
 */
export function mountFleetConflictsView(
  root: HTMLElement,
  cb?: FleetConflictsViewCallbacks
): FleetConflictsViewHandle {
  root.textContent = "";
  root.classList.add("fleet-conflicts");

  const banner = document.createElement("div");
  banner.className = "fleet-conflicts-banner";
  banner.setAttribute("role", "status");

  const header = document.createElement("header");
  header.className = "fleet-conflicts__header";

  const title = document.createElement("h3");
  title.className = "fleet-conflicts__title";
  title.textContent = "Conflicts";
  header.append(title);

  const counts = document.createElement("div");
  counts.className = "fleet-conflicts__counts";
  const conflictCount = document.createElement("span");
  conflictCount.className = "fleet-conflicts-count fleet-conflicts-count--conflict";
  const droppedCount = document.createElement("span");
  droppedCount.className = "fleet-conflicts-count fleet-conflicts-count--dropped";
  const correctedCount = document.createElement("span");
  correctedCount.className = "fleet-conflicts-count fleet-conflicts-count--corrected";
  counts.append(conflictCount, droppedCount, correctedCount);
  header.append(counts);

  const body = document.createElement("div");
  body.className = "fleet-conflicts__body";

  root.append(header, body);

  function onClick(ev: Event): void {
    const target = ev.target as { closest?: (selector: string) => Element | null } | null;
    if (!target || typeof target.closest !== "function") return;
    const el = target.closest(`[${ATTR_ACTION}]`);
    if (!el) return;

    const action = el.getAttribute(ATTR_ACTION);
    const workerId = el.getAttribute(ATTR_WORKER_ID);
    if (!action || !workerId) return;

    if (action === "rename-and-provision") {
      const suggested = el.getAttribute(ATTR_SUGGESTED_ID) ?? "";
      cb?.onRename?.(workerId, suggested);
    } else if (action === "terminate-live-first") {
      cb?.onTerminate?.(workerId);
    }
  }
  body.addEventListener("click", onClick);

  function showBanner(notice: string): void {
    banner.textContent = notice;
    if (!root.contains(banner)) {
      root.insertBefore(banner, header);
    }
  }

  function hideBanner(): void {
    banner.textContent = "";
    if (root.contains(banner)) {
      root.removeChild(banner);
    }
  }

  return {
    update(model: ConflictsLaneModel, credentialNotice?: string): void {
      conflictCount.textContent = countLabel(model.counts.conflict, "conflict");
      droppedCount.textContent = `${model.counts.dropped} dropped`;
      correctedCount.textContent = `${model.counts.corrected} corrected`;

      renderBody(body, model);

      if (credentialNotice !== undefined && credentialNotice.length > 0) {
        showBanner(credentialNotice);
      } else {
        hideBanner();
      }
    },
    destroy(): void {
      body.removeEventListener("click", onClick);
      root.textContent = "";
      root.classList.remove("fleet-conflicts");
    },
  };
}
