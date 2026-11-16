import type { TestProject } from "vitest/node";

import { startWarehouse } from "#tests/support/warehouse";
import type { WarehouseFacts } from "#tests/support/warehouse";

import { startEveServer } from "./support/eve-server";
import { startFakeSlack } from "./support/fake-slack";
import {
  CONTROL_URL_ENV,
  SLACK_API_URL_ENV,
  SLACK_AUTO_REPLY_CHANNEL_ID,
} from "./support/protocol";

declare module "vitest" {
  interface ProvidedContext {
    /** Where the end-to-end tests reach the agent and the fake Slack, and facts about the warehouse's data. */
    e2e: {
      readonly eveUrl: string;
      readonly facts: WarehouseFacts;
      readonly slackUrl: string;
    };
  }
}

const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const { log } = console;
  // The loader reports progress for a person watching a deploy; keep test output quiet.
  console.log = () => {
    // Discard the progress lines.
  };
  try {
    return await work();
  } finally {
    console.log = log;
  }
};

/**
 * Starts the warehouse, the fake Slack, and the fixture agent's server once for every end-to-end test file.
 *
 * @param project - The vitest project whose tests read the URLs with `inject("e2e")`.
 * @returns The teardown that stops all three, server first.
 * @remarks Set the `E2E_SERVER_LOG` environment variable to print the server's output when the run ends.
 */
export default async function setup(project: TestProject) {
  const warehouse = await quietly(startWarehouse);
  const slack = await startFakeSlack();
  const stopServices = async () => {
    await slack.stop();
    await warehouse.stop();
  };
  try {
    const server = await startEveServer({
      ...warehouse.env,
      // Set only when an admin manages the login by hand; the tests use the derived one.
      ANALYST_DATABASE_URL: "",
      [CONTROL_URL_ENV]: slack.url,
      [SLACK_API_URL_ENV]: `${slack.url}/api/`,
      // Top-level posts in this channel start a reply without a mention.
      SLACK_AUTO_REPLY_CHANNEL_IDS: SLACK_AUTO_REPLY_CHANNEL_ID,
      // The visualization tools require a connector name before they post; the fixture replaces the lookup.
      SLACK_CONNECTOR: "slack/e2e",
    });
    project.provide("e2e", {
      eveUrl: server.baseUrl,
      facts: warehouse.facts,
      slackUrl: slack.url,
    });
    return async () => {
      await server.stop();
      if (process.env.E2E_SERVER_LOG) {
        console.log(server.output());
      }
      await stopServices();
    };
  } catch (error) {
    await stopServices();
    throw error;
  }
}
