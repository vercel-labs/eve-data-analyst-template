/**
 * Keeps the fixture agent under `tests/e2e/app` an honest stand-in for the production agent under `agent/`.
 *
 * @remarks
 * Every production file in the agent's root and its `tools`, `hooks`, `instructions`, `skills`, `channels`, and `memory` directories has a fixture file at the same path that loads it. Markdown has a `.ts` counterpart, because eve only lets a module import assets from its own package, and the fixture is a package of its own.
 *
 * Three fixture files rebuild their production file instead of re-exporting it:
 *
 * - `agent.ts` swaps the model for the scripted one. A test compares every other setting.
 * - `channels/slack.ts` calls the same channel factory with the same `analystSlackSettings()`, and adds a static signing secret and the fake Slack's URL where production uses Vercel Connect and Slack.
 * - `channels/eve.ts` keeps `localDev()` and adds a header that selects a Slack person. Production's `vercelOidc()` is left out, because it only admits tokens Vercel issued.
 *
 * Two fixture files have no production counterpart: `hooks/e2e-turn-recorder.ts` reports each started turn to the tests, and `channels/slack-default.ts` is a Slack channel with eve's defaults that serves as a control.
 *
 * `agent/lib` is not mirrored: the fixture imports it. The fixture's own `lib` holds the scripted model and the seam that points the visualization tools at the fake Slack.
 * @packageDocumentation
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HookDefinition } from "eve/hooks";
import type { InstructionsDefinition } from "eve/instructions";
import type { SkillDefinition } from "eve/skills";
import { describe, expect, expectTypeOf, it } from "vitest";

import productionAgent from "../../agent/agent";
import type productionEveChannel from "../../agent/channels/eve";
import type productionSlackChannel from "../../agent/channels/slack";
import type productionGuard from "../../agent/hooks/thread-role-guard";
import type productionCurrentTime from "../../agent/instructions/current-time";
import channelPreferences from "../../agent/memory/channel-preferences";
import userPreferences from "../../agent/memory/user-preferences";
import type productionSandbox from "../../agent/sandbox";
import type { environment as productionEnvironment } from "../../agent/sandbox";
import type productionDescribeSchema from "../../agent/tools/describe_schema";
import type productionPostSlackChart from "../../agent/tools/post_slack_chart";
import type productionPostSlackTable from "../../agent/tools/post_slack_table";
import type productionRunSql from "../../agent/tools/run_sql";
import type productionWebFetch from "../../agent/tools/web_fetch";
import type productionWebSearch from "../../agent/tools/web_search";
import fixtureAgent from "./app/agent/agent";
import type fixtureEveChannel from "./app/agent/channels/eve";
import type fixtureSlackChannel from "./app/agent/channels/slack";
import type fixtureSlackDefaultChannel from "./app/agent/channels/slack-default";
import type fixtureRecorder from "./app/agent/hooks/e2e-turn-recorder";
import type fixtureGuard from "./app/agent/hooks/thread-role-guard";
import type fixtureInstructions from "./app/agent/instructions";
import type fixtureCurrentTime from "./app/agent/instructions/current-time";
import type fixtureChannelPreferences from "./app/agent/memory/channel-preferences";
import type fixtureUserPreferences from "./app/agent/memory/user-preferences";
import type fixtureSandbox from "./app/agent/sandbox";
import type { environment as fixtureEnvironment } from "./app/agent/sandbox";
import type fixtureMetricDefinitions from "./app/agent/skills/metric-definitions";
import type fixtureSqlStyle from "./app/agent/skills/sql-style";
import type fixtureDescribeSchema from "./app/agent/tools/describe_schema";
import type fixturePostSlackChart from "./app/agent/tools/post_slack_chart";
import type fixturePostSlackTable from "./app/agent/tools/post_slack_table";
import type fixtureRunSql from "./app/agent/tools/run_sql";
import type fixtureWebFetch from "./app/agent/tools/web_fetch";
import type fixtureWebSearch from "./app/agent/tools/web_search";
import { clientAs } from "./support/harness";
import { PRODUCTION_TEXT } from "./support/production-text";

const PRODUCTION = fileURLToPath(new URL("../../agent", import.meta.url));
const FIXTURE = fileURLToPath(new URL("app/agent", import.meta.url));

/** Directories whose files eve discovers by path. */
const SLOTS = [
  "tools",
  "hooks",
  "instructions",
  "skills",
  "channels",
  "memory",
];

/** Fixture files with no production counterpart. */
const FIXTURE_ONLY = new Set([
  "channels/slack-default.ts",
  "hooks/e2e-turn-recorder.ts",
]);

const isTest = (name: string) => /\.(?:test|spec)\.ts$/u.test(name);

/* The files eve discovers under an agent directory: its root files and everything in the slots. */
const discovered = (root: string): string[] => [
  ...readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name),
  ...SLOTS.flatMap((slot) =>
    readdirSync(path.join(root, slot), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !isTest(entry.name))
      .map((entry) =>
        path
          .relative(root, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join("/")
      )
  ),
];

const asModule = (file: string) => file.replace(/\.md$/u, ".ts");

