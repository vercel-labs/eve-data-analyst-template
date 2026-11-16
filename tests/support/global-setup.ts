import type { TestProject } from "vitest/node";

import { startWarehouse } from "./warehouse";
import type { WarehouseEnv, WarehouseFacts } from "./warehouse";

declare module "vitest" {
  interface ProvidedContext {
    /** Environment that reaches the test warehouse, and facts about its data. */
    warehouse: { readonly env: WarehouseEnv; readonly facts: WarehouseFacts };
  }
}

/**
 * Starts the test warehouse once for every behavior test file, and stops it when the run ends.
 *
 * @param project - The vitest project whose tests read the warehouse with `inject("warehouse")`.
 * @returns The teardown that stops the warehouse.
 */
export default async function setup(project: TestProject) {
  const { log } = console;
  // The loader reports progress for a person watching a deploy; keep test output quiet.
  console.log = () => {
    // Discard the progress lines.
  };
  const warehouse = await startWarehouse().finally(() => {
    console.log = log;
  });
  project.provide("warehouse", { env: warehouse.env, facts: warehouse.facts });
  return warehouse.stop;
}
