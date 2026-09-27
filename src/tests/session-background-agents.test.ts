/**
 * Background agents outlive the turn that spawned them.
 *
 * The incident (sessions 2902d51b "bug-fixes", 1c34b3ac, 40ec9fdb and others):
 * a model started background agents, ended its turn saying it would report when
 * they landed, and then nothing happened — for minutes, once for six hours —
 * until the owner asked "is this done?". That message was refused with "A tool
 * approval is pending", naming no tool, and only then did the queued wake fire.
 *
 * The session treated every tool call, approval and sub-agent as belonging to
 * the current turn. A background agent's tool call after turn_done therefore:
 *
 *   1. moved an idle session to tool_running (auto-approved) or
 *      waiting_approval (manual), and nothing ever moved it back — while the
 *      background wake is gated on idle, so the reports never delivered;
 *   2. had its tool_start dropped (the turn queue was closed), so the approval
 *      card never rendered: a prompt nobody could see or answer;
 *   3. refused every owner message while "waiting_approval", though no turn was
 *      in flight to protect.
 *
 * And turn exit, run while background work was still live, auto-denied the
 * background agent's approvals, marked its in-flight tools cancelled, and swept
 * (and revoked) the agent itself.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../daemon/store.js";
import { TranscriptStore } from "../daemon/transcript.js";
import { Session, type AttachedClient } from "../daemon/session.js";
import { MockSessionProvider, mockResult } from "../daemon/providers/mock/session-provider.js";
import { ProviderRegistry } from "../daemon/providers/registry.js";
import type { ProviderEvent, SessionScopedEvent } from "../daemon/providers/interface.js";
import type { AuthContext, DaemonMessage, SessionMessage } from "../protocol/types.js";
import { ALL_SCOPES } from "../protocol/scopes.js";

const AUTH: AuthContext = {
  sub: "user:bg-agents",
  scopes: [...ALL_SCOPES] as AuthContext["scopes"],
  delegationDepth: 0,
  accountId: "acc-bga",
  projectId: "proj-bga",
};

let tmp: string;
let store: Store;
let transcriptStore: TranscriptStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codeoid-bga-"));
  store = new Store(join(tmp, "codeoid.db"));
  transcriptStore = new TranscriptStore(join(tmp, "transcripts"));
});

afterEach(async () => {
  await new Promise<void>((r) => setTimeout(r, 50));
  try { await transcriptStore.flush(); } catch {}
  try { store.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const done = (): ProviderEvent => ({ type: "turn_done", result: mockResult() });
const text = (content: string): ProviderEvent => ({ type: "text_done", content });
const spawn = (agentId: string): ProviderEvent => ({ type: "subagent_start", agentId, agentType: "general-purpose" });

interface ToolCall {
  event: Extract<ProviderEvent, { type: "tool_start" }>;
}
function toolCall(name: string, sdkAgentId?: string): ToolCall {
  return {
    event: {
      type: "tool_start",
      toolId: randomUUID(),
      sdkToolUseId: randomUUID(),
      ...(sdkAgentId ? { sdkAgentId } : {}),
      name,
      input: { command: "echo hi" },
      approvalId: randomUUID(),
    },
  };
}

const liveBackground = (...ids: string[]): SessionScopedEvent => ({
  type: "background_tasks",
  tasks: ids.map((id) => ({ id, kind: "subagent", description: `task ${id}`, status: "running" })),
});
const settled = (taskId: string): SessionScopedEvent => ({
  type: "background_task_settled",
  taskId,
  status: "completed",
  summary: `summary for ${taskId}`,
});

function makeSession(
  script: ProviderEvent[][],
  opts: { stall?: boolean; continues?: boolean; fallbackMs?: number; midTurn?: boolean; hooks?: unknown } = {},
) {
  const id = randomUUID();
  const provider = new MockSessionProvider("mock", script, { stall: opts.stall, midTurn: opts.midTurn });
  provider.continuesAfterBackgroundWork = opts.continues ?? false;
  const registry = new ProviderRegistry("mock");
  registry.register({ id: "mock", displayName: "mock", create: () => provider });
  store.createSession({
    id,
    name: "bga",
    workdir: tmp,
    status: "idle",
    createdBy: AUTH.sub,
    createdAt: new Date().toISOString(),
    attachedClients: 0,
    accountId: AUTH.accountId,
    projectId: AUTH.projectId,
  });
  const session = new Session({
    name: "bga",
    workdir: tmp,
    auth: AUTH,
    store,
    transcriptStore,
    existingId: id,
    providers: registry,
    providerId: "mock",
    ...(opts.fallbackMs !== undefined ? { backgroundWakeFallbackMs: opts.fallbackMs } : {}),
    ...(opts.hooks !== undefined ? { hooks: opts.hooks as never } : {}),
  });
  const fire = (e: SessionScopedEvent) => {
    if (!provider.onSessionEvent) throw new Error("Session never wired onSessionEvent");
    provider.onSessionEvent(e);
  };
  /**
   * A background agent calls a tool, the way ClaudeProvider does it: the
   * tool_start goes wherever the provider can deliver it (the live turn queue,
   * or — with no turn — the session channel), then the session's approval gate
   * is consulted. The gate is NOT awaited: a background agent blocking on it
   * does not block the test.
   */
  const backgroundToolCall = (call: ToolCall, turnOpen: boolean) => {
    if (turnOpen) provider.emitLive(call.event);
    else fire({ type: "background_event", event: call.event });
    const gate = provider.capturedOpts.at(-1)!.canUseTool;
    return gate(call.event.toolId, call.event.approvalId, call.event.name, call.event.input);
  };
  return { session, provider, fire, backgroundToolCall };
}

