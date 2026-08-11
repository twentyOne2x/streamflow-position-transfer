import { describe, expect, it } from "vitest";

import { formatTokenAmount } from "./tokenAmount";

describe("formatTokenAmount", () => {
  it("formats the maximum u64 exactly at zero decimals", () => {
    expect(formatTokenAmount(18_446_744_073_709_551_615n, 0)).toBe(
      "18,446,744,073,709,551,615",
    );
  });

  it("does not round integers above Number.MAX_SAFE_INTEGER", () => {
    expect(formatTokenAmount(9_007_199_254_740_993n, 0)).toBe("9,007,199,254,740,993");
  });

  it("places decimals and trims only trailing fractional zeros", () => {
    expect(formatTokenAmount(1_234_500n, 4)).toBe("123.45");
    expect(formatTokenAmount(5n, 9)).toBe("0.000000005");
  });

  it("rejects negative amounts and invalid decimals", () => {
    expect(() => formatTokenAmount(-1n, 0)).toThrow("negative");
    expect(() => formatTokenAmount(1n, 1.5)).toThrow("decimals");
  });
});
