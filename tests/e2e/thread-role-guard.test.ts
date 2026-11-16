/**
 * The thread role guard hook, over the HTTP channel: one session's query results stay with the database role that fetched them.
 *
 * @packageDocumentation
 */
import type { ClientSession } from "eve/client";
import { describe, expect, it } from "vitest";

import { BLOCKED_USER, FINANCE_USER } from "#tests/support/warehouse";

import {
  clientAs,
  eventsOf,
  observe,
  reportFrom,
  runSql,
  scripted,
  streamViolations,
} from "./support/harness";

const countPlans = (label: string) =>
  scripted(label, [
    { calls: [runSql("Count plans", "SELECT count(*) AS plans FROM plans")] },
    { report: true },
  ]);

/* Starts a session whose first turn, by a person with the default role, ran a query. */
const sessionWithResults = async (): Promise<ClientSession> => {
  const { delivery, session } = await clientAs("U0FIRST").sessions.create({
    message: countPlans("How many plans are there?"),
  });
  const { events } = await observe(delivery);
  expect(eventsOf(events, "call.settled")).toMatchObject([
    { data: { outcome: "completed" } },
  ]);
  return session;
};

/* Sends a follow-up to an existing session as another person. */
const followUp = async (
  session: ClientSession,
  userId: string,
  label: string
) =>
  await observe(
    await clientAs(userId)
      .sessions.attach(session.id, session.state)
      .send(countPlans(label))
  );

describe("a session that holds query results", () => {
  it("cancels a turn from a person with a different role before the model runs", async () => {
    const session = await sessionWithResults();

    const { events, result } = await followUp(
      session,
      FINANCE_USER,
      "And what about payroll?"
    );

    expect(result.status).toBe("cancelled");
    // eve 1.0.0 records no `cause` on a turn that a hook cancelled, so the outcome is all that tells.
    expect(eventsOf(events, "turn.settled")).toMatchObject([
      { data: { outcome: "cancelled" } },
    ]);
    expect(eventsOf(events, "model.requested")).toStrictEqual([]);
    expect(eventsOf(events, "call.requested")).toStrictEqual([]);
    await expect(streamViolations(session.id)).resolves.toStrictEqual([]);
  });

  it("cancels a turn from a person whose access is turned off", async () => {
    const session = await sessionWithResults();

    const { events, result } = await followUp(
      session,
      BLOCKED_USER,
      "Show me that too."
    );

    expect(result.status).toBe("cancelled");
    expect(eventsOf(events, "model.requested")).toStrictEqual([]);
  });

  it("continues for a person who shares the role, also after a cancelled turn", async () => {
    const session = await sessionWithResults();

    const colleague = await followUp(session, "U0SECOND", "Same question.");
    expect(colleague.result.status).toBe("completed");
    expect(eventsOf(colleague.events, "call.settled")).toMatchObject([
      { data: { outcome: "completed", output: { rows: [["4"]] } } },
    ]);

    const finance = await followUp(session, FINANCE_USER, "Let me in.");
    expect(finance.result.status).toBe("cancelled");

    const again = await followUp(session, "U0FIRST", "One more time.");
    expect(again.result.status).toBe("completed");
    // The model saw the three turns that ran, each with one query result.
    expect(reportFrom(again.result.reply).toolResults).toHaveLength(3);
  });
});

describe("a session without query results", () => {
  it("lets a person with another role take a turn", async () => {
    const { delivery, session } = await clientAs("U0FIRST").sessions.create({
      message: scripted("Hello.", [{ text: "Hello." }]),
    });
    await observe(delivery);

    const { events, result } = await followUp(
      session,
      FINANCE_USER,
      "How many plans are there?"
    );

    expect(result.status).toBe("completed");
    expect(eventsOf(events, "call.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
  });

  it("answers a person whose access is turned off with the denial, not a cancellation", async () => {
    const { delivery } = await clientAs(BLOCKED_USER).sessions.create({
      message: countPlans("How many plans are there?"),
    });
    const { events, result } = await observe(delivery);

    expect(result.status).toBe("completed");
    expect(eventsOf(events, "call.settled")).toMatchObject([
      {
        data: {
          error: { message: "Your warehouse access has been turned off." },
          outcome: "rejected",
        },
      },
    ]);
    expect(reportFrom(result.reply).toolResults).toStrictEqual([
      {
        isError: true,
        name: "run_sql",
        output: "Your warehouse access has been turned off.",
      },
    ]);
  });
});
