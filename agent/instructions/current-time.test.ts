import { describe, expect, it, vi } from "vitest";

import { describeCurrentTime, resolveCurrentTime } from "./current-time";

describe(describeCurrentTime, () => {
  const now = new Date("2026-10-01T02:30:00.000Z");

  it("reports UTC and the local reporting time", () => {
    expect(describeCurrentTime(now, "America/Los_Angeles")).toBe(
      "Current date and time: 2026-10-01T02:30:00.000Z (UTC). Reporting time zone: America/Los_Angeles; local time there: 2026-09-30 19:30 (Wednesday)."
    );
  });

  it("works in UTC", () => {
    expect(describeCurrentTime(now, "UTC")).toContain(
      "local time there: 2026-10-01 02:30 (Thursday)."
    );
  });
});

describe(resolveCurrentTime, () => {
  type Context = Parameters<typeof resolveCurrentTime>[0];
  type Memo = Context["memo"];

  /* A memo that keeps one result per key, as eve does for the life of the key. */
  const session = () => {
    const saved = new Map<string, unknown>();
    const keys: unknown[] = [];
    const memo: Memo = async (key, fn) => {
      keys.push(key);
      const id = JSON.stringify(key);
      if (!saved.has(id)) {
        saved.set(
          id,
          await fn({
            abortSignal: new AbortController().signal,
            idempotencyKey: id,
          })
        );
      }
      // SAFETY: Each key stores the value its own callback returned, and this test uses one callback per key.
      return saved.get(id) as Awaited<ReturnType<typeof fn>>;
    };
    const at = (turnId: string | null, now: string): Context => ({
      memo,
      now: new Date(now),
      turn:
        turnId === null ? null : { id: turnId, input: [], status: "running" },
    });
    return { at, keys };
  };

  it("adds the time as a user-role instruction in the reporting time zone", async () => {
    vi.stubEnv("ANALYST_TIMEZONE", "America/Los_Angeles");
    const { at } = session();
    await expect(
      resolveCurrentTime(at("turn-1", "2026-10-01T02:30:00.000Z"))
    ).resolves.toMatchObject({
      content:
        "Current date and time: 2026-10-01T02:30:00.000Z (UTC). Reporting time zone: America/Los_Angeles; local time there: 2026-09-30 19:30 (Wednesday).",
      role: "user",
    });
  });

  it("keeps one line for every model call in a turn, so history gains it once", async () => {
    const { at, keys } = session();
    const first = await resolveCurrentTime(
      at("turn-1", "2026-10-01T02:30:00Z")
    );
    // eve runs the function again before each later model call, when its clock has moved on.
    const later = await resolveCurrentTime(
      at("turn-1", "2026-10-01T02:31:45Z")
    );
    expect(later).toStrictEqual(first);
    expect(keys).toStrictEqual([
      ["current-time", "turn-1"],
      ["current-time", "turn-1"],
    ]);
  });

  it("gives the next turn a new line", async () => {
    const { at } = session();
    const first = await resolveCurrentTime(
      at("turn-1", "2026-10-01T02:30:00Z")
    );
    const next = await resolveCurrentTime(at("turn-2", "2026-10-01T09:00:00Z"));
    expect(next.content).not.toBe(first.content);
    expect(next.content).toContain("2026-10-01T09:00:00.000Z");
  });

  it("falls back to UTC for a time zone Postgres wouldn't know", async () => {
    vi.stubEnv("ANALYST_TIMEZONE", "Mars/Olympus_Mons");
    const { at } = session();
    const { content } = await resolveCurrentTime(
      at(null, "2026-10-01T02:30:00Z")
    );
    expect(content).toContain("Reporting time zone: UTC;");
  });
});
