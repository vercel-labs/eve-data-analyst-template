/**
 * What the fixture agent, the fake Slack, and the tests agree on: the script a test hands the mock model, the records the fixture reports, and the fixed credentials of the fake services.
 *
 * @packageDocumentation
 */
import { z } from "zod";

/** Bot token the fixture's Slack channels and visualization tools send to the fake Slack. */
export const SLACK_BOT_TOKEN = "xoxb-e2e-bot-token";

/** Secret that signs the webhooks the tests send to the fixture's Slack routes. */
export const SLACK_SIGNING_SECRET = "e2e-signing-secret";

/** Slack workspace every test principal belongs to. */
export const SLACK_TEAM_ID = "T0E2E";

/** The agent's own Slack user, as the fake Slack reports it. */
export const SLACK_BOT_USER_ID = "U0BOT";

/** Slack channel the tests write in. */
export const SLACK_CHANNEL_ID = "C0E2E";

/** Slack channel the fixture lists in `SLACK_AUTO_REPLY_CHANNEL_IDS`, where top-level posts need no mention. */
export const SLACK_AUTO_REPLY_CHANNEL_ID = "C0AUTO";

/** Route of the production Slack channel in the fixture. */
export const SLACK_ROUTE = "/eve/v1/slack";

/** Route of the fixture's second Slack channel, which keeps eve's defaults. */
export const SLACK_DEFAULT_ROUTE = "/eve/v1/slack-default";

/** Request header naming the Slack user a test calls the HTTP channel as. */
export const PRINCIPAL_HEADER = "x-e2e-slack-user";

/** Request header naming the Slack channel that person writes in. Optional; the fixture has a default. */
export const CHANNEL_HEADER = "x-e2e-slack-channel";

/** Environment variable holding the fake Slack Web API base URL. */
export const SLACK_API_URL_ENV = "E2E_SLACK_API_URL";

/** Environment variable holding the origin of the routes tests use to observe the fixture. */
export const CONTROL_URL_ENV = "E2E_CONTROL_URL";

/** Path prefix of the routes tests use to read what the fixture recorded and to script failures. */
export const CONTROL_PREFIX = "/__e2e";

/** Method name under which the fake Slack records the bytes of an uploaded file, with `file_id` and `content` as its fields. */
export const UPLOAD_METHOD = "upload";

/** One Web API request the fake Slack received. */
export const slackCallSchema = z.object({
  /** Decoded request fields. Form fields holding JSON, such as `blocks`, are parsed. */
  body: z.record(z.string(), z.json()),
  /** Position in the order of arrival, starting at 0. */
  index: z.number(),
  /** Web API method, such as `chat.postMessage`. */
  method: z.string(),
  /** Timestamp the fake assigned to the message this call posted, or null when it posted none. */
  ts: z.string().nullable(),
});

/** One Web API request the fake Slack received. */
export type SlackCall = z.infer<typeof slackCallSchema>;

/** A failure a test scripts for upcoming Web API calls. */
export const slackFailureSchema = z.object({
  /** Slack error code to answer with, such as `invalid_blocks`. */
  error: z.string(),
  /** Only fail calls whose raw request body contains this text, such as a thread timestamp. */
  match: z.string(),
  /** Web API method to fail. */
  method: z.string(),
  /** How many matching calls fail before the method answers normally again. */
  times: z.number().int().positive(),
});

/** A failure a test scripts for upcoming Web API calls. */
export type SlackFailure = z.infer<typeof slackFailureSchema>;

/** A message a person or another app wrote in Slack, which the fake Slack then serves as thread history. */
export const slackMessageSchema = z.object({
  /** Bot that wrote the message, for a message without a person behind it. */
  bot_id: z.string().optional(),
  text: z.string(),
  /** Root timestamp of the thread the message belongs to. A thread's first message names itself. */
  thread_ts: z.string(),
  ts: z.string(),
  type: z.literal("message"),
  /** Slack user who wrote the message. */
  user: z.string().optional(),
});

/** A message in a Slack thread. */
export type SlackMessage = z.infer<typeof slackMessageSchema>;

/** One turn the fixture agent started, as its recorder hook reports it. */
export const startedTurnSchema = z.object({
  /** Channel the session came from, such as `channel:slack`. */
  channel: z.string().nullable(),
  /** The caller's principal ID, or null for an unauthenticated turn. */
  principalId: z.string().nullable(),
  sessionId: z.string(),
  /** Slack thread the caller wrote in, or null when the caller is not a Slack principal. */
  threadTs: z.string().nullable(),
  turnId: z.string(),
});

/** One turn the fixture agent started, as its recorder hook reports it. */
export type StartedTurn = z.infer<typeof startedTurnSchema>;

const scriptStepSchema = z.object({
  /** Tool calls to make in this step. A step without calls ends the turn. */
  calls: z
    .array(
      z.object({ input: z.record(z.string(), z.json()), name: z.string() })
    )
    .optional(),
  /** Replace `text` with a JSON {@link ModelReport} of what the model received. */
  report: z.boolean().optional(),
  /** Text the model writes in this step. */
  text: z.string().optional(),
  /** Token counts the model reports for this step, instead of eve's estimate. */
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
});

/** One model call of a scripted turn. */
export type ScriptStep = z.infer<typeof scriptStepSchema>;

/** One tool call the scripted model makes. */
export type ScriptCall = NonNullable<ScriptStep["calls"]>[number];

/** What the scripted model saw on one call, written as its reply when a step sets `report`. */
export const modelReportSchema = z.object({
  /** Every prompt message in order, with its text. */
  messages: z.array(z.object({ role: z.string(), text: z.string() })),
  /** Every tool result in the prompt. */
  toolResults: z.array(
    z.object({ isError: z.boolean(), name: z.string(), output: z.json() })
  ),
  /** Names of the tools offered to the model. */
  tools: z.array(z.string()),
});

/** What the scripted model saw on one call. */
export type ModelReport = z.infer<typeof modelReportSchema>;

const SCRIPT = /SCRIPT:(?<hex>[0-9a-f]+)/gu;

/** A script found in message text. */
export interface FoundScript {
  /** The script's hex encoding, which identifies it within a conversation. */
  readonly hex: string;
  readonly steps: readonly ScriptStep[];
}

/**
 * Writes a script as message text.
 *
 * @param steps - The model calls of the turn this message starts, in order.
 * @returns A `SCRIPT:` marker followed by the steps as hex-encoded JSON.
 * @remarks Hex survives Slack's text escaping and eve's Markdown conversion unchanged, which SQL and JSON would not.
 */
export const encodeScript = (steps: readonly ScriptStep[]): string =>
  `SCRIPT:${Buffer.from(JSON.stringify(steps), "utf-8").toString("hex")}`;

/**
 * Reads the last script in a message.
 *
 * @param text - Message text as the model received it, including any wrapping a channel added.
 * @returns The script and its encoding, or null when the text holds no script.
 */
export const findScript = (text: string): FoundScript | null => {
  const hex = [...text.matchAll(SCRIPT)].at(-1)?.groups?.hex;
  return hex === undefined
    ? null
    : {
        hex,
        steps: z
          .array(scriptStepSchema)
          .parse(JSON.parse(Buffer.from(hex, "hex").toString("utf-8"))),
      };
};
