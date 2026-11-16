import { postCompletedSlackReply } from "eve/channels/slack";
import type { SlackRendererEvents } from "eve/channels/slack";

import { queriesForTurn } from "../../analyst/query-log";
import {
  sqlAttachmentBlock,
  sqlAttachmentMarkdown,
} from "../../analyst/sql-attachment";
import { conflictsWithThreadRoles } from "../../analyst/thread-roles";
import { defineState } from "../../state";
import { isString, withRecentEntry } from "../../values";
import { visualizationReceipts } from "./visualizations/receipts";

/** Notice posted when the thread role guard cancels a turn. */
export const THREAD_ROLE_NOTICE =
  "This thread has answers fetched with someone else's data access. Start a new thread and I'll answer with yours.";

/** Most notice receipts kept; a session cancels one turn at a time. */
const MAX_TRACKED_NOTICES = 20;

/* Turns whose thread role notice Slack confirmed, so a repeated cancellation doesn't post it again. */
const noticeDeliveries = defineState<Record<string, string>>(
  "slack.thread-role-notice-deliveries",
  () => ({})
);

/** Final-reply delivery, swappable in tests. */
export const replyDelivery = { post: postCompletedSlackReply };

/**
 * Coordinate Slack replies after model messages and tool calls.
 *
 * @remarks eve's default renderer shows narration in the thread status and
 * posts ordinary replies. Successful table/chart delivery suppresses final
 * prose only if the turn has no failed visualization attempts. Later turns
 * retain ordinary replies. Delivery failures propagate rather than
 * triggering a potentially duplicate post.
 * When the turn ran SQL, the reply is posted with a folded "SQL query"
 * section listing the exact queries, through eve's delivery fallbacks.
 * When a turn is cancelled and its caller's role conflicts with the
 * thread's earlier results, the thread gets a notice asking that person to
 * start a new thread, since a cancelled turn otherwise posts nothing. The
 * conflict is checked here, because state the guard writes just before
 * cancelling isn't kept. A delivery receipt keeps the notice to one post per
 * turn if this handler ever runs twice for the same cancellation.
 */
export const replyEvents = {
  async "content.completed"(event, ctx, renderNext) {
    const { kind, phase, value } = event.data;
    const turnId = event.scope?.turnId;
    // Narration, reasoning, files, and structured results keep eve's rendering.
    if (phase !== "reply" || kind !== "text" || turnId === undefined) {
      await renderNext();
      return;
    }
    const receipt = visualizationReceipts.get();
    if (receipt?.turnId === turnId && receipt.posted && !receipt.failed) {
      return;
    }
    const queries = queriesForTurn(turnId);
    const attachment = sqlAttachmentBlock(queries);
    if (!(isString(value) && value && attachment)) {
      await renderNext();
      return;
    }
    await replyDelivery.post(ctx.channel, {
      blocks: [{ text: value, type: "markdown" }, attachment],
      markdown: `${value}${sqlAttachmentMarkdown(queries)}`,
      text: value,
    });
  },
  async "turn.settled"(event, ctx, renderNext) {
    if (event.data.outcome !== "cancelled") {
      await renderNext();
      return;
    }
    const { turnId } = event.data;
    try {
      if (
        conflictsWithThreadRoles(ctx.session.auth.current) &&
        !noticeDeliveries.get()[turnId]
      ) {
        const posted = await ctx.channel.thread.post(THREAD_ROLE_NOTICE);
        if (posted.raw.ok !== true || !posted.id) {
          throw new Error(
            "Could not confirm delivery of the thread role notice."
          );
        }
        noticeDeliveries.update((current) =>
          withRecentEntry(current, turnId, posted.id, MAX_TRACKED_NOTICES)
        );
      }
    } finally {
      // eve's default still clears the thread status when the notice fails.
      await renderNext();
    }
  },
} satisfies SlackRendererEvents;
