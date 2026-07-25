import { describe, expect, it, vi } from "vitest";

import { ManualClock, systemClock } from "../clock";

describe("systemClock", () => {
  it("reports real wall-clock time (matches Date.now() within a generous tolerance)", () => {
    const before = Date.now();
    const reported = systemClock.now();
    const after = Date.now();
    expect(reported).toBeGreaterThanOrEqual(before);
    expect(reported).toBeLessThanOrEqual(after);
  });

  it("delegates to Date.now() exactly", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(1_234_567_890);
    try {
      expect(systemClock.now()).toBe(1_234_567_890);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ManualClock", () => {
  it("starts at the given epoch and now() is stable until mutated", () => {
    const clock = new ManualClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it("throws constructing with a non-finite start", () => {
    expect(() => new ManualClock(NaN)).toThrow(TypeError);
    expect(() => new ManualClock(Infinity)).toThrow(TypeError);
  });

  describe("advance()", () => {
    it("moves the clock forward and returns the new now()", () => {
      const clock = new ManualClock(1_000);
      const returned = clock.advance(500);
      expect(returned).toBe(1_500);
      expect(clock.now()).toBe(1_500);
    });

    it("accumulates exactly across repeated calls", () => {
      const clock = new ManualClock(0);
      clock.advance(1);
      clock.advance(2);
      clock.advance(3);
      clock.advance(994);
      expect(clock.now()).toBe(1_000);
    });

    it("allows advancing by zero (no-op) without throwing", () => {
      const clock = new ManualClock(50);
      expect(clock.advance(0)).toBe(50);
      expect(clock.now()).toBe(50);
    });

    it("throws on a negative duration and leaves now() unchanged", () => {
      const clock = new ManualClock(1_000);
      expect(() => clock.advance(-1)).toThrow(RangeError);
      expect(clock.now()).toBe(1_000);
    });

    it("throws on a non-finite duration", () => {
      const clock = new ManualClock(1_000);
      expect(() => clock.advance(NaN)).toThrow(TypeError);
      expect(() => clock.advance(Infinity)).toThrow(TypeError);
    });
  });

  describe("set()", () => {
    it("jumps forward to an absolute instant", () => {
      const clock = new ManualClock(1_000);
      clock.set(50_000);
      expect(clock.now()).toBe(50_000);
    });

    it("allows setting to the exact same instant (no-op, not a backwards move)", () => {
      const clock = new ManualClock(1_000);
      clock.set(1_000);
      expect(clock.now()).toBe(1_000);
    });

    it("throws attempting to move backwards, and now() is unaffected", () => {
      const clock = new ManualClock(10_000);
      expect(() => clock.set(9_999)).toThrow(RangeError);
      expect(clock.now()).toBe(10_000);
    });

    it("throws on a non-finite target", () => {
      const clock = new ManualClock(1_000);
      expect(() => clock.set(NaN)).toThrow(TypeError);
    });

    it("cannot be used to simulate time travel across a mixed sequence of advance/set", () => {
      const clock = new ManualClock(0);
      clock.advance(10_000);
      clock.set(20_000);
      expect(() => clock.set(15_000)).toThrow(RangeError);
      expect(() => clock.advance(-1)).toThrow(RangeError);
      expect(clock.now()).toBe(20_000);
    });
  });

  it("implements the Clock interface (structurally usable wherever Clock is expected)", () => {
    function readNow(clock: { now(): number }): number {
      return clock.now();
    }
    const clock = new ManualClock(42);
    expect(readNow(clock)).toBe(42);
    expect(readNow(systemClock)).toEqual(expect.any(Number));
  });
});
