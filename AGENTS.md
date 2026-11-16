# eve Data Analyst

This repository is a reusable Slack-based data analyst built on eve. It answers questions by exploring a Postgres database, applying the team's metric definitions, and running read-only SQL as the asking person's database role. Use Node.js 24 and pnpm.

These instructions are for agents maintaining the repository. The analyst's behavior is defined in [agent/instructions.md](agent/instructions.md), the skills under `agent/skills/`, and the dynamic instructions under `agent/instructions/`.

## Project map

| Change | Location |
| --- | --- |
| Analyst behavior, answer format, visualization rules, memory rules, and response style | `agent/instructions.md` |
| Metric definitions and SQL conventions | `agent/skills/metric-definitions.md` and `agent/skills/sql-style.md` |
| Current time and reporting time zone context | `agent/instructions/current-time.ts` |
| Model and session limits | `agent/agent.ts` and `agent/lib/session-usage.ts` |
| Warehouse tools | `agent/tools/run_sql.ts` and `agent/tools/describe_schema.ts`, implemented in `agent/lib/tools/` |
| Configuration, role resolution, SQL safety, and Postgres access | `agent/lib/analyst/` |
| Cost-based approval and its Slack card | `agent/lib/analyst/approval.ts` and `agent/lib/analyst/approval-card.ts` |
| Thread role guard, which keeps query results with the role that fetched them | `agent/hooks/thread-role-guard.ts`, implemented in `agent/lib/analyst/thread-role-guard.ts` and `agent/lib/analyst/thread-roles.ts`, with the Slack notice in `agent/lib/integrations/slack/replies.ts` |
| Slack charts and tables | `agent/tools/post_slack_*.ts`, implemented in `agent/lib/tools/` and `agent/lib/integrations/slack/visualizations/` |
| Folded "SQL query" section on Slack answers | `agent/lib/analyst/query-log.ts` and `agent/lib/analyst/sql-attachment.ts`, attached by `agent/lib/integrations/slack/replies.ts` and `visualizations/post.ts` |
| Memory slots and scopes | `agent/memory/` and `agent/lib/memory/scope.ts` |
| Slack channel, sender auth, profile lookups, and message edits | `agent/channels/slack.ts`, its settings in `agent/lib/analyst/slack-channel.ts`, and `agent/lib/integrations/slack/` |
| HTTP channel and caller auth | `agent/channels/eve.ts` |
| Built-in tool overrides | `agent/tools/web_fetch.ts` and `agent/tools/web_search.ts` |
| Local and hosted sandbox selection | `agent/sandbox.ts` |
| Deploy-time database setup (`vercel-build` and `pnpm db:setup`) | `scripts/setup-on-deploy.ts` and `scripts/setup-on-deploy/plan.ts` |
| Demo data, manual role setup, and health checks | `scripts/seed.ts`, `scripts/seed/`, `scripts/setup-sql.ts`, and `scripts/doctor.ts` |
| Model-in-the-loop evals | `evals/` |
| Shared test fixtures | `agent/lib/testing/` |
| Behavior tests against a real Postgres, the compiled-agent contract, and type tests | `tests/behavior/`, `tests/types/`, and `tests/support/` |
| End-to-end tests through the eve runtime, with a scripted model and a fake Slack | `tests/e2e/`, with the fixture agent in `tests/e2e/app/` |
| Setup and customization guidance | `README.md`, `CUSTOMIZATION.md`, and `.env.example` |

Keep the template focused on answering questions from Postgres. Optional integrations, such as Stripe or PostHog connections, are documented in `CUSTOMIZATION.md` and not installed by default.

## Before implementing changes

