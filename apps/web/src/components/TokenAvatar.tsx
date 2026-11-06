import { useState } from "react";
import { API_URL } from "../lib/config";

const hue = (addr: string) => parseInt(addr.slice(2, 8), 16) % 360;

/**
 * Launch token image when it is hosted by the Curveil API (validated on upload, served with a
 * locked-down CSP); a monogram disc otherwise. Images from any other origin are never loaded.
 */
export function TokenAvatar({ token, symbol, image, size = 40 }: { token: string; symbol: string; image: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const ours = image && image.startsWith(`${API_URL}/v1/launches/metadata/`);
  if (ours && !failed) {
    return <img className="token-img" src={image} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} style={{ width: size, height: size }} />;
  }
  return (
    <span className="token-disc" aria-hidden="true" style={{ position: "relative", width: size, height: size, background: `hsl(${hue(token)} 35% 28%)`, fontSize: size * 0.42 }}>
      {symbol.slice(0, 1)}
    </span>
  );
}