function recordingClient(): AttachedClient & { received: DaemonMessage[] } {
  const received: DaemonMessage[] = [];
  return { id: randomUUID(), auth: AUTH, received, send: (m) => { received.push(m); } };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}
const tick = () => new Promise<void>((r) => setTimeout(r, 20));
const prompts = (p: MockSessionProvider): string[] => p.capturedOpts.map((o) => o.userMessage);

/** Tool-call messages the client saw, by approval id. */
function toolMessage(client: { received: DaemonMessage[] }, approvalId: string): SessionMessage | undefined {
  for (const m of client.received) {
    if (m.type !== "session.message") continue;
    const sm = m as SessionMessage;
    const state = sm.tool?.state as { approvalId?: string } | undefined;
    if (state?.approvalId === approvalId) return sm;
  }
  return undefined;
}

// ── 1. The stall ─────────────────────────────────────────────────────────────

describe("a background agent's tool call between turns", () => {
  it("does not move an idle session off idle, so the background wake still fires", async () => {
    const { session, provider, fire, backgroundToolCall } = makeSession([[text("started agents"), done()], [done()]]);
    session.attach(recordingClient());
    await session.send("start the agents", AUTH);
    await waitFor(() => session.status === "idle");

    // Read is auto-approved in every mode — the common background call.
    await backgroundToolCall(toolCall("Read", "agent-1"), false);
    await tick();
    expect(session.status).toBe("idle");

    // Before the fix the session sat at tool_running and this never woke it.
    fire(settled("t1"));
    await waitFor(() => prompts(provider).length === 2);
    expect(prompts(provider)[1]).toContain("task t1");
  });

  it("renders its approval card, names the tool, and waits visibly", async () => {
    const { session, backgroundToolCall } = makeSession([[done()]]);
    const client = recordingClient();
    session.attach(client);
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    const call = toolCall("Bash", "agent-1");
    void backgroundToolCall(call, false);
    await waitFor(() => session.status === "waiting_approval");

    // Before the fix the tool_start was dropped: no card, nothing to approve.
    const card = toolMessage(client, call.event.approvalId);
    expect(card?.tool?.name).toBe("Bash");
    expect((card?.tool?.state as { phase?: string }).phase).toBe("waiting_confirmation");
  });

  it("returns to idle once decided, and delivers reports that queued meanwhile", async () => {
    const { session, provider, fire, backgroundToolCall } = makeSession([[done()], [done()]]);
    session.attach(recordingClient());
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    const call = toolCall("Bash", "agent-1");
    const decision = backgroundToolCall(call, false);
    await waitFor(() => session.status === "waiting_approval");

    session.approve(call.event.approvalId, true, AUTH);
    expect((await decision).behavior).toBe("allow");
    await waitFor(() => session.status === "idle");

    fire(settled("t1"));
    await waitFor(() => prompts(provider).length === 2);
  });

  it("does not block the owner's message: a fresh turn starts and the approval survives it", async () => {
    const { session, provider, fire, backgroundToolCall } = makeSession([[done()], [text("still waiting on it"), done()]]);
    session.attach(recordingClient());
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    const call = toolCall("Bash", "agent-1");
    let decided: "allow" | "deny" | undefined;
    void backgroundToolCall(call, false).then((r) => { decided = r.behavior; });
    // The background agent is live work, so the next turn's exit keeps its approval.
    fire(liveBackground("t1"));
    await waitFor(() => session.status === "waiting_approval");

    // Before the fix: "A tool approval is pending — approve or deny it before sending".
    await session.send("is this done?", AUTH);
    await waitFor(() => prompts(provider).length === 2);
    await waitFor(() => session.status === "waiting_approval");
    expect(decided).toBeUndefined();

    session.approve(call.event.approvalId, true, AUTH);
    await waitFor(() => decided !== undefined);
    expect(decided).toBe("allow");
    await waitFor(() => session.status === "idle");
  });
});

