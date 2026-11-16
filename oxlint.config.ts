import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import { selectJsPlugins } from "ultracite/oxlint/js-plugins";

const jsPlugins = selectJsPlugins(["jsdoc-js", "tsdoc"]);

export default defineConfig({
  extends: [core, antiSlop, jsPlugins],
  ignorePatterns: core.ignorePatterns,
  jsPlugins: jsPlugins.jsPlugins,
  overrides: [
    {
      // eve names tools after their files, in the agent and in the end-to-end fixture that mirrors it.
      files: ["agent/tools/*.ts", "tests/e2e/app/agent/tools/*.ts"],
      rules: { "unicorn/filename-case": "off" },
    },
    // Setup scripts run statements in order inside one transaction or connection.
    { files: ["scripts/**/*.ts"], rules: { "no-await-in-loop": "off" } },
  ],
});
