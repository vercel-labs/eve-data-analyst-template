import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import type {
  SlackInboundMessageContext,
  SlackMessage,
} from "eve/channels/slack";

import { runSqlApprovalCard } from "#lib/analyst/approval-card";
import { analystReplies } from "#lib/slack/replies";
import { requireEnv } from "#lib/utils/env";
import { isString } from "#lib/values";

const THREAD_GUIDANCE =
  "You are part of this Slack thread, so you see replies that don't mention you. Answer only if " +
  "this reply is meant for you; otherwise call `no_reply`.";

const BOT_ID = /^B[A-Z0-9]+$/u;

/* Channels where every new top-level post from a person starts a reply, from SLACK_AUTO_REPLY_CHANNEL_IDS. */
const autoReplyChannelIds = new Set(
  (process.env.SLACK_AUTO_REPLY_CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

/**
 * Builds a per-bot service principal for a bot post that Slack delivers without a user, such as a Slack Workflow message.
 *
 * @param ctx - Verified inbound webhook context supplied by eve.
 * @param message - Authorless Slack message whose raw payload may carry a bot ID.
 * @returns A `service` principal keyed to the bot, or null when the message has an author or no valid bot ID.
 * @remarks Each bot gets its own principal, so authorless posts never share an identity. Service principals can't query the warehouse unless ANALYST_ROLE_MAP lists them, can't approve queries, and get no memory.
 */
const botPostAuth = (
  ctx: SlackInboundMessageContext,
  message: SlackMessage
) => {
  const botId = message.raw.bot_id;
  if (message.author || !isString(botId) || !BOT_ID.test(botId)) {
    return null;
  }
  const teamId = message.installationTeamId || message.teamId;
  const issuer = teamId ? `slack:${teamId}` : "slack";
  return {
    attributes: {
      author_type: "bot",
      bot_id: botId,
      channel_id: ctx.slack.channelId,
      thread_ts: ctx.slack.threadTs,
      ...(message.teamId && { team_id: message.teamId }),
    },
    authenticator: "slack-webhook",
    issuer,
    principalId: `${issuer}:bot:${botId}`,
    principalType: "service" as const,
  };
};

/* True when the sender is the only person who has posted in the thread. */
const isSoleParticipant = async (
  ctx: SlackInboundMessageContext,
  userId: string
) => {
  // A failed fetch returns an empty or stale list, which doesn't route.
  const participants = await ctx.thread.listParticipants();
  return participants.length === 1 && participants[0] === userId;
};

/* A new top-level post in a channel listed in SLACK_AUTO_REPLY_CHANNEL_IDS. */
const isAutoReplyPost = (message: SlackMessage) =>
  autoReplyChannelIds.has(message.channelId) &&
  message.threadTs === message.ts &&
  (message.raw.subtype === undefined || message.raw.subtype === "file_share");

/**
 * Connects the analyst to Slack with sender names, the run_sql approval card, and replies that carry SQL, tables, and charts.
 *
 * @remarks Mentions and DMs start a turn. Other bots, including Slack Workflows, can mention the agent and get a service principal. In a thread the agent already serves, replies from the only person in the thread reach the agent without a mention, and it calls `no_reply` when a reply isn't meant for it. SLACK_AUTO_REPLY_CHANNEL_IDS optionally answers every new top-level post from a person in selected channels.
 */
export default slackChannel({
  credentials: connectSlackCredentials(
    requireEnv("SLACK_CONNECTOR", "slack/your-agent")
  ),
  messageContext: { users: true },
  async onMessage(ctx, message) {
    const auth = defaultSlackAuth(message, ctx) ?? botPostAuth(ctx, message);
    if (!auth) {
      return null;
    }
    if (ctx.isBotMentioned() || message.raw.channel_type === "im") {
      return { auth };
    }
    // Messages without a mention only count from people.
    if (message.author?.isBot !== false) {
      return null;
    }
    // An edit only reaches a thread that has a session, including an edit to its first message.
    if (
      (ctx.edit ||
        (message.threadTs !== message.ts && (await ctx.isSubscribed()))) &&
      (await isSoleParticipant(ctx, message.author.userId))
    ) {
      return { auth, guidance: THREAD_GUIDANCE, status: "deferred" };
    }
    return !ctx.edit && isAutoReplyPost(message) ? { auth } : null;
  },
  renderers: [analystReplies, runSqlApprovalCard],
  threadContext: { since: "thread-root" },
});
