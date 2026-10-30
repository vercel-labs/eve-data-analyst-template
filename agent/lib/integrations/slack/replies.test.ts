import { beforeEach, expect, it, vi } from "vitest";

import { recordQuery } from "../../analyst/query-log";
import { messageCompletedHarness } from "../../testing/slack";
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
