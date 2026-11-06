import { useState } from "react";
import type { MarketPool } from "../lib/markets";
import { tokenLook } from "../lib/tokens";

const hue = (addr: string) => parseInt(addr.slice(2, 8), 16) % 360;

type Look = { address: string; symbol: string; name?: string | null; image?: string | null; logo?: string | null };

/**
 * A token's official logo, served by this site (or a launch token's image from the Curveil
 * API). Nothing is fetched from third parties. Tokens without one get a lettered disc.
 */
function Disc({ token, size, left }: { token: Look; size: number; left: number }) {
  const { logo } = tokenLook(token);
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, left };
  if (logo && !broken) {
    return <img className="token-disc token-logo" src={logo} alt="" width={size} height={size} style={style} loading="lazy" decoding="async" onError={() => setBroken(true)} />;
  }
  return (
    <span className="token-disc" style={{ ...style, background: `hsl(${hue(token.address)} 35% 28%)`, fontSize: size * 0.44 }}>
      {token.symbol.replace(/^t(?=[A-Z])/, "").slice(0, 1)}
    </span>
  );
}

/** Two overlapping token logos. */
export function TokenPair({ pool, size = 28 }: { pool: { token0: Look; token1: Look } | Pick<MarketPool, "token0" | "token1">; size?: number }) {
  return (
    <span className="pair-icons" style={{ width: size * 1.6, height: size }} aria-hidden="true">
      {[pool.token0, pool.token1].map((t, i) => <Disc key={t.address} token={t} size={size} left={i * size * 0.6} />)}
    </span>
  );
}

/** One token's logo. */
export function TokenDisc({ token, size = 18 }: { token: Look; size?: number }) {
  return (
    <span className="pair-icons" style={{ width: size, height: size }} aria-hidden="true">
      <Disc token={token} size={size} left={0} />
    </span>
  );
}
