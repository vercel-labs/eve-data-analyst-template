/**
 * The SQL safety layers, exercised against a real Postgres through the real `pg` driver.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from "vitest";

import {
  describeTables,
  explainQuery,
  listTables,
  postgres,
  runReadOnlySql,
  WarehouseUnavailableError,
  withReadOnly,
} from "#lib/analyst/postgres";
import { useWarehouse } from "#tests/support/use-warehouse";

const facts = useWarehouse();

const BASE = "analyst_readonly";
const FINANCE = "analyst_finance";

/* The single value of a one-row, one-column result. */
const scalar = async (sql: string, role = BASE) => {
  const { rows } = await runReadOnlySql(sql, role);
  expect(rows).toHaveLength(1);
  return rows[0]?.[0];
};

/* The message Postgres or the analyst refused a query with. */
const rejection = async (sql: string, role = BASE): Promise<string> => {
  try {
    await runReadOnlySql(sql, role);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected this query to be refused: ${sql}`);
};

/* What a pooled connection reports outside any analyst transaction. */
const sessionSettings = async () => {
  const client = await postgres.connect();
  try {
    const { rows } = await client.query({
      rowMode: "array",
      text: `SELECT current_user::text = session_user::text,
                    current_setting('search_path'),
                    current_setting('statement_timeout'),
                    current_setting('TimeZone'),
                    current_setting('transaction_read_only')`,
    });
    return rows;
  } finally {
    client.release(false);
  }
};

/* Names of the tables a role sees in the schema overview. */
const visibleTables = async (role: string) => {
  const { tables } = await listTables(role);
  return tables.map((table) => table.name);
};

describe("the loaded demo data", () => {
  it.each(Object.entries(facts.rows))(
    "holds every generated row of %s",
    async (table, rows) => {
      expect(await scalar(`SELECT count(*)::int FROM ${table}`)).toBe(rows);
    }
  );

  it("gives the MRR the metric definition describes, to the cent", async () => {
    const mrr = await scalar(`
      SELECT sum(s.mrr_cents)::bigint
      FROM subscriptions s
      JOIN customers c USING (customer_id)
      WHERE NOT c.is_internal
        AND s.started_at < timestamptz '${facts.anchor}'
        AND (s.ended_at IS NULL OR s.ended_at >= timestamptz '${facts.anchor}')`);
    // bigint arrives as a string, so large sums never lose precision in JSON.
    expect(mrr).toBe(String(facts.mrrCentsAtAnchor));
    expect(facts.mrrCentsAtAnchor).toBeGreaterThan(0);
  });

  it("counts sessions by source the way the traffic definition does", async () => {
    const { columns, rows, tables } = await runReadOnlySql(
      `SELECT source, count(*)::int AS sessions
       FROM web_sessions WHERE NOT is_bot
       GROUP BY source ORDER BY sessions DESC, source`,
      BASE
    );
    expect(columns).toStrictEqual([
      { name: "source", type: "text" },
      { name: "sessions", type: "integer" },
    ]);
    expect(Object.fromEntries(rows)).toStrictEqual(facts.sessionsBySource);
    expect(tables).toStrictEqual(["analytics.web_sessions"]);
  });

  it("counts customers without the internal accounts", async () => {
    expect(
      await scalar("SELECT count(*)::int FROM customers WHERE NOT is_internal")
    ).toBe(facts.externalCustomers);
    expect(facts.externalCustomers).toBeLessThan(facts.rows.customers ?? 0);
  });
});

describe("the read-only session", () => {
  it("runs as the caller's role in a read-only transaction with the configured settings", async () => {
    const { rows } = await runReadOnlySql(
      `SELECT current_user::text, session_user::text <> current_user::text,
              current_setting('transaction_read_only'),
              current_setting('search_path'), current_setting('TimeZone'),
              current_setting('statement_timeout')`,
      BASE
    );
    expect(rows).toStrictEqual([
      [BASE, true, "on", "analytics, finance", "UTC", "20s"],
    ]);
  });

  it("leaves nothing behind on the pooled connection", async () => {
    const before = await sessionSettings();
    // No earlier query left its role on the connection.
    expect(before[0]).toMatchObject({ 0: true });
    await runReadOnlySql("SELECT 1", FINANCE);
    // The pool hands back the same connection, so a setting that outlived the
    // transaction, such as the role or the search path, would show here.
    await expect(sessionSettings()).resolves.toStrictEqual(before);
    await rejection("SELECT * FROM no_such_table", FINANCE);
    await expect(sessionSettings()).resolves.toStrictEqual(before);
  });

  it("asks Postgres for one row more than the cap, and no more", async () => {
    vi.stubEnv("ANALYST_MAX_ROWS", "25");
    const plan = await explainQuery(
      "SELECT session_id FROM web_sessions",
      BASE
    );
    // The wrapper's LIMIT bounds the plan, so Postgres never sends the whole table.
    expect(plan.planRows).toBe(26);
  });

  it("returns dates and timestamps as text in the reporting time zone", async () => {
    const sql = `SELECT timestamptz '2026-03-01T03:30:00Z' AS at,
                        (timestamptz '2026-03-01T03:30:00Z')::date AS day`;
    const utc = await runReadOnlySql(sql, BASE);
    expect(utc.rows).toStrictEqual([["2026-03-01 03:30:00+00", "2026-03-01"]]);
    vi.stubEnv("ANALYST_TIMEZONE", "America/Los_Angeles");
    const local = await runReadOnlySql(sql, BASE);
    expect(local.rows).toStrictEqual([
      ["2026-02-28 19:30:00-08", "2026-02-28"],
    ]);
    expect(local.timezone).toBe("America/Los_Angeles");
  });

  it("returns exact numbers as strings and reports each column's type", async () => {
    const { columns, rows } = await runReadOnlySql(
      `SELECT 9007199254740993::bigint AS big, 0.1::numeric + 0.2 AS exact,
              true AS flag, NULL::text AS missing, '{"a":1}'::jsonb AS doc`,
      BASE
    );
    expect(columns.map((column) => column.type)).toStrictEqual([
      "bigint",
      "numeric",
      "boolean",
      "text",
      "jsonb",
    ]);
    expect(rows).toStrictEqual([
      ["9007199254740993", "0.3", true, null, { a: 1 }],
    ]);
  });

  it("caps the rows it returns and says so", async () => {
    vi.stubEnv("ANALYST_MAX_ROWS", "25");
    const capped = await runReadOnlySql(
      "SELECT session_id FROM web_sessions ORDER BY session_id",
      BASE
    );
    expect(capped.rowCount).toBe(25);
    expect(capped.truncated).toBe(true);
    expect(capped.truncatedReason).toBe("row-limit");
    const exact = await runReadOnlySql(
      "SELECT plan_id FROM plans ORDER BY plan_id",
      BASE
    );
    expect(exact.rowCount).toBe(facts.rows.plans);
    expect(exact.truncated).toBe(false);
  });

  // PGlite has no timer to interrupt a running query, so this needs a Postgres server.
  it.runIf(process.env.BEHAVIOR_TEST_DATABASE_URL)(
    "stops a query that runs past the statement timeout",
    async () => {
      vi.stubEnv("ANALYST_STATEMENT_TIMEOUT_MS", "1000");
      const slow =
        "SELECT count(*) FROM web_sessions a CROSS JOIN web_sessions b";
      expect(await rejection(slow)).toMatch(
        /canceling statement due to statement timeout/u
      );
      // The cancelled query rolled back, and the connection still serves the next one.
      expect(await scalar("SELECT count(*)::int FROM plans")).toBe(
        facts.rows.plans
      );
    }
  );

  it("accepts a final semicolon and trailing comments", async () => {
    expect(await scalar("SELECT 41 + 1; -- the answer\n/* done */")).toBe(42);
  });

  it("reports a role that doesn't exist as an unavailable warehouse", async () => {
    await expect(runReadOnlySql("SELECT 1", "analyst_missing")).rejects.toThrow(
      WarehouseUnavailableError
    );
    // The failed session setup rolled back, so the next caller starts clean.
    expect(await scalar("SELECT current_user::text")).toBe(BASE);
  });
});

describe("writes", () => {
  it.each([
    ["an insert", "INSERT INTO plans VALUES ('x', 'X', 1, 1)"],
    ["an update", "UPDATE customers SET country = 'ZZ'"],
    ["a delete", "DELETE FROM refunds"],
    ["a truncate", "TRUNCATE customers"],
    ["a dropped table", "DROP TABLE customers"],
    ["a created table", "CREATE TABLE analytics.copy AS SELECT 1"],
    ["a grant", "GRANT analyst_finance TO analyst_readonly"],
    ["a role switch", "SET ROLE analyst_finance"],
    ["a session reset", "RESET ROLE"],
    ["a commit", "COMMIT"],
  ])("refuses %s, which can't be wrapped as a subquery", async (_name, sql) => {
    expect(await rejection(sql)).toMatch(/syntax error/u);
  });

  it.each([
    [
      "an insert",
      "WITH gone AS (INSERT INTO plans VALUES ('x', 'X', 1, 1) RETURNING 1) SELECT * FROM gone",
    ],
    [
      "a delete",
      "WITH gone AS (DELETE FROM refunds RETURNING 1) SELECT count(*) FROM gone",
    ],
  ])("refuses a CTE that hides %s", async (_name, sql) => {
    expect(await rejection(sql)).toMatch(
      /WITH clause containing a data-modifying statement must be at the top level/u
    );
  });

  it("refuses a second statement inside the subquery wrapper", async () => {
    expect(await rejection("SELECT 1; DROP TABLE analytics.customers")).toMatch(
      /syntax error at or near ";"/u
    );
  });

  it.each([
    "SELECT 1) AS a; DELETE FROM analytics.refunds; SELECT * FROM (SELECT 1",
    "SELECT 1) AS a; COMMIT; DROP TABLE analytics.customers; SELECT * FROM (SELECT 1",
  ])(
    "refuses statements stacked by closing the wrapper early: %s",
    async (sql) => {
      // The text is valid SQL once wrapped, so only the extended protocol stops it.
      expect(await rejection(sql)).toMatch(
        /cannot insert multiple commands into a prepared statement/u
      );
    }
  );

  it("leaves every table as it was", async () => {
    expect(await scalar("SELECT count(*)::int FROM plans")).toBe(
      facts.rows.plans
    );
    expect(await scalar("SELECT count(*)::int FROM refunds")).toBe(
      facts.rows.refunds
    );
    expect(await scalar("SELECT count(*)::int FROM customers")).toBe(
      facts.rows.customers
    );
  });
});

describe("functions that could step outside the session", () => {
  it.each([
    ["set_config", "SELECT set_config('role', 'analyst_finance', true)"],
    [
      "set_config",
      "SELECT count(*) FROM customers WHERE set_config('role', 'analyst_finance', true) <> ''",
    ],
    ["query_to_xml", "SELECT query_to_xml('SELECT 1', true, false, '')"],
    ["table_to_xml", "SELECT table_to_xml('analytics.plans', true, false, '')"],
    ["pg_sleep", "SELECT pg_sleep(0)"],
    ["pg_advisory_lock", "SELECT pg_advisory_lock(1)"],
    ["pg_terminate_backend", "SELECT pg_terminate_backend(pg_backend_pid())"],
    ["ts_stat", "SELECT * FROM ts_stat('SELECT 1')"],
  ])("refuses a query that calls %s", async (name, sql) => {
    const plan = await explainQuery(sql, BASE);
    expect(plan.forbidden).toBe(name);
    await expect(runReadOnlySql(sql, BASE)).rejects.toThrow(
      `Queries can't call ${name}().`
    );
  });

  const ESCALATION = `
    SELECT set_config('role', '${FINANCE}', true),
           query_to_xml('SELECT salary_cents FROM finance.payroll', true, false, '')::text`;

  it("refuses the role switch that would read another role's table", async () => {
    await expect(runReadOnlySql(ESCALATION, BASE)).rejects.toThrow(
      "Queries can't call set_config()."
    );
  });

  it("is the only layer that stops it, because Postgres itself would run it", async () => {
    // The SQL text inside query_to_xml is a string, so planning as the base role finds nothing to refuse.
    const { rows } = await withReadOnly(BASE, (client) =>
      client.query({
        queryMode: "extended",
        rowMode: "array",
        text: ESCALATION,
      })
    );
    expect(JSON.stringify(rows)).toContain("12500000");
  });

  it("refuses a forbidden call even when a string only spells it", async () => {
    // The plan check matches names in the plan's output, so it fails closed on a literal.
    await expect(
      runReadOnlySql("SELECT 'call pg_sleep(1) later' AS note", BASE)
    ).rejects.toThrow("Queries can't call pg_sleep().");
  });

  it("allows reading settings and functions with similar names", async () => {
    expect(
      await scalar(
        "SELECT current_setting('role') || ':' || length('pg_sleep')::text"
      )
    ).toBe(`${BASE}:8`);
  });
});

