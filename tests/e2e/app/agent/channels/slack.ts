import { analystSlackSettings } from "../../../../../agent/lib/analyst/slack-channel";
import { createSlackChannel } from "../../../../../agent/lib/integrations/slack/channel";
import { requireEnv } from "../../../../../agent/lib/utils/env";
import {
  SLACK_API_URL_ENV,
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
} from "../../../support/protocol";

/**
 * The production Slack channel, verifying webhooks with a static signing secret and calling the fake Slack Web API.
 *
 * @remarks Built as `agent/channels/slack.ts` builds it, from the same channel factory and the same settings, so the renderers and the auto-reply channels can't differ. Only the credentials and the API base URL are added, which production takes from Vercel Connect and Slack.
 */
export default createSlackChannel({
  ...analystSlackSettings(),
  api: {
    apiBaseUrl: requireEnv(SLACK_API_URL_ENV, "http://127.0.0.1:1234/api/"),
  },
  credentials: {
    botToken: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
  },
});
