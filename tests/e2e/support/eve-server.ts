/**
 * Runs `eve dev` for the fixture app as a child process.
 *
 * @packageDocumentation
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/** The fixture app root: a package of its own, so eve treats it as the app. */
const APP_ROOT = fileURLToPath(new URL("../app", import.meta.url));

/** Longest the server may take to compile the agent and answer its health route. */
const START_TIMEOUT_MS = 90_000;

/** Longest the server may take to exit after SIGTERM before it is killed. */
const STOP_TIMEOUT_MS = 5000;

/** How often the health route is tried while the server starts. */
const HEALTH_INTERVAL_MS = 100;

const addressSchema = z.object({ port: z.number() });

/** A running eve development server. */
export interface EveServer {
  /** Origin the eve routes are served from. */
  readonly baseUrl: string;
  /** Everything the server has written to stdout and stderr. */
  readonly output: () => string;
  /** Stops the server and waits for it to exit. */
  readonly stop: () => Promise<void>;
}

/* Asks the OS for a free port by binding port 0, then releases it for the server. */
const freePort = async (): Promise<number> => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = addressSchema.parse(probe.address());
  probe.close();
  await once(probe, "close");
  return port;
};

/* eve's CLI entry, run with this Node rather than through a shell shim. */
const eveCli = (): string =>
  path.join(
    path.dirname(createRequire(import.meta.url).resolve("eve/package.json")),
    "bin/eve.js"
  );

const isHealthy = async (baseUrl: string): Promise<boolean> => {
  try {
    const response = await fetch(`${baseUrl}/eve/v1/health`);
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * Starts `eve dev --no-ui` in the fixture app and waits until it answers its health route.
 *
 * @param env - Environment for the server, such as the warehouse settings and the fake Slack URL.
 * @returns The server's URL, its output, and a function that stops it.
 * @throws {@link Error} With the server's output when it exits or stays unhealthy.
 * @remarks Removes the app's `.eve` directory first, because `eve dev` keeps sessions there between runs. Sets `NODE_ENV` to `development`: vitest sets it to `test`, under which eve swaps the scripted model for its own. Passes `--no-default-extensions`, so the model gets the tools a deployment has and none of eve's development-only ones. The server runs in its own process group, so stopping it also stops the processes it started.
 */
export const startEveServer = async (
  env: Readonly<Record<string, string>>
): Promise<EveServer> => {
  await rm(path.join(APP_ROOT, ".eve"), { force: true, recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(
    process.execPath,
    [
      eveCli(),
      "dev",
      "--no-ui",
      "--no-default-extensions",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: APP_ROOT,
      detached: true,
      env: {
        ...process.env,
        EVE_TELEMETRY_DISABLED: "1",
        ...env,
        NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const exited = once(child, "exit");
  const collect = (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const signal = (name: NodeJS.Signals) => {
    if (child.pid === undefined || child.exitCode !== null) {
      return;
    }
    try {
      process.kill(-child.pid, name);
    } catch {
      // The process group is already gone.
    }
  };
  const stop = async () => {
    signal("SIGTERM");
    const timer = setTimeout(() => {
      signal("SIGKILL");
    }, STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  const waitUntilHealthy = async (): Promise<void> => {
    if (child.exitCode !== null) {
      throw new Error(`eve dev exited with code ${child.exitCode}.\n${output}`);
    }
    if (await isHealthy(baseUrl)) {
      return;
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`eve dev did not become healthy.\n${output}`);
    }
    await delay(HEALTH_INTERVAL_MS);
    await waitUntilHealthy();
  };
  await waitUntilHealthy();
  return { baseUrl, output: () => output, stop };
};
