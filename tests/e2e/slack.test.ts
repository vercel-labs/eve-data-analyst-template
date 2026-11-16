/**
 * The Slack channel end to end: signed webhooks in, Web API calls out to a fake Slack.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from "vitest";

import { THREAD_ROLE_NOTICE } from "#lib/integrations/slack/replies";
import { FINANCE_USER } from "#tests/support/warehouse";

import {
  buttonsOf,
  clickButton,
  eventsOf,
  EXPENSIVE_QUERY,
  failSlack,
  mentionAgent,
  postedMessages,
  eventsUntil,
  eventsUntilSettled,
  runSql,
  scripted,
  slackCalls,
  slackCursor,
  slackTs,
  slackTurn,
  slackUntilIdle,
  streamViolations,
} from "./support/harness";
import {
  SLACK_CHANNEL_ID,
  SLACK_TEAM_ID,
  UPLOAD_METHOD,
} from "./support/protocol";
import type { SlackCall } from "./support/protocol";

const ASKER = "U0ADA";
const COUNT_PLANS = "SELECT count(*) AS plans FROM plans";

const countPlans = (label: string, reply: string) =>
  scripted(label, [
    { calls: [runSql("Count plans", COUNT_PLANS)] },
    { text: reply },
  ]);

/* The folded "SQL query" section for one query that read one table. */
const sqlSection = (sql: string, table: string) => ({
  child_blocks: [
    {
      elements: [
        {
          elements: [{ text: sql, type: "text" }],
          type: "rich_text_preformatted",
        },
      ],
      type: "rich_text",
    },
    {
      elements: [{ text: `DB tables: ${table}`, type: "mrkdwn" }],
      type: "context",
    },
    {
      elements: [
        {
          text: expect.stringMatching(
            /^Data as of <!date\^\d+\^\{date_long\} at \{time\}\|.+ UTC>$/u
          ),
          type: "mrkdwn",
        },
      ],
      type: "context",
    },
  ],
  default_collapsed: true,
  is_collapsible: true,
  title: { text: "SQL query", type: "plain_text" },
  type: "container",
});

/* The run_sql approval card's blocks above its buttons or its outcome line. */
const cardSummary = [
  {
    text: {
      emoji: false,
      text: "Approve query: Pair sessions",
      type: "plain_text",
    },
    type: "section",
  },
  {
    elements: [
      {
        text: expect.stringMatching(
          /^Estimated cost [\d.]+[KMBT] \(approval needed above 1M\) · about \d+ rows$/u
        ),
        type: "plain_text",
      },
    ],
    type: "context",
  },
  {
    elements: [
      {
        elements: [{ text: EXPENSIVE_QUERY, type: "text" }],
        type: "rich_text_preformatted",
      },
    ],
    type: "rich_text",
  },
];

/* Mentions the agent with a question whose query needs approval, and returns the card it posts. */
const askExpensiveQuestion = async (threadTs: string): Promise<SlackCall> => {
  const cursor = await slackCursor();
  await mentionAgent({
    text: scripted("How many session pairs are there?", [
      { calls: [runSql("Pair sessions", EXPENSIVE_QUERY)] },
      { text: "There are no pairs." },
    ]),
    ts: threadTs,
    user: ASKER,
  });
  const [card, ...others] = postedMessages(
    await slackUntilIdle(threadTs, cursor)
  );
  if (card === undefined) {
    throw new Error("Expected the agent to post an approval card.");
  }
  expect(others).toStrictEqual([]);
  return card;
};

