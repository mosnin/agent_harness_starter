/** Preserve editing position across workbench renders, including persistent editor nodes. */
export function captureFocus(root: HTMLElement) {
  const element = document.activeElement as HTMLElement | null;
  if (!element || !root.contains(element)) return undefined;
  const selector = element.id ? `#${CSS.escape(element.id)}` : element.matches("[data-action], [data-command], [data-session], [data-publish]")
    ? Object.entries(element.dataset).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(value ?? "")}"]`).join("")
    : element.matches(".sidebar-more > summary") ? ".sidebar-more > summary" : undefined;
  const input = element as HTMLInputElement;
  return { element, selector, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
}
export function restoreFocus(root: HTMLElement, saved: ReturnType<typeof captureFocus>) {
  if (!saved) return false;
  const target = saved.element.isConnected ? saved.element : saved.selector ? root.querySelector<HTMLElement>(saved.selector) : null;
  if (!target || target.closest("[hidden], [inert]") || target.matches(":disabled")) return false;
  target.focus({ preventScroll: true });
  if (saved.start != null) {
    try { (target as HTMLInputElement).setSelectionRange(saved.start, saved.end ?? saved.start, saved.direction ?? undefined); } catch { /* Non-text controls have no selection. */ }
  }
  return document.activeElement === target;
}
export function dialogFocusable(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [tabindex]')].filter(el => {
    if (el.matches(':disabled, [tabindex="-1"], input[type="hidden"]') || el.closest('[hidden], [inert]')) return false;
    for (let parent: HTMLElement | null = el; parent && parent !== dialog; parent = parent.parentElement) {
      if (getComputedStyle(parent).display === "none" || getComputedStyle(parent).visibility === "hidden") return false;
      if (parent.tagName === "DETAILS" && !(parent as HTMLDetailsElement).open && !parent.querySelector(":scope > summary")?.contains(el)) return false;
    }
    return true;
  });
}
