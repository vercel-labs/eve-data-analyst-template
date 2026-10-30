import type {
  SlackInteractionCard,
  SlackInteractionCardParts,
} from "eve/channels/slack";
import { emptySessionView } from "eve/events";
import { beforeEach, expect, it } from "vitest";

import { installTestState, testState } from "../testing/state";
import { recordQueryEstimate, runSqlApprovalCard } from "./approval-card";

const controls: SlackInteractionCardParts = {
  controls: {
    blocks: [
      {
        actions: [
          {
            action_id: "eve_input:tool-approval:interaction-1:button:0",
            text: { emoji: false, text: "Approve", type: "plain_text" },
            type: "button",
            value: "approve",
          },
          {
            action_id: "eve_input:tool-approval:interaction-1:button:1",
            text: { emoji: false, text: "Deny", type: "plain_text" },
            type: "button",
            value: "deny",
          },
        ],
        type: "card",
      },
    ],
    text: "Approve",
  },
};
const card = (name = "run_sql", callId = "call-1"): SlackInteractionCard => ({
  audience: "private",
  destination: "thread",
  interaction: {
    call: {
      callId,
      input: { purpose: "MRR", sql: "SELECT 1" },
      name,
    },
    interactionId: "interaction-1",
    request: { kind: "approval", prompt: "Approve?" },
    status: "open",
    stepIndex: 0,
    turnId: "turn-1",
  },
  view: emptySessionView(),
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
  expect(JSON.stringify(result?.controls.blocks)).toContain('"Run query"');
  expect(JSON.stringify(result?.controls.blocks)).toContain('"Cancel"');
  expect(JSON.stringify(result?.controls.blocks)).toContain(
    '"eve_input:tool-approval:interaction-1:button:0"'
  );
  expect(JSON.stringify(result?.details)).toContain("Estimated cost 2.4M");
  expect(JSON.stringify(result?.details)).toContain("Only <@U123>");
});

it("does not show an estimate saved for different SQL", () => {
  recordQueryEstimate("call-1", {
    askerSlackUserId: "U123",
    planRows: 1,
    sql: "SELECT 2",
    threshold: 1,
    totalCost: 2,
  });
  const result = runSqlApprovalCard.interactionCard?.(card(), () => controls);
  expect(JSON.stringify(result?.details)).toContain(
    "estimated cost needs approval"
  );
  expect(JSON.stringify(result?.details)).not.toContain("Only <@U123>");
});

it("truncates long SQL and escapes fallback mrkdwn", () => {
  const initial = card();
  const { call } = initial.interaction;
  if (!call) {
    throw new Error("Expected an approval call.");
  }
  const result = runSqlApprovalCard.interactionCard?.(
    {
      ...initial,
      interaction: {
        ...initial.interaction,
        call: {
          ...call,
          input: {
            purpose: "Ops",
            sql: `SELECT '<b>' WHERE n >= 1 AND tags @> '{x}' AND q = 'A&B' ${"x".repeat(2500)}`,
          },
        },
      },
    },
    () => controls
  );
  const details = JSON.stringify(result?.details);
  expect(details).toContain("… [truncated]");
  expect(result?.details?.text).toContain("&lt;b&gt;");
  expect(result?.details?.text).toContain("&gt;=");
  expect(result?.details?.text).toContain("@&gt;");
  expect(result?.details?.text).toContain("A&amp;B");
});

it("keeps only the newest 50 estimates", () => {
  for (let index = 0; index <= 50; index += 1) {
    recordQueryEstimate(`call-${index}`, {
      askerSlackUserId: null,
      planRows: 1,
      sql: "SELECT 1",
      threshold: 1,
      totalCost: 2,
    });
  }
  expect(
    JSON.stringify(
      runSqlApprovalCard.interactionCard?.(
        card("run_sql", "call-50"),
        () => controls
      )?.details
    )
  ).toContain("Estimated cost");
  expect(
    JSON.stringify(
      runSqlApprovalCard.interactionCard?.(
        card("run_sql", "call-0"),
        () => controls
      )?.details
    )
  ).toContain("estimated cost needs approval");
});

it("leaves other tool cards unchanged", () => {
  const result = runSqlApprovalCard.interactionCard?.(
    card("post_slack_table"),
    () => controls
  );
  expect(result).toBe(controls);
});
