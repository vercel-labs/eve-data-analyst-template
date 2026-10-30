import type {
  SlackInteractionCard,
  SlackInteractionCardParts,
} from "eve/channels/slack";
import { beforeEach, expect, it } from "vitest";

import { installTestState, testState } from "../testing/state";
import { recordQueryEstimate, runSqlApprovalCard } from "./approval-card";

const controls: SlackInteractionCardParts = {
  controls: { blocks: [{ elements: [], type: "actions" }], text: "Approve" },
};
const card = (name = "run_sql"): SlackInteractionCard => ({
  audience: "private",
  destination: "thread",
  interaction: {
    call: {
      callId: "call-1",
      input: { purpose: "MRR", sql: "SELECT 1" },
      name,
    },
    interactionId: "interaction-1",
    request: { kind: "approval", prompt: "Approve?" },
    status: "open",
    stepIndex: 0,
    turnId: "turn-1",
  },
  // SAFETY: The renderer does not read the session view for this card shape.
  view: {} as SlackInteractionCard["view"],
});

beforeEach(() => {
  installTestState();
  testState.reset();
});

it("adds query details while preserving eve-owned interaction controls", () => {
  recordQueryEstimate("call-1", {
    askerSlackUserId: "U123",
    planRows: 3_100_000,
    sql: "SELECT 1",
    threshold: 1_000_000,
    totalCost: 2_400_000,
  });
  const result = runSqlApprovalCard.interactionCard?.(card(), () => controls);
  expect(result?.controls.blocks).toEqual(controls.controls.blocks);
  expect(JSON.stringify(result?.details)).toContain("Estimated cost 2.4M");
  expect(JSON.stringify(result?.details)).toContain("Only <@U123>");
});

it("leaves other tool cards unchanged", () => {
  const result = runSqlApprovalCard.interactionCard?.(
    card("post_slack_table"),
    () => controls
  );
  expect(result).toBe(controls);
});
