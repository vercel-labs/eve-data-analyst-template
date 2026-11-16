/**
 * The session usage limit from `agent/lib/session-usage.ts`, over the HTTP channel.
 *
 * @packageDocumentation
 */
import { APPROVE_OPTION_ID, DENY_OPTION_ID } from "eve/events";
import { describe, expect, it } from "vitest";

import {
  clientAs,
  eventsOf,
  observe,
  scripted,
  streamViolations,
} from "./support/harness";
import type { ScriptStep } from "./support/protocol";

const describePlans = {
  input: { tables: ["plans"] },
  name: "describe_schema",
};

/* Starts a turn whose first model call reports the given usage, then calls a tool so a second model call is due. */
const spend = async (usage: NonNullable<ScriptStep["usage"]>) => {
  const { delivery, session } = await clientAs("U0SPENDER").sessions.create({
    message: scripted("Describe the plans table.", [
      { calls: [describePlans], usage },
      { text: "The plans table has four columns." },
    ]),
  });
  return { first: await observe(delivery), session };
};

describe("the session usage limit", () => {
  it("asks before the next model call once a window has used 5,000,000 input tokens", async () => {
    const { first } = await spend({ inputTokens: 5_000_000, outputTokens: 10 });

    expect(first.result.status).toBe("awaiting-input");
    expect(first.result.interactions).toMatchObject([
      { request: { kind: "budget" }, status: "open" },
    ]);
    expect(
      first.result.interactions[0]?.request.options?.map(({ id }) => id)
    ).toStrictEqual([APPROVE_OPTION_ID, DENY_OPTION_ID]);
    // The call that crossed the limit finished its tool call; only the next model call waits.
    expect(eventsOf(first.events, "call.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
    expect(eventsOf(first.events, "model.requested")).toHaveLength(1);
  });

  it("doesn't ask one token below the limit", async () => {
    const { first } = await spend({ inputTokens: 4_999_999, outputTokens: 10 });

    expect(first.result.status).toBe("completed");
    expect(eventsOf(first.events, "interaction.opened")).toStrictEqual([]);
    expect(first.result.reply).toBe("The plans table has four columns.");
  });

  it("asks once a window has written 100,000 output tokens", async () => {
    const { first } = await spend({ inputTokens: 10, outputTokens: 100_000 });

    expect(first.result.status).toBe("awaiting-input");
    expect(first.result.interactions).toMatchObject([
      { request: { kind: "budget" } },
    ]);
  });

  it("resumes the same turn when the person continues", async () => {
    const { first, session } = await spend({
      inputTokens: 10,
      outputTokens: 100_000,
    });
    const [prompt] = first.result.interactions;
    const [started] = eventsOf(first.events, "turn.started");
    if (prompt === undefined || started === undefined) {
      throw new Error("Expected a started turn with an open budget prompt.");
    }

    const resumed = await observe(
      await session.respond([
        { interactionId: prompt.interactionId, optionId: APPROVE_OPTION_ID },
      ])
    );

    // No new turn starts: the paused turn makes its second model call and replies.
    expect(prompt.turnId).toBe(started.data.turnId);
    expect(eventsOf(resumed.events, "turn.started")).toStrictEqual([]);
    expect(eventsOf(resumed.events, "turn.settled")).toMatchObject([
      { data: { outcome: "completed", turnId: started.data.turnId } },
    ]);
    expect(eventsOf(resumed.events, "content.completed")).toMatchObject([
      {
        data: { phase: "reply", value: "The plans table has four columns." },
        scope: { turnId: started.data.turnId },
      },
    ]);
    expect(resumed.result.reply).toBe("The plans table has four columns.");
    await expect(streamViolations(session.id)).resolves.toStrictEqual([]);
  });

  it("resumes the same turn after the input limit, where eve also compacts the history", async () => {
    const { first, session } = await spend({
      inputTokens: 5_000_000,
      outputTokens: 10,
    });
    const [prompt] = first.result.interactions;
    if (prompt === undefined) {
      throw new Error("Expected an open budget prompt.");
    }

    const resumed = await observe(
      await session.respond([
        { interactionId: prompt.interactionId, optionId: APPROVE_OPTION_ID },
      ])
    );

    // A call that reports more input than the model's context window makes eve compact first.
    expect(eventsOf(resumed.events, "context.settled")).toMatchObject([
      { data: { outcome: "completed" } },
    ]);
    expect(eventsOf(resumed.events, "turn.started")).toStrictEqual([]);
    expect(eventsOf(resumed.events, "turn.settled")).toMatchObject([
      { data: { outcome: "completed", turnId: prompt.turnId } },
    ]);
    expect(resumed.result.reply).toBe("The plans table has four columns.");
    await expect(streamViolations(session.id)).resolves.toStrictEqual([]);
  });

  it("cancels the turn when the person stops", async () => {
    const { first, session } = await spend({
      inputTokens: 10,
      outputTokens: 100_000,
    });
    const [prompt] = first.result.interactions;
    if (prompt === undefined) {
      throw new Error("Expected an open budget prompt.");
    }

    const stopped = await observe(
      await session.respond([
        { interactionId: prompt.interactionId, optionId: DENY_OPTION_ID },
      ])
    );

    expect(stopped.result.status).toBe("cancelled");
    expect(eventsOf(stopped.events, "turn.settled")).toMatchObject([
      { data: { outcome: "cancelled", turnId: prompt.turnId } },
    ]);
    expect(eventsOf(stopped.events, "model.requested")).toStrictEqual([]);
  });
});
