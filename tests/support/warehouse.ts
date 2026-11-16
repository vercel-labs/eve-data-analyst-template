/**
 * An in-process Postgres that the behavior tests query through the real `pg` driver.
 *
 * @packageDocumentation
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Client } from "pg";

import {
  DEMO_SCHEMA,
  derivePassword,
  DERIVED_LOGIN,
} from "#lib/analyst/derived-login";
import { loadDemoData } from "#scripts/seed/load";
import { planDeploySetup } from "#scripts/setup-on-deploy/plan";
import { buildSetupSql } from "#scripts/setup-sql/build";

/** The instant the demo data runs through, fixed so every run loads identical rows. */
const WAREHOUSE_ANCHOR = "2026-10-10T00:00:00.000Z";

/** Slack user mapped to the finance team role, which alone can read the restricted schema. */
export const FINANCE_USER = "U0FINANCE";

/** Slack user whose access is turned off with an empty role. */
export const BLOCKED_USER = "U0BLOCKED";

/** The restricted schema, listed in `ANALYST_SCHEMAS` but not shared with the base role. */
export const RESTRICTED_SCHEMA = "finance";

/** Environment variables that point the analyst at the test warehouse, as a deployed project would set them. */
export type WarehouseEnv = Readonly<Record<string, string>>;

/** Facts computed from the generated rows in JavaScript, never from SQL, so tests can check query results against them. */
export interface WarehouseFacts {
  /** The instant the demo data runs through. */
  readonly anchor: string;
  /** Customers that aren't internal test accounts. */
  readonly externalCustomers: number;
  /** MRR in cents at the anchor, by the metric definition: started, not ended, and not internal. */
  readonly mrrCentsAtAnchor: number;
  /** Rows in each demo table. */
  readonly rows: Readonly<Record<string, number>>;
  /** Web sessions that aren't bots, by source. */
  readonly sessionsBySource: Readonly<Record<string, number>>;
}

/** A running test warehouse. */
export interface TestWarehouse {
  readonly env: WarehouseEnv;
  readonly facts: WarehouseFacts;
  /** Stops the socket server and the database. */
  readonly stop: () => Promise<void>;
}

/* Creates what an admin adds by hand: a schema only the finance role can read. */
const RESTRICTED_SCHEMA_SQL = `
  DROP SCHEMA IF EXISTS ${RESTRICTED_SCHEMA} CASCADE;
  CREATE SCHEMA ${RESTRICTED_SCHEMA};
  CREATE TABLE ${RESTRICTED_SCHEMA}.payroll (
    employee text PRIMARY KEY,
    salary_cents bigint NOT NULL
  );
  COMMENT ON TABLE ${RESTRICTED_SCHEMA}.payroll IS 'Salaries. Finance only.';
  INSERT INTO ${RESTRICTED_SCHEMA}.payroll VALUES ('Ada', 12500000), ('Grace', 13100000);
  ANALYZE ${RESTRICTED_SCHEMA}.payroll;
  GRANT USAGE ON SCHEMA ${RESTRICTED_SCHEMA} TO analyst_finance;
  GRANT SELECT ON ALL TABLES IN SCHEMA ${RESTRICTED_SCHEMA} TO analyst_finance;
`;

/** A Postgres server the tests can reach as a database owner. */
interface OwnerServer {
  readonly ownerUrl: string;
  readonly stop: () => Promise<void>;
}

/* Starts PGlite behind a TCP socket on a free local port. */
const startInProcessServer = async (): Promise<OwnerServer> => {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    maxConnections: 8,
    port: 0,
  });
  await server.start();
  return {
    ownerUrl: `postgres://owner:owner-password-1234@${server.getServerConn()}/postgres`,
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
};

