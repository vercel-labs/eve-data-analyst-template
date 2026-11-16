import { localDev } from "eve/channels/auth";
import type { AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

import {
  SLACK_CHANNEL_ID,
  SLACK_USER_ID,
} from "../../../../../agent/lib/slack-ids";
import { slackAuth } from "../../../../../agent/lib/testing/session";
import {
  CHANNEL_HEADER,
  PRINCIPAL_HEADER,
  SLACK_TEAM_ID,
} from "../../../support/protocol";

/**
 * Lets a test call the HTTP channel as a Slack person.
 *
 * @param request - Inbound request, whose principal header names a Slack user ID and whose channel header may name the Slack channel they write in.
 * @returns The principal eve's Slack channel would build for that user, or null without the principal header, which leaves the request to `localDev()`.
 * @remarks Role resolution, the thread role guard, and the memory scopes read the Slack-shaped principal, so tests reach them without a Slack webhook. Never use this outside tests: the headers are not credentials.
 */
const slackPrincipal: AuthFn<Request> = (request) => {
  const userId = request.headers.get(PRINCIPAL_HEADER);
  if (userId === null || !SLACK_USER_ID.test(userId)) {
    return null;
  }
  const channelId = request.headers.get(CHANNEL_HEADER);
  return slackAuth({
    teamId: SLACK_TEAM_ID,
    userId,
    ...(channelId !== null &&
      SLACK_CHANNEL_ID.test(channelId) && { channelId }),
  });
};

/** The HTTP channel with production's `localDev()` caller and a header that selects a Slack person. */
export default eveChannel({
  auth: [slackPrincipal, localDev()],
});
