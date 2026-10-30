import { postCompletedSlackReply } from "eve/channels/slack";
import type { SlackRendererEvents } from "eve/channels/slack";
import { z } from "zod";

import { queriesForTurn } from "../../analyst/query-log";
import {
  sqlAttachmentBlock,
  sqlAttachmentMarkdown,
} from "../../analyst/sql-attachment";
import { conflictsWithThreadRoles } from "../../analyst/thread-roles";
import { defineState } from "../../state";
import { withRecentEntry } from "../../values";
import { visualizationReceipts } from "./visualizations/receipts";

/** Notice posted when the thread role guard cancels a turn. */
export const THREAD_ROLE_NOTICE =
  "This thread has answers fetched with someone else's data access. Start a new thread and I'll answer with yours.";

/** Most notice receipts kept; a session cancels one turn at a time. */
const MAX_TRACKED_NOTICES = 20;

/* Turns whose thread role notice Slack confirmed, so a replayed cancellation doesn't post it again. */
const noticeDeliveries = defineState<Record<string, string>>(
  "slack.thread-role-notice-deliveries",
  () => ({})
);

/** Final-reply delivery, swappable in tests. */
export const replyDelivery = { post: postCompletedSlackReply };

/**
 * Coordinate Slack replies after model messages and tool calls.
 *
 * @remarks eve's default renderer buffers intermediate narration for typing
 * status and posts ordinary replies. Successful
 * table/chart delivery suppresses final prose only if the turn has no failed
 * visualization attempts. Later turns retain ordinary replies. Delivery
 * failures propagate rather than triggering a potentially duplicate post.
 * When the turn ran SQL, the reply is posted with a folded "SQL query"
 * section listing the exact queries, through eve's delivery fallbacks.
 * When a turn is cancelled and its caller's role conflicts with the
 * thread's earlier results, the thread gets a notice asking that person to
 * start a new thread, since a cancelled turn otherwise posts nothing. The
 * conflict is checked here, because state the guard writes just before
 * cancelling isn't kept. eve can emit a cancellation again when a durable
 * step retries, so a delivery receipt keeps the notice to one post per turn.
 */
export const replyEvents = {
  async "content.completed"(event, ctx, next) {
    const { kind, phase, value } = event.data;
    const text = z.string().safeParse(value);
    if (kind !== "text" || phase !== "reply" || !text.success) {
      return await next();
    }
    const receipt = visualizationReceipts.get();
    const turnId = event.scope?.turnId;
    if (
      !turnId ||
      (receipt?.turnId === turnId && receipt.posted && !receipt.failed)
    ) {
      return;
    }
    const queries = queriesForTurn(turnId);
    const attachment = sqlAttachmentBlock(queries);
    if (!attachment) {
      return await next();
    }
    await replyDelivery.post(ctx.channel, {
      blocks: [{ text: text.data, type: "markdown" }, attachment],
      markdown: `${text.data}${sqlAttachmentMarkdown(queries)}`,
      text: text.data,
    });
  },
  async "turn.settled"(event, ctx, next) {
    if (
      event.data.outcome === "cancelled" &&
      conflictsWithThreadRoles(ctx.session.auth.current) &&
      !noticeDeliveries.get()[event.data.turnId]
    ) {
      const posted = await ctx.channel.thread.post(THREAD_ROLE_NOTICE);
      if (posted.raw.ok !== true || !posted.id) {
        throw new Error(
          "Could not confirm delivery of the thread role notice."
        );
      }
      noticeDeliveries.update((current) =>
        withRecentEntry(
          current,
          event.data.turnId,
          posted.id,
          MAX_TRACKED_NOTICES
        )
      );
    }
    return next();
  },
} satisfies SlackRendererEvents;
