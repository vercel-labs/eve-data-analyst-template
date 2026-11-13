import { renderInteractionBlocks } from "eve/channels/slack";
import type {
  SlackInteractionCard,
  SlackInteractionCardParts,
} from "eve/channels/slack";
import { emptySessionView } from "eve/events";
import type { Interaction } from "eve/events";
import { beforeEach, describe, expect, it } from "vitest";

import { installTestState, testState } from "../testing/state";
import { recordQueryEstimate, runSqlApprovalCard } from "./approval-card";

const MRR_INPUT = { purpose: "MRR by plan", sql: "SELECT 1" };

const approval = (
  input: Record<string, string> = MRR_INPUT,
  {
    callId = "call-1",
    toolName = "run_sql",
  }: { callId?: string; toolName?: string } = {}
): Interaction => ({
  call: { callId, input, name: toolName },
  interactionId: "request-1",
  request: {
    kind: "approval",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny" },
    ],
    prompt: "Approve run_sql?",
  },
  status: "open",
  stepIndex: 0,
  turnId: "turn-1",
});

/* Action IDs and values of every control in `blocks`, in order. */
const actions = (blocks: readonly unknown[]) =>
  JSON.stringify(blocks).match(/"action_id":"[^"]+"|"value":"[^"]+"/gu);

/* eve's default card, as the rest of the renderer chain returns it. */
const next = (card: SlackInteractionCard): SlackInteractionCardParts => ({
  controls: {
    blocks: renderInteractionBlocks(card.interaction),
    text: "eve default",
  },
});

const render = (interaction: Interaction) => {
  const { interactionCard } = runSqlApprovalCard;
  if (!interactionCard) {
    throw new Error("Expected an interactionCard renderer.");
  }
  const parts = interactionCard(
    {
      audience: "public",
      destination: "thread",
      interaction,
      view: emptySessionView(),
    },
    next
  );
  return {
    ...parts.controls,
    details: parts.details,
    json: JSON.stringify(parts.controls.blocks),
  };
};

beforeEach(() => {
  installTestState();
  testState.reset();
});

describe("runSqlApprovalCard", () => {
  it.each<[string, Interaction]>([
    ["other tools", approval(undefined, { toolName: "post_slack_table" })],
    [
      "questions",
      { ...approval(), request: { ...approval().request, kind: "question" } },
    ],
    [
      "answered approvals",
      {
        ...approval(),
        answer: { interactionId: "request-1", optionId: "approve" },
      },
    ],
    [
      "settled approvals",
      { ...approval(), outcome: "declined", status: "settled" },
    ],
    [
      "approvals shown as a select",
      { ...approval(), request: { ...approval().request, display: "select" } },
    ],
  ])("leaves %s to eve's default", (_name, interaction) => {
    expect(render(interaction).text).toBe("eve default");
  });

  it("shows the estimate, SQL, eve's buttons, and who may answer", () => {
    recordQueryEstimate("call-1", {
      askerSlackUserId: "U123",
      planRows: 3_100_000,
      sql: "SELECT 1",
      threshold: 1_000_000,
      totalCost: 2_400_000,
    });
    const card = render(approval());
    expect(card.json).toContain("Approve query: MRR by plan");
    expect(card.json).toContain(
      "Estimated cost 2.4M (approval needed above 1M) · about 3.1M rows"
    );
    expect(card.json).toContain("SELECT 1");
    expect(card.json).toContain("Only <@U123> can run or cancel this query.");
    expect(card.json).toContain('"text":"Run query"');
    expect(card.json).toContain('"text":"Cancel"');
    expect(card.blocks.length).toBeLessThanOrEqual(50);
    expect(card.details).toBeUndefined();
  });

  it("keeps exactly eve's controls, with their action IDs and values", () => {
    const card = render(approval());
    expect(actions(card.blocks)).toStrictEqual(
      actions(renderInteractionBlocks(approval()))
    );
    expect(card.json).toContain('"action_id":"eve_input:');
  });

  it("never shows an estimate recorded for different SQL", () => {
    recordQueryEstimate("call-1", {
      askerSlackUserId: "U123",
      planRows: 1,
      sql: "SELECT 2",
      threshold: 1,
      totalCost: 2,
    });
    const card = render(approval());
    expect(card.json).toContain("estimated cost needs approval");
    expect(card.json).toContain("Only the person who asked");
  });

  it("truncates long SQL and escapes the fallback text", () => {
    const sql = `SELECT '<b>' AS x, ${"1 + ".repeat(1000)}1`;
    const card = render(approval({ purpose: "Big", sql }));
    expect(card.json).toContain("… [truncated]");
    expect(card.text).not.toMatch(/[<>]/u);
    expect(card.text).toContain("&lt;b&gt;");
  });

  it("escapes SQL operators as Slack entities in the fallback text", () => {
    const sql = "SELECT 1 WHERE a >= 1 AND tags @> '{x}' AND q = 'A&B'";
    const card = render(approval({ purpose: "Ops", sql }));
    expect(card.text).toContain("&gt;=");
    expect(card.text).toContain("@&gt;");
    expect(card.text).toContain("A&amp;B");
    expect(card.text).not.toMatch(/[‹›]/u);
  });

  it("keeps only the newest 50 estimates", () => {
    const sql = "SELECT 1";
    for (let index = 0; index <= 50; index += 1) {
      recordQueryEstimate(`call-${index}`, {
        askerSlackUserId: null,
        planRows: 1,
        sql,
        threshold: 1,
        totalCost: 2,
      });
    }
    const input = { purpose: "MRR", sql };
    expect(render(approval(input, { callId: "call-50" })).json).toContain(
      "Estimated cost"
    );
    expect(render(approval(input, { callId: "call-0" })).json).toContain(
      "estimated cost needs approval"
    );
  });
});
