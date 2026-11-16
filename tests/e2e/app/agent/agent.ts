import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { exceedsSessionUsage } from "../../../../agent/lib/session-usage";
import { respondFromScript } from "./lib/scripted-model";

/**
 * The production agent's configuration with a scripted model in place of the real one.
 *
 * @remarks Keeps every other production setting, which a test compares against `agent/agent.ts`. Each test steers the model through a script in its message, so one server serves every test.
 */
export default defineAgent({
  // pg has optional native bindings (pg-native), so keep it out of the bundle.
  build: { externalDependencies: ["pg"] },
  limits: { sessionUsage: exceedsSessionUsage },
  model: mockModel(respondFromScript),
  reasoning: "medium",
});
