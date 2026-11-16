/**
 * The warehouse tools and the approval policy, run as real callers against a real Postgres.
 *
 * @packageDocumentation
 */
import { renderInteractionBlocks } from "eve/channels/slack";
import { emptySessionView } from "eve/events";
import type { Interaction } from "eve/events";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestRunSqlApproval,
  respondToRunSqlApproval,
} from "#lib/analyst/approval";
import { runSqlApprovalCard } from "#lib/analyst/approval-card";
import { queriesForTurn } from "#lib/analyst/query-log";
import {
  conflictsWithThreadRoles,
  recordThreadRole,
} from "#lib/analyst/thread-roles";
import {
  approvalContext,
  approvalResponseContext,
  isCallable,
  localDevAuth,
  slackAuth,
  slackBotAuth,
  toolContext,
} from "#lib/testing/session";
import { installTestState, testState } from "#lib/testing/state";
import describeSchemaTool from "#lib/tools/describe-schema";
import runSqlTool, { runSqlOutputSchema } from "#lib/tools/run-sql";
import { useWarehouse } from "#tests/support/use-warehouse";
import { BLOCKED_USER, FINANCE_USER } from "#tests/support/warehouse";

const facts = useWarehouse();

const analyst = slackAuth({ userId: "U0ANALYST" });
const colleague = slackAuth({ userId: "U0COLLEAGUE" });
const finance = slackAuth({ userId: FINANCE_USER });
const blocked = slackAuth({ userId: BLOCKED_USER });

const PAYROLL =
  "SELECT sum(salary_cents)::bigint AS total FROM finance.payroll";
const EXPENSIVE =
  "SELECT count(*) FROM analytics.web_sessions a CROSS JOIN analytics.web_sessions b";

const { execute: executeRunSql } = runSqlTool;
const { execute: executeDescribeSchema } = describeSchemaTool;
if (!(isCallable(executeRunSql) && isCallable(executeDescribeSchema))) {
  throw new Error("Expected executable warehouse tools.");
}

const runSql = async (sql: string, current = analyst) => {
  const result = await executeRunSql(
    { purpose: "Behavior test", sql },
    toolContext({ current, toolName: "run_sql" })
  );
  if (Symbol.asyncIterator in result) {
    throw new Error("Expected a single result.");
  }
  // The declared output schema is what eve validates and shows the model.
  return runSqlOutputSchema.parse(result);
};

const describeSchema = async (tables?: string[], current = analyst) => {
  const result = await executeDescribeSchema(
    tables ? { tables } : {},
    toolContext({ current, toolName: "describe_schema" })
  );
  if (Symbol.asyncIterator in result) {
    throw new Error("Expected a single result.");
  }
  return result;
};

const requestApproval = (sql: string, current = analyst) =>
  requestRunSqlApproval(
    approvalContext(
      { purpose: "Behavior test", sql },
      { current, toolName: "run_sql" }
    )
  );

beforeEach(() => {
  installTestState();
  testState.reset();
});