describe("a mention in Slack", () => {
  it("is answered in the thread as the Slack person, with the query folded below the reply", async () => {
    const threadTs = slackTs();
    const cursor = await slackCursor();

    await mentionAgent({
      text: countPlans("How many plans are there?", "There are 4 plans."),
      ts: threadTs,
      user: ASKER,
    });
    const messages = postedMessages(await slackUntilIdle(threadTs, cursor));

    expect(messages.map((message) => message.body)).toStrictEqual([
      {
        blocks: [
          { text: "There are 4 plans.", type: "markdown" },
          sqlSection(COUNT_PLANS, "plans"),
        ],
        channel: SLACK_CHANNEL_ID,
        text: "There are 4 plans.",
        thread_ts: threadTs,
        unfurl_links: "false",
        unfurl_media: "false",
      },
    ]);
    const turn = await slackTurn(threadTs, 0);
    expect(turn).toMatchObject({
      channel: "channel:slack",
      principalId: `slack:${SLACK_TEAM_ID}:${ASKER}`,
    });
    const events = await eventsUntilSettled(turn);
    expect(eventsOf(events, "call.settled")).toMatchObject([
      { data: { outcome: "completed", output: { rows: [["4"]] } } },
    ]);
    expect(eventsOf(events, "turn.settled")).toMatchObject([
      { data: { outcome: "completed", turnId: turn.turnId } },
    ]);
    await expect(streamViolations(turn.sessionId)).resolves.toStrictEqual([]);
  });

  it("is answered without a query section when the turn ran no query", async () => {
    const threadTs = slackTs();
    const cursor = await slackCursor();

    await mentionAgent({
      text: scripted("Hello!", [{ text: "Hello. Ask me about the data." }]),
      ts: threadTs,
      user: ASKER,
    });
    const messages = postedMessages(await slackUntilIdle(threadTs, cursor));

    expect(messages.map((message) => message.body)).toStrictEqual([
      {
        channel: SLACK_CHANNEL_ID,
        markdown_text: "Hello. Ask me about the data.",
        thread_ts: threadTs,
        unfurl_links: "false",
        unfurl_media: "false",
      },
    ]);
  });

  it("repeats the query as Markdown when Slack rejects the reply's blocks", async () => {
    const threadTs = slackTs();
    const cursor = await slackCursor();
    await failSlack({
      error: "invalid_blocks",
      match: threadTs,
      method: "chat.postMessage",
      times: 1,
    });

    await mentionAgent({
      text: countPlans("How many plans are there?", "There are 4 plans."),
      ts: threadTs,
      user: ASKER,
    });
    const [rejected, delivered, ...others] = postedMessages(
      await slackUntilIdle(threadTs, cursor)
    );

    expect(rejected?.body.blocks).toStrictEqual([
      { text: "There are 4 plans.", type: "markdown" },
      sqlSection(COUNT_PLANS, "plans"),
    ]);
    expect(delivered?.body).toStrictEqual({
      channel: SLACK_CHANNEL_ID,
      markdown_text: expect.stringMatching(
        /^There are 4 plans\.\n\n\*\*SQL query\*\*\n\n```sql\nSELECT count\(\*\) AS plans FROM plans\n```\nDB tables: plans\n\nData as of .+ UTC$/u
      ),
      thread_ts: threadTs,
      unfurl_links: "false",
      unfurl_media: "false",
    });
    expect(others).toStrictEqual([]);
  });

  it("delivers an answer too long for a message as a file that still lists the query", async () => {
    const threadTs = slackTs();
    const cursor = await slackCursor();
    // 900 short lines are about twice what Slack accepts as Markdown in one message.
    const answer = Array.from(
      { length: 900 },
      (_, line) => `Line ${line + 1} of a long answer.`
    ).join("\n");

    await mentionAgent({
      text: scripted("List everything about the plans.", [
        { calls: [runSql("Count plans", COUNT_PLANS)] },
        { text: answer },
      ]),
      ts: threadTs,
      user: ASKER,
    });
    const calls = await slackUntilIdle(threadTs, cursor);

    // Slack rejects the oversized blocks, and eve falls back to uploading the Markdown.
    const [rejected, ...otherMessages] = postedMessages(calls);
    expect(rejected?.ts).toBeNull();
    expect(otherMessages).toStrictEqual([]);
    const completed = calls.filter(
      (call) => call.method === "files.completeUploadExternal"
    );
    expect(completed).toMatchObject([
      { body: { channel_id: SLACK_CHANNEL_ID, thread_ts: threadTs } },
    ]);
    const uploads = await slackCalls(cursor);
    const [upload, ...otherUploads] = uploads.filter(
      (call) => call.method === UPLOAD_METHOD
    );
    expect(otherUploads).toStrictEqual([]);
    const file = String(upload?.body.content);
    const beforeTime = `${answer}\n\n**SQL query**\n\n\`\`\`sql\n${COUNT_PLANS}\n\`\`\`\nDB tables: plans\n\nData as of `;
    expect(file.slice(0, beforeTime.length)).toBe(beforeTime);
    expect(file.slice(beforeTime.length)).toMatch(/^[^\n]+ UTC$/u);
  });
});

