/**
 * A stand-in for the Slack Web API that records every request the agent makes, and the control routes tests use to observe the fixture.
 *
 * @packageDocumentation
 */
import { once, setMaxListeners } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import type { JsonObject, JsonValue } from "#lib/json";
import { isString } from "#lib/values";

import {
  CONTROL_PREFIX,
  SLACK_BOT_USER_ID,
  UPLOAD_METHOD,
  SLACK_TEAM_ID,
  slackFailureSchema,
  slackMessageSchema,
  startedTurnSchema,
} from "./protocol";
import type {
  SlackCall,
  SlackFailure,
  SlackMessage,
  StartedTurn,
} from "./protocol";

/** A running fake Slack. */
export interface FakeSlack {
  /** Stops the server and ends any waiting requests. */
  readonly stop: () => Promise<void>;
  /** Origin the control routes and the Web API are served from. */
  readonly url: string;
}

/** The agent's own bot ID, which Slack puts on every message the agent posts. */
const BOT_ID = "B0BOT";

/** Slack's limit on the text of all `markdown` blocks in one message, and on `markdown_text`. */
const MAX_MARKDOWN_CHARS = 12_000;

/** Methods whose message content Slack checks against its size limits. */
const MESSAGE_METHODS = new Set([
  "chat.postEphemeral",
  "chat.postMessage",
  "chat.update",
]);

/** Longest a control request waits for a new entry before answering with none. */
const MAX_WAIT_MS = 10_000;

const fieldsSchema = z.record(z.string(), z.json());

const addressSchema = z.object({ port: z.number() });