describe("run_sql", () => {
  it("answers a question from the warehouse as the asker's role", async () => {
    const result = await runSql(
      "SELECT count(*)::int AS customers, current_user::text AS role FROM customers"
    );
    expect(result).toMatchObject({
      columns: [
        { name: "customers", type: "integer" },
        { name: "role", type: "text" },
      ],
      rowCount: 1,
      rows: [[facts.rows.customers, "analyst_readonly"]],
      tables: ["analytics.customers"],
      timezone: "UTC",
      truncated: false,
      truncatedReason: null,
    });
  });

  it("records exactly what ran for the turn's SQL section", async () => {
    await runSql("SELECT count(*) FROM plans;");
    expect(queriesForTurn("turn-1")).toMatchObject([
      {
        purpose: "Behavior test",
        sql: "SELECT count(*) FROM plans;",
        tables: ["analytics.plans"],
      },
    ]);
  });

  it("records nothing for a query Postgres refused", async () => {
    await expect(runSql("SELECT * FROM no_such_table")).rejects.toThrow(
      /relation "no_such_table" does not exist/u
    );
    await expect(runSql("DELETE FROM refunds")).rejects.toThrow(/syntax/u);
    expect(queriesForTurn("turn-1")).toStrictEqual([]);
  });

  it("tells the model to aggregate when the result was cut short", async () => {
    vi.stubEnv("ANALYST_MAX_ROWS", "10");
    const result = await runSql("SELECT customer_id FROM customers");
    expect(result.rowCount).toBe(10);
    expect(result.truncatedReason).toBe("row-limit");
    expect(result.note).toContain("Aggregate or filter in SQL");
  });

  it("runs a team member's query as the team role", async () => {
    const result = await runSql(`${PAYROLL}`, finance);
    expect(result.rows).toStrictEqual([["25600000"]]);
    await expect(runSql(PAYROLL)).rejects.toThrow(
      /permission denied for schema finance/u
    );
  });

  it.each([
    ["a person whose access is off", blocked, "has been turned off"],
    ["a bot", slackBotAuth(), "Bots, workflows, and service callers"],
  ])(
    "refuses %s before it reaches the database",
    async (_name, caller, reason) => {
      await expect(runSql("SELECT 1", caller)).rejects.toThrow(reason);
    }
  );

  it("lets local development query as the default role", async () => {
    const result = await runSql("SELECT current_user::text", localDevAuth());
    expect(result.rows).toStrictEqual([["analyst_readonly"]]);
  });
});

describe("describe_schema", () => {
  it("lists the tables the asker's role can read, with row estimates", async () => {
    const overview = await describeSchema();
    expect(overview).toMatchObject({
      schemas: ["analytics", "finance"],
      timezone: "UTC",
      truncated: false,
    });
    const names =
      "tables" in overview ? overview.tables.map((t) => t.name) : [];
    expect(names).toContain("analytics.web_sessions");
    expect(names).not.toContain("finance.payroll");
    expect(overview).not.toHaveProperty("note");
  });

  it("shows a team member their restricted tables too", async () => {
    const overview = await describeSchema(undefined, finance);
    expect(overview.tables.map((table) => table.name)).toContain(
      "finance.payroll"
    );
  });

  it("describes named tables and says which ones it couldn't find", async () => {
    const details = await describeSchema(["customers", "payroll", "nope"]);
    expect(details.tables.map((table) => table.name)).toStrictEqual([
      "analytics.customers",
    ]);
    expect(details.note).toBe(
      "No visible table named payroll, nope. Call describe_schema without arguments to list tables."
    );
  });

  it("refuses a person whose access is off", async () => {
    await expect(describeSchema(undefined, blocked)).rejects.toThrow(
      "has been turned off"
    );
  });
});

