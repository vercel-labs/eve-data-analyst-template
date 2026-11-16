/**
 * What every end-to-end test uses to drive the fixture agent: clients that call as a chosen person, scripts for the mock model, signed Slack webhooks, and reads of what the agent did.
 *
 * @packageDocumentation
 */
import { createHash, createHmac } from "node:crypto";

import { Client } from "eve/client";
import type { SessionStreamEvent } from "eve/client";
import { createStreamChecker } from "eve/events";
import type { StoredLine, Violation } from "eve/events";
import type { Delivery, DeliveryResult } from "eve/sessions";
import { expect, inject } from "vitest";
import { z } from "zod";

import type { JsonObject } from "#lib/json";
import { isObject, isString } from "#lib/values";

import {
  CHANNEL_HEADER,
  CONTROL_PREFIX,
  encodeScript,
  modelReportSchema,
  PRINCIPAL_HEADER,
  SLACK_BOT_USER_ID,
  SLACK_CHANNEL_ID,
  SLACK_ROUTE,
  SLACK_SIGNING_SECRET,
  SLACK_TEAM_ID,
  slackCallSchema,
  startedTurnSchema,
} from "./protocol";
import type {
  ModelReport,
  ScriptCall,
  ScriptStep,
  SlackCall,
  SlackFailure,
  SlackMessage,
  StartedTurn,
} from "./protocol";

const { eveUrl, facts, slackUrl } = inject("e2e");

/** Facts about the warehouse's data, computed from the generated rows rather than from SQL. */
export const warehouseFacts = facts;

/** Longest a test waits for something the agent should do before failing with what it saw instead. */
const WAIT_TIMEOUT_MS = 30_000;

/** How long one request to a control route stays open waiting for a new entry. */
const LONG_POLL_MS = 5000;

/**
 * A query the planner prices far above the approval threshold, yet which runs in milliseconds.
 *
 * @remarks The planner can't estimate `random() < 0`, so it assumes a third of the sessions match and prices the cross join accordingly. No row matches when the query runs, so the join does no work and the count is 0.
 */
export const EXPENSIVE_QUERY =
  "SELECT count(*) AS pairs FROM web_sessions a CROSS JOIN (SELECT 1 FROM web_sessions WHERE random() < 0) b";

/** One event read from a session stream, narrowed by its type. */
export type EventOf<T extends SessionStreamEvent["type"]> = Extract<
  SessionStreamEvent,
  { type: T }
>;

/** A delivery's events and its summary. */
export interface Observed {
  readonly events: readonly SessionStreamEvent[];
  readonly result: DeliveryResult;
}

/**
 * Builds an `eve/client` for the fixture's HTTP channel.
 *
 * @param slackUserId - Slack user to call as. Without one, the caller is eve's `local-dev` principal.
 * @param slackChannelId - Slack channel that person writes in. Without one, the fixture's default channel.
 * @returns A client whose every request carries that identity.
 */
export const clientAs = (
  slackUserId?: string,
  slackChannelId?: string
): Client =>
  new Client({
    baseUrl: eveUrl,
    ...(slackUserId !== undefined && {
      headers: {
        [PRINCIPAL_HEADER]: slackUserId,
        ...(slackChannelId !== undefined && {
          [CHANNEL_HEADER]: slackChannelId,
        }),
      },
    }),
  });

/**
 * Writes a message that scripts the turn it starts.
 *
 * @param label - Words a person might have written, which make the message recognizable in a failure.
 * @param steps - The model calls of the turn, in order.
 * @returns The message text.
 */
export const scripted = (label: string, steps: readonly ScriptStep[]): string =>
  `${label} ${encodeScript(steps)}`;

/**
 * Scripts one `run_sql` call.
 *
 * @param purpose - The call's purpose line.
 * @param sql - The query to run.
 * @returns The tool call for a script step.
 */
export const runSql = (purpose: string, sql: string): ScriptCall => ({
  input: { purpose, sql },
  name: "run_sql",
});

/**
 * Reads a delivery's events as they arrive, then its summary.
 *
 * @param delivery - The receipt of a sent message or answer.
 * @returns Every event up to the delivery's settlement, and the settled result.
 */
export const observe = async (delivery: Delivery): Promise<Observed> => {
  const events: SessionStreamEvent[] = [];
  for await (const event of delivery.stream()) {
    events.push(event);
  }
  return { events, result: await delivery.result() };
};

