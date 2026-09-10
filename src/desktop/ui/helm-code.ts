/** A persistent frame: workbench renders must not restart coding sessions. */
export class HelmCodeFrame {
  private frame?: HTMLIFrameElement;
  private anchor?: HTMLElement;
  private resize?: ResizeObserver;
  private changes?: MutationObserver;
  private scope = "";
  private origin = "";
  constructor(private openExternal: (url: string) => void = () => {}) {}
  private external = (event: MessageEvent) => {
    if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== this.origin) return;
    if (event.data?.type !== "helm.openExternal" || typeof event.data.url !== "string") return;
    let url: URL;
    try { url = new URL(event.data.url); } catch { return; }
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
    this.openExternal(url.href);
  };
  private position = () => {
    if (!this.frame) return;
    const rect = this.anchor?.isConnected ? this.anchor.getBoundingClientRect() : undefined;
    const visible = rect && rect.width > 0 && rect.height > 0;
    this.frame.hidden = !visible;
    if (visible) Object.assign(this.frame.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${Math.min(rect.height, Math.max(0, window.innerHeight - rect.top - 12))}px`,
      clipPath: `inset(${Math.max(0, (document.querySelector(".toolbar")?.getBoundingClientRect().bottom ?? 0) - rect.top)}px 0 0px 0)`,
    });
  };
  attach(anchor?: HTMLElement) {
    this.resize?.disconnect();
    this.anchor = anchor;
    if (anchor && typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(this.position);
      this.resize.observe(anchor);
    }
    this.position();
  }
  open(url: string, scope: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password)
      throw new Error("The coding workspace must use its local Hades connection.");
    if (this.frame && this.scope === scope) return;
    this.frame?.remove();
    this.scope = scope;
    this.origin = parsed.origin;
    this.frame = document.createElement("iframe");
    this.frame.className = "helm-code-frame";
    this.frame.title = "Helm coding workspace · powered by OpenCode";
    this.frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-downloads");
    this.frame.referrerPolicy = "no-referrer";
    this.frame.src = parsed.href;
    document.body.append(this.frame);
    if (!this.changes) {
      this.changes = new MutationObserver(this.position);
      this.changes.observe(document.body, { childList: true, subtree: true });
      window.addEventListener("message", this.external);
      window.addEventListener("resize", this.position);
      window.addEventListener("scroll", this.position, true);
      window.addEventListener("beforeunload", () => this.dispose(), { once: true });
    }
    this.position();
  }
  dispose() {
    this.frame?.remove();
    this.frame = undefined;
    this.resize?.disconnect();
    this.changes?.disconnect();
    this.changes = undefined;
    window.removeEventListener("message", this.external);
    window.removeEventListener("resize", this.position);
    window.removeEventListener("scroll", this.position, true);
  }
}
