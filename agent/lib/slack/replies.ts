import {
  defineSlackRenderer,
  postCompletedSlackReply,
} from "eve/channels/slack";

import { queriesForTurn } from "../analyst/query-log";
import {
  sqlAttachmentBlock,
  sqlAttachmentMarkdown,
} from "../analyst/sql-attachment";
import { conflictsWithThreadRoles } from "../analyst/thread-roles";
import { defineState } from "../state";
import { isString, withRecentEntry } from "../values";
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
 * Coordinates the analyst's Slack replies with its tables, charts, SQL attachment, and thread role guard.
 *
 * @remarks Only the final reply text is handled here; narration and every other event go to eve's
 * default. Successful table or chart delivery suppresses the reply only if the turn has no failed
 * visualization attempts. Later turns keep ordinary replies. When the turn ran SQL, the reply is
 * posted through `postCompletedSlackReply` with a folded "SQL query" section listing the exact
 * queries, so eve's fallbacks still apply. Delivery failures propagate to eve's delivery notice
 * rather than triggering a possibly duplicate post.
 * When a turn is cancelled and its caller's role conflicts with the thread's earlier results, the
 * thread gets a notice asking that person to start a new thread, since a cancelled turn otherwise
 * posts nothing. The conflict is checked here, because state the guard writes just before
 * cancelling isn't kept. eve can emit a settlement again when a durable step retries, so a delivery
 * receipt keeps the notice to one post per turn.
 */
export const analystReplies = defineSlackRenderer({
  events: {
    async "content.completed"(event, ctx, renderNext) {
      const { kind, phase, value } = event.data;
      if (phase !== "reply" || kind !== "text" || !isString(value)) {
        await renderNext();
        return;
      }
      // The same turn ID the tools record their queries and visualizations under.
      const turnId = ctx.session.turn.id;
      const receipt = visualizationReceipts.get();
      if (receipt?.turnId === turnId && receipt.posted && !receipt.failed) {
        return;
      }
      const queries = queriesForTurn(turnId);
      const attachment = sqlAttachmentBlock(queries);
      if (!(value && attachment)) {
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
      const { outcome, turnId } = event.data;
      try {
        if (
          outcome === "cancelled" &&
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
  },
});
