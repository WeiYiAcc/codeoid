/**
 * The TUI rendered the daemon's background wake under "You", in full — a wall
 * of injected task digests that read as the owner's own message.
 */
import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { MessageRow } from "../tui/components/MessageRow.js";
import type { SessionMessage } from "../protocol/types.js";

const BODY = [
  "<background_tasks>",
  "(daemon-injected background-task notifications — NOT a message from the owner)",
  "- [completed] task ba3emjr2: Find Studio uses of NEXT_PUBLIC_AUTHN_URL",
  "- [failed] task a14fac26: # Security review",
  "",
  "A long digest body that must not be printed inline.",
  "</background_tasks>",
  "",
  "Background work you started earlier has finished.",
].join("\n");

const message = (sub: string, content: string): SessionMessage =>
  ({
    type: "session.message",
    sessionId: "s",
    messageId: "m",
    role: "user",
    content,
    identity: { sub, name: sub, type: sub.startsWith("system:") ? "system" : "user" },
    timestamp: "2026-09-27T08:00:00Z",
  }) as unknown as SessionMessage;

describe("TUI MessageRow — background wake", () => {
  it("shows the finished tasks compactly, not as the owner's message", () => {
    const out = renderToString(<MessageRow msg={message("system:background", BODY)} />);
    expect(out).toContain("Background");
    expect(out).toContain("2 tasks finished");
    expect(out).toContain("ba3emjr2");
    expect(out).toContain("failed");
    expect(out).not.toContain("You");
    expect(out).not.toContain("A long digest body");
  });

  it("leaves the owner's own messages alone", () => {
    const out = renderToString(<MessageRow msg={message("user:me", "hello")} />);
    expect(out).toContain("You");
    expect(out).toContain("hello");
  });
});
