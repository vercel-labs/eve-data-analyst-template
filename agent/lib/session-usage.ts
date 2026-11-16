import type { SessionUsageLimit } from "eve";

/** Input tokens one session may use before eve asks whether to continue. */
const MAX_INPUT_TOKENS_PER_WINDOW = 5_000_000;

/** Output tokens one session may use before eve asks whether to continue. */
const MAX_OUTPUT_TOKENS_PER_WINDOW = 100_000;

/**
 * Decides when a session has used enough tokens that eve must ask before the next model call.
 *
 * @param usage - The session's usage; `window` is what it spent since the last approved continuation.
 * @returns True when the window reached either limit.
 * @remarks Input counts everything the provider reports, including prompt-cache reads, so a long thread that replays its history reaches the limit as it did before eve 1.0. Choosing Continue on the prompt starts a new window.
 */
export const exceedsSessionUsage: SessionUsageLimit = ({ window }) =>
  window.inputTokens >= MAX_INPUT_TOKENS_PER_WINDOW ||
  window.outputTokens >= MAX_OUTPUT_TOKENS_PER_WINDOW;