describe("the run_sql approval policy", () => {
  it("lets an ordinary query run without asking", async () => {
    await expect(
      requestApproval("SELECT count(*) FROM web_sessions")
    ).resolves.toBe("not-applicable");
    expect(testState.get("analyst.query-estimates")).toBeUndefined();
  });

  it("asks the person before a query the planner prices above the threshold", async () => {
    await expect(requestApproval(EXPENSIVE)).resolves.toBe("user-approval");
    const estimates = testState.get("analyst.query-estimates");
    expect(estimates).toMatchObject({
      "call-1": {
        askerSlackUserId: "U0ANALYST",
        sql: EXPENSIVE,
        threshold: 1_000_000,
      },
    });
  });

  it("follows the configured threshold", async () => {
    vi.stubEnv("ANALYST_APPROVAL_COST", "10");
    await expect(
      requestApproval("SELECT count(*) FROM web_sessions")
    ).resolves.toBe("user-approval");
    vi.stubEnv("ANALYST_APPROVAL_COST", "1000000000000000");
    await expect(requestApproval(EXPENSIVE)).resolves.toBe("not-applicable");
  });

  it("tells a caller who can't approve to narrow the query instead", async () => {
    vi.stubEnv(
      "ANALYST_ROLE_MAP",
      JSON.stringify({ "slack:T123:bot:B123": "analyst_readonly" })
    );
    await expect(
      requestApproval(EXPENSIVE, slackBotAuth())
    ).resolves.toStrictEqual({
      reason: expect.stringContaining("too expensive to run without a person"),
      type: "denied",
    });
  });

  it.each([
    [
      "a forbidden function",
      "SELECT set_config('role', 'analyst_finance', true)",
      "Queries can't call set_config().",
    ],
    [
      "a table that doesn't exist",
      "SELECT * FROM no_such_table",
      'Postgres rejected this query while planning it: relation "no_such_table" does not exist.',
    ],
    [
      "a table the role can't read",
      PAYROLL,
      "Postgres rejected this query while planning it: permission denied for schema finance.",
    ],
    [
      "a write",
      "UPDATE customers SET country = 'ZZ'",
      "Postgres rejected this query while planning it: syntax error",
    ],
  ])(
    "denies %s with a reason the model can act on",
    async (_name, sql, reason) => {
      await expect(requestApproval(sql)).resolves.toStrictEqual({
        reason: expect.stringContaining(reason),
        type: "denied",
      });
    }
  );

  it("denies a person whose access is off, with the reason", async () => {
    await expect(requestApproval("SELECT 1", blocked)).resolves.toStrictEqual({
      reason: "Your warehouse access has been turned off.",
      type: "denied",
    });
  });

  it("admits only the asker's own answer", () => {
    const respond = (responder: typeof analyst, decision: "approve" | "deny") =>
      respondToRunSqlApproval(
        approvalResponseContext({
          decision,
          requester: analyst,
          responder,
          toolInput: { purpose: "Behavior test", sql: EXPENSIVE },
          toolName: "run_sql",
        })
      );
    expect(respond(analyst, "approve")).toStrictEqual({ status: "allowed" });
    expect(respond(analyst, "deny")).toStrictEqual({ status: "allowed" });
    expect(respond(colleague, "approve")).toMatchObject({ status: "rejected" });
    expect(respond(finance, "deny")).toMatchObject({ status: "rejected" });
  });
});

describe("the approval card", () => {
  it("shows the planner's own estimate for the query awaiting approval", async () => {
    await requestApproval(EXPENSIVE);
    const interaction: Interaction = {
      call: {
        callId: "call-1",
        input: { purpose: "Behavior test", sql: EXPENSIVE },
        name: "run_sql",
      },
      interactionId: "interaction-1",
      request: {
        kind: "approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "deny", label: "Deny" },
        ],
        prompt: "Approve run_sql?",
      },
      status: "open",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const parts = runSqlApprovalCard.interactionCard?.(
      {
        audience: "private",
        destination: "thread",
        interaction,
        view: emptySessionView(),
      },
      // eve's own blocks for an open approval, which carry its buttons.
      () => ({
        controls: {
          blocks: renderInteractionBlocks(interaction),
          text: interaction.request.prompt,
        },
      })
    );
    const card = JSON.stringify(parts?.controls.blocks);
    expect(card).toMatch(
      /Estimated cost [\d.]+[BMT] \(approval needed above 1M\) · about \d/u
    );
    expect(card).toContain("Only <@U0ANALYST> can run or cancel this query.");
    expect(card).toContain(EXPENSIVE);
    expect(card).toContain('"text":"Run query"');
  });
});

describe("the thread role record", () => {
  it("separates a thread's results by the role that fetched them", async () => {
    await runSql("SELECT 1", finance);
    recordThreadRole(finance);
    expect(conflictsWithThreadRoles(finance)).toBe(false);
    expect(conflictsWithThreadRoles(analyst)).toBe(true);
    expect(conflictsWithThreadRoles(blocked)).toBe(true);
  });
});
