import { slackChannel } from "eve/channels/slack";

import { requireEnv } from "../../../../../agent/lib/utils/env";
import {
  SLACK_API_URL_ENV,
  SLACK_BOT_TOKEN,
  SLACK_DEFAULT_ROUTE,
  SLACK_SIGNING_SECRET,
} from "../../../support/protocol";

/**
 * A second Slack channel that keeps every eve default, on its own route.
 *
 * @remarks Exists only in the fixture, as the control for tests of what the production channel turns off. A webhook that starts a turn here and none on the production channel shows that the production channel dropped it, and that the test's payload is one eve acts on.
 */
export default slackChannel({
  api: {
    apiBaseUrl: requireEnv(SLACK_API_URL_ENV, "http://127.0.0.1:1234/api/"),
  },
  credentials: {
    botToken: SLACK_BOT_TOKEN,
    signingSecret: SLACK_SIGNING_SECRET,
  },
  route: SLACK_DEFAULT_ROUTE,
});
