/**
 * Typed Slack fixtures for unit tests, built against eve's public Slack types
 * so fixture drift after an eve upgrade fails typecheck instead of passing
 * silently through a cast.
 *
 * @packageDocumentation
 */
import type {
  SlackAuthor,
  SlackChannelState,
  SlackEventContext,
  SlackHandle,
  SlackInboundMessageContext,
  SlackMessage,
  SlackRendererEvents,
  SlackRenderNext,
  SlackThread,
} from "eve/channels/slack";
import { emptySessionView } from "eve/events";
import type { SessionView } from "eve/events";
import { vi } from "vitest";

import { sessionContext } from "./session";

type SessionOptions = Parameters<typeof sessionContext>[0];

const unsupported = (name: string) => (): never => {
  throw new Error(`This test does not provide ${name}.`);
};

/**
 * Builds the author eve derives for a human Slack user.
 *
 * @param overrides - Author properties to replace, such as `isBot` or `isMe`.
 * @returns A human author with user ID U123 unless overridden.
 */
export const slackAuthor = (
  overrides: Partial<SlackAuthor> = {}
): SlackAuthor => ({
  fullName: undefined,
  isBot: false,
  isMe: false,
  userId: "U123",
  userName: undefined,
  ...overrides,
});

/**
 * Builds a complete inbound Slack message matching eve's public webhook contract.
 *
 * @param overrides - Message properties to replace for the scenario under test.
 * @returns A human-authored message with stable channel, workspace, and thread identifiers.
 */
export const slackMessage = (
  overrides: Partial<SlackMessage> = {}
): SlackMessage => {
  const text = overrides.text ?? "";
  return {
    attachments: [],
    author: slackAuthor(),
    channelId: "C123",
    markdown: text,
    raw: {},
    teamId: "T123",
    text,
    threadTs: "100.1",
    ts: "100.2",
    ...overrides,
  };
};

/**
 * Builds a Slack thread handle with observable delivery and subscription operations.
 *
 * @param overrides - Explicit thread methods or properties required by the scenario.
 * @returns A thread fixture whose supported delivery methods return stable receipts and whose DMs fail unless supplied.
 */
export const slackThread = (
  overrides: Partial<SlackThread> = {}
): SlackThread => ({
  listParticipants: vi.fn<SlackThread["listParticipants"]>(() =>
    Promise.resolve([])
  ),
  mentionUser: (userId) => `<@${userId}>`,
  post: vi.fn<SlackThread["post"]>(
    async () =>
      await {
        id: "posted-ts",
        raw: { ok: true },
      }
  ),
  postDirectMessage: vi.fn<SlackThread["postDirectMessage"]>(
    unsupported("DMs")
  ),
  postEphemeral: vi.fn<SlackThread["postEphemeral"]>(
    async () =>
      await {
        id: "ephemeral-ts",
        raw: { ok: true },
      }
  ),
  recentMessages: [],
  refresh: vi.fn<SlackThread["refresh"]>(() => Promise.resolve()),
  startTyping: vi.fn<SlackThread["startTyping"]>(() => Promise.resolve()),
  ...overrides,
});

/* The `ctx.slack` handle; `request` defaults to an `{ ok: true }` spy. */
const slackHandle = (overrides: Partial<SlackHandle> = {}): SlackHandle => ({
  channelId: "C123",
  codeChannel: false,
  request: vi.fn<SlackHandle["request"]>(async () => await { ok: true }),
  teamId: "T123",
  threadTs: "100.1",
  uploadFiles: unsupported("file uploads"),
  ...overrides,
});

interface InboundContextOptions {
  mentioned?: boolean;
  slack?: Partial<SlackHandle>;
  subscribed?: boolean;
  thread?: Partial<SlackThread>;
}

/**
 * Builds the context supplied to Slack inbound message hooks.
 *
 * @param options - Mention/subscription state and optional Slack API or thread overrides.
 * @returns Routing context whose session mutation methods fail when unexpectedly called.
 */
export const inboundContext = ({
  mentioned = false,
  slack,
  subscribed = false,
  thread,
}: InboundContextOptions = {}): SlackInboundMessageContext => ({
  cancel: unsupported("session cancellation"),
  clear: unsupported("session clearing"),
  compact: unsupported("session compaction"),
  end: unsupported("session ending"),
  isBotMentioned: vi.fn(() => mentioned),
  isDMOrPrivateChannel: vi.fn(() => Promise.resolve(false)),
  isSubscribed: vi.fn(async () => await subscribed),
  openCodeChannel: unsupported("code channels"),
  resolveSession: unsupported("session resolution"),
  respond: unsupported("input responses"),
  send: unsupported("session sends"),
  slack: slackHandle(slack),
  thread: slackThread(thread),
});

interface EventContextOptions {
  slack?: Partial<SlackHandle>;
  state?: Partial<SlackChannelState>;
  thread?: Partial<SlackThread>;
}

/**
 * Builds the hydrated Slack channel context that renderers read as `ctx.channel`.
 *
 * @param options - Slack API, channel-state, and thread overrides for the renderer test.
 * @returns A channel fixture with stable workspace/thread coordinates and observable thread methods.
 */
const slackEventContext = ({
  slack,
  state,
  thread,
}: EventContextOptions = {}): SlackEventContext => ({
  slack: slackHandle(slack),
  state: { channelId: "C123", teamId: "T123", threadTs: "100.1", ...state },
  thread: slackThread(thread),
});

type RendererContext = Parameters<
  NonNullable<SlackRendererEvents["content.completed"]>
>[1];

/**
 * Builds the context eve passes to a Slack renderer's event handler.
 *
 * @param options - Channel overrides, session principals, and the session view; the view defaults to an empty session.
 * @returns Session context whose `channel` is the Slack fixture from {@link slackEventContext}.
 */
export const rendererContext = ({
  view,
  ...options
}: EventContextOptions &
  SessionOptions & { view?: SessionView } = {}): RendererContext => ({
  ...sessionContext(options),
  channel: slackEventContext(options),
  position: { index: 0, line: 0 },
  view: view ?? emptySessionView(),
});

type ContentCompleted = NonNullable<SlackRendererEvents["content.completed"]>;

type ContentCompletedData = Parameters<ContentCompleted>[0]["data"];

/**
 * Exercises a content-completed renderer while observing final reply delegation.
 *
 * @param handler - Renderer whose posting or suppression behavior is under test.
 * @returns The renderer context, completion driver, post spy, and next-renderer spy.
 * @remarks `complete()` sends a final text reply scoped to turn-1 unless overridden; a null turn ID omits the scope. The harness observes whether the chain continues without duplicating eve's own rendering.
 */
export const contentCompletedHarness = (handler: ContentCompleted) => {
  const post = vi.fn<SlackThread["post"]>(
    async () =>
      await {
        id: "posted-ts",
        raw: { ok: true },
      }
  );
  const ctx = rendererContext({ thread: { post } });
  const next = vi.fn<SlackRenderNext<"content.completed">>(() =>
    Promise.resolve()
  );
  const complete = (
    overrides: Partial<ContentCompletedData> = {},
    turnId: string | null = "turn-1"
  ) =>
    handler(
      {
        data: {
          kind: "text",
          partId: "part-1",
          phase: "reply",
          value: "Here is the result.",
          ...overrides,
        },
        ...(turnId !== null && { scope: { turnId } }),
        type: "content.completed",
      },
      ctx,
      next
    );
  return { complete, ctx, next, post };
};
