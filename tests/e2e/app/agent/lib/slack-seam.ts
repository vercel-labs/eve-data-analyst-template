/**
 * Points the visualization tools' Slack calls at the fake Slack Web API.
 *
 * @remarks Production reads its bot token from Vercel Connect and posts to Slack. Importing this module replaces both operations on the `slackApi` seam, so `post_slack_chart` and `post_slack_table` run unchanged against the fake.
 * @packageDocumentation
 */
import { callSlackApi } from "eve/channels/slack";

import { slackApi } from "../../../../../agent/lib/integrations/slack/api";
import { requireEnv } from "../../../../../agent/lib/utils/env";
import { SLACK_API_URL_ENV, SLACK_BOT_TOKEN } from "../../../support/protocol";

slackApi.credentials = (connector) => ({
  botToken: SLACK_BOT_TOKEN,
  vercelConnect: { connector },
});
slackApi.request = (input) =>
  callSlackApi({
    ...input,
    api: {
      apiBaseUrl: requireEnv(SLACK_API_URL_ENV, "http://127.0.0.1:1234/api/"),
    },
  });
