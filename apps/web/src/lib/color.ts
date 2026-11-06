/** Text colour that reads on a solid `#rrggbb` background: near-black on light fills, white on dark ones. */
export function inkOn(bg: string | undefined | null): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg?.trim() ?? "");
  if (!m) return "#0b0e14";
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
  // Pick whichever of the two inks has the higher contrast ratio.
  return (L + 0.05) / (0.0045 + 0.05) >= 1.05 / (L + 0.05) ? "#0b0e14" : "#ffffff";
}
