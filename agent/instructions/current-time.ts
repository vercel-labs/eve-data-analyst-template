import type { DynamicContext } from "eve";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { isTimeZone } from "#lib/analyst/config";

/* Reporting time zone for the time reference; invalid values fall back to UTC here and fail loudly in tools. */
const reportingTimeZone = (): string => {
  const zone = process.env.ANALYST_TIMEZONE?.trim() || "UTC";
  return isTimeZone(zone) ? zone : "UTC";
};

/**
 * Formats the current time as a UTC timestamp plus the local date and time in the reporting time zone.
 *
 * @param now - Instant to describe.
 * @param timeZone - IANA reporting time zone.
 * @returns A one-line time reference for the model.
 */
export const describeCurrentTime = (now: Date, timeZone: string): string => {
  const local = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
    weekday: "long",
    year: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    local.find((entry) => entry.type === type)?.value ?? "";
  return `Current date and time: ${now.toISOString()} (UTC). Reporting time zone: ${timeZone}; local time there: ${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} (${part("weekday")}).`;
};

/** The parts of eve's dynamic context the time reference reads. */
type TimeContext = Pick<DynamicContext, "memo" | "now" | "turn">;

/**
 * Resolves the time reference for the current turn.
 *
 * @param ctx - eve's dynamic context: the latest turn, the time of the session's latest event, and the memo.
 * @returns User-role instructions whose content stays the same for every model call in one turn.
 * @remarks eve runs a dynamic function before every model call and adds a user-role instruction to history whenever its content changes, so the time is saved in a memo keyed on the turn. The timestamp is eve's `ctx.now` at the turn's first model call, not a live clock.
 */
export const resolveCurrentTime = async (ctx: TimeContext) => {
  const content = await ctx.memo(["current-time", ctx.turn?.id ?? null], () =>
    describeCurrentTime(ctx.now, reportingTimeZone())
  );
  return defineInstructions({ content, role: "user" });
};

/**
 * Appends a time reference in UTC and the reporting time zone to conversation history at each turn.
 *
 * @returns Dynamic user-role instructions resolved once for each turn.
 * @remarks
 * Every model call in one turn reads the same line, and the next turn appends
 * a new one. Previous timestamps remain unchanged, preserving the existing
 * prompt prefix for caching. Relative periods such as "last month" are
 * resolved in the reporting time zone.
 */
export const currentTimeInstructions = () => defineDynamic(resolveCurrentTime);

export default currentTimeInstructions();
