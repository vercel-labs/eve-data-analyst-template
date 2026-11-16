/**
 * The types the model-facing tools promise: their inputs, their outputs, and their approval policies.
 *
 * @packageDocumentation
 */
import type { ToolContext, ToolDefinition } from "eve/tools";
import type {
  Approval,
  ApprovalPolicy,
  ApprovalResponsePolicy,
} from "eve/tools/approval";
import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import type {
  requestRunSqlApproval,
  respondToRunSqlApproval,
  RunSqlApprovalInput,
} from "#lib/analyst/approval";
import type { QueryResult } from "#lib/analyst/postgres";
import type { visualizationOutputSchema } from "#lib/integrations/slack/visualizations/post";
import type describeSchema from "#lib/tools/describe-schema";
import type { describeSchemaInputSchema } from "#lib/tools/describe-schema";
import type postSlackChart from "#lib/tools/post-slack-chart";
import type postSlackTable from "#lib/tools/post-slack-table";
import type runSql from "#lib/tools/run-sql";
import type { runSqlInputSchema, runSqlOutputSchema } from "#lib/tools/run-sql";

/* A tool's executor, which eve types as optional. */
type Execute<T extends { execute?: object }> = Extract<
  T["execute"],
  (...args: never[]) => object
>;

/* The input a tool's executor receives. */
type Input<T extends { execute?: object }> = Parameters<Execute<T>>[0];

/* What a tool's executor resolves to, without the streaming form the project never uses. */
type Output<T extends { execute?: object }> = Exclude<
  Awaited<ReturnType<Execute<T>>>,
  AsyncIterable<object>
>;

describe("run_sql", () => {
  it("takes a purpose and one SQL string, and nothing else", () => {
    expectTypeOf<z.infer<typeof runSqlInputSchema>>().toEqualTypeOf<{
      purpose: string;
      sql: string;
    }>();
    expectTypeOf<Input<typeof runSql>>().toEqualTypeOf<{
      purpose: string;
      sql: string;
    }>();
  });

  it("returns typed columns, bounded rows, and how the result was cut", () => {
    type Result = z.infer<typeof runSqlOutputSchema>;
    expectTypeOf<Result["columns"]>().toEqualTypeOf<
      { name: string; type: string }[]
    >();
    expectTypeOf<Result["rows"]>().toEqualTypeOf<z.core.util.JSONType[][]>();
    expectTypeOf<Result["truncatedReason"]>().toEqualTypeOf<
      "output-size" | "row-limit" | null
    >();
    expectTypeOf<Result["note"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Result["tables"]>().toEqualTypeOf<string[]>();
  });

  it("returns what its output schema declares", () => {
    // eve validates the result against outputSchema, so the two must name the same fields.
    // `note` is only on a truncated result, so it isn't common to every result.
    expectTypeOf<keyof Output<typeof runSql>>().toEqualTypeOf<
      Exclude<keyof z.infer<typeof runSqlOutputSchema>, "note">
    >();
    expectTypeOf<
      Extract<Output<typeof runSql>, { note: string }>["truncated"]
    >().toBeBoolean();
    expectTypeOf<QueryResult>().toExtend<Output<typeof runSql>>();
  });

  it("is an eve tool whose executor receives eve's tool context", () => {
    expectTypeOf<typeof runSql>().toExtend<
      Pick<ToolDefinition, "description" | "inputSchema">
    >();
    expectTypeOf<
      Parameters<NonNullable<(typeof runSql)["execute"]>>[1]
    >().toEqualTypeOf<ToolContext>();
  });

  it("gates calls with a request policy and a response policy for its own input", () => {
    expectTypeOf<typeof requestRunSqlApproval>().toEqualTypeOf<
      ApprovalPolicy<RunSqlApprovalInput>
    >();
    expectTypeOf<typeof respondToRunSqlApproval>().toEqualTypeOf<
      ApprovalResponsePolicy<RunSqlApprovalInput>
    >();
    expectTypeOf<{
      request: typeof requestRunSqlApproval;
      response: typeof respondToRunSqlApproval;
    }>().toExtend<Approval<RunSqlApprovalInput>>();
    expectTypeOf<
      z.infer<typeof runSqlInputSchema>
    >().toExtend<RunSqlApprovalInput>();
  });
});

describe("describe_schema", () => {
  it("takes an optional list of table names", () => {
    expectTypeOf<z.infer<typeof describeSchemaInputSchema>>().toEqualTypeOf<{
      tables?: string[] | undefined;
    }>();
  });

  it("returns either an overview or table details, each with an optional note", () => {
    type Result = Output<typeof describeSchema>;
    expectTypeOf<Result["tables"][number]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<Result["note"]>().toEqualTypeOf<string | undefined>();
  });
});

describe("post_slack_table and post_slack_chart", () => {
  type Delivery = z.infer<typeof visualizationOutputSchema>;

  it("report delivery, never the data they posted", () => {
    expectTypeOf<Delivery>().toEqualTypeOf<{
      channel?: string | undefined;
      error?: string | undefined;
      posted: boolean;
      threadTs?: string | undefined;
      usedTextFallback?: boolean | undefined;
    }>();
    expectTypeOf<Output<typeof postSlackTable>>().toExtend<Delivery>();
    expectTypeOf<Output<typeof postSlackChart>>().toExtend<Delivery>();
    expectTypeOf<Output<typeof postSlackTable>>().not.toHaveProperty("rows");
  });

  it("end the turn only after a confirmed post", () => {
    // endsTurn is a function of the tool's own output, not a constant true.
    type EndsTurn = Exclude<
      NonNullable<(typeof postSlackTable)["endsTurn"]>,
      boolean
    >;
    expectTypeOf<Parameters<EndsTurn>[0]>().toEqualTypeOf<
      Output<typeof postSlackTable>
    >();
    expectTypeOf<Parameters<EndsTurn>[0]["posted"]>().toBeBoolean();
  });

  it("accept table cells as text or a labelled link", () => {
    type Cell = Input<typeof postSlackTable>["table"]["rows"][number][number];
    expectTypeOf<Cell>().toEqualTypeOf<
      string | { text: string; url: string }
    >();
  });

  it("accept a pie chart or a chart with categories and series", () => {
    type Chart = Input<typeof postSlackChart>["chart"];
    expectTypeOf<Chart["type"]>().toEqualTypeOf<
      "area" | "bar" | "line" | "pie"
    >();
    expectTypeOf<Extract<Chart, { type: "pie" }>>().toHaveProperty("segments");
    expectTypeOf<Extract<Chart, { type: "bar" }>>().toHaveProperty("series");
  });
});
