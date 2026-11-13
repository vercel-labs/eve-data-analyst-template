import type { SessionAuthContext } from "eve/context";
import { emptySessionView, foldEvents } from "eve/events";
import type { HookContext, HookEvent } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hookContext, localDevAuth, slackAuth } from "../testing/session";
import { installTestState, testState } from "../testing/state";
import hook from "./thread-role-guard";

const callSettled = hook.events?.["call.settled"];
const turnStarted = hook.events?.["turn.started"];
if (!(callSettled && turnStarted)) {
  throw new Error("Expected call.settled and turn.started handlers.");
}

const alice = slackAuth({ userId: "U0ALICE" });
const bob = slackAuth({ userId: "U0BOB" });

interface CallOptions {
  kind?: "agent" | "tool";
  outcome?: HookEvent<"call.settled">["data"]["outcome"];
  toolName?: string;
}

/* Stream metadata on each recorded line. */
const meta = (line: number) => ({
  at: "2026-10-10T00:00:00.000Z",
  endOfLine: true,
  position: { index: 0, line },
});

/* One call in turn-1 that settled with `outcome`, and the session view that records it. */
const settledCall = ({
  kind = "tool",
  outcome = "completed",
  toolName = "run_sql",
}: CallOptions = {}) => {
  const settled = {
    data: { callId: "call-1", outcome, output: {} },
    scope: { turnId: "turn-1" },
    type: "call.settled",
  } satisfies HookEvent<"call.settled">;
  const view = foldEvents(emptySessionView(), [
    {
      data: {
        callId: "call-1",
        capability: { kind, name: toolName },
        input: {},
        owner: { turnId: "turn-1" },
      },
      meta: meta(0),
      scope: { turnId: "turn-1" },
      type: "call.requested",
    },
    { ...settled, meta: meta(1) },
  ]);
  return { settled, view };
};

/* Start of a later turn in the same session. */
const startedEvent = {
  data: {
    cause: { deliveryId: "delivery-2" },
    follows: "turn-1",
    turnId: "turn-2",
  },
  scope: { turnId: "turn-2" },
  type: "turn.started",
} satisfies HookEvent<"turn.started">;

/* Settles one call as `caller`, then starts the next turn as `next`. */
const callThenStart = async (
  caller: SessionAuthContext,
  next: SessionAuthContext,
  options: CallOptions = {}
) => {
  const { settled, view } = settledCall(options);
  await callSettled(settled, hookContext({ current: caller, view }));
  const cancel = vi.fn<HookContext["cancel"]>();
  await turnStarted(startedEvent, hookContext({ cancel, current: next }));
  return cancel;
};

beforeEach(() => {
  installTestState();
  testState.reset();
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({ U0ALICE: "analyst_finance" })
  );
});

describe("call.settled", () => {
  it.each(["run_sql", "describe_schema"])(
    "records the caller's role after a successful %s",
    async (toolName) => {
      const { settled, view } = settledCall({ toolName });
      await callSettled(settled, hookContext({ current: alice, view }));
      expect(testState.get("analyst.thread-roles")).toStrictEqual({
        roles: ["analyst_finance"],
      });
    }
  );

  it.each<[string, CallOptions]>([
    ["failed calls", { outcome: "failed" }],
    ["rejected calls", { outcome: "rejected" }],
    ["interrupted calls", { outcome: "interrupted" }],
    ["other tools", { toolName: "post_slack_table" }],
    ["agents named like a tool", { kind: "agent" }],
  ])("records nothing for %s", async (_name, options) => {
    const { settled, view } = settledCall(options);
    await callSettled(settled, hookContext({ current: alice, view }));
    expect(testState.get("analyst.thread-roles")).toBeUndefined();
  });
});

describe("turn.started", () => {
  it("cancels a caller with a different role", async () => {
    const cancel = await callThenStart(alice, bob);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("lets the same caller continue", async () => {
    const cancel = await callThenStart(alice, alice);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("lets anyone in when only failed queries ran", async () => {
    const cancel = await callThenStart(alice, bob, { outcome: "failed" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("never cancels local development", async () => {
    const cancel = await callThenStart(localDevAuth(), localDevAuth());
    expect(cancel).not.toHaveBeenCalled();
  });
});
