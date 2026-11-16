import { afterAll, beforeEach, inject, vi } from "vitest";

import { closePool } from "#lib/analyst/postgres";

/**
 * Points the analyst at the test warehouse for every test in the calling file.
 *
 * @returns Facts about the warehouse's data, computed from the generated rows rather than from SQL.
 * @remarks Sets the same environment variables a deployed project has, so the analyst derives its read-only login and opens its own `pg` pool. Closes that pool after the file's last test.
 */
export const useWarehouse = () => {
  const { env, facts } = inject("warehouse");
  beforeEach(() => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    // Set only when an admin manages the login by hand; the tests use the derived one.
    vi.stubEnv("ANALYST_DATABASE_URL", "");
  });
  afterAll(closePool);
  return facts;
};