describe("role separation", () => {
  const payroll = "SELECT sum(salary_cents)::bigint FROM finance.payroll";

  it("keeps the restricted schema from the base role", async () => {
    await expect(runReadOnlySql(payroll, BASE)).rejects.toThrow(
      /permission denied for schema finance/u
    );
    await expect(explainQuery(payroll, BASE)).rejects.toThrow(
      /permission denied for schema finance/u
    );
  });

  it("lets the team role read it, along with everything the base role reads", async () => {
    expect(await scalar(payroll, FINANCE)).toBe("25600000");
    expect(await scalar("SELECT count(*)::int FROM customers", FINANCE)).toBe(
      facts.rows.customers
    );
    const { tables } = await explainQuery(payroll, FINANCE);
    expect(tables).toStrictEqual(["finance.payroll"]);
  });

  it("lists only the tables each role can query", async () => {
    const base = await visibleTables(BASE);
    expect(base).toStrictEqual(
      expect.arrayContaining(
        Object.keys(facts.rows).map((table) => `analytics.${table}`)
      )
    );
    expect(base).not.toContain("finance.payroll");
    expect(await visibleTables(FINANCE)).toStrictEqual([
      ...base,
      "finance.payroll",
    ]);
  });

  it("describes a restricted table only to a role that can read it", async () => {
    expect(await describeTables(BASE, ["finance.payroll"])).toStrictEqual([]);
    const [table] = await describeTables(FINANCE, ["payroll"]);
    expect(table).toMatchObject({
      comment: "Salaries. Finance only.",
      name: "finance.payroll",
    });
    expect(table?.columns.join("\n")).toMatch(/salary_cents.*bigint/u);
  });
});

