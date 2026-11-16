/**
 * Which Slack messages the production channel answers: mentions, direct messages, follow-ups from a thread's only participant, posts in auto-reply channels, and other apps' posts. Edits and other unmentioned messages are dropped.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from "vitest";

import {
  editMessage,
  eventsOf,
  eventsUntilSettled,
  mentionAgent,
  postedMessages,
  runSql,
  scripted,
  sendSlackEvent,
  slackCursor,
  slackTs,
  slackTurn,
  slackUntilIdle,
  writeMessage,
} from "./support/harness";
import type { SlackWriting } from "./support/harness";
import {
  SLACK_AUTO_REPLY_CHANNEL_ID,
  SLACK_BOT_USER_ID,
  SLACK_CHANNEL_ID,
  SLACK_DEFAULT_ROUTE,
  SLACK_TEAM_ID,
} from "./support/protocol";

const ASKER = "U0ADA";
const COUNT_PLANS = "SELECT count(*) AS plans FROM plans";

/* Sends one message and returns the messages the agent posted in its thread in response. */
const answersTo = async (
  send: (writing: SlackWriting) => Promise<void>,
  writing: SlackWriting
) => {
  const cursor = await slackCursor();
  await send(writing);
  return postedMessages(
    await slackUntilIdle(writing.threadTs ?? writing.ts, cursor)
  );
};

describe("an unmentioned message in a thread the agent answered", () => {
  it("is answered when its author is the thread's only participant", async () => {
    const threadTs = slackTs();
    const first = await answersTo(mentionAgent, {
      text: scripted("How many plans are there?", [
        { calls: [runSql("Count plans", COUNT_PLANS)] },
        { text: "There are 4 plans." },
      ]),
      ts: threadTs,
      user: ASKER,
    });
    expect(first).toMatchObject([{ body: { text: "There are 4 plans." } }]);

    const followUp = await answersTo(writeMessage, {
      text: scripted("Thanks. Which is the cheapest?", [
        { text: "The Free plan." },
      ]),
      threadTs,
      ts: slackTs(),
      user: ASKER,
    });

    // The follow-up ran no query, so its answer carries no query section from the first turn.
    expect(followUp.map((message) => message.body)).toStrictEqual([
      {
        channel: SLACK_CHANNEL_ID,
        markdown_text: "The Free plan.",
        thread_ts: threadTs,
        unfurl_links: "false",
        unfurl_media: "false",
      },
    ]);
  });

  it("is ignored once a second person has written in the thread", async () => {
    const threadTs = slackTs();
    await answersTo(mentionAgent, {
      text: scripted("Hello.", [{ text: "First answer." }]),
      ts: threadTs,
      user: ASKER,
    });
    const afterAnswer = await slackCursor();

    await writeMessage({
      text: scripted("Can I ask something too?", [
        { text: "To the colleague." },
      ]),
      threadTs,
      ts: slackTs(),
      user: "U0COLLEAGUE",
    });
    await writeMessage({
      text: scripted("Go ahead.", [{ text: "To the asker." }]),
      threadTs,
      ts: slackTs(),
      user: ASKER,
    });
    // A mention is still answered, and its turn is the thread's second.
    await mentionAgent({
      text: scripted("Are you there?", [{ text: "Yes." }]),
      threadTs,
      ts: slackTs(),
      user: ASKER,
    });
    const later = postedMessages(await slackUntilIdle(threadTs, afterAnswer));

    expect(later).toMatchObject([{ body: { markdown_text: "Yes." } }]);
    const events = await eventsUntilSettled(await slackTurn(threadTs, 1));
    expect(eventsOf(events, "turn.started")).toHaveLength(2);
    expect(
      eventsOf(events, "content.completed").map((event) => event.data.value)
    ).toStrictEqual(["First answer.", "Yes."]);
  });
});

