import type { TokenUsage } from "eve";
import { describe, expect, it } from "vitest";

import { exceedsSessionUsage } from "./session-usage";

const usage = (overrides: Partial<TokenUsage> = {}): TokenUsage => ({
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  ...overrides,
});

/* A session that has spent `total` overall and `window` since the last approved continuation. */
const exceeds = (
  window: Partial<TokenUsage>,
  total: Partial<TokenUsage> = window
) => exceedsSessionUsage({ total: usage(total), window: usage(window) });

describe(exceedsSessionUsage, () => {
  it("lets a session run below both limits", () => {
    expect(exceeds({})).toBe(false);
    expect(exceeds({ inputTokens: 4_999_999, outputTokens: 99_999 })).toBe(
      false
    );
  });

  it("stops at five million input tokens", () => {
    expect(exceeds({ inputTokens: 5_000_000 })).toBe(true);
    expect(exceeds({ inputTokens: 5_000_001 })).toBe(true);
  });

  it("stops at one hundred thousand output tokens", () => {
    expect(exceeds({ outputTokens: 100_000 })).toBe(true);
    expect(exceeds({ inputTokens: 1, outputTokens: 100_000 })).toBe(true);
  });

  it("counts cached input, as the limit did before eve 1.0", () => {
    expect(
      exceeds({ cacheReadTokens: 4_900_000, inputTokens: 5_000_000 })
    ).toBe(true);
  });

  it("measures the window since the last continuation, not the whole session", () => {
    const total = { inputTokens: 12_000_000, outputTokens: 250_000 };
    expect(exceeds({ inputTokens: 10, outputTokens: 10 }, total)).toBe(false);
    expect(exceeds({ inputTokens: 5_000_000 }, total)).toBe(true);
  });
});
