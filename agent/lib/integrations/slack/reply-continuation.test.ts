import { emptySessionView, foldEvents } from "eve/events";
import type { HookContext, HookEvent } from "eve/hooks";
import { beforeEach, expect, it } from "vitest";

import { recordQuery, queriesForTurn } from "../../analyst/query-log";
import { sessionContext } from "../../testing/session";
import { installTestState, testState } from "../../testing/state";
import hook from "./reply-continuation";
import { visualizationReceipts } from "./visualizations/receipts";

const settled = hook.events?.["interaction.settled"];
const started = hook.events?.["turn.started"];
if (!(settled && started)) {
  throw new Error("Expected v27 interaction handlers.");
}
const meta = { position: { index: 0, line: 0 } };
const context = (kind: "budget" | "question"): HookContext => ({
  ...sessionContext(),
  agent: { name: "test" },
  cancel: () => {},
  channel: { kind: "channel:slack", metadata: {} },
  // SAFETY: These lifecycle fixtures exercise only state transfer, not hook services.
  memo: {} as HookContext["memo"],
  now: new Date(),
  // SAFETY: These lifecycle fixtures exercise only state transfer, not hook services.
  occurrence: {} as HookContext["occurrence"],
  position: meta.position,
  // SAFETY: These lifecycle fixtures exercise only state transfer, not hook services.
  turn: {} as HookContext["turn"],
  view: foldEvents(emptySessionView(), [
    {
      data: {
        interactionId: "limit-1",
        request: { kind, prompt: "Continue?" },
        subject: { turnId: "turn-1" },
      },
      meta: {
        at: "2026-10-10T00:00:00.000Z",
        endOfLine: true,
        position: { index: 0, line: 0 },
      },
      scope: { turnId: "turn-1" },
      type: "interaction.opened",
    },
    {
      data: {
        interactionId: "limit-1",
        outcome: "accepted",
        response: { optionId: "continue" },
      },
      meta: {
        at: "2026-10-10T00:01:00.000Z",
        endOfLine: true,
        position: { index: 0, line: 1 },
      },
      scope: { turnId: "turn-1" },
      type: "interaction.settled",
    },
  ]),
});
const continued = (): HookEvent<"interaction.settled"> => ({
  data: {
    interactionId: "limit-1",
    outcome: "accepted",
    response: { optionId: "continue" },
  },
  scope: { turnId: "turn-1" },
  type: "interaction.settled",
});
const nextTurn = (): HookEvent<"turn.started"> => ({
  data: {
    cause: { deliveryId: "delivery-1" },
    follows: "turn-1",
    turnId: "turn-2",
  },
  type: "turn.started",
});

beforeEach(() => {
  installTestState();
  testState.reset();
});

it("moves SQL and visualization ownership after a v27 budget continuation", async () => {
  visualizationReceipts.update(() => ({
    failed: false,
    posted: true,
    turnId: "turn-1",
  }));
  recordQuery("turn-1", {
    purpose: "MRR",
    ranAt: "2026-10-10T00:00:00Z",
    sql: "SELECT 1",
    tables: [],
  });
  await settled(continued(), context("budget"));
  await started(nextTurn(), context("budget"));
  expect(visualizationReceipts.get()?.turnId).toBe("turn-2");
  expect(queriesForTurn("turn-2")).toHaveLength(1);
});

it("keeps reply ownership when a question accepts a continue option", async () => {
  visualizationReceipts.update(() => ({
    failed: false,
    posted: true,
    turnId: "turn-1",
  }));
  recordQuery("turn-1", {
    purpose: "MRR",
    ranAt: "2026-10-10T00:00:00Z",
    sql: "SELECT 1",
    tables: [],
  });
  await settled(continued(), context("question"));
  await started(nextTurn(), context("question"));
  expect(visualizationReceipts.get()?.turnId).toBe("turn-1");
  expect(queriesForTurn("turn-1")).toHaveLength(1);
});
