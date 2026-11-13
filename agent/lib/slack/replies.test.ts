import type { SlackThread } from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import { beforeEach, expect, it, vi } from "vitest";

import { recordQuery } from "../analyst/query-log";
import { recordThreadRole } from "../analyst/thread-roles";
import { completeReply, rendererContext } from "../testing/renderer";
import { slackAuth } from "../testing/session";
import { installTestState, testState } from "../testing/state";
import { analystReplies, replyDelivery, THREAD_ROLE_NOTICE } from "./replies";
import { recordVisualizationDelivery } from "./visualizations/receipts";

const events = analystReplies.events ?? {};
const reply = (value = "Here is the result.", phase = "reply") =>
  completeReply(events, value, { phase });

beforeEach(() => {
  installTestState();
  testState.reset();
});

it("suppresses duplicate prose after a successful visualization", async () => {
  recordVisualizationDelivery("turn-1", true);
  const { done, next } = reply();
  await done;
  expect(next).not.toHaveBeenCalled();
});

it("keeps the normal response after any failed visualization", async () => {
  recordVisualizationDelivery("turn-1", true);
  recordVisualizationDelivery("turn-1", false);
  const { done, next } = reply();
  await done;
  expect(next).toHaveBeenCalledOnce();
});

it("does not suppress later turns", async () => {
  recordVisualizationDelivery("older-turn", true);
  const { done, next } = reply();
  await done;
  expect(next).toHaveBeenCalledOnce();
});

it("leaves narration to eve", async () => {
  recordVisualizationDelivery("turn-1", true);
  recordQuery("turn-1", {
    purpose: "Checking",
    ranAt: "2026-10-10T09:14:00.000Z",
    sql: "SELECT 1",
    tables: [],
  });
  const deliver = vi.spyOn(replyDelivery, "post").mockResolvedValue();
  const { done, next } = reply("Checking the warehouse.", "narration");
  await done;
  expect(next).toHaveBeenCalledOnce();
  expect(deliver).not.toHaveBeenCalled();
});

const query = {
  purpose: "MRR at the end of September",
  ranAt: "2026-10-10T09:14:00.000Z",
  sql: "SELECT sum(mrr_cents) FROM subscriptions",
  tables: ["analytics.subscriptions", "analytics.customers"],
};

it("posts the reply with a folded SQL section when the turn ran queries", async () => {
  const deliver = vi.spyOn(replyDelivery, "post").mockResolvedValue();
  const context = rendererContext();
  recordQuery("turn-1", query);
  const { done, next } = completeReply(events, "Here is the result.", {
    context,
  });
  await done;
  expect(next).not.toHaveBeenCalled();
  expect(deliver).toHaveBeenCalledExactlyOnceWith(context.ctx.channel, {
    blocks: [
      { text: "Here is the result.", type: "markdown" },
      expect.objectContaining({ default_collapsed: true, type: "container" }),
    ],
    markdown: expect.stringContaining(
      "```sql\nSELECT sum(mrr_cents) FROM subscriptions\n```"
    ),
    text: "Here is the result.",
  });
});

it("leaves replies without queries to eve's default", async () => {
  const deliver = vi.spyOn(replyDelivery, "post").mockResolvedValue();
  recordQuery("older-turn", query);
  const { done, next } = reply();
  await done;
  expect(next).toHaveBeenCalledOnce();
  expect(deliver).not.toHaveBeenCalled();
});

it("lets delivery failures reach eve's notice instead of posting twice", async () => {
  vi.spyOn(replyDelivery, "post").mockRejectedValue(new Error("invalid_auth"));
  recordQuery("turn-1", query);
  const { done, next } = reply();
  await expect(done).rejects.toThrow("invalid_auth");
  expect(next).not.toHaveBeenCalled();
});

const turnSettled = events["turn.settled"];
if (!turnSettled) {
  throw new Error("Expected a turn.settled handler.");
}

const alice = slackAuth({ userId: "U0ALICE" });

/* Records results fetched as Alice's own role, so the default-role caller conflicts. */
const holdFinanceResults = () => {
  vi.stubEnv("ANALYST_DATABASE_URL", "postgres://db/app");
  vi.stubEnv(
    "ANALYST_ROLE_MAP",
    JSON.stringify({ U0ALICE: "analyst_finance" })
  );
  recordThreadRole(alice);
};

/* Runs the turn-settled renderer for a turn, observing posts and the rest of the chain. */
const settleTurn = (
  turnId: string,
  {
    current = slackAuth(),
    outcome = "cancelled",
    post,
  }: {
    current?: SessionAuthContext;
    outcome?: "cancelled" | "completed" | "failed";
    post?: SlackThread["post"];
  } = {}
) => {
  const context = rendererContext({ current, post });
  const next = vi.fn(() => Promise.resolve());
  const run = Promise.resolve(
    turnSettled(
      { data: { outcome, turnId }, scope: { turnId }, type: "turn.settled" },
      context.ctx,
      next
    )
  );
  return { next, post: context.post, run };
};

it("posts the start-a-new-thread notice when the caller's role conflicts", async () => {
  holdFinanceResults();
  const { next, post, run } = settleTurn("turn-2");
  await run;
  expect(post).toHaveBeenCalledExactlyOnceWith(THREAD_ROLE_NOTICE);
  expect(next).toHaveBeenCalledOnce();
});

it.each([
  ["cancelled turns of the same role", { current: alice }],
  ["turns that weren't cancelled", { outcome: "completed" as const }],
])("leaves %s to eve's default", async (_name, options) => {
  holdFinanceResults();
  const { next, post, run } = settleTurn("turn-3", options);
  await run;
  expect(post).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
});

it("still runs eve's default when the notice fails to post", async () => {
  holdFinanceResults();
  const { next, run } = settleTurn("turn-2", {
    post: () => Promise.reject(new Error("invalid_auth")),
  });
  await expect(run).rejects.toThrow("invalid_auth");
  expect(next).toHaveBeenCalledOnce();
});

it("posts the notice once when eve replays the cancellation", async () => {
  holdFinanceResults();
  const first = settleTurn("turn-2");
  await first.run;
  const replay = settleTurn("turn-2");
  await replay.run;
  expect(first.post).toHaveBeenCalledOnce();
  expect(replay.post).not.toHaveBeenCalled();
  expect(replay.next).toHaveBeenCalledOnce();
});

it("keeps no receipt when Slack doesn't confirm the notice", async () => {
  holdFinanceResults();
  const refused = settleTurn("turn-2", {
    post: () =>
      Promise.resolve({ id: "", raw: { error: "invalid_auth", ok: false } }),
  });
  await expect(refused.run).rejects.toThrow("thread role notice");
  expect(refused.next).toHaveBeenCalledOnce();
  const thrown = settleTurn("turn-2", {
    post: () => Promise.reject(new Error("socket hang up")),
  });
  await expect(thrown.run).rejects.toThrow("socket hang up");
  const retry = settleTurn("turn-2");
  await retry.run;
  expect(retry.post).toHaveBeenCalledExactlyOnceWith(THREAD_ROLE_NOTICE);
});