Inspect the relevant implementation and nearby tests. For eve API changes, start with [the installed documentation index](node_modules/eve/docs/README.md), then read the page it identifies for the task. Use [eve's published documentation](https://eve.dev/docs) if the installed docs are unavailable. Verify third-party APIs, including `pg`, against the installed package or current official documentation rather than relying on recalled signatures.

Keep discovery focused: read the routed documentation and the files the change needs, then implement.

Content-only changes to the instructions or skills need no framework research. Preserve the configured model unless changing it is part of the request.

For a new external integration, check the eve registry before writing one from scratch:

```sh
pnpm exec eve registry search <query> --json
pnpm exec eve registry view <item>
```

Prefer native integrations. When installation is part of the task, use `pnpm exec eve add <item> --non-interactive`. Exit code 2 means setup needs an answer or a prerequisite, so read the final NDJSON event and follow its next command. Pass secrets as environment variables, keeping `--answer` for non-secret values.

## Implementation conventions

Keep files in `agent/tools/` to one-line re-exports, with behavior in `agent/lib/`. The filename exemption for `agent/tools/*.ts` in `oxlint.config.ts` exists because eve names tools after their files.

Modules the setup scripts import run under Node's built-in type stripping, so they and everything they import must use `#lib/...` or `#scripts/...` imports and erasable TypeScript syntax only. This covers `agent/lib/analyst/` (except `approval*.ts`, `slack-channel.ts`, and `thread-role*.ts`), `agent/lib/json.ts`, `agent/lib/slack-ids.ts`, `agent/lib/slack-text.ts`, `agent/lib/values.ts`, and `scripts/`. Eval files follow eve's docs and use `.js` specifiers for relative imports.

Parse database rows at the boundary with Zod before using them, as `agent/lib/analyst/postgres.ts` does, and test Postgres behavior through the `postgres.connect` seam with the fake client in `agent/lib/testing/postgres.ts`.

Keep the strict TypeScript and Ultracite configuration, and change the code to satisfy its rules. The only override beyond the tool filenames allows sequential awaits in `scripts/`, where statements must run in order.

Add useful TSDoc when introducing or changing exported helpers, tools, channels, scopes, or configuration types. Document parameters with `@param name - description`, type parameters with `@typeParam`, and meaningful return values with `@returns`. Use `@remarks` for behavior callers need to know.

Document new configuration in `.env.example` and `CUSTOMIZATION.md` without credentials, and add it to the Zod schema in `agent/lib/analyst/config.ts` so every problem is reported at once.

## SQL safety to preserve

Each layer below works on its own, so keep every one of them complete:

- `withReadOnly` opens `BEGIN TRANSACTION READ ONLY`, then sets `statement_timeout`, `ROLE`, `search_path`, and `TIME ZONE` with `SET LOCAL`, and always rolls back. It destroys the connection when the rollback fails. Connections are pooled, so every setting stays `SET LOCAL`.
- Model-authored SQL only runs through `wrapQuery`, as `SELECT * FROM (<sql>) AS eve_q LIMIT n`, with `queryMode: "extended"`. The wrapper rejects writes and data-modifying CTEs, and the extended protocol rejects stacked statements.
- `normalizeSql` removes only a final semicolon and the whitespace and comments after it. The plan check and the run both wrap the same normalized text, so every other layer still applies to exactly what runs.
- The approval policy and `runReadOnlySql` both plan the exact wrapped query with `EXPLAIN (VERBOSE, FORMAT JSON)` and refuse plans that call `set_config` or functions that run SQL text. Those are the `*_to_xml` family, `ts_stat`, `ts_rewrite`, `dblink`, and the contrib functions `crosstab`, `connectby`, and `xpath_table`. A psql check confirmed that, without this, a role could read another granted role's tables through `set_config('role', ...)` plus `query_to_xml`. The SQL text these functions run can be assembled at runtime, so only the function names can be matched. The same check refuses session-level advisory locks, which would outlive the rollback on a pooled connection, `pg_sleep`, and the functions that cancel or end other sessions. Keep both checks and extend `FORBIDDEN_CALL` in `agent/lib/analyst/sql.ts` when Postgres or an installed extension adds similar functions. The list can't cover user-defined functions that run dynamic SQL, so separate logins per role, or revoking `set_config` from `PUBLIC`, remain the complete fix.
- Only validated values are interpolated into SQL: role names through `identifierSchema`, schema names through `schemaNameSchema`, integers from the config schema, and time zones through `isTimeZone`. Everything else is a bind parameter. `schemaNameSchema` differs only by allowing `public`, which stays reserved as a role name. `db:seed` still refuses `public`, because it replaces the schema it loads.
- `resolveAnalystRole` reads `ANALYST_ROLE_MAP` with `Object.hasOwn` on a null-prototype map. Keys are full principal IDs, bare Slack member IDs, or Slack channel IDs, taken only from the verified Slack webhook attributes of a Slack user principal. Precedence is a personal denial under either the full principal ID or the bare Slack user ID, then the current channel's role, then the personal role, where the full principal ID wins over the bare ID, then the default. Principal IDs shaped like bare Slack user or channel IDs are never looked up directly. Service, runtime, and anonymous callers get access only through an entry for their own principal ID, and channel roles apply to people only. Update `access.test.ts` with any change.
- The thread role guard records the caller's role in session state after every `run_sql` or `describe_schema` call that settles as completed. eve's `call.settled` event doesn't name the tool, so the hook reads the name from the session view with `call(ctx.view, callId)`. Its `turn.started` hook cancels a turn whose caller resolves to a different role or to no access. The Slack `turn.settled` renderer in `replies.ts` runs the same check when the outcome is `cancelled` and posts the "start a new thread" notice. It can't rely on a marker from the hook, because state a hook writes just before `ctx.cancel()` isn't kept. Roles are recorded by tool name through `ROLE_SCOPED_TOOLS` in `thread-roles.ts`, so renaming either tool file without updating that list silently turns the guard off. `local-dev` and callers who share a role are never blocked. Update `thread-roles.test.ts` and `thread-role-guard.test.ts` with any change.
- `run_sql` keeps `approval: { request: requestRunSqlApproval, response: respondToRunSqlApproval }` as an inline object literal, because eve compiles the `approval` property from source and treats a bare identifier as a policy function. The request policy fails closed with a denial carrying the Postgres error. Errors that `isWarehouseUnavailable` recognizes, such as a failed connection, a failed `SET LOCAL ROLE`, or a server shutdown, tell the model to stop and tell the person. Every other error tells it to fix the SQL. The response policy admits only the asking principal when it is a person or `local-dev`. eve's answers to an approval are `approve` and `deny`.
- The agent always queries as the read-only login. It reads `DATABASE_URL` only to derive the `eve_analyst` login's connection with `deriveAnalystUrl`, and only when `ANALYST_DATABASE_URL` is unset. Keep `derivePassword`, `loginUrl`, and the login name in `agent/lib/analyst/derived-login.ts` shared between the deploy step, `scripts/setup-sql.ts`, and the agent. `derivePassword` uses only the owner's password and refuses a `DATABASE_URL` without one. `scripts/seed.ts` refuses to run against `ANALYST_DATABASE_URL`. Every tool stays read-only.
- `web_fetch` and `web_search` stay disabled, and `agent/sandbox.ts` blocks outbound network access when deployed, so query results stay in the conversation. `bash`, `read_file`, `write_file`, and `edit_file` only reach the sandbox. `tests/behavior/agent.test.ts` lists the exact built-in and authored tools of the compiled agent, and `tests/e2e/http.test.ts` lists every tool the model is offered at run time, so a tool that a later eve release adds fails a test until someone checks it against this rule. The built-in `agent` tool is still enabled, as it was before eve 1.0. A task it starts runs in a child session with its own state, so a query the child runs isn't recorded for the thread role guard or the SQL section of the parent thread. Export `disableTool()` from `agent/tools/agent.ts` to remove it.

## SQL attachment behavior to preserve

- The SQL shown in Slack comes from `recordQuery` in `run_sql`'s `execute`, after the query succeeded, so the section always matches what ran.
- The instructions tell the model that the section is attached for it, so its replies leave out SQL. Change the two together.
- The attachment keeps the reply's fallbacks: `replies.ts` posts through `postCompletedSlackReply` with the SQL repeated in the Markdown fallback, and `visualizations/post.ts` adds it to the text fallback when it fits. That fallback comes from `sqlAttachmentMrkdwn`, which uses `escapeMrkdwnCode` from `agent/lib/slack-text.ts` to escape mrkdwn and break runs of three or more backticks with zero-width spaces so the SQL can't close its code block. After a block rejection, `post.ts` retries with the SQL as plain blocks from `sqlAttachmentPlainBlocks`, skipping that step for size errors, then posts the visualization alone, then text only. Whenever the delivered message can't show the SQL, it posts the SQL as its own text message and ignores that message's failure, because the tool ends the turn and no final reply follows. A renderer that takes over the final reply owns its delivery, so let errors propagate to eve's delivery notice and post each reply once.

## Slack rendering to preserve

- `replies.ts` handles eve's `content.completed` event, and treats only a part with `phase: "reply"` and `kind: "text"` as the final answer. Narration, reasoning, files, and structured results go to eve's default renderer. It handles `turn.settled` for cancelled turns. Renderers take `(event, ctx, next)`, and the Slack thread is `ctx.channel.thread`.
- The run_sql approval card in `approval-card.ts` is an `interactionCard` renderer. eve posts the card, routes clicks, tells a refused responder why, and updates the card when the request is answered or ends. eve checks every card it gets back: an open, unanswered request must hold exactly eve's own controls, with the same `action_id` and `value`, and an answered or ended request must hold none. A card that breaks either rule is replaced by eve's default, so only relabel the buttons. The card reads the query estimate from session state inside a `try`, because eve can render a card outside a session step.
- A session-limit prompt's Continue resumes the same turn, with the same turn ID. The visualization receipt and the query log are keyed on that turn ID, so they need no transfer between turns.
- `createSlackInboundHandlers` drops message edits by default, through `onMessageEdited`. Without that hook, eve sends an edit through the mention, DM, and message hooks, and an edit that arrives after the reply starts another turn.
- `createSlackChannel` takes `credentials` only so the channel can run without Vercel Connect. `agent/channels/slack.ts` passes none.

## Deploy-time setup to preserve

- `vercel-build` runs `scripts/setup-on-deploy.ts` before `eve build`. It does nothing when `ANALYST_DATABASE_URL` is set, or when `DATABASE_URL` is unset or has no password. Otherwise it loads demo data only when `ANALYST_SEED_DEMO_DATA` is on and the demo schema is missing or older than a week, and replaces only schemas the seed created.
- A failed demo reload is logged, and the role setup still runs.
- It catches every error and exits successfully, so deploys always complete and the agent reports unfinished setup in Slack.
- Setup grants the base role `USAGE`, `SELECT` on existing tables, and default privileges only in `ANALYST_SHARED_SCHEMAS`, which defaults to `ANALYST_SCHEMAS` and must be a subset of it. It grants and revokes nothing in the other `ANALYST_SCHEMAS` schemas, because team roles inherit the base role. Discovery in `agent/lib/analyst/postgres.ts` filters on `has_schema_privilege` and `has_table_privilege`, so each person sees only tables their role can query. `resolveSchemaLists` in `agent/lib/analyst/schemas.ts` resolves the two lists, including the demo schema, for `parseAnalystConfig`, `planDeploySetup`, and `scripts/setup-sql.ts`, so keep all three using it. Each caller validates the names itself.
- `loadDemoData` builds the new data, grants, and planner statistics in `eve_demo_staging` inside one transaction. It then drops the seed's own tables by name and the live schema with the default `RESTRICT`, and renames the staging schema into place under `lock_timeout`, retrying from a savepoint. Postgres checks dependencies under the drop's locks, so anything added to the schema or depending on it during the load stops the swap. `replacementBlocker` only refuses early with a clearer reason. Only `db:seed --force` drops with `CASCADE`. Live demo tables stay readable during the load. The marker table and schema comment move with the rename, so `replacementBlocker` keeps working. When a table leaves `DEMO_TABLES`, keep its name in the lists that `inspectDemoSchema` and `dropDemoSchemaStatements` use, or existing demo schemas refuse every reload until someone runs `db:seed --force`.
- `pnpm db:doctor` judges demo data freshness by `_eve_demo_seed.anchor_at` and `DEMO_DATA_MAX_AGE_MS` from `scripts/setup-on-deploy/plan.ts`, the same rule the deploy uses to reload it.
- The deploy step creates the pg `Client` inside the `try`, with `connectionTimeoutMillis` and an `error` listener, because its constructor parses `DATABASE_URL` and reads certificate files. `scripts/setup-on-deploy.test.ts` runs the script as a child process and checks that it exits successfully.
- Keep code, messages, and test fixtures provider-neutral, with generic wording and `example.com` hosts.

## Metric and memory behavior to preserve

- `agent/skills/metric-definitions.md` defines the metrics. The instructions and both memory descriptions tell the agent to keep metric definitions and SQL in the skill, and to follow the skill when memory disagrees with it.
- `scripts/seed/sql.ts` mirrors the skill's MRR and traffic SQL for the seed summary and eval ground truth. Keep the three in sync.
- Memory scopes come only from authenticated session details. `bySlackChannel` accepts only Slack webhook user principals with a `slack:<team>` issuer and a public or private channel ID, and `byHumanPrincipal` disables user memory for service principals. Return `null` when a caller doesn't qualify.
- Renaming a memory slot file or changing a scope's tuple shape orphans existing memories. Keep the old namespace with `defaultNamespace({ ...ctx, slot: "<old-name>" })` from `eve/memory` when renaming.

## Local and hosted behavior

`pnpm dev` opens eve's terminal chat as the `local-dev` principal, which gets `ANALYST_DEFAULT_ROLE` and can answer its own approval prompts. Local sessions use `just-bash`, skip Slack profile lookups, and keep memory while the server runs. Slack tables and charts post in Slack threads.

The hosted agent uses Vercel Sandbox and stores memory in a private Vercel Blob store. The Slack channel requires `SLACK_CONNECTOR`, so `pnpm exec eve info`, `pnpm build`, and `pnpm eval` fail when it is unset; use `slack/placeholder` when only checking compilation. Database settings are validated when a tool first runs, so builds succeed before the database is configured.

Use the Vercel CLI for project configuration and deployment instructions, including `vercel deploy --prod` and `vercel env add`. Provisioning services or deploying the agent is separate from checking code and documentation.

## Documentation standards

Keep `README.md` short, with the deployment flow, the technology and customization tables, and brief summaries that link to `CUSTOMIZATION.md` for detailed steps.

Write for a person using the template:

- Name the kind of thing on first use, such as "the `ANALYST_SCHEMAS` environment variable" or "the `pnpm db:setup` script", and say what it controls before showing it. State the default, and what happens when a value is unset.
- Explain terms on first use, such as role, schema, and memory. Prefer everyday words, such as "database user" over "principal".
- Frame guidance positively. Say what to do and what happens, such as "Deploy with `vercel deploy --prod`, which keeps your `.env.local` file as it is."
- Keep sentences short, with one idea each, and keep introductions to the essentials.
- Write the way a teammate would explain it. Leave out filler and stock phrases such as "seamless", "robust", "leverage", and "source of truth", along with em dashes, "not just X but Y", forced groups of three, parenthetical asides, bold lead-ins, colons joining two sentences, and sentences beginning with "A" or "An".
- Keep code comments, messages, and docs provider-neutral, and describe databases as Postgres.
- Say which memory a statement applies to, user memory or channel memory, when the difference matters.
- Lowercase Vercel environment names mid-sentence, such as "preview" and "production".
- Keep commands usable in context. Identify required input and explain how to recognize success.

Verify behavior against code and current CLI help, and reread each section as a whole for contradictions and repetition.

## Validation

Choose checks that establish the changed behavior. Unit tests live beside their implementations under `agent/` and `scripts/`, and use the fakes in `agent/lib/testing/`. The tests under `tests/` run real components:

- `tests/behavior/warehouse.test.ts` and `tests/behavior/tools.test.ts` run the SQL safety layers, the tools, and the approval policy against a real Postgres through the real `pg` driver. `tests/support/warehouse.ts` starts that Postgres inside the test process with PGlite, loads the demo data with the project's own loader and a fixed anchor, and creates the roles with the same plan and SQL the deploy step runs. Expected values come from the generated rows, computed in JavaScript, so a query result is checked against a second calculation. PGlite shares one session between connections and doesn't enforce `statement_timeout`, so these files run one at a time, and the statement timeout test runs only against a Postgres server.
- `tests/behavior/agent.test.ts` compiles the real agent with `eve info --json` and checks the model, the exact list of built-in and authored tools, the tool input schemas, and every registered file. eve adds more tools when a session runs, such as `eve__skill` and each memory slot's tools, and `eve info` doesn't list those. The end-to-end tests list them.
- `tests/e2e/*.test.ts` run whole conversations through the eve runtime. `tests/e2e/global-setup.ts` starts the same Postgres, a fake Slack Web API, and `eve dev` on the fixture agent in `tests/e2e/app/`. The fixture re-exports every production tool, hook, instruction, skill, memory slot, and the Slack channel settings, and replaces only the model with a scripted one, the Slack credentials with a signing secret, and the Slack API host. Tests send messages over the HTTP channel or as signed Slack webhooks, then check the session's events and what the fake Slack received. They cover approvals and the approval card, the thread role guard, the session limit prompt, the SQL section, charts and tables, message routing, and memory scopes. `tests/e2e/fixture.test.ts` fails when a file under `agent/` has no mirror in the fixture, so add the one-line re-export when you add a tool, hook, instruction, skill, channel, or memory slot. `tests/e2e/http.test.ts` lists every tool the model is offered at run time, including the ones eve adds for skills, tasks, and memory.
- `tests/types/*.test-d.ts` are type tests. They pin the tool inputs and outputs, the analyst's own types, and the parts of eve's API the project is written against. `pnpm typecheck` compiles them too.

All of them run with no database, model, or credentials. Compiling the agent downloads the public AI Gateway model list when `.eve/cache/model-catalog.json` is missing or older than five minutes, and falls back to the saved copy when the download fails. So the first `eve info`, `eve build`, or run of `tests/behavior/agent.test.ts` on a fresh clone needs network access, and later runs work offline. To run the behavior tests against a Postgres server, set `BEHAVIOR_TEST_DATABASE_URL` to an owner connection string for an empty, disposable database. The tests replace its `analytics` and `finance` schemas and create the analyst roles.

| Command | Purpose |
| --- | --- |
| `pnpm check` | Formatting and lint rules |
| `pnpm fix` | Apply formatting and lint fixes |
| `pnpm typecheck` | TypeScript checks |
| `pnpm test` | Every test project |
| `pnpm exec vitest run <test-file>` | Tests for the changed behavior |
| `pnpm exec vitest run --project unit` | Unit tests only. The other projects are `behavior`, `e2e`, and `types`. |
| `pnpm validate` | Formatting, lint, types, all tests, and unused-code checks |
| `pnpm exec eve info` | Agent diagnostics |
| `pnpm build` | Production compilation |
| `pnpm db:setup` and `pnpm db:doctor` | Deploy-time setup and database lockdown checks against a real Postgres |
| `pnpm eval` | Model-in-the-loop evals against the seeded demo database |

For changes to `agent/lib/analyst/`, run its unit tests and the `behavior` project. For changes to hooks, the Slack channel and its renderers, approvals, or anything else that depends on how eve runs a turn, run the `e2e` project, which takes about 40 seconds. Set `E2E_SERVER_LOG=1` to print the eve server's output when it ends. When the SQL itself changes, also exercise it against a Postgres server, with `BEHAVIOR_TEST_DATABASE_URL` or with `pnpm db:setup` and `pnpm db:doctor`. Run `pnpm build` when changing tools, channels, memory slots, the sandbox, or other framework registration, and update `tests/behavior/agent.test.ts` when the registered files or tools change on purpose. After an eve upgrade, fix `tests/types/eve.test-d.ts` first, because each failure there names the code to revisit. Run `pnpm eval` after changing instructions or skills. State which checks ran and distinguish unit tests from behavior tested against a live database or model.