describe("a query that needs approval in Slack", () => {
  it("posts the run_sql card with the estimate, the SQL, and eve's buttons relabelled", async () => {
    const threadTs = slackTs();

    const card = await askExpensiveQuestion(threadTs);

    expect(card.body).toStrictEqual({
      blocks: [
        ...cardSummary,
        {
          elements: [
            {
              action_id: expect.stringMatching(
                /^eve_input:tool-approval:[^:]+:button:\d+$/u
              ),
              style: "primary",
              text: { emoji: false, text: "Run query", type: "plain_text" },
              type: "button",
              value: "approve",
            },
            {
              action_id: expect.stringMatching(
                /^eve_input:tool-approval:[^:]+:button:\d+$/u
              ),
              text: { emoji: false, text: "Cancel", type: "plain_text" },
              type: "button",
              value: "deny",
            },
          ],
          type: "actions",
        },
        {
          elements: [
            {
              text: `Only <@${ASKER}> can run or cancel this query.`,
              type: "mrkdwn",
            },
          ],
          type: "context",
        },
      ],
      channel: SLACK_CHANNEL_ID,
      text: expect.stringMatching(
        /^Approve query: Pair sessions\nEstimated cost \S+ \(approval needed above 1M\) · about \d+ rows\nSELECT count\(\*\) AS pairs /u
      ),
      thread_ts: threadTs,
      unfurl_links: "false",
      unfurl_media: "false",
    });
    expect(buttonsOf(card).map((button) => button.text.text)).toStrictEqual([
      "Run query",
      "Cancel",
    ]);
    // The turn is paused on the request the card shows.
    const turn = await slackTurn(threadTs, 0);
    const events = await eventsUntil(
      turn.sessionId,
      (event) => event.type === "turn.paused"
    );
    expect(eventsOf(events, "call.settled")).toStrictEqual([]);
  });

  it("runs the query and marks the card approved when the asker clicks Run query", async () => {
    const threadTs = slackTs();
    const card = await askExpensiveQuestion(threadTs);
    const cursor = await slackCursor();

    await clickButton(card, "Run query", ASKER);
    const calls = await slackUntilIdle(threadTs, cursor);

    // chat.update names its message by timestamp, so it is matched by that rather than by thread.
    const updates = calls.filter((call) => call.method === "chat.update");
    expect(updates.map((update) => update.body)).toStrictEqual([
      {
        blocks: [
          ...cardSummary,
          {
            elements: [{ text: `Approved by <@${ASKER}>`, type: "mrkdwn" }],
            type: "context",
          },
        ],
        channel: SLACK_CHANNEL_ID,
        text: "Approve query: Pair sessions\nApproved",
        ts: card.ts,
      },
    ]);
    expect(postedMessages(calls).map((message) => message.body)).toMatchObject([
      {
        blocks: [
          { text: "There are no pairs.", type: "markdown" },
          sqlSection(EXPENSIVE_QUERY, "web_sessions"),
        ],
        thread_ts: threadTs,
      },
    ]);
    const turn = await slackTurn(threadTs, 0);
    const events = await eventsUntilSettled(turn);
    expect(eventsOf(events, "call.settled")).toMatchObject([
      { data: { outcome: "completed", output: { rows: [["0"]] } } },
    ]);
    expect(eventsOf(events, "turn.started")).toHaveLength(1);
    await expect(streamViolations(turn.sessionId)).resolves.toStrictEqual([]);
  });

  it("doesn't run the query and marks the card cancelled when the asker clicks Cancel", async () => {
    const threadTs = slackTs();
    const card = await askExpensiveQuestion(threadTs);
    const cursor = await slackCursor();

    await clickButton(card, "Cancel", ASKER);
    const calls = await slackUntilIdle(threadTs, cursor);

    const updates = calls.filter((call) => call.method === "chat.update");
    expect(updates.map((update) => update.body)).toStrictEqual([
      {
        blocks: [
          ...cardSummary,
          {
            elements: [{ text: `Cancelled by <@${ASKER}>`, type: "mrkdwn" }],
            type: "context",
          },
        ],
        channel: SLACK_CHANNEL_ID,
        text: "Approve query: Pair sessions\nCancelled",
        ts: card.ts,
      },
    ]);
    // The reply has no query section, because no query ran.
    expect(postedMessages(calls).map((message) => message.body)).toMatchObject([
      { markdown_text: "There are no pairs.", thread_ts: threadTs },
    ]);
    const events = await eventsUntilSettled(await slackTurn(threadTs, 0));
    expect(eventsOf(events, "call.started")).toStrictEqual([]);
    expect(eventsOf(events, "call.settled")).toMatchObject([
      {
        data: { error: { code: "TOOL_EXECUTION_DENIED" }, outcome: "rejected" },
      },
    ]);
  });

  it("tells anyone else who clicks that only the asker can answer, and keeps the card open", async () => {
    const threadTs = slackTs();
    const card = await askExpensiveQuestion(threadTs);
    const cursor = await slackCursor();

    await clickButton(card, "Run query", "U0COLLEAGUE");
    const refused = await slackUntilIdle(threadTs, cursor);

    expect(
      refused
        .filter((call) => call.method === "chat.postEphemeral")
        .map((call) => call.body)
    ).toMatchObject([
      {
        channel: SLACK_CHANNEL_ID,
        markdown_text:
          "Only the person who asked this question can run or cancel this query.",
        thread_ts: threadTs,
        user: "U0COLLEAGUE",
      },
    ]);
    expect(
      refused.filter((call) => call.method === "chat.update")
    ).toStrictEqual([]);
    expect(postedMessages(refused)).toStrictEqual([]);
    const turn = await slackTurn(threadTs, 0);
    const pending = await eventsUntil(
      turn.sessionId,
      (event) => event.type === "response.settled"
    );
    expect(eventsOf(pending, "response.settled")).toMatchObject([
      { data: { outcome: "refused" } },
    ]);
    expect(eventsOf(pending, "call.settled")).toStrictEqual([]);

    // The asker can still answer on the same card.
    const afterRefusal = await slackCursor();
    await clickButton(card, "Run query", ASKER);
    const approved = await slackUntilIdle(threadTs, afterRefusal);
    expect(postedMessages(approved)).toMatchObject([
      { body: { text: "There are no pairs." } },
    ]);
  });

  it("withdraws the request without running the query when the asker writes instead of clicking", async () => {
    const threadTs = slackTs();
    const card = await askExpensiveQuestion(threadTs);
    const cursor = await slackCursor();

    await mentionAgent({
      text: scripted("Never mind, skip that.", [{ text: "Skipped." }]),
      threadTs,
      ts: slackTs(),
      user: ASKER,
    });
    const calls = await slackUntilIdle(threadTs, cursor);

    const updates = calls.filter((call) => call.method === "chat.update");
    expect(updates.map((update) => update.body)).toStrictEqual([
      {
        blocks: [
          ...cardSummary,
          {
            elements: [{ text: "No longer needed", type: "mrkdwn" }],
            type: "context",
          },
        ],
        channel: SLACK_CHANNEL_ID,
        text: "Approve query: Pair sessions\nNo longer needed",
        ts: card.ts,
      },
    ]);
    expect(postedMessages(calls).map((message) => message.body)).toMatchObject([
      { markdown_text: "Skipped.", thread_ts: threadTs },
    ]);
    // The message continued the paused turn, and the pending call ended without running.
    const events = await eventsUntilSettled(await slackTurn(threadTs, 0));
    expect(eventsOf(events, "turn.started")).toHaveLength(1);
    expect(eventsOf(events, "interaction.settled")).toMatchObject([
      { data: { outcome: "withdrawn" } },
    ]);
    expect(eventsOf(events, "call.started")).toStrictEqual([]);
    expect(eventsOf(events, "call.settled")).toMatchObject([
      {
        data: { outcome: "rejected", output: { tool: { result: "not_run" } } },
      },
    ]);
  });
});