describe("schema discovery", () => {
  it("estimates row counts from planner statistics", async () => {
    const { tables, truncated } = await listTables(BASE);
    expect(truncated).toBe(false);
    for (const [name, rows] of Object.entries(facts.rows)) {
      const table = tables.find((entry) => entry.name === `analytics.${name}`);
      expect(table?.kind).toBe("table");
      // ANALYZE samples large tables, so the estimate is close rather than exact.
      expect(table?.approxRows).toBeGreaterThan(rows * 0.9);
      expect(table?.approxRows).toBeLessThan(rows * 1.1);
    }
  });

  it("returns columns, comments, and keys for the tables asked for", async () => {
    const [customers, subscriptions] = await describeTables(BASE, [
      "customers",
      "analytics.subscriptions",
      "no_such_table",
    ]);
    expect(customers?.name).toBe("analytics.customers");
    expect(customers?.comment).toBe(
      "One row per account that signed up, paying or not."
    );
    expect(customers?.columns.join("\n")).toMatch(/is_internal.*boolean/u);
    expect(customers?.keys.join("\n")).toMatch(/PRIMARY KEY \(customer_id\)/u);
    expect(subscriptions?.keys.join("\n")).toMatch(
      /FOREIGN KEY \(customer_id\) REFERENCES (?:analytics\.)?customers/u
    );
  });
});

describe("the planner estimate behind the approval gate", () => {
  it("prices a whole-table join far above a single-table aggregate", async () => {
    const cheap = await explainQuery("SELECT count(*) FROM web_sessions", BASE);
    const expensive = await explainQuery(
      "SELECT count(*) FROM web_sessions a CROSS JOIN web_sessions b",
      BASE
    );
    expect(cheap.totalCost).toBeLessThan(1_000_000);
    expect(expensive.totalCost).toBeGreaterThan(1_000_000);
    expect(expensive.tables).toStrictEqual(["analytics.web_sessions"]);
  });
});
