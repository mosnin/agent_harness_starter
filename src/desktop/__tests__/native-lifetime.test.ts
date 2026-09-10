import { afterEach, expect, it, vi } from "vitest";
import { nativeLifetime } from "../core/native-lifetime";
afterEach(() => vi.useRealTimers());
it("bounds a stuck shutdown when the native parent disappears", () => {
  vi.useFakeTimers(); let parent = 42;
  const stop = vi.fn(), terminate = vi.fn();
  const life = nativeLifetime({ parent: 42, parentNow: () => parent, stop, terminate });
  vi.advanceTimersByTime(500); expect(stop).not.toHaveBeenCalled();
  parent = 1; vi.advanceTimersByTime(250); expect(stop).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1999); expect(terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(terminate).toHaveBeenCalledOnce();
  life.finish();
});
it("starts the deadline on EOF once, and cancels it after normal cleanup", () => {
  vi.useFakeTimers(); const terminate = vi.fn(), stop = vi.fn();
  const life = nativeLifetime({parent:42,parentNow:() => 42,stop,terminate});
  life.stop(); life.stop(); expect(stop).toHaveBeenCalledOnce();
  life.finish(); vi.advanceTimersByTime(5000); expect(terminate).not.toHaveBeenCalled();
});
it("reaps the group even when cleanup finishes before the parent-death poll", () => {
  vi.useFakeTimers(); const terminate = vi.fn();
  const life = nativeLifetime({parent:42,parentNow:() => 1,stop:vi.fn(),terminate});
  life.finish(); expect(terminate).toHaveBeenCalledOnce();
});
