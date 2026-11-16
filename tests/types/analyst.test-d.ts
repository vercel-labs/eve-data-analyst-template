/**
 * The analyst's own contracts: who may query, with which settings, and what a query returns.
 *
 * @packageDocumentation
 */
import type { SessionAuthContext } from "eve/context";
import { describe, expectTypeOf, it } from "vitest";

import type {
  requireAnalystRole,
  resolveAnalystRole,
  RoleResolution,
} from "#lib/analyst/access";
import type { AnalystConfig } from "#lib/analyst/config";
import type {
  AnalystClient,
  explainQuery,
  QueryPlan,
  QueryResult,
  runReadOnlySql,
} from "#lib/analyst/postgres";
import type { LoggedQuery } from "#lib/analyst/query-log";
import type {
  conflictsWithThreadRoles,
  ROLE_SCOPED_TOOLS,
} from "#lib/analyst/thread-roles";
import type { JsonValue } from "#lib/json";
import type { LoadOptions } from "#scripts/seed/load";
import type { DeploySetupPlan } from "#scripts/setup-on-deploy/plan";

describe("access", () => {
  it("resolves a caller to a role or to a reason, never both", () => {
    expectTypeOf<RoleResolution>().toEqualTypeOf<
      | { readonly ok: true; readonly role: string }
      | { readonly ok: false; readonly reason: string }
    >();
    expectTypeOf<typeof resolveAnalystRole>()
      .parameter(0)
      .toEqualTypeOf<SessionAuthContext | null>();
    expectTypeOf<
      typeof resolveAnalystRole
    >().returns.toEqualTypeOf<RoleResolution>();
  });

  it("returns the role name or throws", () => {
    expectTypeOf<typeof requireAnalystRole>().returns.toBeString();
  });

  it("checks a caller against the thread's recorded roles", () => {
    expectTypeOf<typeof conflictsWithThreadRoles>().toEqualTypeOf<
      (auth: SessionAuthContext | null) => boolean
    >();
    expectTypeOf<typeof ROLE_SCOPED_TOOLS>().toEqualTypeOf<
      ReadonlySet<string>
    >();
  });
});

describe("settings", () => {
  it("parses numbers, lists, and the role map into their own types", () => {
    expectTypeOf<AnalystConfig["ANALYST_APPROVAL_COST"]>().toBeNumber();
    expectTypeOf<AnalystConfig["ANALYST_MAX_ROWS"]>().toBeNumber();
    expectTypeOf<AnalystConfig["ANALYST_STATEMENT_TIMEOUT_MS"]>().toBeNumber();
    expectTypeOf<AnalystConfig["ANALYST_SCHEMAS"]>().toEqualTypeOf<string[]>();
    expectTypeOf<AnalystConfig["ANALYST_SHARED_SCHEMAS"]>().toEqualTypeOf<
      string[]
    >();
    expectTypeOf<AnalystConfig["ANALYST_TIMEZONE"]>().toBeString();
    expectTypeOf<AnalystConfig["ANALYST_DATABASE_URL"]>().toBeString();
  });

  it("plans a deploy as either a skip with a reason or a full setup", () => {
    expectTypeOf<DeploySetupPlan["action"]>().toEqualTypeOf<"setup" | "skip">();
    expectTypeOf<
      Extract<DeploySetupPlan, { action: "skip" }>["reason"]
    >().toBeString();
    expectTypeOf<
      Extract<DeploySetupPlan, { action: "setup" }>["sharedSchemas"]
    >().toEqualTypeOf<readonly string[]>();
  });

  it("lets a caller fix the instant the demo data runs through", () => {
    expectTypeOf<LoadOptions["anchor"]>().toEqualTypeOf<Date | undefined>();
  });
});

describe("queries", () => {
  it("takes model-written SQL and a role, in that order", () => {
    expectTypeOf<typeof runReadOnlySql>().parameters.toEqualTypeOf<
      [sql: string, role: string]
    >();
    expectTypeOf<typeof explainQuery>().parameters.toEqualTypeOf<
      [sql: string, role: string]
    >();
  });

  it("returns JSON rows with their columns, the tables read, and how they were cut", () => {
    expectTypeOf<
      Awaited<ReturnType<typeof runReadOnlySql>>
    >().toEqualTypeOf<QueryResult>();
    expectTypeOf<QueryResult["rows"]>().toEqualTypeOf<JsonValue[][]>();
    expectTypeOf<QueryResult["tables"]>().toEqualTypeOf<string[]>();
    expectTypeOf<QueryResult["truncatedReason"]>().toEqualTypeOf<
      "output-size" | "row-limit" | null
    >();
  });

  it("plans a query with its cost, its tables, and any forbidden call", () => {
    expectTypeOf<QueryPlan["totalCost"]>().toBeNumber();
    expectTypeOf<QueryPlan["planRows"]>().toBeNumber();
    expectTypeOf<QueryPlan["forbidden"]>().toEqualTypeOf<string | null>();
    expectTypeOf<QueryPlan["tables"]>().toEqualTypeOf<string[]>();
  });

  it("needs only query and release from a database client", () => {
    expectTypeOf<keyof AnalystClient>().toEqualTypeOf<"query" | "release">();
  });

  it("logs each query with its purpose, SQL, tables, and time", () => {
    expectTypeOf<LoggedQuery>().toEqualTypeOf<{
      readonly purpose: string;
      readonly ranAt: string;
      readonly sql: string;
      readonly tables: readonly string[];
    }>();
  });
});
