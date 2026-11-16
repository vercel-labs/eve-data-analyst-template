import { connectSlackCredentials } from "@vercel/connect/eve";
import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import type {
  SlackChannelConfig,
  SlackInboundMessageContext,
  SlackInboundResult,
  SlackMessage,
} from "eve/channels/slack";

import { requireEnv } from "../../utils/env";
import { isString } from "../../values";
import {
  createSlackIdentityResolver,
  formatSlackIdentityContext,
} from "./identity";
import { replyEvents } from "./replies";

/**
 * Native Slack channel settings with shared identity and reply behavior.
 */
export type CreateSlackChannelConfig = SlackChannelConfig & {
  /**
   * Continue un-mentioned messages in active, single-author threads.
   *
   * @defaultValue true
   */
  autoReply?: boolean;
  /** Channels whose new human-authored top-level posts should start an agent reply without a mention. */
  autoReplyChannelIds?: readonly string[];
};

type InboundHandlers = Pick<
  SlackChannelConfig,
  "onAppMention" | "onDirectMessage" | "onMessage"
>;

const BOT_ID = /^B[A-Z0-9]+$/u;

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

/**
 * Starts a turn for a mention or DM using eve's Slack identity.
 *
 * @param ctx - Verified inbound webhook context supplied by eve.
 * @param message - Slack message carrying user, workspace, channel, and thread identifiers.
 * @returns eve's authenticated Slack principal, or null to drop the message.
 * @remarks Other bots are accepted with a `service` principal, which can't query the warehouse unless ANALYST_ROLE_MAP lists it and can't approve queries. Bots with a Slack user get eve's principal, and bot posts without one, such as Slack Workflow messages, get a per-bot principal from their bot ID. The agent's own messages and other authorless messages are dropped, so no message falls back to a shared principal.
 */
export const handleExplicitInvocation = (
  ctx: SlackInboundMessageContext,
  message: SlackMessage
): SlackInboundResult => {
  if (message.author?.isMe) {
    return null;
  }
  const auth = defaultSlackAuth(message, ctx) ?? botPostAuth(ctx, message);
  return auth ? { auth } : null;
};

const autoReplyToSoleParticipant = async (
  ctx: SlackInboundMessageContext,
  message: SlackMessage
): Promise<SlackInboundResult> => {
  if (message.author?.isMe) {
    return null;
  }
  // A mention delivered as a plain message event is an explicit invocation,
  // including from other bots such as Slack Workflows.
  if (ctx.isBotMentioned()) {
    return handleExplicitInvocation(ctx, message);
  }
  // Unmentioned follow-ups come only from humans in an active thread.
  if (!message.author || message.author.isBot || !(await ctx.isSubscribed())) {
    return null;
  }

  const participants = await ctx.thread.listParticipants().catch(() => []);
  const auth = defaultSlackAuth(message, ctx);
  return auth &&
    participants.length === 1 &&
    participants[0] === message.author.userId
    ? { auth }
    : null;
};

/**
 * Chooses the mention, DM, and message handlers while preserving eve's handler precedence.
 *
 * @param handlers - Caller-supplied handlers, any of which may be omitted.
 * @param autoReply - Whether the default message handler continues single-author threads.
 * @returns The handlers to register before routing and identity enrichment.
 * @remarks eve sends mentions and DMs to `onAppMention` and `onDirectMessage` before `onMessage`. They default to {@link handleExplicitInvocation} only when the caller supplies no `onMessage`, so a custom `onMessage` also receives mentions and DMs.
 */
export const selectInboundHandlers = (
  { onAppMention, onDirectMessage, onMessage }: InboundHandlers,
  autoReply: boolean
): InboundHandlers => {
  const fallback = onMessage ? undefined : handleExplicitInvocation;
  return {
    onAppMention: onAppMention ?? fallback,
    onDirectMessage: onDirectMessage ?? fallback,
    onMessage:
      onMessage ?? (autoReply ? autoReplyToSoleParticipant : undefined),
  };
};

const isAutoReplyChannelPost = (
  ctx: SlackInboundMessageContext,
  message: SlackMessage,
  channelIds: readonly string[]
): boolean =>
  channelIds.includes(message.channelId) &&
  message.threadTs === message.ts &&
  !!message.author &&
  !message.author.isBot &&
  !message.author.isMe &&
  (message.raw.subtype === undefined || message.raw.subtype === "file_share") &&
  !ctx.isBotMentioned();

const routeMessage = async (
  ctx: SlackInboundMessageContext,
  message: SlackMessage,
  handler: SlackChannelConfig["onMessage"],
  channelIds: readonly string[]
): Promise<SlackInboundResult> => {
  if (isAutoReplyChannelPost(ctx, message, channelIds)) {
    return (await ctx.isSubscribed())
      ? null
      : handleExplicitInvocation(ctx, message);
  }
  return handler?.(ctx, message) ?? null;
};