describe("the session usage prompt in Slack", () => {
  it("keeps eve's own card, and resumes the same turn when the person approves", async () => {
    const threadTs = slackTs();
    const cursor = await slackCursor();
    await mentionAgent({
      text: scripted("Describe the plans table.", [
        {
          calls: [{ input: { tables: ["plans"] }, name: "describe_schema" }],
          usage: { inputTokens: 10, outputTokens: 100_000 },
        },
        { text: "It has four columns." },
      ]),
      ts: threadTs,
      user: ASKER,
    });
    const [card, ...others] = postedMessages(
      await slackUntilIdle(threadTs, cursor)
    );
    if (card === undefined) {
      throw new Error("Expected the agent to post a usage prompt.");
    }

    // The run_sql renderer leaves this card alone: eve's default layout and labels.
    expect(others).toStrictEqual([]);
    expect(card.body.blocks).toMatchObject([
      {
        actions: [
          { text: { text: "Approve" }, value: "approve" },
          { text: { text: "Stop" }, value: "deny" },
        ],
        type: "card",
      },
    ]);

    const afterCard = await slackCursor();
    await clickButton(card, "Approve", ASKER);
    const answers = postedMessages(await slackUntilIdle(threadTs, afterCard));

    expect(answers).toMatchObject([
      { body: { markdown_text: "It has four columns." } },
    ]);
    const events = await eventsUntilSettled(await slackTurn(threadTs, 0));
    expect(eventsOf(events, "turn.started")).toHaveLength(1);
    expect(eventsOf(events, "interaction.settled")).toMatchObject([
      { data: { outcome: "accepted" } },
    ]);
  });
});