/* An append-only list whose readers can wait for the next entry. */
const createLog = <T>() => {
  const entries: T[] = [];
  const arrivals = new EventTarget();
  // Every waiting reader listens, and a slow test may have several.
  setMaxListeners(0, arrivals);
  return {
    entries,
    push: (entry: T) => {
      entries.push(entry);
      arrivals.dispatchEvent(new Event("entry"));
    },
    /* The entries past `after`, waiting up to `wait` ms for one to arrive when there are none yet. */
    since: async (after: number, wait: number): Promise<T[]> => {
      if (entries.length <= after && wait > 0) {
        try {
          await once(arrivals, "entry", {
            signal: AbortSignal.timeout(Math.min(wait, MAX_WAIT_MS)),
          });
        } catch {
          // Nothing arrived in time, so the reader gets an empty list.
        }
      }
      return entries.slice(after);
    },
    /* Ends every wait, as when the server stops. */
    wake: () => {
      arrivals.dispatchEvent(new Event("entry"));
    },
  };
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

/** The decoded fields of one Web API request. */
type Fields = SlackCall["body"];

/* Form values that hold JSON, such as blocks, arrive as strings. */
const parseField = (value: string): Fields[string] => {
  if (!(value.startsWith("[") || value.startsWith("{"))) {
    return value;
  }
  try {
    return z.json().parse(JSON.parse(value));
  } catch {
    return value;
  }
};

const parseFields = (raw: string, contentType: string): Fields =>
  contentType.includes("json")
    ? fieldsSchema.parse(JSON.parse(raw || "{}"))
    : Object.fromEntries(
        [...new URLSearchParams(raw)].map(([name, value]) => [
          name,
          parseField(value),
        ])
      );

const send = (response: ServerResponse, status: number, body: JsonValue) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const markdownBlocksSchema = z.array(
  z.looseObject({ text: z.json().optional(), type: z.string() })
);

/* The error Slack answers with when a message's Markdown is longer than it accepts, or null. */
const sizeError = (method: string, body: Fields): string | null => {
  if (!MESSAGE_METHODS.has(method)) {
    return null;
  }
  if (
    isString(body.markdown_text) &&
    body.markdown_text.length > MAX_MARKDOWN_CHARS
  ) {
    return "msg_too_long";
  }
  const blocks = markdownBlocksSchema.safeParse(body.blocks ?? []);
  const markdownChars = (blocks.data ?? [])
    .filter((block) => block.type === "markdown")
    .reduce(
      (total, block) => total + (isString(block.text) ? block.text.length : 0),
      0
    );
  return markdownChars > MAX_MARKDOWN_CHARS ? "invalid_blocks" : null;
};

/* The method-specific part of a successful Web API reply. */
const answer = (
  method: string,
  body: Fields,
  ts: string | null,
  thread: readonly SlackMessage[],
  upload: { readonly fileId: string; readonly url: string }
): JsonObject => {
  switch (method) {
    case "auth.test": {
      return {
        bot_id: BOT_ID,
        team: "E2E",
        team_id: SLACK_TEAM_ID,
        url: "https://e2e.example.com/",
        user: "analyst",
        user_id: SLACK_BOT_USER_ID,
      };
    }
    case "chat.postMessage": {
      return {
        channel: body.channel,
        message: { text: body.text, ts, type: "message" },
        ts,
      };
    }
    case "chat.update": {
      return { channel: body.channel, text: body.text, ts: body.ts };
    }
    case "chat.postEphemeral": {
      return { message_ts: ts };
    }
    case "chat.getPermalink": {
      return {
        channel: body.channel,
        permalink: `https://e2e.example.com/archives/${String(body.channel)}/p${String(body.message_ts).replace(".", "")}`,
      };
    }
    case "users.info": {
      const id = String(body.user);
      return {
        user: {
          id,
          is_bot: id === SLACK_BOT_USER_ID,
          name: id.toLowerCase(),
          profile: { display_name: `Display ${id}`, real_name: `Real ${id}` },
          real_name: `Real ${id}`,
          team_id: SLACK_TEAM_ID,
        },
      };
    }
    case "conversations.info": {
      const directMessage = String(body.channel).startsWith("D");
      return {
        channel: {
          id: body.channel,
          is_channel: !directMessage,
          is_im: directMessage,
          is_mpim: false,
          is_private: false,
          name: "e2e",
        },
      };
    }
    case "files.getUploadURLExternal": {
      return { file_id: upload.fileId, upload_url: upload.url };
    }
    case "files.completeUploadExternal": {
      return { files: body.files };
    }
    case "conversations.replies": {
      return { has_more: false, messages: [...thread] };
    }
    case "conversations.history": {
      return { has_more: false, messages: [] };
    }
    default: {
      return {};
    }
  }
};

/**
 * Starts the fake Slack Web API on a free local port.
 *
 * @returns The server's URL and a function that stops it.
 * @remarks Serves the Web API under `/api/<method>` and answers every method with `ok: true` and a plausible body, assigning each posted message the next timestamp from a counter. Tests read what arrived from `GET /__e2e/calls?after=<n>&wait=<ms>`, which holds the request open until a call past `n` arrives, and script failures with `POST /__e2e/failures`. The fixture's recorder hook posts each started turn to `/__e2e/turns`, which tests read the same way as calls. Messages whose Markdown is longer than Slack accepts are rejected as Slack rejects them, and files can be uploaded through the URL `files.getUploadURLExternal` returns, which records the bytes as a call named `upload`. `conversations.replies` serves each thread's history: the messages tests register with `POST /__e2e/messages` before sending their webhook, and the messages the agent posted.
 */
export const startFakeSlack = async (): Promise<FakeSlack> => {
  const calls = createLog<SlackCall>();
  const turns = createLog<StartedTurn>();
  const failures: SlackFailure[] = [];
  const threads = new Map<string, SlackMessage[]>();
  let posted = 0;
  let uploads = 0;

  /* Adds a message to its thread's history, as Slack does for everything written in a thread. */
  const keep = (message: SlackMessage) => {
    threads.set(message.thread_ts, [
      ...(threads.get(message.thread_ts) ?? []),
      message,
    ]);
  };

  const nextTs = () => {
    posted += 1;
    return `1800000000.${String(posted).padStart(6, "0")}`;
  };

  /* The scripted failure for this call, used up one call at a time. */
  const takeFailure = (method: string, raw: string): string | null => {
    const at = failures.findIndex(
      (failure) => failure.method === method && raw.includes(failure.match)
    );
    const failure = failures[at];
    if (failure === undefined) {
      return null;
    }
    if (failure.times <= 1) {
      failures.splice(at, 1);
    } else {
      failures[at] = { ...failure, times: failure.times - 1 };
    }
    return failure.error;
  };

  const handleApi = async (
    method: string,
    request: IncomingMessage,
    response: ServerResponse
  ) => {
    const raw = await readBody(request);
    const body = parseFields(raw, request.headers["content-type"] ?? "");
    const error = takeFailure(method, raw) ?? sizeError(method, body);
    const posts =
      error === null &&
      (method === "chat.postMessage" || method === "chat.postEphemeral");
    const ts = posts ? nextTs() : null;
    calls.push({ body, index: calls.entries.length, method, ts });
    const { markdown_text: markdown, text, thread_ts: threadTs } = body;
    if (method === "chat.postMessage" && ts !== null && isString(threadTs)) {
      keep({
        bot_id: BOT_ID,
        text: [text, markdown].find(isString) ?? "",
        thread_ts: threadTs,
        ts,
        type: "message",
        user: SLACK_BOT_USER_ID,
      });
    }
    const thread = threads.get(String(body.ts)) ?? [];
    uploads += method === "files.getUploadURLExternal" ? 1 : 0;
    const fileId = `F0E2E${uploads}`;
    const upload = {
      fileId,
      url: `http://${request.headers.host ?? ""}/upload/${fileId}`,
    };
    send(
      response,
      200,
      error === null
        ? { ok: true, ...answer(method, body, ts, thread, upload) }
        : { error, ok: false }
    );
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://fake-slack");
    const after = Number(url.searchParams.get("after") ?? "0");
    const wait = Number(url.searchParams.get("wait") ?? "0");
    switch (url.pathname) {
      case `${CONTROL_PREFIX}/calls`: {
        send(response, 200, await calls.since(after, wait));
        return;
      }
      case `${CONTROL_PREFIX}/turns`: {
        if (request.method === "POST") {
          turns.push(
            startedTurnSchema.parse(JSON.parse(await readBody(request)))
          );
          send(response, 200, { ok: true });
          return;
        }
        send(response, 200, await turns.since(after, wait));
        return;
      }
      case `${CONTROL_PREFIX}/messages`: {
        keep(slackMessageSchema.parse(JSON.parse(await readBody(request))));
        send(response, 200, { ok: true });
        return;
      }
      case `${CONTROL_PREFIX}/failures`: {
        failures.push(
          slackFailureSchema.parse(JSON.parse(await readBody(request)))
        );
        send(response, 200, { ok: true });
        return;
      }
      default: {
        if (url.pathname.startsWith("/upload/")) {
          // The bytes of a file, sent to the URL that files.getUploadURLExternal handed out.
          calls.push({
            body: {
              content: await readBody(request),
              file_id: url.pathname.slice("/upload/".length),
            },
            index: calls.entries.length,
            method: UPLOAD_METHOD,
            ts: null,
          });
          response.writeHead(200).end("OK");
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          await handleApi(
            url.pathname.slice("/api/".length),
            request,
            response
          );
          return;
        }
        send(response, 404, { error: "unknown_route", ok: false });
      }
    }
  };

  const server = createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      send(response, 500, { error: String(error), ok: false });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = addressSchema.parse(server.address());
  return {
    stop: async () => {
      calls.wake();
      turns.wake();
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
    url: `http://127.0.0.1:${port}`,
  };
};
