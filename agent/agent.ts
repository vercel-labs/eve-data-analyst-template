import { defineAgent } from "eve";

import { exceedsSessionUsage } from "./lib/session-usage";

export default defineAgent({
  // pg has optional native bindings (pg-native), so keep it out of the bundle.
  build: { externalDependencies: ["pg"] },
  limits: { sessionUsage: exceedsSessionUsage },
  model: "anthropic/claude-fable-5.2",
  reasoning: "medium",
});