/**
 * Picks the events of one type.
 *
 * @typeParam T - The event type to keep.
 * @param events - Events read from a session stream.
 * @param type - The event type to keep.
 * @returns The matching events in stream order, typed by their event.
 */
export const eventsOf = <T extends SessionStreamEvent["type"]>(
  events: readonly SessionStreamEvent[],
  type: T
): EventOf<T>[] =>
  events.filter((event): event is EventOf<T> => event.type === type);

/**
 * Reads the report a scripted `report` step wrote as the turn's reply.
 *
 * @param reply - The reply text of a settled delivery.
 * @returns What the model received on its last call of the turn.
 */
export const reportFrom = (reply: string | undefined): ModelReport =>
  modelReportSchema.parse(JSON.parse(reply ?? "null"));

/**
 * Follows a session's stream from its start until an awaited event arrives.
 *
 * @param sessionId - The session to read.
 * @param awaited - Decides whether an event is the one the test waits for.
 * @returns The session's events up to and including the awaited one.
 * @throws {@link Error} When the event hasn't arrived within the wait timeout.
 * @remarks A Slack webhook returns before its turn runs, and what the agent sends to Slack can arrive before the stream shows the event that caused it. Following the stream to a named event waits for exactly that event.
 */
export const eventsUntil = async (
  sessionId: string,
  awaited: (event: SessionStreamEvent) => boolean
): Promise<SessionStreamEvent[]> => {
  const events: SessionStreamEvent[] = [];
  const session = clientAs().sessions.attach(sessionId);
  const stream = session.stream({
    signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
    startIndex: 0,
  });
  for await (const event of stream) {
    events.push(event);
    if (awaited(event)) {
      return events;
    }
  }
  throw new Error(
    `The session's stream ended before the awaited event. Saw: ${events.map((event) => event.type).join(", ")}.`
  );
};

/**
 * Follows a session's stream until one of its turns ends.
 *
 * @param turn - The turn to wait for, from {@link slackTurn}.
 * @returns The session's events up to and including that turn's `turn.settled`.
 */
export const eventsUntilSettled = async (
  turn: StartedTurn
): Promise<SessionStreamEvent[]> =>
  await eventsUntil(
    turn.sessionId,
    (event) =>
      event.type === "turn.settled" && event.data.turnId === turn.turnId
  );

const storedLineSchema = z.union([
  z.looseObject({ at: z.string(), facts: z.array(z.looseObject({})) }),
  z.looseObject({ progress: z.looseObject({}) }),
]);

/**
 * Reads a session's stored stream as eve wrote it.
 *
 * @param sessionId - The session whose stream to read.
 * @returns The stored lines in order, without the stream route's heartbeat and end markers.
 */
export const storedLines = async (sessionId: string): Promise<StoredLine[]> => {
  const response = await fetch(
    `${eveUrl}/eve/v1/session/${sessionId}/stream?follow=false`
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)))
    .filter((line) => !("$eve" in line))
    .map(
      (line) =>
        // SAFETY: The schema confirms the line is a commit or a progress record; the checker reads the rest as eve typed it.
        storedLineSchema.parse(line) as StoredLine
    );
};

/**
 * Checks stored stream lines against eve's lifecycle rules.
 *
 * @param lines - A session's stored lines from its first line, from {@link storedLines}.
 * @returns The violations `createStreamChecker` reports, which is none for a well-formed stream.
 */
export const violationsIn = (
  lines: readonly StoredLine[]
): readonly Violation[] => {
  const checker = createStreamChecker();
  return lines.flatMap((line, position) => checker.check(line, position));
};

/**
 * Checks a session's stored stream against eve's lifecycle rules.
 *
 * @param sessionId - The session whose stream to check.
 * @returns The violations found, which is none for a well-formed stream.
 */
export const streamViolations = async (
  sessionId: string
): Promise<readonly Violation[]> => {
  const lines = await storedLines(sessionId);
  expect(lines.length).toBeGreaterThan(0);
  return violationsIn(lines);
};

/* Reads a control route's entries past a position, holding the request open while there are none. */
const readControl = async <T>(
  route: string,
  schema: z.ZodType<T>,
  after: number,
  wait: number
): Promise<T[]> => {
  const response = await fetch(
    `${slackUrl}${CONTROL_PREFIX}/${route}?after=${after}&wait=${wait}`
  );
  return z.array(schema).parse(await response.json());
};

