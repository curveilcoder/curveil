/**
 * DLMM allocation strategies (whitepaper 5.2), matching LiquidityShapes.sol so the preview is
 * exactly what the contract receives. Bins below the active bin take Y only, bins above take
 * X only, and the active bin takes half weight on each side.
 */
export type Strategy = "balanced" | "concentrated" | "edge" | "custom";

export const STRATEGIES: { id: Strategy; label: string; text: string }[] = [
  { id: "balanced", label: "Balanced", text: "Even distribution across the selected bins." },
  { id: "concentrated", label: "Concentrated", text: "More near the active price, less toward the edges." },
  { id: "edge", label: "Edge-weighted", text: "More toward the range boundaries." },
  { id: "custom", label: "Custom", text: "Set the lower and upper bounds separately, evenly weighted." },
];

const ONE = 10n ** 18n;

export type Distribution = { deltaIds: bigint[]; distributionX: bigint[]; distributionY: bigint[]; deltas: number[] };

/** `lower` and `upper` are bin offsets from the active bin (lower <= 0 <= upper). */
export function distribution(strategy: Strategy, lower: number, upper: number): Distribution {
  const deltas: number[] = [];
  for (let d = lower; d <= upper; d++) deltas.push(d);
  const k = Math.max(-lower, upper);
  const weight = (d: number) => {
    const ad = Math.abs(d);
    if (strategy === "concentrated") return 2 * (k + 1 - ad);
    if (strategy === "edge") return 2 * (1 + ad);
    return 2;
  };
  const side = (d: number) => (d === 0 ? weight(d) / 2 : weight(d));
  const totalX = deltas.filter((d) => d >= 0).reduce((a, d) => a + side(d), 0);
  const totalY = deltas.filter((d) => d <= 0).reduce((a, d) => a + side(d), 0);
  return {
    deltas,
    deltaIds: deltas.map((d) => BigInt(d)),
    distributionX: deltas.map((d) => (d >= 0 && totalX > 0 ? (BigInt(side(d)) * ONE) / BigInt(totalX) : 0n)),
    distributionY: deltas.map((d) => (d <= 0 && totalY > 0 ? (BigInt(side(d)) * ONE) / BigInt(totalY) : 0n)),
  };
}

/** Amount each bin receives, before the active bin is matched to its current proportion. */
export function allocate(dist: Distribution, amountX: bigint, amountY: bigint) {
  return dist.deltas.map((d, i) => ({
    delta: d,
    x: (amountX * dist.distributionX[i]!) / ONE,
    y: (amountY * dist.distributionY[i]!) / ONE,
  }));
}
