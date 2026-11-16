import { defineHook } from "eve/hooks";

import { requireEnv } from "../../../../../agent/lib/utils/env";
import { isString } from "../../../../../agent/lib/values";
import { CONTROL_PREFIX, CONTROL_URL_ENV } from "../../../support/protocol";
import type { StartedTurn } from "../../../support/protocol";

/**
 * Tells the tests which session and turn each inbound message started.
 *
 * @remarks Exists only in the fixture. A Slack webhook answers before its session exists, so a test can't learn the session ID from the response. With the ID from this hook, the test reads the session's real event stream through `eve/client`. The hook only reports; a failed report is logged and never changes the turn.
 */
export default defineHook({
  events: {
    async "turn.started"(event, ctx) {
      const caller = ctx.session.auth.current;
      const threadTs = caller?.attributes.thread_ts;
      const turn: StartedTurn = {
        channel: ctx.channel.kind ?? null,
        principalId: caller?.principalId ?? null,
        sessionId: ctx.session.id,
        threadTs: isString(threadTs) ? threadTs : null,
        turnId: event.data.turnId,
      };
      try {
        await fetch(
          `${requireEnv(CONTROL_URL_ENV, "http://127.0.0.1:1234")}${CONTROL_PREFIX}/turns`,
          { body: JSON.stringify(turn), method: "POST" }
        );
      } catch (error) {
        console.warn("Could not report a started turn to the tests.", error);
      }
    },
  },
});
