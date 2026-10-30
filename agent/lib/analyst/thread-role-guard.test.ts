import type { SessionAuthContext } from "eve/context";
import { emptySessionView, foldEvents } from "eve/events";
import type { HookContext, HookEvent } from "eve/hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { localDevAuth, sessionContext, slackAuth } from "../testing/session";
import { installTestState, testState } from "../testing/state";
import hook from "./thread-role-guard";

const callSettled = hook.events?.["call.settled"];
const turnStarted = hook.events?.["turn.started"];
if (!(callSettled && turnStarted)) {
  throw new Error("Expected v27 hook handlers.");
}

const alice = slackAuth({ userId: "U0ALICE" });
const bob = slackAuth({ userId: "U0BOB" });
const meta = { position: { index: 0, line: 0 } };
const view = foldEvents(emptySessionView(), [
  {
    data: {
      callId: "call-1",
      capability: { kind: "tool", name: "run_sql" },
      owner: { runId: "run-1" },
    },
    meta: {
      at: "2026-10-10T00:00:00.000Z",
      endOfLine: true,
      position: meta.position,
    },
    type: "call.requested",
  },
]);

const context = (current: SessionAuthContext) => {
  const cancel = vi.fn<HookContext["cancel"]>();
  const partial: Partial<HookContext> = {
    ...sessionContext({ current }),
    agent: { name: "test" },
    cancel,
    channel: { kind: "channel:slack", metadata: {} },
    position: meta.position,
    view,
  };
  return {
    cancel,
    // SAFETY: The handlers exercise only session auth, cancellation, and the valid folded view.
    ctx: partial as HookContext,
  };
};

const settled = (
  outcome: HookEvent<"call.settled">["data"]["outcome"] = "completed"
) =>
  ({
    data: { callId: "call-1", outcome },
    scope: { turnId: "turn-1" },
    type: "call.settled",
  }) satisfies HookEvent<"call.settled">;

const started = (): HookEvent<"turn.started"> => ({
  data: {
    cause: { deliveryId: "delivery-1" },
    follows: null,
    turnId: "turn-2",
  },
  type: "turn.started",
});

beforeEach(() => {
  installTestState();
  testState.reset();
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({ U0ALICE: "analyst_finance" })
  );
});

describe("v27 call.settled", () => {
  it("records a successful role-scoped tool call", async () => {
    await callSettled(settled(), context(alice).ctx);
    expect(testState.get("analyst.thread-roles")).toStrictEqual({
      roles: ["analyst_finance"],
    });
  });

  it("ignores failed calls", async () => {
    await callSettled(settled("failed"), context(alice).ctx);
    expect(testState.get("analyst.thread-roles")).toBeUndefined();
  });

  it("cancels a later caller with a different role", async () => {
    await callSettled(settled(), context(alice).ctx);
    const next = context(bob);
    await turnStarted(started(), next.ctx);
    expect(next.cancel).toHaveBeenCalledOnce();
  });

  it("keeps local development unblocked", async () => {
    const next = context(localDevAuth());
    await turnStarted(started(), next.ctx);
    expect(next.cancel).not.toHaveBeenCalled();
  });
});
