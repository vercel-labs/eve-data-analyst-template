/**
 * Slack approval card for expensive run_sql queries.
 *
 * @packageDocumentation
 */
import { ANSWER_ACTION_PREFIX, defineSlackRenderer } from "eve/channels/slack";
import type { BlockKitBlock } from "eve/channels/slack";
import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "eve/events";
import { z } from "zod";

import { escapeMrkdwn } from "#lib/slack-text";
import { defineState } from "#lib/state";
import { isObject, isString, withRecentEntry } from "#lib/values";

/** Longest SQL excerpt shown on the card. */
const MAX_CARD_SQL = 2500;

/** Most estimates kept; well above the approvals one turn can leave pending. */
const MAX_PENDING_ESTIMATES = 50;

/** Button labels for eve's approve and deny options. */
const BUTTON_LABELS = new Map([
  [APPROVE_OPTION_ID, "Run query"],
  [DENY_OPTION_ID, "Cancel"],
]);

/** Planner estimate recorded when a query needs approval. */
export interface QueryEstimate {
  readonly askerSlackUserId: string | null;
  readonly planRows: number;
  readonly sql: string;
  readonly threshold: number;
  readonly totalCost: number;
}

const estimates = defineState<Record<string, QueryEstimate>>(
  "analyst.query-estimates",
  () => ({})
);

/* The run_sql input fields the card shows; anything else falls back to defaults. */
const cardInputSchema = z.object({
  purpose: z.string().optional(),
  sql: z.string().optional(),
});

/**
 * Records the estimate shown on a pending approval card.
 *
 * @param callId - Tool call awaiting approval.
 * @param estimate - Planner estimate, threshold, exact SQL, and the asker's Slack user ID.
 * @remarks Keeps only the newest estimates. An older card shows a generic cost line instead.
 */
export const recordQueryEstimate = (
  callId: string,
  estimate: QueryEstimate
): void => {
  estimates.update((current) =>
    withRecentEntry(current, callId, estimate, MAX_PENDING_ESTIMATES)
  );
};

const compact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);

const excerpt = (sql: string) =>
  sql.length > MAX_CARD_SQL
    ? `${sql.slice(0, MAX_CARD_SQL)}\n… [truncated]`
    : sql;

const plain = (text: string) => ({
  emoji: false,
  text,
  type: "plain_text" as const,
});

const isBlock = (value: unknown): value is BlockKitBlock => isObject(value);

/* eve's own controls in its default card, wherever they're nested. */
const eveControls = (blocks: readonly unknown[]): BlockKitBlock[] =>
  blocks.filter(isBlock).flatMap((block): BlockKitBlock[] => {
    const actionId = block.action_id;
    if (isString(actionId) && actionId.startsWith(ANSWER_ACTION_PREFIX)) {
      return [block];
    }
    return Object.values(block).flatMap((value) =>
      Array.isArray(value) ? eveControls(value) : []
    );
  });

/**
 * Renders run_sql approvals with the query's purpose, cost estimate, SQL, and who may answer.
 *
 * @remarks Restyles only open, unanswered run_sql approvals. It keeps eve's buttons with their
 * action IDs and values, relabeled "Run query" and "Cancel". Answered and settled cards, other
 * requests, and cards whose controls aren't plain buttons use eve's default, which shows the
 * answer and who gave it.
 */
export const runSqlApprovalCard = defineSlackRenderer({
  interactionCard(card, renderDefault) {
    const parts = renderDefault(card);
    const { answer, call, request, status } = card.interaction;
    if (
      request.kind !== "approval" ||
      call?.name !== "run_sql" ||
      status !== "open" ||
      answer !== undefined
    ) {
      return parts;
    }
    const controls = eveControls(parts.controls.blocks);
    if (
      controls.length === 0 ||
      controls.some((control) => control.type !== "button")
    ) {
      return parts;
    }
    const input = cardInputSchema.safeParse(call.input).data;
    const sql = input?.sql ?? "";
    const purpose = input?.purpose || "Run a query";
    const saved = estimates.get()[call.callId];
    // Never show an estimate recorded for different SQL.
    const estimate = saved?.sql === sql ? saved : undefined;
    const details = estimate
      ? `Estimated cost ${compact(estimate.totalCost)} (approval needed above ${compact(estimate.threshold)}) · about ${compact(estimate.planRows)} rows`
      : "This query's estimated cost needs approval.";
    const who = estimate?.askerSlackUserId
      ? `Only <@${estimate.askerSlackUserId}> can run or cancel this query.`
      : "Only the person who asked can run or cancel this query.";
    const buttons = controls.map((button) => {
      const label = isString(button.value)
        ? BUTTON_LABELS.get(button.value)
        : undefined;
      return label ? { ...button, text: plain(label) } : button;
    });
    return {
      controls: {
        blocks: [
          { text: plain(`Approve query: ${purpose}`), type: "section" },
          {
            elements: [{ text: details, type: "plain_text" }],
            type: "context",
          },
          {
            elements: [
              {
                elements: [{ text: excerpt(sql), type: "text" }],
                type: "rich_text_preformatted",
              },
            ],
            type: "rich_text",
          },
          { elements: buttons, type: "actions" },
          { elements: [{ text: who, type: "mrkdwn" }], type: "context" },
        ],
        text: escapeMrkdwn(
          `Approve query: ${purpose}\n${details}\n${excerpt(sql)}`
        ),
      },
    };
  },
});
