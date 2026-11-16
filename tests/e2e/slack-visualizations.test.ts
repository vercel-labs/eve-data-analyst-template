/**
 * The `post_slack_table` and `post_slack_chart` tools end to end, posting to a fake Slack from a turn that a Slack mention started.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from "vitest";

import {
  eventsOf,
  failSlack,
  mentionAgent,
  postedMessages,
  eventsUntilSettled,
  runSql,
  scripted,
  slackCursor,
  slackTs,
  slackTurn,
  slackUntilIdle,
  streamViolations,
} from "./support/harness";
import { SLACK_CHANNEL_ID } from "./support/protocol";
import type { ScriptStep } from "./support/protocol";

const ASKER = "U0ADA";
const PLAN_PRICES =
  "SELECT name, monthly_price_cents FROM plans ORDER BY monthly_price_cents LIMIT 2";

const tableInput = {
  summary: "Two cheapest plans.",
  table: {
    columns: ["Plan", "Monthly price"],
    rows: [
      ["Free", "0"],
      ["Pro", { text: "49", url: "https://example.com/pro" }],
    ],
  },
  title: "Plans by price",
};

const tableBlocks = [
  { text: { text: "Two cheapest plans.", type: "mrkdwn" }, type: "section" },
  {
    caption: "Plans by price",
    page_size: 2,
    rows: [
      [
        { text: "Plan", type: "raw_text" },
        { text: "Monthly price", type: "raw_text" },
      ],
      [
        { text: "Free", type: "raw_text" },
        { text: "0", type: "raw_text" },
      ],
      [
        { text: "Pro", type: "raw_text" },
        {
          elements: [
            {
              elements: [
                { text: "49", type: "link", url: "https://example.com/pro" },
              ],
              type: "rich_text_section",
            },
          ],
          type: "rich_text",
        },
      ],
    ],
    type: "data_table",
  },
];

/** Width of the fallback table's second column, set by its longest cell. */
const PRICE_WIDTH = "49 (https://example.com/pro)".length;

/* The table's text alternative with the query below it, up to the time the query ran. */
const TABLE_TEXT = [
  "Two cheapest plans.",
  "",
  "Plans by price",
  "```",
  `Plan  ${"Monthly price".padEnd(PRICE_WIDTH)}`,
  `----  ${"-".repeat(PRICE_WIDTH)}`,
  `Free  ${"0".padEnd(PRICE_WIDTH)}`,
  "Pro   49 (https://example.com/pro)",
  "```",
  "",
  "*SQL query*",
  "",
  "```",
  PLAN_PRICES,
  "```",
  "DB tables: plans",
  "",
  "Data as of <!date^",
].join("\n");

const postTable = { input: tableInput, name: "post_slack_table" };

/* Mentions the agent with a script and returns what it sent to the thread, with the session's events. */
const ask = async (
  steps: readonly ScriptStep[],
  prepare?: (threadTs: string) => Promise<void>
) => {
  const threadTs = slackTs();
  const cursor = await slackCursor();
  await prepare?.(threadTs);
  await mentionAgent({
    text: scripted("Show me the plans.", steps),
    ts: threadTs,
    user: ASKER,
  });
  const calls = await slackUntilIdle(threadTs, cursor);
  const turn = await slackTurn(threadTs, 0);
  return {
    events: await eventsUntilSettled(turn),
    messages: postedMessages(calls),
    sessionId: turn.sessionId,
    threadTs,
  };
};

