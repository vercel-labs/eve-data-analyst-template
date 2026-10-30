import { expect, it } from "vitest";

import type { SlackInputRequestsConfig } from "./input-requests";

it("uses eve's interaction-card contract for custom Slack input presentation", () => {
  const presentation: SlackInputRequestsConfig = {
    interactionCard: (_card, next) => next(_card),
  };
  expect(presentation.interactionCard).toBeTypeOf("function");
});
