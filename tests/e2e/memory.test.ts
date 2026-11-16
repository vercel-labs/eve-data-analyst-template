/**
 * User memory and channel memory, over the HTTP channel: what one session saves, and which later sessions recall it.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from "vitest";

import {
  clientAs,
  eventsOf,
  observe,
  reportFrom,
  scripted,
} from "./support/harness";

/* Saves one memory in a new session, as the model would after a person states a preference. */
const remember = async (
  tool: string,
  text: string,
  ...caller: Parameters<typeof clientAs>
) => {
  const { delivery } = await clientAs(...caller).sessions.create({
    message: scripted("Please remember this.", [
      { calls: [{ input: { text }, name: tool }] },
      { text: "Saved." },
    ]),
  });
  const { events } = await observe(delivery);
  expect(eventsOf(events, "call.settled")).toMatchObject([
    { data: { outcome: "completed" } },
  ]);
};

/* Starts a new session and returns the text of everything the model received in it. */
const recalled = async (
  ...caller: Parameters<typeof clientAs>
): Promise<string> => {
  const { delivery } = await clientAs(...caller).sessions.create({
    message: scripted("What do you know about my preferences?", [
      { report: true },
    ]),
  });
  const { result } = await observe(delivery);
  return reportFrom(result.reply)
    .messages.map(({ text }) => text)
    .join("\n");
};

describe("user memory", () => {
  it("is recalled in the same person's later sessions, in any channel, and in no one else's", async () => {
    const preference = "Show money in whole dollars without cents.";
    await remember(
      "user-preferences__save_memory",
      preference,
      "U0MEMORYA",
      "C0MEMORY1"
    );

    await expect(recalled("U0MEMORYA", "C0MEMORY1")).resolves.toContain(
      preference
    );
    await expect(recalled("U0MEMORYA", "C0MEMORY2")).resolves.toContain(
      preference
    );
    await expect(recalled("U0MEMORYB", "C0MEMORY1")).resolves.not.toContain(
      preference
    );
  });
});

describe("channel memory", () => {
  it("is recalled for everyone in the Slack channel, and not in another channel", async () => {
    const convention = "In this channel, revenue means recognized revenue.";
    await remember(
      "channel-preferences__save_memory",
      convention,
      "U0MEMORYC",
      "C0MEMORY3"
    );

    await expect(recalled("U0MEMORYC", "C0MEMORY3")).resolves.toContain(
      convention
    );
    await expect(recalled("U0MEMORYD", "C0MEMORY3")).resolves.toContain(
      convention
    );
    await expect(recalled("U0MEMORYC", "C0MEMORY4")).resolves.not.toContain(
      convention
    );
  });
});
