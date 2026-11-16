/**
 * Turns over the HTTP channel: the real warehouse tools, as the real caller's database role, with a scripted model.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from "vitest";

import {
  BLOCKED_USER,
  FINANCE_USER,
  RESTRICTED_SCHEMA,
} from "#tests/support/warehouse";

import { describeCurrentTime } from "../../agent/instructions/current-time";
import {
  clientAs,
  eventsOf,
  observe,
  reportFrom,
  runSql,
  scripted,
  storedLines,
  streamViolations,
  violationsIn,
  warehouseFacts,
} from "./support/harness";

const PAYROLL = `SELECT employee FROM ${RESTRICTED_SCHEMA}.payroll ORDER BY employee`;

const TIME_LINE = /^Current date and time: (?<iso>\S+) \(UTC\)\./u;

/* Asks for the restricted table as one person and returns how the call settled. */
const askForPayroll = async (userId: string) => {
  const { delivery } = await clientAs(userId).sessions.create({
    message: scripted("Who is on payroll?", [
      { calls: [runSql("List payroll", PAYROLL)] },
      { text: "Done." },
    ]),
  });
  const { events } = await observe(delivery);
  return eventsOf(events, "call.settled").map((event) => event.data);
};

/* A turn of three model calls: two tool calls, then a report of what the model received. */
const threeCallTurn = (label: string) =>
  scripted(label, [
    { calls: [{ input: { tables: ["plans"] }, name: "describe_schema" }] },
    { calls: [runSql("Count plans", "SELECT count(*) AS plans FROM plans")] },
    { report: true },
  ]);

/* The current-time lines among the user messages the model received. */
const timeLines = (reply: string | undefined) =>
  reportFrom(reply)
    .messages.filter(({ role }) => role === "user")
    .map(({ text }) => text)
    .filter((text) => TIME_LINE.test(text));

/* The sorted names of the tools the model is offered in a new session of one caller. */
const offeredTo = async (userId?: string) => {
  const { delivery } = await clientAs(userId).sessions.create({
    message: scripted("What can you do?", [{ report: true }]),
  });
  const { result } = await observe(delivery);
  return reportFrom(result.reply).tools.toSorted();
};

