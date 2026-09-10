import type { Terminal } from "@xterm/xterm";

/**
 * WKWebView can suspend animation frames while still displaying a native window.
 * xterm parses PTY bytes on timers, but its renderer then waits forever for RAF.
 * Keep normal frame batching; only flush a stalled, attached terminal after 100ms.
 * This small, shape-checked compatibility boundary targets xterm 6's debouncer.
 * It never replaces the window scheduler or rebuilds/focuses the terminal DOM.
 */
export function terminalRendering(terminal: Terminal, node: HTMLElement, fit: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const visible = () => node.isConnected && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const request = () => {
    if (disposed || timer !== undefined || !visible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !visible()) return;
      const service = (terminal as unknown as { _core?: { _renderService?: RenderService } })._core?._renderService;
      if (!service) return;
      // A detach/reattach can leave an outdated IntersectionObserver pause behind.
      if (service._isPaused && typeof service._handleIntersectionChange === "function") {
        service._handleIntersectionChange({ isIntersecting: true });
      }
      const debouncer = service._renderDebouncer;
      if (!debouncer || typeof debouncer._innerRefresh !== "function") return;
      terminal.refresh(0, terminal.rows - 1);
      if (debouncer._animationFrame !== undefined) {
        node.ownerDocument.defaultView?.cancelAnimationFrame(debouncer._animationFrame);
        debouncer._innerRefresh();
      }
    }, 100);
  };
  const recover = () => {
    if (!visible() || disposed) return;
    fit();
    terminal.refresh(0, terminal.rows - 1);
    request();
  };
  const rendered = terminal.onRender(clear);
  const parsed = terminal.onWriteParsed(request);
  const win = node.ownerDocument.defaultView;
  win?.addEventListener("focus", recover);
  node.ownerDocument.addEventListener("visibilitychange", recover);
  node.addEventListener("wheel", request, { passive: true });
  node.addEventListener("keydown", request);
  return {
    recover,
    dispose() {
      disposed = true; clear(); rendered.dispose(); parsed.dispose();
      win?.removeEventListener("focus", recover);
      node.ownerDocument.removeEventListener("visibilitychange", recover);
      node.removeEventListener("wheel", request);
      node.removeEventListener("keydown", request);
    },
  };
}

interface RenderService {
  _isPaused?: boolean;
  _handleIntersectionChange?: (entry: { isIntersecting: boolean }) => void;
  _renderDebouncer?: { _animationFrame?: number; _innerRefresh?: () => void };
}