/**
 * Drops a person's edit to a message the agent already received.
 *
 * @returns Null, which tells eve to ignore the edit.
 * @remarks eve otherwise runs an edit through the mention, DM, and message hooks, and an edit that arrives after the reply starts a new turn. The analyst answers each question once, so edits stay out unless a caller passes its own `onMessageEdited`.
 */
const ignoreMessageEdits: NonNullable<
  SlackChannelConfig["onMessageEdited"]
> = () => null;

/** Inbound routing settings shared by {@link createSlackChannel} and its tests. */
export type SlackInboundRoutingConfig = Pick<
  CreateSlackChannelConfig,
  | "autoReply"
  | "autoReplyChannelIds"
  | "onAppMention"
  | "onDirectMessage"
  | "onMessage"
  | "onMessageEdited"
  | "threadContext"
>;

/**
 * Builds the mention, DM, message, and message-edit hooks registered with eve's Slack channel.
 *
 * @param config - Caller handlers, automatic-reply settings, and the thread history used for profile lookups.
 * @returns Hooks that route each message and append Slack profile context to accepted turns. A hook is undefined when eve should fall back to `onMessage` or ignore the event. The edit hook drops every edit unless the caller supplies one.
 */
export const createSlackInboundHandlers = ({
  autoReply = true,
  autoReplyChannelIds = [],
  onAppMention,
  onDirectMessage,
  onMessage,
  onMessageEdited = ignoreMessageEdits,
  threadContext,
}: SlackInboundRoutingConfig): InboundHandlers &
  Pick<SlackChannelConfig, "onMessageEdited"> => {
  const handlers = selectInboundHandlers(
    { onAppMention, onDirectMessage, onMessage },
    autoReply
  );
  const resolveSlackIdentities = createSlackIdentityResolver(threadContext);

  const createInboundHandler = (
    handler: SlackChannelConfig["onMessage"],
    channelIds: readonly string[] = []
  ): SlackChannelConfig["onMessage"] => {
    if (!handler && channelIds.length === 0) {
      return undefined;
    }
    return async (ctx, message) => {
      const result = await routeMessage(ctx, message, handler, channelIds);
      if (!result) {
        return null;
      }
      const identities = await resolveSlackIdentities(ctx, message);
      const identityContext = formatSlackIdentityContext(message, identities);
      return identityContext
        ? { ...result, context: [...(result.context ?? []), identityContext] }
        : result;
    };
  };

  return {
    onAppMention: createInboundHandler(handlers.onAppMention),
    onDirectMessage: createInboundHandler(handlers.onDirectMessage),
    onMessage: createInboundHandler(handlers.onMessage, autoReplyChannelIds),
    onMessageEdited,
  };
};

/**
 * Builds the settings passed to eve's Slack channel.
 *
 * @param config - Native channel overrides, including renderers such as the run_sql approval card.
 * @returns eve channel settings with authenticated inbound routing, credentials, and the shared reply renderer last.
 * @throws {@link Error} When SLACK_CONNECTOR is missing and the caller passes no credentials.
 * @remarks Credentials come from the Vercel Connect connector that SLACK_CONNECTOR names, unless the caller passes its own. Caller renderers come first, so they wrap the shared reply rendering.
 */
export const slackChannelSettings = (
  config: CreateSlackChannelConfig = {}
): SlackChannelConfig => {
  const {
    autoReply,
    autoReplyChannelIds,
    onMessage,
    onAppMention,
    onDirectMessage,
    onMessageEdited,
    threadContext = { since: "thread-root" },
    ...channelConfig
  } = config;

  return {
    ...channelConfig,
    ...createSlackInboundHandlers({
      autoReply,
      autoReplyChannelIds,
      onAppMention,
      onDirectMessage,
      onMessage,
      onMessageEdited,
      threadContext,
    }),
    credentials:
      channelConfig.credentials ??
      connectSlackCredentials(
        requireEnv("SLACK_CONNECTOR", "slack/your-agent")
      ),
    // Caller renderers stay outermost so they can wrap the shared rendering.
    renderers: [...(channelConfig.renderers ?? []), { events: replyEvents }],
    threadContext,
  };
};

/**
 * Creates the Slack channel using credentials from the configured Vercel Connect connector.
 *
 * @param config - Native channel overrides, including renderers such as the run_sql approval card.
 * @returns A channel definition with authenticated inbound routing and shared event renderers.
 * @throws {@link Error} When SLACK_CONNECTOR is missing and the caller passes no credentials.
 * @remarks Export this definition from agent/channels/slack.ts to retain the slack runtime name. Pass `credentials` only to run the channel without Vercel Connect, as the end-to-end tests do with a signing secret.
 */
export const createSlackChannel = (config: CreateSlackChannelConfig = {}) =>
  slackChannel(slackChannelSettings(config));
