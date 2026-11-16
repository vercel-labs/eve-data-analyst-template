/**
 * Typed session-event fixtures for unit tests, built against eve's public event
 * and hook types so fixture drift after an eve upgrade fails typecheck instead
 * of passing silently through a cast.
 *
 * @packageDocumentation
 */
import { emptySessionView, foldEvents } from "eve/events";
import type { CallOutcome, SessionView } from "eve/events";
import type { HookContext, HookEvent, HookEventType } from "eve/hooks";
import { vi } from "vitest";

import { sessionContext } from "./session";

/** Time stamped on every fixture line. */
const AT = "2026-10-10T00:00:00.000Z";

/** Hook context for events whose handlers can't continue a turn, which is every event except `turn.settled`. */
type ObserverHookContext = HookContext<"turn.started">;

type SessionOptions = Parameters<typeof sessionContext>[0];

/**
 * Folds events into the session view eve hands to hooks, channel renderers, and dynamic functions.
 *
 * @param events - Events in stream order; each is stored as its own line.
 * @returns The same read-only view `eve/events` selectors such as `call` and `interactions` read.
 * @remarks Uses eve's own fold, so a selector reads fixtures exactly as it reads a real session.
 */
export const sessionView = (
  events: readonly HookEvent<HookEventType>[]
): SessionView =>
  foldEvents(
    emptySessionView(),
    events.map((event, line) => ({
      ...event,
      meta: { at: AT, endOfLine: true, position: { index: 0, line } },
    }))
  );

interface ToolCallOptions {
  callId?: string;
  name?: string;
  outcome?: CallOutcome;
  turnId?: string;
}

/**
 * Builds the two events eve records for one tool call: the request and its outcome.
 *
 * @param options - Call ID, tool name, outcome, and owning turn; defaults describe a completed `run_sql` call in turn-1.
 * @returns The `call.requested` and `call.settled` events, in stream order.
 */
export const toolCallEvents = ({
  callId = "call-1",
  name = "run_sql",
  outcome = "completed",
  turnId = "turn-1",
}: ToolCallOptions = {}): [
  HookEvent<"call.requested">,
  HookEvent<"call.settled">,
] => [
  {
    data: {
      callId,
      capability: { kind: "tool", name },
      input: {},
      owner: { turnId },
    },
    scope: { turnId },
    type: "call.requested",
  },
  {
    data: {
      callId,
      outcome,
      ...(outcome === "completed" && { output: {} }),
      ...(outcome === "failed" && {
        error: { code: "TOOL_FAILED", message: "The tool failed." },
      }),
    },
    scope: { turnId },
    type: "call.settled",
  },
];

/**
 * Builds the event eve records when a turn starts.
 *
 * @param turnId - Turn that starts.
 * @returns A `turn.started` event caused by a delivered message.
 */
export const turnStartedEvent = (
  turnId = "turn-2"
): HookEvent<"turn.started"> => ({
  data: { cause: { deliveryId: "delivery-1" }, follows: null, turnId },
  scope: { turnId },
  type: "turn.started",
});

/**
 * Builds the context eve passes to a hook handler, with an observable `cancel`.
 *
 * @param options - Session principals and the session view the handler reads; the view defaults to an empty session.
 * @returns The context and its `cancel` spy.
 * @remarks `memo` runs its callback every time, so tests see each computation.
 */
export const hookContext = (
  options: SessionOptions & { view?: SessionView } = {}
) => {
  const cancel = vi.fn<ObserverHookContext["cancel"]>();
  const occurrence = {
    abortSignal: new AbortController().signal,
    idempotencyKey: "occurrence-1",
  };
  const ctx: ObserverHookContext = {
    ...sessionContext(options),
    agent: { name: "test" },
    cancel,
    channel: { kind: "channel:slack", metadata: {} },
    memo: async (_key, fn) => await fn(occurrence),
    now: new Date(AT),
    occurrence,
    position: { index: 0, line: 0 },
    turn: null,
    view: options.view ?? emptySessionView(),
  };
  return { cancel, ctx };
};
