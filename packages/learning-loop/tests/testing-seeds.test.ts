import { describe, expect, it } from "vitest";
import { LearningLoopError } from "../src/diagnostics.js";
import { createFixedClock, createSequentialIds } from "../src/testing/deterministic.js";

describe("createFixedClock", () => {
  it("returns the start instant until ticked", () => {
    const clock = createFixedClock("2026-08-16T12:00:00.000Z");
    expect(clock.now()).toBe("2026-08-16T12:00:00.000Z");
    expect(clock.now()).toBe("2026-08-16T12:00:00.000Z");
  });

  it("advances by one second by default and by the given milliseconds otherwise", () => {
    const clock = createFixedClock("2026-08-16T12:00:00.000Z");
    clock.tick();
    expect(clock.now()).toBe("2026-08-16T12:00:01.000Z");
    clock.tick(250);
    expect(clock.now()).toBe("2026-08-16T12:00:01.250Z");
  });

  it("rejects an unparseable start timestamp", () => {
    expect(() => createFixedClock("not-a-time")).toThrow(LearningLoopError);
  });
});

describe("createSequentialIds", () => {
  it("counts per namespace", () => {
    const ids = createSequentialIds();
    expect(ids.next("candidate")).toBe("candidate-1");
    expect(ids.next("candidate")).toBe("candidate-2");
    expect(ids.next("review")).toBe("review-1");
  });

  it("applies an optional prefix", () => {
    const ids = createSequentialIds("t");
    expect(ids.next("candidate")).toBe("t-candidate-1");
  });
});
