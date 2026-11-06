import { fmtQuote } from "../lib/format";

/** A quote-token figure in short form: "$1.8K" for a dollar token, otherwise "1.8K tWETH". */
export function QuoteFig({ n, symbol }: { n: number | null | undefined; symbol: string }) {
  const f = fmtQuote(n, symbol);
  return <>{f.text}{f.unit && <> <span>{f.unit}</span></>}</>;
}