describe("a Slack thread that holds query results", () => {
  it("asks a person with a different database role to start a new thread", async () => {
    const threadTs = slackTs();
    const cursor = await slackCursor();
    await mentionAgent({
      text: countPlans("How many plans are there?", "There are 4 plans."),
      ts: threadTs,
      user: ASKER,
    });
    await slackUntilIdle(threadTs, cursor);
    const afterAnswer = await slackCursor();

    await mentionAgent({
      text: countPlans("And how many for finance?", "Never posted."),
      threadTs,
      ts: slackTs(),
      user: FINANCE_USER,
    });
    const messages = postedMessages(
      await slackUntilIdle(threadTs, afterAnswer)
    );

    expect(messages.map((message) => message.body)).toStrictEqual([
      {
        channel: SLACK_CHANNEL_ID,
        markdown_text: THREAD_ROLE_NOTICE,
        thread_ts: threadTs,
        unfurl_links: "false",
        unfurl_media: "false",
      },
    ]);
    const turn = await slackTurn(threadTs, 1);
    expect(turn.principalId).toBe(`slack:${SLACK_TEAM_ID}:${FINANCE_USER}`);
    const events = await eventsUntilSettled(turn);
    expect(
      eventsOf(events, "turn.settled").map((event) => event.data.outcome)
    ).toStrictEqual(["completed", "cancelled"]);
    // Only the first turn reached the model.
    expect(eventsOf(events, "call.requested")).toHaveLength(1);
    await expect(streamViolations(turn.sessionId)).resolves.toStrictEqual([]);
  });

  it("holds a different role's message while an approval is pending, then turns it away", async () => {
    const threadTs = slackTs();
    const card = await askExpensiveQuestion(threadTs);
    const cursor = await slackCursor();

    // The message waits behind the open request. It can't answer it, and it doesn't join the paused turn.
    await mentionAgent({
      text: countPlans("How many plans for finance?", "Never posted."),
      threadTs,
      ts: slackTs(),
      user: FINANCE_USER,
    });
    await clickButton(card, "Run query", ASKER);
    const approved = await slackUntilIdle(threadTs, cursor);
    const turnedAway = await slackUntilIdle(
      threadTs,
      (approved.at(-1)?.index ?? cursor) + 1
    );

    expect(postedMessages(approved)).toMatchObject([
      { body: { text: "There are no pairs." } },
    ]);
    expect(postedMessages(turnedAway)).toMatchObject([
      { body: { markdown_text: THREAD_ROLE_NOTICE } },
    ]);
    const turn = await slackTurn(threadTs, 1);
    expect(turn.principalId).toBe(`slack:${SLACK_TEAM_ID}:${FINANCE_USER}`);
    const events = await eventsUntilSettled(turn);
    expect(
      eventsOf(events, "turn.settled").map((event) => event.data.outcome)
    ).toStrictEqual(["completed", "cancelled"]);
    expect(eventsOf(events, "call.requested")).toHaveLength(1);
  });

  it("keeps answering a person who shares the role", async () => {
    const threadTs = slackTs();
    const cursor = await slackCursor();
    await mentionAgent({
      text: countPlans("How many plans are there?", "There are 4 plans."),
      ts: threadTs,
      user: ASKER,
    });
    await slackUntilIdle(threadTs, cursor);
    const afterAnswer = await slackCursor();

    await mentionAgent({
      text: countPlans("Can you check again?", "Still 4 plans."),
      threadTs,
      ts: slackTs(),
      user: "U0COLLEAGUE",
    });
    const messages = postedMessages(
      await slackUntilIdle(threadTs, afterAnswer)
    );

    expect(messages).toMatchObject([{ body: { text: "Still 4 plans." } }]);
  });
});
