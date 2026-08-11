export function formatTokenAmount(raw: bigint, decimals: number) {
  if (raw < 0n) throw new Error("Token amount cannot be negative.");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals must be an integer from 0 through 255.");
  }
  const digits = raw.toString().padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, "") : "";
  const formattedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${formattedWhole}.${fraction}` : formattedWhole;
}
