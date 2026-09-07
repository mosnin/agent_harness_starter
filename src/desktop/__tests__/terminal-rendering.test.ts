// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { terminalRendering } from "../ui/terminal-rendering";

let node: HTMLElement;
let parsed: () => void;
let rendered: () => void;
let handle: ReturnType<typeof terminalRendering>;
let terminal: any;
let fit = vi.fn<() => void>();
beforeEach(() => {
  vi.useFakeTimers();
  node = document.createElement("div"); document.body.append(node);
  vi.spyOn(node, "getBoundingClientRect").mockReturnValue({ width: 600, height: 300 } as DOMRect);
  const debouncer = { _animationFrame: undefined as number | undefined, _innerRefresh: vi.fn(() => { debouncer._animationFrame = undefined; rendered(); }) };
  const service = { _isPaused: false, _renderDebouncer: debouncer, _handleIntersectionChange: vi.fn(() => { service._isPaused = false; }) };
  terminal = { rows: 20, _core: { _renderService: service }, refresh: vi.fn(() => { debouncer._animationFrame = 1; }), onRender: (cb: () => void) => { rendered = cb; return { dispose: vi.fn() }; }, onWriteParsed: (cb: () => void) => { parsed = cb; return { dispose: vi.fn() }; } };
  fit = vi.fn(); handle = terminalRendering(terminal as Terminal, node, fit);
});
afterEach(() => { handle.dispose(); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("native terminal frame recovery", () => {
  it("flushes parsed PTY output once if WKWebView never delivers animation frames", () => {
    parsed(); parsed(); parsed();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(terminal._core._renderService._renderDebouncer._innerRefresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10000);
    expect(terminal.refresh).toHaveBeenCalledOnce();
  });
  it("leaves normal rendering alone and does not keep a polling timer", () => {
    parsed(); rendered(); vi.advanceTimersByTime(100);
    expect(terminal.refresh).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("recovers stale intersection state after reattachment without changing focus", () => {
    terminal._core._renderService._isPaused = true;
    const input = document.createElement("input"); document.body.append(input); input.focus();
    handle.recover(); vi.advanceTimersByTime(100);
    expect(fit).toHaveBeenCalledOnce();
    expect(terminal._core._renderService._handleIntersectionChange).toHaveBeenCalledWith({ isIntersecting: true });
    expect(document.activeElement).toBe(input);
  });
  it("does not paint detached panes or act after disposal", () => {
    parsed(); node.remove(); vi.advanceTimersByTime(100);
    expect(terminal.refresh).not.toHaveBeenCalled();
    document.body.append(node); parsed(); handle.dispose(); vi.advanceTimersByTime(100);
    expect(terminal.refresh).not.toHaveBeenCalled();
  });
  it("fails safely if an xterm upgrade changes the private renderer shape", () => {
    delete terminal._core._renderService._renderDebouncer._innerRefresh;
    parsed(); expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