// ── 2. Turn exit ─────────────────────────────────────────────────────────────

describe("turn exit while background work is live", () => {
  it("keeps a background agent's pending approval, tool card and registration", async () => {
    const { session, provider, fire, backgroundToolCall } = makeSession([[text("working"), spawn("agent-1")]], { stall: true });
    const client = recordingClient();
    session.attach(client);
    void session.send("start a background agent", AUTH);
    await waitFor(() => session.toInfo().subagents?.length === 1);
    fire(liveBackground("t1"));

    const call = toolCall("Bash", "agent-1");
    let decided: "allow" | "deny" | undefined;
    void backgroundToolCall(call, true).then((r) => { decided = r.behavior; });
    await waitFor(() => toolMessage(client, call.event.approvalId) !== undefined);

    // The main agent finishes its turn while the background agent waits.
    provider.emitLive(done());
    await waitFor(() => provider.endTurnCount === 1);
    await tick();

    expect(decided).toBeUndefined(); // not auto-denied
    expect(session.status).toBe("waiting_approval"); // its bar stays up
    expect(session.toInfo().subagents?.length).toBe(1); // not swept / revoked
    const cancelled = client.received.some(
      (m) =>
        m.type === "session.message.delta" &&
        (m.toolStateUpdate as { phase?: string } | undefined)?.phase === "cancelled",
    );
    expect(cancelled).toBe(false);

    session.approve(call.event.approvalId, true, AUTH);
    await waitFor(() => decided === "allow");
    await waitFor(() => session.status === "idle");
  });

  it("still reconciles everything when no background work is live", async () => {
    const { session, provider, backgroundToolCall } = makeSession([[text("working"), spawn("agent-1")]], { stall: true });
    session.attach(recordingClient());
    void session.send("start a foreground agent", AUTH);
    await waitFor(() => session.toInfo().subagents?.length === 1);

    const call = toolCall("Bash", "agent-1");
    let decided: "allow" | "deny" | undefined;
    void backgroundToolCall(call, true).then((r) => { decided = r.behavior; });
    await waitFor(() => session.status === "waiting_approval");

    provider.emitLive(done());
    await waitFor(() => decided !== undefined);
    // A foreground sub-agent cannot outlive its turn: stale, denied, swept.
    expect(decided).toBe("deny");
    await waitFor(() => session.status === "idle");
    expect(session.toInfo().subagents ?? []).toHaveLength(0);
  });

  it("reconciles the background agent's leftovers once the background set drains", async () => {
    const { session, provider, fire, backgroundToolCall } = makeSession([[text("working"), spawn("agent-1")]], { stall: true });
    session.attach(recordingClient());
    void session.send("start a background agent", AUTH);
    await waitFor(() => session.toInfo().subagents?.length === 1);
    fire(liveBackground("t1"));

    const call = toolCall("Bash", "agent-1");
    let decided: "allow" | "deny" | undefined;
    void backgroundToolCall(call, true).then((r) => { decided = r.behavior; });
    await waitFor(() => session.status === "waiting_approval");
    provider.emitLive(done());
    await waitFor(() => provider.endTurnCount === 1);
    await tick();
    expect(session.toInfo().subagents?.length).toBe(1);

    // The provider reports the background set empty: whatever is still open
    // can never complete.
    fire(liveBackground());
    await waitFor(() => decided !== undefined);
    expect(decided).toBe("deny");
    await waitFor(() => session.status === "idle");
    expect(session.toInfo().subagents ?? []).toHaveLength(0);
  });
});

// ── 3. Turns the backend starts on its own ───────────────────────────────────
//
// Measured live against the real CLI (codeoid's own wake disabled): ~20s after
// the main turn ended, the CLI ran the main agent by itself to report the
// finished background task — thinking, reply, turn_done — and every event was
// dropped for want of an open turn. An approval inside such a turn is the
// "A tool approval is pending" nobody could see.

const assistantText = (client: { received: DaemonMessage[] }): string[] =>
  client.received
    .filter((m) => m.type === "session.message" && (m as SessionMessage).role === "assistant")
    .map((m) => (m as SessionMessage).content);

