import { analystSlackSettings } from "../lib/analyst/slack-channel";
import { createSlackChannel } from "../lib/integrations/slack/channel";

/**
 * Connects the agent to Slack with identity context and the run_sql approval card.
 *
 * @remarks SLACK_AUTO_REPLY_CHANNEL_IDS optionally enables unsolicited top-level replies in selected channels.
 */
export default createSlackChannel(analystSlackSettings());
