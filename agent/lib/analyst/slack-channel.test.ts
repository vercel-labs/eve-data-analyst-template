import { describe, expect, it } from "vitest";

import { slackChannelSettings } from "../integrations/slack/channel";
import { replyEvents } from "../integrations/slack/replies";
import { runSqlApprovalCard } from "./approval-card";
import { analystSlackSettings } from "./slack-channel";

describe(analystSlackSettings, () => {
  it("registers the run_sql approval card", () => {
    expect(analystSlackSettings({}).renderers).toStrictEqual([
      runSqlApprovalCard,
    ]);
  });

  it("reads the auto-reply channels from a comma-separated list", () => {
    expect(
      analystSlackSettings({
        SLACK_AUTO_REPLY_CHANNEL_IDS: " C0123ABCD, ,C0456EFGH,",
      }).autoReplyChannelIds
    ).toStrictEqual(["C0123ABCD", "C0456EFGH"]);
    expect(analystSlackSettings({}).autoReplyChannelIds).toStrictEqual([]);
  });

  it("gives eve the approval card ahead of the reply renderer", () => {
    const settings = slackChannelSettings({
      ...analystSlackSettings({}),
      credentials: { botToken: "xoxb-test", signingSecret: "secret" },
    });
    // eve runs renderers outermost first, so the card and the SQL section both apply.
    expect(settings.renderers).toStrictEqual([
      runSqlApprovalCard,
      { events: replyEvents },
    ]);
  });
});
