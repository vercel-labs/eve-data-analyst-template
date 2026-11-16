/**
 * The production agent's Markdown sources, as text.
 *
 * @remarks eve only lets a module import assets inside its own package. The fixture app under `tests/e2e/app` is its own package, so its modules reach the production Markdown through this module, which belongs to the repository's package.
 * @packageDocumentation
 */
import instructions from "../../../agent/instructions.md?raw";
import metricDefinitions from "../../../agent/skills/metric-definitions.md?raw";
import sqlStyle from "../../../agent/skills/sql-style.md?raw";

/** Production Markdown by its path under `agent/`. */
export const PRODUCTION_TEXT = {
  "instructions.md": instructions,
  "skills/metric-definitions.md": metricDefinitions,
  "skills/sql-style.md": sqlStyle,
} as const;

/** A flat Markdown skill split into the parts eve reads from it. */
export interface SkillSource {
  readonly content: string;
  readonly description: string;
}

/* One plain YAML scalar: no quoting, no indicator at its start, and neither ": " nor " #" inside. */
const FRONTMATTER =
  /^---\ndescription: (?<description>[A-Za-z](?:(?!: | #)[^\n])*)\n---\n\n?(?<content>[\s\S]+)$/u;

/**
 * Splits a production skill file into its description and body.
 *
 * @param markdown - The skill file's text.
 * @returns The frontmatter description and the Markdown after it, without the blank line that separates the two, as eve reads a Markdown skill.
 * @throws {@link Error} When the frontmatter is anything other than one plain `description` line, so a production change that this small parser can't mirror fails the fixture's build.
 */
export const parseSkill = (markdown: string): SkillSource => {
  const groups = FRONTMATTER.exec(markdown)?.groups;
  if (!groups?.description || !groups.content) {
    throw new Error(
      "Expected skill frontmatter with one plain description line."
    );
  }
  return { content: groups.content, description: groups.description.trim() };
};
