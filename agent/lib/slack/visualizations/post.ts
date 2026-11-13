import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";
import type { SlackApiResponse } from "eve/channels/slack";
import type { ToolContext } from "eve/tools";
import { z } from "zod";

import { queriesForTurn } from "../../analyst/query-log";
import {
  sqlAttachmentBlock,
  sqlAttachmentMrkdwn,
  sqlAttachmentPlainBlocks,
} from "../../analyst/sql-attachment";
import type { JsonObject } from "../../json";
import { requireEnv } from "../../utils/env";
import { isString } from "../../values";
import { recordVisualizationDelivery } from "./receipts";

/** Slack credentials, Web API calls, and delivery receipts, swappable in tests. */
export const visualizationDelivery = {
  credentials: connectSlackCredentials,
  record: recordVisualizationDelivery,
  request: callSlackApi,
};

/** The slice of eve's tool context a visualization reads. */
export type VisualizationContext = Pick<ToolContext, "channel" | "session">;

/* The Slack thread serving the session, from the channel's metadata. */
const slackThread = (
  ctx: VisualizationContext
): { channelId: string; ts: string } | null => {
  if (ctx.channel.kind !== "channel:slack") {
    return null;
  }
  const { channelId, threadTs } = ctx.channel.metadata;
  return isString(channelId) && channelId && isString(threadTs) && threadTs
    ? { channelId, ts: threadTs }
    : null;
};

const BLOCK_ERROR = /block/iu;

/* Rejections caused by the message's size, which a smaller SQL section wouldn't fix. */
const SIZE_ERRORS = new Set(["msg_blocks_too_long", "msg_blocks_too_many"]);

/** Slack's limit on blocks in one message. */
const MAX_BLOCKS = 50;

const failureCode = (result: SlackApiResponse) =>
  String(result.error ?? "unknown_error");

/* eve's Slack client throws for non-2xx replies and keeps Slack's JSON reply on `response`. */
const thrownErrorSchema = z.object({
  message: z.string(),
  response: z.unknown().optional(),
});
const slackReplySchema = z.object({ error: z.string() });

const thrownFailure = (
  error: z.infer<typeof thrownErrorSchema> | undefined
) => {
  if (!error) {
    return "Slack post failed";
  }
  const code = slackReplySchema.safeParse(error.response).data?.error;
  return code ? `${error.message} (${code})` : error.message;
};

/* One block post: the visualization, plus the SQL as a container, as plain blocks, or not at all. */
interface Attempt {
  blocks: JsonObject[];
  plainSql: boolean;
  showsSql: boolean;
}

/** Slack's limit on a message's text, kept clear of when adding SQL to a fallback. */
const MAX_MESSAGE_TEXT = 39_000;

/* Small delivery receipt shared by table and chart tools; no chart/table data is echoed. */
export const visualizationOutputSchema = z.object({
  channel: z.string().optional(),
  error: z.string().optional(),
  posted: z.boolean(),
  threadTs: z.string().optional(),
  usedTextFallback: z.boolean().optional(),
});

/**
 * Posts one visualization message to the Slack thread serving the session.
 *
 * @param ctx - The serving channel, whose metadata names the Slack thread, and the current turn used to record delivery.
 * @param message - Slack blocks and their readable text alternative, including any truncation notice.
 * @returns Delivery outcome, including whether Slack required the text fallback.
 * @remarks Adds the turn's folded "SQL query" section below the visualization,
 * and the same SQL to the text fallback when it fits. After a block rejection,
 * retries once with the SQL as plain blocks, unless the message was too large,
 * then once with the visualization alone, then once with text only.
 * When the delivered message can't show the SQL, posts it as a separate text
 * message, whose failure doesn't change the outcome. Thrown errors and other
 * rejections are not retried because delivery may be uncertain.
 * Records success or failure for final-reply suppression.
 */