describe("a message without a mention", () => {
  it("is answered in a direct message", async () => {
    const ts = slackTs();

    const answers = await answersTo(writeMessage, {
      channel: "D0E2EDM",
      text: scripted("How many plans are there?", [
        { calls: [runSql("Count plans", COUNT_PLANS)] },
        { text: "There are 4 plans." },
      ]),
      ts,
      user: ASKER,
    });

    expect(answers).toMatchObject([
      {
        body: {
          blocks: [
            { text: "There are 4 plans.", type: "markdown" },
            { title: { text: "SQL query" }, type: "container" },
          ],
          channel: "D0E2EDM",
          thread_ts: ts,
        },
      },
    ]);
    expect(await slackTurn(ts, 0)).toMatchObject({
      principalId: `slack:${SLACK_TEAM_ID}:${ASKER}`,
    });
  });

  it("is answered as a top-level post in an auto-reply channel", async () => {
    const answers = await answersTo(writeMessage, {
      channel: SLACK_AUTO_REPLY_CHANNEL_ID,
      text: scripted("How many plans are there?", [{ text: "Four." }]),
      ts: slackTs(),
      user: ASKER,
    });

    expect(answers).toMatchObject([
      {
        body: { channel: SLACK_AUTO_REPLY_CHANNEL_ID, markdown_text: "Four." },
      },
    ]);
  });

  it("is ignored as a top-level post in any other channel", async () => {
    const threadTs = slackTs();
    await writeMessage({
      text: scripted("How many plans are there?", [{ text: "Never posted." }]),
      ts: threadTs,
      user: ASKER,
    });

    // A mention in the same thread starts the thread's first turn, so the post started none.
    const answers = await answersTo(mentionAgent, {
      text: scripted("Can you answer that?", [{ text: "Four." }]),
      threadTs,
      ts: slackTs(),
      user: ASKER,
    });

    expect(answers).toMatchObject([{ body: { markdown_text: "Four." } }]);
    const events = await eventsUntilSettled(await slackTurn(threadTs, 0));
    expect(eventsOf(events, "turn.started")).toMatchObject([
      { data: { follows: null } },
    ]);
    expect(
      eventsOf(events, "content.completed").map((event) => event.data.value)
    ).toStrictEqual(["Four."]);
  });
});

describe("a mention posted by a Slack Workflow", () => {
  it("is answered as a service caller, which can't query the warehouse", async () => {
    const ts = slackTs();
    const cursor = await slackCursor();

    // A workflow's post has a bot ID and no Slack user.
    await sendSlackEvent({
      bot_id: "B0WORKFLOW",
      channel: SLACK_CHANNEL_ID,
      channel_type: "channel",
      event_ts: ts,
      subtype: "bot_message",
      text: `<@${SLACK_BOT_USER_ID}> ${scripted("Post the weekly numbers.", [
        { calls: [runSql("Count plans", COUNT_PLANS)] },
        { text: "I can't query the warehouse for a workflow." },
      ])}`,
      ts,
      type: "app_mention",
    });
    const answers = postedMessages(await slackUntilIdle(ts, cursor));

    expect(answers).toMatchObject([
      {
        body: { markdown_text: "I can't query the warehouse for a workflow." },
      },
    ]);
    const turn = await slackTurn(ts, 0);
    expect(turn.principalId).toBe(`slack:${SLACK_TEAM_ID}:bot:B0WORKFLOW`);
    const events = await eventsUntilSettled(turn);
    expect(eventsOf(events, "delivery.admitted")).toMatchObject([
      { data: { principal: { type: "service" } } },
    ]);
    expect(eventsOf(events, "call.settled")).toMatchObject([
      {
        data: {
          error: {
            message:
              "Bots, workflows, and service callers can't query the warehouse unless ANALYST_ROLE_MAP lists them.",
          },
          outcome: "rejected",
        },
      },
    ]);
  });
});

describe("an edit to a message the agent already answered", () => {
  const original = scripted("How many plans are there?", [
    { text: "First answer." },
  ]);
  const edited = scripted("How many plans do we sell?", [
    { text: "Answer to the edit." },
  ]);

  /* Mentions the agent, waits for its answer, then edits the mention. */
  const askThenEdit = async (route?: string) => {
    const threadTs = slackTs();
    const answered = await answersTo(mentionAgent, {
      route,
      text: original,
      ts: threadTs,
      user: ASKER,
    });
    expect(answered).toMatchObject([
      { body: { markdown_text: "First answer." } },
    ]);
    const afterAnswer = await slackCursor();
    await editMessage({
      previousText: original,
      route,
      text: edited,
      ts: threadTs,
      user: ASKER,
    });
    return { afterAnswer, threadTs };
  };

  it("starts a turn on a Slack channel with eve's defaults", async () => {
    // The control: it shows that eve acts on the webhook the next test sends.
    const { afterAnswer, threadTs } = await askThenEdit(SLACK_DEFAULT_ROUTE);

    const answers = postedMessages(await slackUntilIdle(threadTs, afterAnswer));

    expect(answers).toMatchObject([
      { body: { markdown_text: "Answer to the edit." } },
    ]);
  });

  it("is dropped by the production channel", async () => {
    const { afterAnswer, threadTs } = await askThenEdit();

    // The next mention starts the thread's second turn, so the edit started none.
    await mentionAgent({
      text: scripted("Are you there?", [{ text: "Yes." }]),
      threadTs,
      ts: slackTs(),
      user: ASKER,
    });
    const later = postedMessages(await slackUntilIdle(threadTs, afterAnswer));

    expect(later).toMatchObject([{ body: { markdown_text: "Yes." } }]);
    const events = await eventsUntilSettled(await slackTurn(threadTs, 1));
    expect(eventsOf(events, "turn.started")).toHaveLength(2);
    expect(
      eventsOf(events, "content.completed").map((event) => event.data.value)
    ).toStrictEqual(["First answer.", "Yes."]);
  });
});