/* Waits until `pick` finds its entry among those past `after`, failing with what arrived instead. */
const waitForEntry = async <T>(
  route: string,
  schema: z.ZodType<T>,
  pick: (entries: readonly T[]) => T | undefined,
  after: number,
  describe: (entry: T) => string
): Promise<T> => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const next = async (seen: readonly T[]): Promise<T> => {
    const found = pick(seen);
    if (found !== undefined) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting on ${route}. Saw instead: ${seen.map(describe).join(", ") || "nothing"}.`
      );
    }
    const more = await readControl(
      route,
      schema,
      after + seen.length,
      LONG_POLL_MS
    );
    return await next([...seen, ...more]);
  };
  return await next(await readControl(route, schema, after, 0));
};

/**
 * Reads the calls the fake Slack has received.
 *
 * @param after - Position from {@link slackCursor} to start reading at.
 * @returns Every call from that position on, in order of arrival, in any channel or thread.
 */
export const slackCalls = async (after: number): Promise<SlackCall[]> =>
  await readControl("calls", slackCallSchema, after, 0);

/**
 * Counts the Web API calls the fake Slack has received.
 *
 * @returns The position the next call will take, to pass as `after` when reading what a step caused.
 */
export const slackCursor = async (): Promise<number> => {
  const calls = await readControl("calls", slackCallSchema, 0, 0);
  return calls.length;
};

const inThread = (call: SlackCall, threadTs: string): boolean =>
  call.body.thread_ts === threadTs;

/**
 * Waits until the agent has finished reacting in a Slack thread, then returns what it sent there.
 *
 * @param threadTs - The thread the agent is working in.
 * @param after - Position from {@link slackCursor}, taken before the webhook that started the work.
 * @returns The thread's Web API calls from that position up to the cleared status, in order. Updates to messages posted in the thread are included, although `chat.update` names a message rather than a thread.
 * @remarks eve clears the thread's status when a turn ends or pauses for an answer, after it has rendered everything the turn produced, so the cleared status marks the end of the reaction.
 */
export const slackUntilIdle = async (
  threadTs: string,
  after: number
): Promise<SlackCall[]> => {
  const cleared = await waitForEntry(
    "calls",
    slackCallSchema,
    (calls) =>
      calls.find(
        (call) =>
          call.method === "assistant.threads.setStatus" &&
          inThread(call, threadTs) &&
          call.body.status === ""
      ),
    after,
    (call) => call.method
  );
  const calls = await readControl("calls", slackCallSchema, 0, 0);
  const threadMessages = new Set(
    calls.filter((call) => inThread(call, threadTs)).map((call) => call.ts)
  );
  return calls.filter(
    (call) =>
      call.index >= after &&
      call.index <= cleared.index &&
      (inThread(call, threadTs) ||
        (call.method === "chat.update" &&
          isString(call.body.ts) &&
          threadMessages.has(call.body.ts)))
  );
};

/**
 * Picks the messages among Web API calls.
 *
 * @param calls - Calls the fake Slack received.
 * @returns The `chat.postMessage` calls, in order.
 */
export const postedMessages = (calls: readonly SlackCall[]): SlackCall[] =>
  calls.filter((call) => call.method === "chat.postMessage");

/**
 * Makes the fake Slack reject upcoming calls.
 *
 * @param failure - The method to fail, the error to answer with, the text that scopes it to one thread, and how many calls fail.
 */
export const failSlack = async (failure: SlackFailure): Promise<void> => {
  const response = await fetch(`${slackUrl}${CONTROL_PREFIX}/failures`, {
    body: JSON.stringify(failure),
    method: "POST",
  });
  expect(response.status).toBe(200);
};

/**
 * Waits for a turn the agent started for a Slack thread.
 *
 * @param threadTs - The thread whose turns to count.
 * @param nth - Which of the thread's turns to wait for, starting at 0.
 * @returns The turn's session and turn IDs, as the fixture's recorder hook reported them.
 * @remarks Counts only turns of Slack sessions, so the turn of a subagent that the thread's session started isn't counted.
 */
export const slackTurn = async (
  threadTs: string,
  nth: number
): Promise<StartedTurn> =>
  await waitForEntry(
    "turns",
    startedTurnSchema,
    (turns) =>
      turns.filter(
        (turn) =>
          turn.threadTs === threadTs &&
          turn.channel?.startsWith("channel:slack")
      )[nth],
    0,
    (turn) => `${turn.threadTs ?? "no thread"} ${turn.turnId}`
  );

let timestamps = 0;

/**
 * Makes a Slack message timestamp no other test uses.
 *
 * @returns A timestamp derived from the running test's name and a counter, so it is the same on every run.
 * @remarks Slack threads are keyed by timestamp, and the fixture server serves every test file, so each test needs its own.
 */
export const slackTs = (): string => {
  const { currentTestName, testPath } = expect.getState();
  if (currentTestName === undefined) {
    throw new Error("slackTs() must be called inside a test.");
  }
  const digest = createHash("sha256")
    .update(`${testPath ?? ""}\n${currentTestName}`)
    .digest();
  timestamps += 1;
  const seconds = 1_700_000_000 + (digest.readUInt32BE(0) % 90_000_000);
  return `${seconds}.${String(timestamps).padStart(6, "0")}`;
};

/* Signs and posts a webhook body the way Slack does. */
const postSigned = async (
  route: string,
  body: string,
  contentType: string
): Promise<void> => {
  // Slack rejects signatures older than five minutes, so the signature carries the real time.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  const response = await fetch(`${eveUrl}${route}`, {
    body,
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
};

const writtenMessageSchema = z.object({
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string(),
  thread_ts: z.string().optional(),
  ts: z.string(),
  user: z.string().optional(),
});

/* Adds a newly written message to the fake Slack's thread history, where the agent reads it back. */
const keepInThread = async (event: JsonObject): Promise<void> => {
  const written = writtenMessageSchema.safeParse(event);
  if (!written.success || written.data.subtype === "message_changed") {
    return;
  }
  const { bot_id: botId, text, thread_ts: threadTs, ts, user } = written.data;
  const message: SlackMessage = {
    text,
    thread_ts: threadTs ?? ts,
    ts,
    type: "message",
    ...(botId !== undefined && { bot_id: botId }),
    ...(user !== undefined && { user }),
  };
  const response = await fetch(`${slackUrl}${CONTROL_PREFIX}/messages`, {
    body: JSON.stringify(message),
    method: "POST",
  });
  expect(response.status).toBe(200);
};

/**
 * Posts a signed Events API webhook, as Slack does for each event the app subscribes to.
 *
 * @param event - The inner event, such as a `message` or an `app_mention`.
 * @param route - The Slack route to post to. Defaults to the production channel's.
 * @remarks A newly written message is first added to the fake Slack's thread history, because the agent reads the thread back from Slack when it handles the event.
 */
export const sendSlackEvent = async (
  event: JsonObject,
  route: string = SLACK_ROUTE
): Promise<void> => {
  await keepInThread(event);
  const body = {
    api_app_id: "A0E2E",
    authorizations: [
      { is_bot: true, team_id: SLACK_TEAM_ID, user_id: SLACK_BOT_USER_ID },
    ],
    event,
    event_time: 1_700_000_000,
    team_id: SLACK_TEAM_ID,
    type: "event_callback",
  };
  const eventId = createHash("sha256")
    .update(JSON.stringify(body))
    .digest("hex")
    .slice(0, 16);
  await postSigned(
    route,
    JSON.stringify({ ...body, event_id: `Ev${eventId}` }),
    "application/json"
  );
};

/** A message a person writes in Slack. */
export interface SlackWriting {
  /** The Slack channel written in. Defaults to the tests' channel. */
  readonly channel?: string;
  /** The Slack route to post to. Defaults to the production channel's. */
  readonly route?: string;
  /** The message text. */
  readonly text: string;
  /** The thread's root timestamp, for a reply in a thread. A new thread when omitted. */
  readonly threadTs?: string;
  /** The message's own timestamp. */
  readonly ts: string;
  /** The Slack user writing. */
  readonly user: string;
}

const mentionText = (text: string) => `<@${SLACK_BOT_USER_ID}> ${text}`;

/* The event fields Slack sends for a message a person wrote, whatever the event's type. */
const writtenEvent = ({
  channel = SLACK_CHANNEL_ID,
  text,
  threadTs,
  ts,
  user,
}: SlackWriting): JsonObject => ({
  channel,
  channel_type: channel.startsWith("D") ? "im" : "channel",
  event_ts: ts,
  team: SLACK_TEAM_ID,
  text,
  ts,
  user,
  ...(threadTs !== undefined && { thread_ts: threadTs }),
});

/**
 * Posts a signed `app_mention` webhook, as Slack does when a person mentions the agent.
 *
 * @param writing - Who writes what, and where. The mention of the agent is added in front of the text.
 */
export const mentionAgent = async (writing: SlackWriting): Promise<void> => {
  await sendSlackEvent(
    {
      ...writtenEvent({ ...writing, text: mentionText(writing.text) }),
      type: "app_mention",
    },
    writing.route
  );
};

/**
 * Posts a signed `message` webhook, as Slack does when a person writes without mentioning the agent.
 *
 * @param writing - Who writes what, and where. A channel ID that starts with `D` makes it a direct message.
 */
export const writeMessage = async (writing: SlackWriting): Promise<void> => {
  await sendSlackEvent(
    { ...writtenEvent(writing), type: "message" },
    writing.route
  );
};

/** An edit a person makes to a message they already sent. */
export interface SlackEdit {
  /** The message text before the edit, after the mention of the agent. */
  readonly previousText: string;
  /** The Slack route to post to. Defaults to the production channel's. */
  readonly route?: string;
  /** The new message text after the mention of the agent. */
  readonly text: string;
  /** The edited message's timestamp. */
  readonly ts: string;
  /** The Slack user who wrote and edited the message. */
  readonly user: string;
}

/**
 * Posts a signed `message_changed` webhook, as Slack does when a person edits a message.
 *
 * @param edit - The message, its old and new text, and its author.
 */
export const editMessage = async ({
  previousText,
  route = SLACK_ROUTE,
  text,
  ts,
  user,
}: SlackEdit): Promise<void> => {
  const editedTs = slackTs();
  const message = { team: SLACK_TEAM_ID, ts, type: "message", user };
  await sendSlackEvent(
    {
      channel: SLACK_CHANNEL_ID,
      channel_type: "channel",
      event_ts: editedTs,
      hidden: true,
      message: {
        ...message,
        edited: { ts: editedTs, user },
        text: mentionText(text),
      },
      previous_message: { ...message, text: mentionText(previousText) },
      subtype: "message_changed",
      ts: editedTs,
      type: "message",
    },
    route
  );
};

const buttonSchema = z.looseObject({
  action_id: z.string(),
  text: z.object({ text: z.string() }),
  type: z.literal("button"),
  value: z.string(),
});

/** A button on a message the agent posted. */
export type SlackButton = z.infer<typeof buttonSchema>;

/* The buttons anywhere inside a block structure, in document order. */
const buttonsIn = (value: SlackCall["body"][string]): SlackButton[] => {
  if (Array.isArray(value)) {
    return value.flatMap(buttonsIn);
  }
  if (!isObject(value)) {
    return [];
  }
  const button = buttonSchema.safeParse(value);
  return button.success
    ? [button.data]
    : Object.values(value).flatMap(buttonsIn);
};

/**
 * Reads the buttons of a posted message.
 *
 * @param message - A `chat.postMessage` or `chat.update` call.
 * @returns The buttons in the message's blocks, in order, wherever a block nests them.
 */
export const buttonsOf = (message: SlackCall): SlackButton[] =>
  buttonsIn(message.body.blocks ?? []);

/**
 * Posts a signed `block_actions` webhook, as Slack does when a person clicks a button.
 *
 * @param card - The `chat.postMessage` call that posted the message holding the button.
 * @param label - The clicked button's label.
 * @param user - The Slack user clicking.
 * @throws {@link Error} When the message has no button with that label.
 */
export const clickButton = async (
  card: SlackCall,
  label: string,
  user: string
): Promise<void> => {
  const button = buttonsOf(card).find(
    (candidate) => candidate.text.text === label
  );
  if (button === undefined) {
    throw new Error(`The message has no "${label}" button.`);
  }
  const { blocks, channel, text, thread_ts: threadTs } = card.body;
  const payload = {
    actions: [{ ...button, action_ts: slackTs(), block_id: "actions" }],
    api_app_id: "A0E2E",
    channel: { id: channel, name: "e2e" },
    container: {
      channel_id: channel,
      is_ephemeral: false,
      message_ts: card.ts,
      thread_ts: threadTs,
      type: "message",
    },
    message: {
      blocks,
      bot_id: "B0BOT",
      text,
      thread_ts: threadTs,
      ts: card.ts,
      type: "message",
      user: SLACK_BOT_USER_ID,
    },
    response_url: "https://hooks.example.com/actions/e2e",
    team: { domain: "e2e", id: SLACK_TEAM_ID },
    trigger_id: "trigger.e2e",
    type: "block_actions",
    user: {
      id: user,
      name: user.toLowerCase(),
      team_id: SLACK_TEAM_ID,
      username: user.toLowerCase(),
    },
  };
  await postSigned(
    SLACK_ROUTE,
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    "application/x-www-form-urlencoded"
  );
};
