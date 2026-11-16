import { defineSkill } from "eve/skills";

import { parseSkill, PRODUCTION_TEXT } from "../../../support/production-text";

/** The production `sql-style` skill, read from `agent/skills/sql-style.md`. */
export default defineSkill(parseSkill(PRODUCTION_TEXT["skills/sql-style.md"]));
