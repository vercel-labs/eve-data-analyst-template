/**
 * The parts of eve 1.0 this project is written against. A change here after an eve upgrade
 * names the code to revisit before anything fails at runtime.
 *
 * @packageDocumentation
 */
import type { AgentLimitsDefinition, SessionUsageLimit, TokenUsage } from "eve";
import type {
  SlackChannelConfig,
  SlackRenderer,
  SlackRendererEvents,
} from "eve/channels/slack";
import type { SessionAuthContext } from "eve/context";
import type {
  CallOutcome,
  ContentCompletedData,
  InteractionKind,
  TurnOutcome,
} from "eve/events";
import type { HookContext, HookEvent, HookEventKey } from "eve/hooks";
import type { MemoryScopeDefinition } from "eve/memory";
import type { ToolContext } from "eve/tools";
import type {
  ApprovalContext,
  ApprovalRequest,
  ApprovalResponse,
} from "eve/tools/approval";
import { describe, expectTypeOf, it } from "vitest";

import type { runSqlApprovalCard } from "#lib/analyst/approval-card";
import type threadRoleGuard from "#lib/analyst/thread-role-guard";
import type { createSlackInboundHandlers } from "#lib/integrations/slack/channel";
import type { replyEvents } from "#lib/integrations/slack/replies";
import type { byHumanPrincipal, bySlackChannel } from "#lib/memory/scope";
import type { exceedsSessionUsage } from "#lib/session-usage";

describe("session events (stream version 27)", () => {
  it("has the event names the hooks and renderers subscribe to", () => {
    expectTypeOf<
      "call.settled" | "content.completed" | "turn.settled" | "turn.started"
    >().toExtend<HookEventKey>();
  });

  it("no longer has the event names eve 0.75 used", () => {
    expectTypeOf<"action.result">().not.toExtend<HookEventKey>();
    expectTypeOf<"input.resolved">().not.toExtend<HookEventKey>();
    expectTypeOf<"message.completed">().not.toExtend<HookEventKey>();
    expectTypeOf<"turn.cancelled">().not.toExtend<HookEventKey>();
    expectTypeOf<SlackRendererEvents>().not.toHaveProperty("message.completed");
    expectTypeOf<SlackRendererEvents>().not.toHaveProperty("input.requested");
  });

  it("ends a call with one event that carries an outcome and the call's ID, not its name", () => {
    type Settled = HookEvent<"call.settled">["data"];
    expectTypeOf<Settled["callId"]>().toBeString();
    expectTypeOf<Settled["outcome"]>().toEqualTypeOf<CallOutcome>();
    expectTypeOf<"completed">().toExtend<CallOutcome>();
    expectTypeOf<Settled>().not.toHaveProperty("toolName");
  });

  it("ends a turn with one event whose outcome can be cancelled", () => {
    expectTypeOf<
      HookEvent<"turn.settled">["data"]["outcome"]
    >().toEqualTypeOf<TurnOutcome>();
    expectTypeOf<"cancelled">().toExtend<TurnOutcome>();
    expectTypeOf<HookEvent<"turn.started">["data"]["turnId"]>().toBeString();
  });

  it("completes content with a phase, a kind, and the part's whole value", () => {
    // Both unions are open, so eve can add values without a type error here.
    expectTypeOf<ContentCompletedData["phase"]>().toBeString();
    expectTypeOf<ContentCompletedData["kind"]>().toBeString();
    expectTypeOf<ContentCompletedData>().toHaveProperty("value");
    expectTypeOf<ContentCompletedData>().not.toHaveProperty("finishReason");
    expectTypeOf<ContentCompletedData>().not.toHaveProperty("message");
  });

  it("treats approvals and budget prompts as kinds of one interaction", () => {
    expectTypeOf<"approval" | "budget">().toExtend<InteractionKind>();
  });
});