describe("a turn over the HTTP channel", () => {
  it("explores the schema, runs a query, and answers from real rows", async () => {
    const { delivery } = await clientAs("U0ANALYST").sessions.create({
      message: scripted("How many customers do we have?", [
        { calls: [{ input: {}, name: "describe_schema" }] },
        {
          calls: [
            runSql(
              "Count customers",
              "SELECT count(*) AS customers FROM customers"
            ),
          ],
        },
        { report: true },
      ]),
    });
    const { events, result } = await observe(delivery);

    expect(result.status).toBe("completed");
    const [schema, query] = eventsOf(events, "call.settled");
    expect(schema?.data).toMatchObject({
      outcome: "completed",
      output: { schemas: ["analytics", RESTRICTED_SCHEMA], timezone: "UTC" },
    });
    expect(query?.data).toMatchObject({
      outcome: "completed",
      output: {
        columns: [{ name: "customers", type: "bigint" }],
        rowCount: 1,
        rows: [[String(warehouseFacts.rows.customers)]],
        tables: ["analytics.customers"],
        truncated: false,
      },
    });
    // The model received both results, and the reply is the last model call's text.
    const report = reportFrom(result.reply);
    expect(
      report.toolResults.map(({ isError, name }) => [name, isError])
    ).toStrictEqual([
      ["describe_schema", false],
      ["run_sql", false],
    ]);
    expect(eventsOf(events, "model.requested")).toHaveLength(3);
    await expect(streamViolations(result.sessionId)).resolves.toStrictEqual([]);
  });

  it("records a stream that eve's checker accepts, and the checker rejects it with a line missing", async () => {
    const { delivery } = await clientAs("U0ANALYST").sessions.create({
      message: scripted("How many plans are there?", [
        {
          calls: [runSql("Count plans", "SELECT count(*) AS plans FROM plans")],
        },
        { text: "Four." },
      ]),
    });
    await observe(delivery);
    const lines = await storedLines(delivery.sessionId);

    expect(violationsIn(lines)).toStrictEqual([]);
    // The control: without the line that starts the session and its first delivery, the rest breaks the rules.
    expect(violationsIn(lines.slice(1))).not.toStrictEqual([]);
  });

  it("offers the model exactly the analyst's tools, without web access", async () => {
    // The complete list the model gets at run time, which includes tools eve adds for skills, tasks, and memory.
    // Before adding a name here, check the new tool against the rule in AGENTS.md that query results stay in the conversation: `web_fetch` and `web_search` stay off this list.
    const expected = [
      "agent",
      "bash",
      "channel-preferences__remove_memory",
      "channel-preferences__save_memory",
      "describe_schema",
      "edit_file",
      "eve__skill",
      "eve__task_cancel",
      "eve__task_wait",
      "post_slack_chart",
      "post_slack_table",
      "read_file",
      "run_sql",
      "user-preferences__remove_memory",
      "user-preferences__save_memory",
      "write_file",
    ];
    await expect(offeredTo("U0ANALYST")).resolves.toStrictEqual(expected);
    await expect(offeredTo()).resolves.toStrictEqual(expected);
  });

  it("runs shell commands in the local sandbox", async () => {
    const { delivery } = await clientAs().sessions.create({
      message: scripted("What is six times seven?", [
        { calls: [{ input: { command: "echo $((6 * 7))" }, name: "bash" }] },
        { report: true },
      ]),
    });
    const { events, result } = await observe(delivery);

    expect(eventsOf(events, "call.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
    expect(reportFrom(result.reply).toolResults).toMatchObject([
      { isError: false, name: "bash", output: expect.stringContaining("42") },
    ]);
  });

  it("queries as the caller's database role", async () => {
    // PGlite shares one session between connections, so the three callers ask in turn.
    const finance = await askForPayroll(FINANCE_USER);
    const analyst = await askForPayroll("U0ANALYST");
    const blocked = await askForPayroll(BLOCKED_USER);

    expect(finance).toMatchObject([
      { outcome: "completed", output: { rows: [["Ada"], ["Grace"]] } },
    ]);
    expect(analyst).toMatchObject([
      {
        error: {
          message: expect.stringContaining(
            `permission denied for schema ${RESTRICTED_SCHEMA}`
          ),
        },
        outcome: "rejected",
      },
    ]);
    expect(blocked).toMatchObject([
      {
        error: { message: "Your warehouse access has been turned off." },
        outcome: "rejected",
      },
    ]);
  });

  it("adds the current time once per turn, however many model calls the turn makes", async () => {
    const client = clientAs("U0ANALYST");
    const { delivery, session } = await client.sessions.create({
      message: threeCallTurn("How many plans are there?"),
    });
    const first = await observe(delivery);
    const second = await observe(await session.send(threeCallTurn("And now?")));

    // Three model calls ran in each turn, and each turn added one line.
    expect(eventsOf(first.events, "model.requested")).toHaveLength(3);
    const [firstLine, ...noMore] = timeLines(first.result.reply);
    expect(noMore).toStrictEqual([]);
    const afterSecond = timeLines(second.result.reply);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[0]).toBe(firstLine);

    // Each line is the production formatter's rendering of the instant it names.
    for (const line of afterSecond) {
      const iso = TIME_LINE.exec(line)?.groups?.iso ?? "";
      expect(line).toBe(describeCurrentTime(new Date(iso), "UTC"));
    }

    // The line sits right before the message that started its turn.
    const { messages } = reportFrom(first.result.reply);
    const at = messages.findIndex(({ text }) => text === firstLine);
    expect(messages[at + 1]).toMatchObject({
      role: "user",
      text: expect.stringContaining("How many plans are there?"),
    });
  });
});
