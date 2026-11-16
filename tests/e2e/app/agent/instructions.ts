import { defineInstructions } from "eve/instructions";

import { PRODUCTION_TEXT } from "../../support/production-text";

/** The production system prompt, read from `agent/instructions.md`. */
export default defineInstructions({
  content: PRODUCTION_TEXT["instructions.md"],
});