describe("the fixture agent's files", () => {
  it("mirror every production agent file, and add only the documented ones", () => {
    const fixture = discovered(FIXTURE);

    expect(
      fixture.filter((file) => !FIXTURE_ONLY.has(file)).toSorted()
    ).toStrictEqual(discovered(PRODUCTION).map(asModule).toSorted());
    expect(fixture.filter((file) => FIXTURE_ONLY.has(file))).toHaveLength(
      FIXTURE_ONLY.size
    );
  });

  it("export production's definitions, which the type checker compares", () => {
    // Re-exports: each is the production module's own default export.
    expectTypeOf<typeof fixtureDescribeSchema>().toEqualTypeOf<
      typeof productionDescribeSchema
    >();
    expectTypeOf<typeof fixtureRunSql>().toEqualTypeOf<
      typeof productionRunSql
    >();
    expectTypeOf<typeof fixturePostSlackChart>().toEqualTypeOf<
      typeof productionPostSlackChart
    >();
    expectTypeOf<typeof fixturePostSlackTable>().toEqualTypeOf<
      typeof productionPostSlackTable
    >();
    expectTypeOf<typeof fixtureWebFetch>().toEqualTypeOf<
      typeof productionWebFetch
    >();
    expectTypeOf<typeof fixtureWebSearch>().toEqualTypeOf<
      typeof productionWebSearch
    >();
    expectTypeOf<typeof fixtureGuard>().toEqualTypeOf<typeof productionGuard>();
    expectTypeOf<typeof fixtureCurrentTime>().toEqualTypeOf<
      typeof productionCurrentTime
    >();
    expectTypeOf<typeof fixtureChannelPreferences>().toEqualTypeOf<
      typeof channelPreferences
    >();
    expectTypeOf<typeof fixtureUserPreferences>().toEqualTypeOf<
      typeof userPreferences
    >();
    expectTypeOf<typeof fixtureSandbox>().toEqualTypeOf<
      typeof productionSandbox
    >();
    expectTypeOf<typeof fixtureEnvironment>().toEqualTypeOf<
      typeof productionEnvironment
    >();
    // Rebuilt channels: the same kind of definition as production's.
    expectTypeOf<typeof fixtureSlackChannel>().toEqualTypeOf<
      typeof productionSlackChannel
    >();
    expectTypeOf<typeof fixtureSlackDefaultChannel>().toEqualTypeOf<
      typeof productionSlackChannel
    >();
    expectTypeOf<typeof fixtureEveChannel>().toEqualTypeOf<
      typeof productionEveChannel
    >();
    // Markdown counterparts and the fixture's own hook.
    expectTypeOf<
      typeof fixtureInstructions
    >().toExtend<InstructionsDefinition>();
    expectTypeOf<typeof fixtureMetricDefinitions>().toExtend<SkillDefinition>();
    expectTypeOf<typeof fixtureSqlStyle>().toExtend<SkillDefinition>();
    expectTypeOf<typeof fixtureRecorder>().toExtend<HookDefinition>();
  });

  it("configure the agent as production does, except for the model", () => {
    expect({ ...fixtureAgent, model: null }).toStrictEqual({
      ...productionAgent,
      model: null,
    });
    expect(fixtureAgent.limits?.sessionUsage).toBe(
      productionAgent.limits?.sessionUsage
    );
  });
});

describe("the running fixture agent", () => {
  it("has loaded production's instructions, skills, hooks, memory, and tools", async () => {
    const info = await clientAs().info();

    expect(info.diagnostics).toMatchObject({
      discoveryErrors: 0,
      discoveryWarnings: 0,
    });
    expect(
      info.instructions.static.map(({ content, role }) => ({ content, role }))
    ).toStrictEqual([
      { content: PRODUCTION_TEXT["instructions.md"], role: "system" },
    ]);
    expect(info.instructions.dynamic.map(({ slug }) => slug)).toStrictEqual([
      "current-time",
    ]);
    // A skill's description and body together are its whole production file.
    expect(
      Object.fromEntries(
        info.skills.static.map(({ description, logicalPath, markdown }) => [
          logicalPath.replace(/\.ts$/u, ".md"),
          `---\ndescription: ${description}\n---\n\n${markdown}`,
        ])
      )
    ).toStrictEqual({
      "skills/metric-definitions.md":
        PRODUCTION_TEXT["skills/metric-definitions.md"],
      "skills/sql-style.md": PRODUCTION_TEXT["skills/sql-style.md"],
    });
    expect(
      info.hooks.map(({ eventNames, slug }) => ({ eventNames, slug }))
    ).toStrictEqual([
      { eventNames: ["turn.started"], slug: "e2e-turn-recorder" },
      {
        eventNames: ["call.settled", "turn.started"],
        slug: "thread-role-guard",
      },
    ]);
    expect(
      info.memories.map(({ description, slot }) => ({ description, slot }))
    ).toStrictEqual([
      {
        description: channelPreferences.description,
        slot: "channel-preferences",
      },
      { description: userPreferences.description, slot: "user-preferences" },
    ]);
    expect(
      info.tools.static
        .map(({ name, requiresApproval }) => ({ name, requiresApproval }))
        .toSorted((a, b) => a.name.localeCompare(b.name))
    ).toStrictEqual([
      { name: "agent", requiresApproval: false },
      { name: "bash", requiresApproval: false },
      { name: "describe_schema", requiresApproval: false },
      { name: "edit_file", requiresApproval: false },
      { name: "post_slack_chart", requiresApproval: false },
      { name: "post_slack_table", requiresApproval: false },
      { name: "read_file", requiresApproval: false },
      { name: "run_sql", requiresApproval: true },
      { name: "write_file", requiresApproval: false },
    ]);
    expect(
      info.composition.disabled.map(({ logicalPath }) => logicalPath)
    ).toStrictEqual(["tools/web_fetch.ts", "tools/web_search.ts"]);
    expect(info.sandbox).toMatchObject({
      environmentExportName: "environment",
      provider: "just-bash",
    });
    expect(info.agent.model.reasoning).toBe("medium");
  });
});