describe("post_slack_table", () => {
  it("posts a data table with the turn's query folded below, and ends the turn without a second reply", async () => {
    const { events, messages, sessionId, threadTs } = await ask([
      { calls: [runSql("Plan prices", PLAN_PRICES)] },
      { calls: [postTable], text: "Posting the table." },
      { text: "This reply must never be written." },
    ]);

    expect(messages.map((message) => message.body)).toStrictEqual([
      {
        blocks: [
          ...tableBlocks,
          {
            child_blocks: [
              {
                elements: [
                  {
                    elements: [{ text: PLAN_PRICES, type: "text" }],
                    type: "rich_text_preformatted",
                  },
                ],
                type: "rich_text",
              },
              {
                elements: [{ text: "DB tables: plans", type: "mrkdwn" }],
                type: "context",
              },
              {
                elements: [
                  {
                    text: expect.stringMatching(/^Data as of <!date\^\d+\^/u),
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
          },
        ],
        channel: SLACK_CHANNEL_ID,
        text: expect.stringContaining(TABLE_TEXT),
        thread_ts: threadTs,
        unfurl_links: "false",
      },
    ]);
    const [, posted] = eventsOf(events, "call.settled");
    expect(posted?.data).toMatchObject({
      outcome: "completed",
      output: {
        channel: SLACK_CHANNEL_ID,
        deliveredRows: 2,
        deliveryComplete: true,
        posted: true,
        threadTs,
        totalRows: 2,
      },
    });
    // The successful post ended the turn: the model was not called a third time.
    expect(eventsOf(events, "model.requested")).toHaveLength(2);
    expect(eventsOf(events, "turn.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
    await expect(streamViolations(sessionId)).resolves.toStrictEqual([]);
  });

  it("retries with the query as plain blocks when Slack rejects the folded section", async () => {
    const { events, messages } = await ask(
      [
        { calls: [runSql("Plan prices", PLAN_PRICES)] },
        { calls: [postTable] },
        { text: "This reply must never be written." },
      ],
      async (threadTs) => {
        await failSlack({
          error: "invalid_blocks",
          match: threadTs,
          method: "chat.postMessage",
          times: 1,
        });
      }
    );

    const [rejected, delivered, ...others] = messages;
    expect(others).toStrictEqual([]);
    expect(rejected?.ts).toBeNull();
    expect(rejected?.body.blocks).toMatchObject([
      ...tableBlocks,
      { type: "container" },
    ]);
    expect(delivered?.body.blocks).toMatchObject([
      ...tableBlocks,
      { elements: [{ text: "*SQL query*", type: "mrkdwn" }], type: "context" },
      { type: "rich_text" },
      { elements: [{ text: "DB tables: plans" }], type: "context" },
      { type: "context" },
    ]);
    const [, posted] = eventsOf(events, "call.settled");
    expect(posted?.data).toMatchObject({
      outcome: "completed",
      output: { deliveryComplete: true, posted: true },
    });
  });

  it("lets the model explain when the table can't be posted", async () => {
    const { events, messages } = await ask(
      [
        { calls: [postTable] },
        { text: "I couldn't post the table: Slack refused it." },
      ],
      async (threadTs) => {
        await failSlack({
          error: "channel_not_found",
          match: threadTs,
          method: "chat.postMessage",
          times: 1,
        });
      }
    );

    const [failed] = eventsOf(events, "call.settled");
    expect(failed?.data).toMatchObject({
      outcome: "completed",
      output: { error: "channel_not_found", posted: false },
    });
    // The failed attempt delivered nothing, and the turn went on to a written reply.
    const [rejected, reply, ...others] = messages;
    expect(others).toStrictEqual([]);
    expect(rejected?.ts).toBeNull();
    expect(reply?.body).toMatchObject({
      markdown_text: "I couldn't post the table: Slack refused it.",
    });
  });

  it("keeps the final reply out of the thread when the turn goes on after the table posted", async () => {
    // A subagent task keeps the turn open after the post, so the model is called again and replies.
    const { events, messages } = await ask([
      {
        calls: [
          {
            input: {
              message: scripted("Wait for me.", [
                { text: "The task is done." },
              ]),
            },
            name: "agent",
          },
          postTable,
        ],
      },
      { text: "Here is the table again in words." },
    ]);

    const replies = eventsOf(events, "content.completed").filter(
      (event) => event.data.phase === "reply"
    );
    expect(replies).toMatchObject([
      { data: { value: "Here is the table again in words." } },
    ]);
    const tables = messages.filter((message) =>
      JSON.stringify(message.body.blocks ?? []).includes("data_table")
    );
    expect(tables).toHaveLength(1);
    expect(
      messages.filter((message) =>
        JSON.stringify(message.body).includes(
          "Here is the table again in words."
        )
      )
    ).toStrictEqual([]);
  });
});

describe("post_slack_chart", () => {
  it("posts a native chart block with its text alternative", async () => {
    const { events, messages, threadTs } = await ask([
      {
        calls: [
          {
            input: {
              chart: {
                categories: ["Aug", "Sep"],
                series: [{ name: "MRR", values: [120, 135] }],
                type: "line",
                xLabel: "Month",
                yLabel: "USD thousands",
              },
              summary: "MRR grew in September.",
              title: "MRR by month",
            },
            name: "post_slack_chart",
          },
        ],
      },
      { text: "This reply must never be written." },
    ]);

    expect(messages.map((message) => message.body)).toStrictEqual([
      {
        blocks: [
          {
            text: {
              text: "MRR grew in September.",
              type: "mrkdwn",
              verbatim: true,
            },
            type: "section",
          },
          {
            chart: {
              axis_config: {
                categories: ["Aug", "Sep"],
                x_label: "Month",
                y_label: "USD thousands",
              },
              series: [
                {
                  data: [
                    { label: "Aug", value: 120 },
                    { label: "Sep", value: 135 },
                  ],
                  name: "MRR",
                },
              ],
              type: "line",
            },
            title: "MRR by month",
            type: "data_visualization",
          },
        ],
        channel: SLACK_CHANNEL_ID,
        text: "MRR grew in September.\nMRR by month\nX-axis: Month\nY-axis: USD thousands\nAug: MRR=120\nSep: MRR=135",
        thread_ts: threadTs,
        unfurl_links: "false",
      },
    ]);
    expect(eventsOf(events, "call.settled")).toMatchObject([
      { data: { outcome: "completed", output: { posted: true, threadTs } } },
    ]);
    expect(eventsOf(events, "model.requested")).toHaveLength(1);
  });
});