describe("hooks and renderers", () => {
  it("registers the thread role guard for call.settled and turn.started only", () => {
    expectTypeOf<keyof (typeof threadRoleGuard)["events"]>().toEqualTypeOf<
      "call.settled" | "turn.started"
    >();
  });

  it("gives a hook the session view, the caller, and cancel", () => {
    type Context = HookContext<"turn.started">;
    expectTypeOf<Context>().toHaveProperty("view");
    expectTypeOf<Context["cancel"]>().toBeCallableWith("reason");
    expectTypeOf<
      Context["session"]["auth"]["current"]
    >().toEqualTypeOf<SessionAuthContext | null>();
    // Only turn.settled handlers can start another turn.
    expectTypeOf<Context>().not.toHaveProperty("continue");
    expectTypeOf<HookContext<"turn.settled">>().toHaveProperty("continue");
  });

  it("renders replies and cancelled turns, and leaves every other event to eve", () => {
    expectTypeOf<keyof typeof replyEvents>().toEqualTypeOf<
      "content.completed" | "turn.settled"
    >();
    expectTypeOf<typeof replyEvents>().toExtend<SlackRendererEvents>();
  });

  it("restyles approval cards through interactionCard", () => {
    expectTypeOf<typeof runSqlApprovalCard>().toExtend<SlackRenderer>();
    expectTypeOf<
      Parameters<NonNullable<SlackRenderer["interactionCard"]>>[0]
    >().toHaveProperty("interaction");
    expectTypeOf<
      ReturnType<NonNullable<SlackRenderer["interactionCard"]>>
    >().toHaveProperty("controls");
  });

  it("builds every inbound Slack hook, including the one for edits", () => {
    expectTypeOf<
      keyof ReturnType<typeof createSlackInboundHandlers>
    >().toEqualTypeOf<
      "onAppMention" | "onDirectMessage" | "onMessage" | "onMessageEdited"
    >();
    expectTypeOf<SlackChannelConfig>().toHaveProperty("onMessageEdited");
    expectTypeOf<SlackChannelConfig>().toHaveProperty("onAnswers");
    expectTypeOf<SlackChannelConfig>().not.toHaveProperty("onInputResponse");
  });
});

describe("tools and approvals", () => {
  it("gives a tool the channel it was called from", () => {
    expectTypeOf<ToolContext>().toHaveProperty("channel");
    expectTypeOf<ToolContext["callId"]>().toBeString();
    expectTypeOf<ToolContext["session"]["turn"]["id"]>().toBeString();
  });

  it("answers an approval with approve or deny", () => {
    expectTypeOf<ApprovalResponse["decision"]>().toEqualTypeOf<
      "approve" | "deny"
    >();
    expectTypeOf<ApprovalRequest>().toHaveProperty("interactionId");
    expectTypeOf<ApprovalRequest>().not.toHaveProperty("requestId");
    expectTypeOf<ApprovalContext>().not.toHaveProperty("approvedTools");
  });
});

describe("agent configuration", () => {
  it("limits a session with one function over its token usage", () => {
    expectTypeOf<
      Exclude<AgentLimitsDefinition["sessionUsage"], false | undefined>
    >().toEqualTypeOf<SessionUsageLimit>();
    expectTypeOf<ReturnType<typeof exceedsSessionUsage>>().toBeBoolean();
    expectTypeOf<typeof exceedsSessionUsage>().parameter(0).toEqualTypeOf<{
      readonly total: TokenUsage;
      readonly window: TokenUsage;
    }>();
    expectTypeOf<TokenUsage>().toHaveProperty("cacheReadTokens");
    expectTypeOf<AgentLimitsDefinition>().not.toHaveProperty(
      "maxInputTokensPerSession"
    );
  });

  it("scopes memory with functions eve accepts", () => {
    expectTypeOf<typeof byHumanPrincipal>().toExtend<MemoryScopeDefinition>();
    expectTypeOf<typeof bySlackChannel>().toExtend<MemoryScopeDefinition>();
  });
});