export const postVisualization = async (
  ctx: VisualizationContext,
  message: { blocks: JsonObject[]; text: string }
): Promise<z.infer<typeof visualizationOutputSchema>> => {
  const turnId = ctx.session.turn.id;
  const queries = queriesForTurn(turnId);
  const attachment = sqlAttachmentBlock(queries);
  const plainSql = sqlAttachmentPlainBlocks(queries);
  const sqlText = sqlAttachmentMrkdwn(queries);
  const textHasSql = message.text.length + sqlText.length <= MAX_MESSAGE_TEXT;
  const text = textHasSql ? `${message.text}${sqlText}` : message.text;
  const thread = slackThread(ctx);
  if (!thread) {
    visualizationDelivery.record(turnId, false);
    return {
      error: "The current session has no Slack thread to post to.",
      posted: false,
    };
  }
  const delivered = {
    channel: thread.channelId,
    posted: true,
    threadTs: thread.ts,
  };
  try {
    const { botToken } = visualizationDelivery.credentials(
      requireEnv("SLACK_CONNECTOR", "slack/your-agent")
    );
    const post = (body: JsonObject) =>
      visualizationDelivery.request({
        body: {
          channel: thread.channelId,
          thread_ts: thread.ts,
          unfurl_links: false,
          ...body,
        },
        botToken,
        operation: "chat.postMessage",
      });
    /* Best effort: the visualization already posted, so a failure here is only logged. */
    const postSqlSeparately = async () => {
      if (!sqlText || sqlText.length > MAX_MESSAGE_TEXT) {
        return;
      }
      try {
        const result = await post({ text: sqlText.trimStart() });
        if (result.ok !== true) {
          console.warn(
            `Could not post the SQL query section: ${failureCode(result)}`
          );
        }
      } catch (error) {
        console.warn(
          `Could not post the SQL query section: ${thrownFailure(thrownErrorSchema.safeParse(error).data)}`
        );
      }
    };
    const attempts: Attempt[] = attachment
      ? [
          {
            blocks: [...message.blocks, attachment],
            plainSql: false,
            showsSql: true,
          },
          {
            blocks: [...message.blocks, ...plainSql],
            plainSql: true,
            showsSql: true,
          },
          { blocks: message.blocks, plainSql: false, showsSql: false },
        ].filter(
          (attempt) => attempt.blocks.length <= MAX_BLOCKS || !attempt.plainSql
        )
      : [{ blocks: message.blocks, plainSql: false, showsSql: true }];
    /* Each rejected post delivered nothing, so the next attempt can't duplicate it. */
    const postBlocks = async ([
      attempt,
      ...rest
    ]: readonly Attempt[]): Promise<z.infer<
      typeof visualizationOutputSchema
    > | null> => {
      if (!attempt) {
        return null;
      }
      const result = await post({ blocks: attempt.blocks, text });
      if (result.ok === true) {
        visualizationDelivery.record(turnId, true);
        if (!attempt.showsSql) {
          await postSqlSeparately();
        }
        return delivered;
      }
      const error = failureCode(result);
      if (!BLOCK_ERROR.test(error)) {
        visualizationDelivery.record(turnId, false);
        return { error, posted: false };
      }
      return await postBlocks(
        SIZE_ERRORS.has(error) ? rest.filter((next) => !next.plainSql) : rest
      );
    };
    const withBlocks = await postBlocks(attempts);
    if (withBlocks) {
      return withBlocks;
    }
    const textOnly = await post({ text });
    visualizationDelivery.record(turnId, textOnly.ok === true);
    if (textOnly.ok !== true) {
      return { error: failureCode(textOnly), posted: false };
    }
    if (!textHasSql) {
      await postSqlSeparately();
    }
    return { ...delivered, usedTextFallback: true };
  } catch (error) {
    visualizationDelivery.record(turnId, false);
    return {
      error: thrownFailure(thrownErrorSchema.safeParse(error).data),
      posted: false,
    };
  }
};
