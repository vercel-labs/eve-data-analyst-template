/**
 * The cost-based approval of `run_sql`, over the HTTP channel.
 *
 * @packageDocumentation
 */
import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "eve/events";
import { describe, expect, it } from "vitest";

import {
  clientAs,
  eventsOf,
  EXPENSIVE_QUERY,
  observe,
  reportFrom,
  runSql,
  scripted,
  streamViolations,
} from "./support/harness";

const ASKER = "U0ASKER";

const expensiveTurn = scripted("How many session pairs are there?", [
  { calls: [runSql("Pair sessions", EXPENSIVE_QUERY)] },
  { report: true },
]);

/* Starts a turn that stops at the approval prompt, and returns the session with the open request. */
const askExpensiveQuestion = async () => {
  const { delivery, session } = await clientAs(ASKER).sessions.create({
    message: expensiveTurn,
  });
  const paused = await observe(delivery);
  expect(paused.result.status).toBe("awaiting-input");
  const [interaction, ...others] = paused.result.interactions;
  if (interaction === undefined) {
    throw new Error("Expected an open approval request.");
  }
  expect(others).toStrictEqual([]);
  return { interaction, paused, session };
};

describe("an expensive query", () => {
  it("pauses the turn with an approval request before it runs", async () => {
    const { interaction, paused } = await askExpensiveQuestion();

    expect(interaction).toMatchObject({
      call: {
        input: { purpose: "Pair sessions", sql: EXPENSIVE_QUERY },
        name: "run_sql",
      },
      request: { allowFreeform: false, kind: "approval" },
      status: "open",
    });
    expect(interaction.request.options?.map(({ id }) => id)).toStrictEqual([
      APPROVE_OPTION_ID,
      DENY_OPTION_ID,
    ]);
    // The query has not started: the turn paused with the call still unsettled.
    expect(eventsOf(paused.events, "call.started")).toStrictEqual([]);
    expect(eventsOf(paused.events, "call.settled")).toStrictEqual([]);
    expect(eventsOf(paused.events, "turn.paused")).toHaveLength(1);
  });

  it("runs in the same turn once the asker approves", async () => {
    const { interaction, session } = await askExpensiveQuestion();

    const resumed = await observe(
      await session.respond([
        {
          interactionId: interaction.interactionId,
          optionId: APPROVE_OPTION_ID,
        },
      ])
    );

    expect(resumed.result.status).toBe("completed");
    expect(eventsOf(resumed.events, "interaction.settled")).toMatchObject([
      { data: { outcome: "accepted", response: { optionId: "approve" } } },
    ]);
    expect(eventsOf(resumed.events, "call.settled")).toMatchObject([
      {
        data: {
          outcome: "completed",
          output: { rows: [["0"]], tables: ["analytics.web_sessions"] },
        },
        scope: { turnId: interaction.turnId },
      },
    ]);
    expect(eventsOf(resumed.events, "turn.settled")).toMatchObject([
      { data: { outcome: "completed", turnId: interaction.turnId } },
    ]);
    expect(reportFrom(resumed.result.reply).toolResults).toMatchObject([
      { isError: false, name: "run_sql" },
    ]);
    await expect(
      streamViolations(resumed.result.sessionId)
    ).resolves.toStrictEqual([]);
  });

  it("is rejected without running when the asker denies", async () => {
    const { interaction, session } = await askExpensiveQuestion();

    const resumed = await observe(
      await session.respond([
        { interactionId: interaction.interactionId, optionId: DENY_OPTION_ID },
      ])
    );

    expect(resumed.result.status).toBe("completed");
    expect(eventsOf(resumed.events, "interaction.settled")).toMatchObject([
      { data: { outcome: "declined", response: { optionId: "deny" } } },
    ]);
    expect(eventsOf(resumed.events, "call.started")).toStrictEqual([]);
    expect(eventsOf(resumed.events, "call.settled")).toMatchObject([
      {
        data: {
          error: { code: "TOOL_EXECUTION_DENIED" },
          outcome: "rejected",
          output: { tool: { result: "not_run" } },
        },
      },
    ]);
    // The model is told the call was denied, and gets no rows.
    expect(reportFrom(resumed.result.reply).toolResults).toStrictEqual([
      { isError: true, name: "run_sql", output: "Tool execution was denied." },
    ]);
    await expect(
      streamViolations(resumed.result.sessionId)
    ).resolves.toStrictEqual([]);
  });

  it("stays pending when someone other than the asker answers", async () => {
    const { interaction, session } = await askExpensiveQuestion();
    const answer = [
      { interactionId: interaction.interactionId, optionId: APPROVE_OPTION_ID },
    ];

    // A colleague with the same database role answers in the asker's session.
    const refused = await observe(
      await clientAs("U0COLLEAGUE")
        .sessions.attach(session.id, session.state)
        .respond(answer)
    );

    expect(eventsOf(refused.events, "response.settled")).toMatchObject([
      {
        data: {
          outcome: "refused",
          reason:
            "Only the person who asked this question can run or cancel this query.",
        },
      },
    ]);
    expect(eventsOf(refused.events, "interaction.settled")).toStrictEqual([]);
    expect(eventsOf(refused.events, "call.settled")).toStrictEqual([]);
    expect(refused.result.status).toBe("awaiting-input");

    // The request is still open, and the asker's answer decides it.
    const approved = await observe(await session.respond(answer));
    expect(eventsOf(approved.events, "response.settled")).toMatchObject([
      { data: { outcome: "applied" } },
    ]);
    expect(eventsOf(approved.events, "call.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
  });
});

describe("a cheap query", () => {
  it("runs without asking", async () => {
    const { delivery } = await clientAs(ASKER).sessions.create({
      message: scripted("How many plans are there?", [
        {
          calls: [runSql("Count plans", "SELECT count(*) AS plans FROM plans")],
        },
        { text: "Four." },
      ]),
    });
    const { events, result } = await observe(delivery);

    expect(result.status).toBe("completed");
    expect(eventsOf(events, "interaction.opened")).toStrictEqual([]);
    expect(eventsOf(events, "call.settled")).toMatchObject([
      { data: { outcome: "completed", output: { rows: [["4"]] } } },
    ]);
  });
});
