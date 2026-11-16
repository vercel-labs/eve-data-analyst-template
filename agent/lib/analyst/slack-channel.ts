/**
 * The analyst's settings for the shared Slack channel.
 *
 * @packageDocumentation
 */
import { runSqlApprovalCard } from "#lib/analyst/approval-card";
import type { CreateSlackChannelConfig } from "#lib/integrations/slack/channel";

/**
 * Builds the analyst's Slack channel settings.
 *
 * @param env - Environment variables to read; defaults to the process environment.
 * @returns The run_sql approval card renderer, and the channels from `SLACK_AUTO_REPLY_CHANNEL_IDS` where the agent answers every new post.
 * @remarks `agent/channels/slack.ts` passes these to `createSlackChannel`. Keeping them here lets tests check that the approval card is registered.
 */
export const analystSlackSettings = (
  env: NodeJS.ProcessEnv = process.env
): CreateSlackChannelConfig => ({
  autoReplyChannelIds: (env.SLACK_AUTO_REPLY_CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  renderers: [runSqlApprovalCard],
});
