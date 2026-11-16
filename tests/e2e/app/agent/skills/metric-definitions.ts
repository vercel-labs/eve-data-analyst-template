import { defineSkill } from "eve/skills";

import { parseSkill, PRODUCTION_TEXT } from "../../../support/production-text";

/** The production `metric-definitions` skill, read from `agent/skills/metric-definitions.md`. */
export default defineSkill(
  parseSkill(PRODUCTION_TEXT["skills/metric-definitions.md"])
);