/**
 * Starts a Postgres warehouse and sets it up exactly as a deploy does.
 *
 * @returns The environment that reaches it, facts about its data, and a function that stops it.
 * @remarks By default Postgres runs in this process as PGlite behind a TCP socket, so the analyst's own `pg` pool connects to it and nothing leaves the machine. The demo data comes from the project's loader with a fixed anchor, and the roles from the same plan and SQL the deploy step runs. PGlite has one session shared by every connection, running as a superuser, so those runs can't cover login failures or `statement_timeout`, which PGlite doesn't enforce. Set `BEHAVIOR_TEST_DATABASE_URL` to an owner connection string for an empty, disposable database to run the same tests against a Postgres server instead. The tests replace its `analytics` and `finance` schemas and create the analyst roles.
 */
export const startWarehouse = async (): Promise<TestWarehouse> => {
  const external = process.env.BEHAVIOR_TEST_DATABASE_URL?.trim();
  const server: OwnerServer = external
    ? { ownerUrl: external, stop: () => Promise.resolve() }
    : await startInProcessServer();
  const env = {
    ANALYST_APPROVAL_COST: "1000000",
    ANALYST_DEFAULT_ROLE: "analyst_readonly",
    ANALYST_MAX_ROWS: "500",
    ANALYST_ROLE_MAP: JSON.stringify({
      [BLOCKED_USER]: "",
      [FINANCE_USER]: "analyst_finance",
    }),
    ANALYST_SCHEMAS: `${DEMO_SCHEMA},${RESTRICTED_SCHEMA}`,
    ANALYST_SEED_DEMO_DATA: "true",
    ANALYST_SHARED_SCHEMAS: DEMO_SCHEMA,
    ANALYST_STATEMENT_TIMEOUT_MS: "20000",
    ANALYST_TIMEZONE: "UTC",
    DATABASE_URL: server.ownerUrl,
  } satisfies WarehouseEnv;
  const plan = planDeploySetup({ ...env });
  if (plan.action !== "setup") {
    throw new Error(`Expected a setup plan, got: ${plan.reason}`);
  }
  const owner = new Client({ connectionString: plan.ownerUrl });
  await owner.connect();
  try {
    const anchor = new Date(WAREHOUSE_ANCHOR);
    const { data } = await loadDemoData(owner, DEMO_SCHEMA, [], { anchor });
    await owner.query(
      buildSetupSql({
        baseRole: plan.baseRole,
        login: DERIVED_LOGIN,
        password: derivePassword(plan.ownerUrl),
        schemas: plan.schemas,
        setPassword: true,
        sharedSchemas: plan.sharedSchemas,
        teamRoles: plan.teamRoles,
      })
    );
    await owner.query(RESTRICTED_SCHEMA_SQL);
    const internal = new Set(
      data.customers
        .filter((customer) => customer.is_internal)
        .map((customer) => customer.customer_id)
    );
    const sessionsBySource: Record<string, number> = {};
    for (const session of data.webSessions) {
      if (!session.is_bot) {
        sessionsBySource[session.source] =
          (sessionsBySource[session.source] ?? 0) + 1;
      }
    }
    const at = anchor.getTime();
    return {
      env,
      facts: {
        anchor: WAREHOUSE_ANCHOR,
        externalCustomers: data.customers.length - internal.size,
        mrrCentsAtAnchor: data.subscriptions
          .filter(
            (subscription) =>
              !internal.has(subscription.customer_id) &&
              subscription.started_at !== null &&
              subscription.started_at.getTime() < at &&
              (subscription.ended_at === null ||
                subscription.ended_at.getTime() >= at)
          )
          .reduce((total, subscription) => total + subscription.mrr_cents, 0),
        rows: {
          customers: data.customers.length,
          invoices: data.invoices.length,
          payments: data.payments.length,
          plans: data.plans.length,
          refunds: data.refunds.length,
          signups: data.signups.length,
          subscriptions: data.subscriptions.length,
          web_sessions: data.webSessions.length,
        },
        sessionsBySource,
      },
      stop: server.stop,
    };
  } catch (error) {
    await server.stop();
    throw error;
  } finally {
    await owner.end();
  }
};
