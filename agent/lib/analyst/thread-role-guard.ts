import { call } from "eve/events";
import { defineHook } from "eve/hooks";

import {
  conflictsWithThreadRoles,
  recordThreadRole,
  ROLE_SCOPED_TOOLS,
} from "#lib/analyst/thread-roles";

/**
 * Keeps one Slack thread's query results with the role that fetched them.
 *
 * @remarks Each `run_sql` or `describe_schema` call that settles as completed records the caller's role. eve's `call.settled` event doesn't name the tool, so the name comes from the session view. A later turn whose caller resolves to a different role, or to no access, is cancelled before the model runs, and the Slack renderer asks that person to start a new thread. Callers who share a role, including `local-dev`, are never blocked.
 */
export default defineHook({
  events: {
    "call.settled"(event, ctx) {
      if (event.data.outcome !== "completed") {
        return;
      }
      const settled = call(ctx.view, event.data.callId);
      if (!settled) {
        // Without the call's name the guard can't tell whether data was fetched.
        console.warn("analyst.thread_role_guard_unknown_call");
        return;
      }
      if (settled.kind !== "tool" || !ROLE_SCOPED_TOOLS.has(settled.name)) {
        return;
      }
      recordThreadRole(ctx.session.auth.current);
    },
    "turn.started"(_event, ctx) {
      if (conflictsWithThreadRoles(ctx.session.auth.current)) {
        ctx.cancel("The caller's database role differs from this thread's.");
      }
    },
  },
});