describe("a turn the backend starts on its own", () => {
  it("is consumed like a prompted turn: the reply renders and the session returns to idle", async () => {
    const { session, provider } = makeSession([[done()]], { continues: true });
    const client = recordingClient();
    session.attach(client);
    await session.send("start background work", AUTH);
    await waitFor(() => session.status === "idle");

    provider.startOwnTurn([text("The background agent printed BG-DONE."), done()]);
    await waitFor(() => assistantText(client).includes("The background agent printed BG-DONE."));
    await waitFor(() => session.status === "idle");
    // Said why a turn appeared with no prompt.
    const note = client.received.find(
      (m) => m.type === "session.message" && (m as SessionMessage).metadata?.event === "turn.adopted",
    );
    expect(note).toBeDefined();
  });

  it("renders an approval requested inside it, and the owner can answer", async () => {
    const { session, provider } = makeSession([[done()]], { continues: true });
    const client = recordingClient();
    session.attach(client);
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    const call = toolCall("Bash"); // the MAIN agent's tool call
    const push = provider.startOwnTurn([call.event]);
    let decided: "allow" | "deny" | undefined;
    void provider.capturedOpts.at(-1)!
      .canUseTool(call.event.toolId, call.event.approvalId, call.event.name, call.event.input)
      .then((r) => { decided = r.behavior; });
    await waitFor(() => session.status === "waiting_approval");
    expect(toolMessage(client, call.event.approvalId)?.tool?.name).toBe("Bash");

    session.approve(call.event.approvalId, true, AUTH);
    await waitFor(() => decided === "allow");
    push(done());
    await waitFor(() => session.status === "idle");
  });
});

describe("waking a backend that continues on its own", () => {
  it("does not inject a second turn when the backend starts its own", async () => {
    const { session, provider, fire } = makeSession([[done()]], { continues: true, fallbackMs: 150 });
    session.attach(recordingClient());
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    fire(settled("t1"));
    provider.startOwnTurn([text("reporting t1"), done()]);
    await waitFor(() => session.status === "idle");
    await new Promise((r) => setTimeout(r, 300)); // well past the fallback
    // Only the owner's prompt reached the backend — no duplicate wake.
    expect(prompts(provider)).toEqual(["go"]);
  });

  it("wakes the session itself if the backend never continues", async () => {
    const { session, provider, fire } = makeSession([[done()], [done()]], { continues: true, fallbackMs: 100 });
    session.attach(recordingClient());
    await session.send("go", AUTH);
    await waitFor(() => session.status === "idle");

    fire(settled("t1"));
    expect(prompts(provider)).toHaveLength(1); // not immediately
    await waitFor(() => prompts(provider).length === 2, 2000);
    expect(prompts(provider)[1]).toContain("task t1");
  });

  it("treats a result that settles mid-turn as delivered in that turn", async () => {
    const { session, provider, fire } = makeSession([[text("working")]], { continues: true, fallbackMs: 100, stall: true });
    session.attach(recordingClient());
    void session.send("go", AUTH);
    await waitFor(() => session.status === "thinking");

    fire(settled("t1")); // the backend injects it into this very turn
    provider.emitLive(done());
    await waitFor(() => session.status === "idle");
    await new Promise((r) => setTimeout(r, 300));
    expect(prompts(provider)).toEqual(["go"]);
  });

  it("joins a turn the backend started while the owner's message was on its way", async () => {
    // The race: the backend starts its own turn AFTER the send decided the
    // session was idle but BEFORE it started a turn. A before_turn hook is the
    // await in that window, so the stand-in starts the backend's turn there.
    let push: ((e: ProviderEvent) => boolean) | undefined;
    // The hook needs the provider, which exists only once the session does.
    const ref: { provider?: MockSessionProvider } = {};
    const hooks = {
      hasHooks: (event: string) => event === "before_turn",
      dispatchBeforeTurn: async () => {
        push = ref.provider!.startOwnTurn([text("reporting")]);
        await tick();
        return {};
      },
      emit: () => {},
    };
    const { session, provider } = makeSession([[done()]], { continues: true, midTurn: true, hooks });
    ref.provider = provider;
    session.attach(recordingClient());

    await session.send("is it done?", AUTH);
    // Joined the backend's turn — no competing runTurn that would close its queue.
    expect(prompts(provider)).toEqual([]);
    expect(provider.midTurnPushes.map((p) => p.content)).toEqual(["is it done?"]);
    // The push queried: one turn_done for it, one for the backend's own turn.
    push!(done());
    push!(done());
    await waitFor(() => session.status === "idle");
  });
});
