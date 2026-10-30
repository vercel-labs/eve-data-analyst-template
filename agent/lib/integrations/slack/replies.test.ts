import { emptySessionView } from "eve/events";
import { beforeEach, expect, it, vi } from "vitest";

import { recordQuery } from "../../analyst/query-log";
import { recordThreadRole } from "../../analyst/thread-roles";
import { sessionContext, slackAuth } from "../../testing/session";
import {
  messageCompletedHarness,
  slackEventContext,
} from "../../testing/slack";
import { installTestState, testState } from "../../testing/state";
import { replyDelivery, replyEvents } from "./replies";
import { recordVisualizationDelivery } from "./visualizations/receipts";

beforeEach(() => {
  installTestState();
  testState.reset();
});

it("suppresses prose only after a successful visualization", async () => {
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordVisualizationDelivery("turn-1", true);
  await harness.complete();
  expect(harness.next).not.toHaveBeenCalled();
});

it("posts the v27 reply content with the successful query attachment", async () => {
  const post = vi.spyOn(replyDelivery, "post").mockResolvedValue();
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  recordQuery("turn-1", {
    purpose: "MRR",
    ranAt: "2026-10-10T00:00:00Z",
    sql: "SELECT 1",
    tables: [],
  });
  await harness.complete();
  expect(post).toHaveBeenCalledOnce();
  expect(harness.next).not.toHaveBeenCalled();
});

it("delegates replies without SQL to eve", async () => {
  const harness = messageCompletedHarness(replyEvents["content.completed"]);
  await harness.complete();
  expect(harness.next).toHaveBeenCalledOnce();
});

it("clears Slack status when a thread-role notice post fails", async () => {
  const settled = replyEvents["turn.settled"];
  if (!settled) {
    throw new Error("Expected a turn.settled renderer.");
  }
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({ U0ALICE: "analyst_finance" })
  );
  recordThreadRole(slackAuth({ userId: "U0ALICE" }));
  const next = vi.fn(() => Promise.resolve());
  await expect(
    settled(
      {
        data: { outcome: "cancelled", turnId: "turn-2" },
        type: "turn.settled",
      },
      {
        ...sessionContext({ current: slackAuth() }),
        channel: slackEventContext({
          thread: {
            post: vi.fn(() => Promise.reject(new Error("invalid_auth"))),
          },
        }),
        position: { index: 0, line: 0 },
        view: emptySessionView(),
      },
      next
    )
  ).rejects.toThrow("invalid_auth");
  expect(next).toHaveBeenCalledOnce();
});
