/**
 * Fixtures for exercising Slack renderer event handlers directly.
 *
 * @packageDocumentation
 */
import type { ChannelEventContext } from "eve/channels";
import type {
  SlackEventContext,
  SlackRenderer,
  SlackThread,
} from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import { emptySessionView } from "eve/events";
import { vi } from "vitest";

import { sessionContext, slackAuth } from "./session";

type Events = NonNullable<SlackRenderer["events"]>;

/** The renderer context a handler under test receives, with an observable thread post. */
export interface RendererContext {
  readonly ctx: ChannelEventContext<SlackEventContext>;
  readonly post: ReturnType<typeof vi.fn<SlackThread["post"]>>;
}

/**
 * Builds the renderer context for one event in turn-1.
 *
 * @param options - The current caller and an optional thread post implementation; posts succeed by default.
 * @returns The context and its thread post spy.
 * @remarks Only the session, an empty view, and `channel.thread.post` are provided. A handler that reads any other part of the channel fails the test.
 */
export const rendererContext = ({
  current = slackAuth(),
  post = () => Promise.resolve({ id: "posted-ts", raw: { ok: true } }),
}: {
  current?: SessionAuthContext;
  post?: SlackThread["post"];
} = {}): RendererContext => {
  const postSpy = vi.fn<SlackThread["post"]>(post);
  const thread: Pick<SlackThread, "post"> = { post: postSpy };
  const ctx = {
    ...sessionContext({ current }),
    channel: { thread },
    position: { index: 0, line: 0 },
    view: emptySessionView(),
  };
  // SAFETY: The analyst's handlers read only the session and `channel.thread.post`; missing members throw if a change starts using them.
  return { ctx: ctx as RendererContext["ctx"], post: postSpy };
};

/**
 * Runs the analyst's final-reply handler on a reply text, observing whether eve's default runs.
 *
 * @param events - The renderer's event handlers.
 * @param value - Final reply text.
 * @param options - The phase of the content, `reply` by default, and the renderer context.
 * @returns The handler's completion and the `next` spy for eve's default rendering.
 */
export const completeReply = (
  events: Events,
  value: string,
  {
    context = rendererContext(),
    phase = "reply",
  }: { context?: RendererContext; phase?: string } = {}
) => {
  const handler = events["content.completed"];
  if (!handler) {
    throw new Error("Expected a content.completed handler.");
  }
  const next = vi.fn(() => Promise.resolve());
  const done = handler(
    {
      data: { kind: "text", partId: "part-1", phase, value },
      scope: { turnId: "turn-1" },
      type: "content.completed",
    },
    context.ctx,
    next
  );
  return { done: Promise.resolve(done), next };
};
