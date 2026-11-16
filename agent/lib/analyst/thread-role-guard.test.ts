import type { SessionAuthContext } from "eve/context";
import type { CallOutcome } from "eve/events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hookContext,
  sessionView,
  toolCallEvents,
  turnStartedEvent,
} from "../testing/events";
import { localDevAuth, slackAuth } from "../testing/session";
import { installTestState, testState } from "../testing/state";
import hook from "./thread-role-guard";

const callSettled = hook.events["call.settled"];
const turnStarted = hook.events["turn.started"];
if (!(callSettled && turnStarted)) {
  throw new Error("Expected call.settled and turn.started handlers.");
}

const alice = slackAuth({ userId: "U0ALICE" });
const bob = slackAuth({ userId: "U0BOB" });

interface CallOptions {
  name?: string;
  outcome?: CallOutcome;
}

/* Settles one tool call as `caller`, with the session view eve folds from the same events. */
const settleCall = async (
  caller: SessionAuthContext,
  options: CallOptions = {}
) => {
  const [requested, settled] = toolCallEvents(options);
  const { ctx } = hookContext({
    current: caller,
    view: sessionView([requested, settled]),
  });
  await callSettled(settled, ctx);
};

/* Runs one tool call as `caller`, then starts the next turn as `next`. */
const queryThenStart = async (
  caller: SessionAuthContext,
  next: SessionAuthContext,
  options: CallOptions = {}
) => {
  await settleCall(caller, options);
  const started = hookContext({ current: next });
  await turnStarted(turnStartedEvent(), started.ctx);
  return started.cancel;
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
    "records the caller's role after a completed %s",
    async (name) => {
      await settleCall(alice, { name });
      expect(testState.get("analyst.thread-roles")).toStrictEqual({
        roles: ["analyst_finance"],
      });
    }
  );

  it.each<[string, CallOptions]>([
    ["failed calls", { outcome: "failed" }],
    ["rejected calls", { outcome: "rejected" }],
    ["interrupted calls", { outcome: "interrupted" }],
    ["abandoned calls", { outcome: "abandoned" }],
    ["other tools", { name: "post_slack_table" }],
  ])("records nothing for %s", async (_name, options) => {
    await settleCall(alice, options);
    expect(testState.get("analyst.thread-roles")).toBeUndefined();
  });

  it("records nothing for a call the session view doesn't know", async () => {
    const [, settled] = toolCallEvents();
    await callSettled(settled, hookContext({ current: alice }).ctx);
    expect(testState.get("analyst.thread-roles")).toBeUndefined();
  });

  it("records nothing for a skill or agent call that shares a tool's name", async () => {
    const [requested, settled] = toolCallEvents();
    const skill = {
      ...requested,
      data: {
        ...requested.data,
        capability: { kind: "skill" as const, name: "run_sql" },
      },
    };
    const { ctx } = hookContext({
      current: alice,
      view: sessionView([skill, settled]),
    });
    await callSettled(settled, ctx);
    expect(testState.get("analyst.thread-roles")).toBeUndefined();
  });
});

describe("turn.started", () => {
  it("cancels a caller with a different role", async () => {
    const cancel = await queryThenStart(alice, bob);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      "The caller's database role differs from this thread's."
    );
  });

  it("lets the same caller continue", async () => {
    const cancel = await queryThenStart(alice, alice);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("lets anyone in when only failed queries ran", async () => {
    const cancel = await queryThenStart(alice, bob, { outcome: "failed" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("never cancels local development", async () => {
    const cancel = await queryThenStart(localDevAuth(), localDevAuth());
    expect(cancel).not.toHaveBeenCalled();
  });
});
