import { describe, it, expect } from "bun:test";

import { isBackgroundWake, parseBackgroundWake } from "./background-wake.js";

// Verbatim shape of the daemon's wake body (session.ts #maybeDeliverBackgroundReports).
const WAKE = [
  "<background_tasks>",
  "(daemon-injected background-task notifications — NOT a message from the owner)",
  "- [completed] task ba3emjr2: Find Studio uses of NEXT_PUBLIC_AUTHN_URL",
  "- [failed] task a14fac26: # Security review: part 1 (round 1)",
  "",
  "**Verdict:** Part 1 works as designed.",
  "- [completed] task b0eg4lz3: ",
  "",
  "no oracle response after 15 min",
  "</background_tasks>",
  "",
  "Background work you started earlier has finished. Continue what you deferred.",
].join("\n");

describe("parseBackgroundWake", () => {
  it("lists every task with its status and a one-line headline", () => {
    expect(parseBackgroundWake(WAKE)).toEqual([
      { status: "completed", taskId: "ba3emjr2", headline: "Find Studio uses of NEXT_PUBLIC_AUTHN_URL" },
      { status: "failed", taskId: "a14fac26", headline: "# Security review: part 1 (round 1)" },
      // An empty first digest line takes the next non-empty one.
      { status: "completed", taskId: "b0eg4lz3", headline: "no oracle response after 15 min" },
    ]);
  });

  it("returns nothing for text that is not the wake shape", () => {
    expect(parseBackgroundWake("- [completed] task x: outside the block")).toEqual([]);
    expect(parseBackgroundWake("")).toEqual([]);
  });
});

describe("isBackgroundWake", () => {
  it("is the system:background principal's user-role message only", () => {
    expect(isBackgroundWake({ role: "user", identity: { sub: "system:background" } })).toBe(true);
    expect(isBackgroundWake({ role: "user", identity: { sub: "user:someone" } })).toBe(false);
    expect(isBackgroundWake({ role: "info", identity: { sub: "system:background" } })).toBe(false);
  });
});
