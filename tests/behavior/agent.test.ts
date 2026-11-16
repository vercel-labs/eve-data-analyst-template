/**
 * The agent as eve compiles it: the model, the tools the model can call, and what is registered.
 *
 * @packageDocumentation
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const infoSchema = z.object({
  artifacts: z.object({ compiledManifest: z.string() }),
  channels: z.array(
    z.object({ method: z.string(), name: z.string(), urlPath: z.string() })
  ),
  diagnostics: z.object({ errors: z.number(), warnings: z.number() }),
  instructions: z.string(),
  model: z.string(),
  schedules: z.array(z.unknown()),
  skills: z.array(z.string()),
  status: z.string(),
  subagents: z.array(z.unknown()),
  toolInputSchemas: z.object({
    root: z.record(z.string(), z.json()),
  }),
  tools: z.array(z.string()),
});

const manifestSchema = z.object({
  bindings: z.record(z.string(), z.unknown()),
  config: z.object({
    build: z.object({ externalDependencies: z.array(z.string()) }),
    limits: z.object({ sessionUsage: z.boolean() }),
    model: z.object({
      id: z.string(),
      routing: z.object({ kind: z.string(), target: z.string() }),
    }),
    reasoning: z.string(),
  }),
  sandbox: z.object({ providerName: z.string() }),
});

let info: z.infer<typeof infoSchema>;
let manifest: z.infer<typeof manifestSchema>;

beforeAll(async () => {
  // `eve info` compiles the real agent directory with no database or credentials. It downloads
  // the public AI Gateway model list when .eve/cache has no copy, so a fresh clone needs network once.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["node_modules/eve/bin/eve.js", "info", "--json"],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: {
        ...process.env,
        // vitest sets NODE_ENV=test, which makes eve swap in its own fixture model.
        NODE_ENV: "development",
        SLACK_CONNECTOR: "slack/placeholder",
        // The sandbox follows these, so a run on Vercel's build machines compiles the same agent.
        VERCEL: "",
        VERCEL_ENV: "",
      },
    }
  );
  info = infoSchema.parse(JSON.parse(stdout));
  manifest = manifestSchema.parse(
    JSON.parse(await readFile(info.artifacts.compiledManifest, "utf-8"))
  );
}, 60_000);

describe("the compiled agent", () => {
  it("compiles without errors or warnings", () => {
    expect(info.status).toBe("ready");
    expect(info.diagnostics).toStrictEqual({ errors: 0, warnings: 0 });
  });

  it("runs Claude Fable 5.2 through AI Gateway with medium reasoning", () => {
    expect(info.model).toBe("anthropic/claude-fable-5.2");
    expect(manifest.config.model).toMatchObject({
      id: "anthropic/claude-fable-5.2",
      routing: { kind: "gateway", target: "anthropic" },
    });
    expect(manifest.config.reasoning).toBe("medium");
  });

  it("applies the session usage limit and keeps pg out of the bundle", () => {
    expect(manifest.config.limits).toStrictEqual({ sessionUsage: true });
    expect(manifest.config.build.externalDependencies).toStrictEqual(["pg"]);
  });

  it("has exactly these built-in and authored tools", () => {
    // A new name here means eve added a default tool. Check that it can't send
    // query results out of the conversation before adding it to this list.
    // eve adds more tools when a session runs, such as eve__skill, and they aren't listed here.
    expect(info.tools.toSorted()).toStrictEqual([
      "agent",
      "bash",
      "describe_schema",
      "edit_file",
      "post_slack_chart",
      "post_slack_table",
      "read_file",
      "run_sql",
      "write_file",
    ]);
  });

  it.each(["web_fetch", "web_search"])("keeps %s disabled", (tool) => {
    expect(info.tools).not.toContain(tool);
    expect(info.toolInputSchemas.root).not.toHaveProperty(tool);
  });

  it("gives run_sql and describe_schema strict input schemas", () => {
    expect(info.toolInputSchemas.root.run_sql).toMatchObject({
      additionalProperties: false,
      properties: {
        purpose: { maxLength: 200, minLength: 1, type: "string" },
        sql: { maxLength: 20_000, minLength: 1, type: "string" },
      },
      required: ["purpose", "sql"],
      type: "object",
    });
    expect(info.toolInputSchemas.root.describe_schema).toMatchObject({
      additionalProperties: false,
      properties: { tables: { maxItems: 10, type: "array" } },
      type: "object",
    });
  });

  it("loads the instructions and both skills", () => {
    expect(info.instructions).toBe("instructions.md (system)");
    expect(info.skills).toStrictEqual(["metric-definitions", "sql-style"]);
    expect(info.subagents).toStrictEqual([]);
    expect(info.schedules).toStrictEqual([]);
  });

  it("registers these authored files and no others", () => {
    const authored = Object.keys(manifest.bindings)
      .filter((source) => !source.startsWith("eve:"))
      .toSorted();
    expect(authored).toStrictEqual([
      "agent.ts",
      "channels/eve.ts",
      "channels/slack.ts",
      "hooks/thread-role-guard.ts",
      "instructions/current-time.ts",
      "memory/channel-preferences.ts",
      "memory/user-preferences.ts",
      "sandbox.ts",
      "tools/describe_schema.ts",
      "tools/post_slack_chart.ts",
      "tools/post_slack_table.ts",
      "tools/run_sql.ts",
    ]);
  });

  it("serves the Slack webhook and the HTTP session routes", () => {
    const routes = info.channels.map(
      (route) => `${route.method} ${route.urlPath} (${route.name})`
    );
    expect(routes).toStrictEqual(
      expect.arrayContaining([
        "POST /eve/v1/slack (slack)",
        "POST /eve/v1/session (eve)",
        "POST /eve/v1/session/:sessionId (eve)",
        "GET /eve/v1/session/:sessionId/stream (eve)",
      ])
    );
    expect(
      info.channels.filter((route) => route.name === "slack")
    ).toHaveLength(1);
  });

  it("uses the in-process sandbox outside a deployment", () => {
    expect(manifest.sandbox.providerName).toBe("just-bash");
  });
});
