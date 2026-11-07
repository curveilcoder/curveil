import { Link } from "@tanstack/react-router";
import { SDK_VERSION } from "@curveil/sdk";
import { Loading, Sk } from "../Skeleton";
import { useStatus, STATUS_LABEL } from "../../lib/api";
import { useTemplates } from "../../lib/launch";
import { quoteSym } from "../../lib/tokens";
import { API_URL, IS_TESTNET, NETWORK, manifest } from "../../lib/config";
import { CaChip } from "../CaChip";
import { Calc, Callout, Cards, C, Code, CodeTabs, DocCard, Icon, Section, Step, Steps, Table } from "./Kit";

const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
const SDK_TARBALL = `/sdk/curveil-sdk-${SDK_VERSION}.tgz`;
const clientLine = `createClient({ network: "${NETWORK}"${API_URL.includes("localhost") ? `, baseUrl: "${API_URL}"` : ""} })`;

// ------------------------------------------------------------------ docs home

export function DocsHome() {
  return (
    <div className="dk-home">
      <header className="dk-hero">
        <h1>Curveil documentation</h1>
        <p>
          Trade on public pools, launch tokens, run your own launchpad, hold assets privately in the Vault and open leveraged positions. Learn how each part works, or
          build on it with the SDK and API.
        </p>
        <div className="dk-hero-actions">
          <Link to="/docs" search={{ page: "quickstart" }} className="btn btn-primary">Quickstart <span aria-hidden="true">→</span></Link>
          <Link to="/docs" search={{ page: "api" }} className="btn">API reference</Link>
        </div>
      </header>

      <CodeTabs
        tabs={[
          { label: "Install", lang: "sh", code: `npm install viem ${origin()}${SDK_TARBALL}` },
          {
            label: "Read launches",
            code: `import { createClient } from "@curveil/sdk";

const curveil = ${clientLine};
const { launches } = await curveil.launches({ sort: "volume", limit: 3 });

for (const l of launches) console.log(l.symbol, l.state);`,
          },
          { label: "curl", lang: "sh", code: `curl "${API_URL}/v1/launches?sort=volume&limit=3"` },
        ]}
      />

      <Section title="Use cases">
        <Cards>
          <DocCard page="markets" icon={<Icon name="pool" />} title="Provide liquidity">Earn fees from DLMM price bins or full-range DAMM pools.</DocCard>
          <DocCard page="swap" icon={<Icon name="swap" />} title="Swap tokens">Routes across both pool types with a minimum you set.</DocCard>
          <DocCard page="launch" icon={<Icon name="launch" />} title="Launch a token">Start on a bonding curve and graduate into a locked pool.</DocCard>
          <DocCard page="launchpad-guide" icon={<Icon name="pad" />} title="Run a launchpad">Your brand and fee share on the shared launch contracts.</DocCard>
          <DocCard page="vault" icon={<Icon name="vault" />} title="Use the Shielded Vault">Hold, send and trade from private notes.</DocCard>
          <DocCard page="perps" icon={<Icon name="perps" />} title="Trade perpetuals">ETH and BTC up to 5×, SOL up to 2×, with isolated margin.</DocCard>
        </Cards>
      </Section>

      <Section title="Build on Curveil">
        <Cards>
          <DocCard page="quickstart" icon={<Icon name="code" />} title="Quickstart">Install the SDK and make your first call in a few minutes.</DocCard>
          <DocCard page="api" icon={<Icon name="api" />} title="API reference">Every endpoint, with parameters and responses.</DocCard>
          <DocCard page="contracts" icon={<Icon name="contract" />} title="Contracts">Addresses, sources and verification for this network.</DocCard>
          {IS_TESTNET && <DocCard page="testnet" icon={<Icon name="faucet" />} title="Testnet tools">Test tokens and the Vault broadcaster.</DocCard>}
          <DocCard page="fees" icon={<Icon name="fees" />} title="Fees">Who pays what, with worked examples.</DocCard>
          <DocCard page="risks" icon={<Icon name="risk" />} title="Risks">What can go wrong before you use it.</DocCard>
        </Cards>
      </Section>

      <div className="dk-cta">
        <div>
          <h2>Get an API key</h2>
          <p>Reads work without one at 300 requests a minute. Sign in with your wallet to create a key for 3,000.</p>
        </div>
        <Link to="/app/profile" search={{ tab: "developer", sub: "keys" }} className="btn btn-primary">Create a key <span aria-hidden="true">→</span></Link>
      </div>

      <LiveStatus />
    </div>
  );
}

function LiveStatus() {
  const { data, isError } = useStatus();
  return (
    <Section title="What is live">
      <p className="dk-p">
        {IS_TESTNET
          ? "Everything runs on testnet with test tokens that have no value. Numbers marked proposed are planned settings, not what is deployed today."
          : "Markets, launches, launchpads, perps and the shielded vault are live on Robinhood Chain. They have not had an independent audit yet, and each vault deposit is capped. Anything not marked live here is not available yet."}
      </p>
      {isError && <p className="notice bad">Live status could not be loaded. Treat every module as not live until it can.</p>}
      {!data && !isError && <Loading label="Loading live status" />}
      {!data && !isError && (
        <ul className="status-list" aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} aria-hidden="true">
              <Sk w={8} h={8} style={{ borderRadius: "50%" }} />
              <span><Sk w="8ch" /> <Sk w="28ch" /></span>
              <Sk w="7ch" />
            </li>
          ))}
        </ul>
      )}
      {data && (
        <ul className="status-list">
          {data.modules.map((m) => (
            <li key={m.id}>
              <span className={`dot ${m.status === "not_live" ? "" : "good"}`} aria-hidden="true" />
              <span>{m.name}: <span className="muted">{m.reason}</span></span>
              <span className="small">{STATUS_LABEL[m.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ markets

export function MarketsGuide() {
  return (
    <>
      <Section title="Two kinds of pools">
        <p className="dk-p">Every pool on Curveil is one of two types. Both are public, and anyone can trade against them or add liquidity.</p>
        <Table
          head={["", "DLMM", "DAMM"]}
          rows={[
            ["Shape", "Liquidity sits in separate price bins", "One full-range curve, x × y = k"],
            ["You choose", "Which bins your capital covers", "Only how much to add"],
            ["Fees go to", "Liquidity in the bin being traded", "Every provider, by share"],
            ["Good for", "Concentrating near a price you expect", "Set and forget, any price"],
          ]}
        />
      </Section>

      <Section title="How DLMM bins are priced">
        <p className="dk-p">
          Each bin has a fixed price. Bin <C>i</C> is priced at <C>Pᵢ = P₀ × (1 + s)ⁱ</C>, where <C>P₀</C> is the pool's starting price and <C>s</C> is its bin step.
          Only the bin that holds the current price trades, so only liquidity in that bin earns fees at that moment.
        </p>
        <Callout kind="example" title="A 0.25% bin step around 1.00 USDG">
          <Calc
            rows={[
              ["Bin −4", "1.00 × 1.0025⁻⁴ = 0.9901"],
              ["Bin 0", "1.0000"],
              ["Bin +4", "1.00 × 1.0025⁴ = 1.0100"],
            ]}
          />
          <p>Liquidity spread over bins −4 to +4 earns fees while the price stays between about 0.99 and 1.01, and sits idle outside that range.</p>
        </Callout>
        <p className="dk-p">Bins are separate claims and are never pooled. When the price moves through your bins, your position converts from one asset to the other.</p>
      </Section>

      <Section title="How the DAMM fee moves">
        <p className="dk-p">A DAMM pool charges <C>min(maximum fee, base fee + volatility component)</C>. The fee rises while the price is moving fast and settles back afterwards.</p>
        <Callout kind="example" title="Base 0.30%, maximum 1.00%">
          <Calc
            rows={[
              ["Quiet market, volatility 0.00%", "0.30%"],
              ["Busy market, volatility 0.15%", "0.45%"],
              ["Sharp move, volatility 0.90%", "1.00% (capped)"],
            ]}
          />
        </Callout>
      </Section>

      <Section title="Create a pool">
        <Steps>
          <Step title="Pick the assets">Open <Link to="/app/pools/new">Create a pool</Link> and choose two admitted assets. See <Link to="/docs" search={{ page: "assets" }}>Admitted assets</Link> for the list.</Step>
          <Step title="Pick the type">Choose DLMM with one of the enabled bin steps (each comes with its own fee), or DAMM. These are fixed once the pool exists.</Step>
          <Step title="Set the starting price">For DLMM you enter it and the pool starts in the matching bin. For DAMM the ratio of the first deposit sets it. Check it against another market before you confirm.</Step>
          <Step title="Add liquidity">Add more at any time from the pool's page with <strong>Add liquidity</strong>.</Step>
        </Steps>
        <Callout kind="warn">
          A pool existing does not mean a token is safe. Rebasing, fee-on-transfer and other balance-changing tokens are excluded because pools cannot account for them.
        </Callout>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ swaps

export function SwapGuide() {
  return (
    <>
      <Section title="How a route is found">
        <p className="dk-p">
          The router looks at direct routes and two-hop routes across DLMM and DAMM pools, and quotes the one that pays out the most after fees. A two-hop route goes through a
          middle asset, for example WETH → USDG → a launched token.
        </p>
      </Section>

      <Section title="Slippage and the minimum you receive">
        <p className="dk-p">
          Prices can move between the quote and the moment your transaction lands. You set a tolerance, and the swap reverts if it would pay less than{" "}
          <C>floor(expected output × (1 − tolerance))</C>.
        </p>
        <Callout kind="example" title="Selling 0.3 WETH with 0.5% tolerance">
          <Calc rows={[["Quoted output", "1,000.00 USDG"], ["Tolerance", "0.5%"]]} total={["Minimum received", "995.00 USDG"]} />
          <p>If the price moves and the swap would pay 994.99 USDG or less, it reverts and you keep your WETH, minus gas.</p>
        </Callout>
        <Callout kind="note">Slippage limits do not remove every ordering or MEV risk. Reference prices give context; only the executable quote decides what you receive.</Callout>
      </Section>

      <Section title="Swap from code">
        <p className="dk-p">
          The SDK builds the router call. Pass the hops of your route, the amount in and a minimum out, then send the transaction with any wallet library after approving the
          router to spend the input.
        </p>
        <Code>{`import { approveTx, swapExactInTx, withSlippage } from "@curveil/sdk";

const m = await curveil.manifest();
const router = m.contracts.CurveilRouter.address;

await wallet.sendTransaction(approveTx(weth, router, amountIn));
await wallet.sendTransaction(swapExactInTx({
  router,
  hops: [{ pool, tokenIn: weth, tokenOut: usdg }],
  amountIn,
  minOut: withSlippage(expectedOut, 50),   // 50 bps = 0.5%
  to: user,
}));`}</Code>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ vault

export function VaultGuide() {
  return (
    <>
      <Section title="What stays private">
        <p className="dk-p">
          Shielding turns an admitted asset into an encrypted note that only your Curveil account can open. Zero-knowledge proofs, made on your device, spend notes and
          create new ones. The chain checks the proof without learning whose notes they are.
        </p>
        <Table
          head={["", "Public on-chain", "Private"]}
          rows={[
            ["Deposit (shield)", "Depositor, asset, amount, time", "Which note it became"],
            ["Private transfer", "That a transfer happened, and when", "Sender, recipient and amount"],
            ["Shielded swap or perps", "The market action and its amounts", "Which account paid, and who holds the result"],
            ["Withdrawal", "Recipient, asset, amount, time", "Which notes paid for it"],
            ["Balances", "Nothing", "Every account's balance"],
          ]}
        />
      </Section>

      <Section title="Use the Vault">
        <Steps>
          <Step title="Create your Curveil account">
            Open <Link to="/app/vault">Vault</Link>. You get a recovery phrase that is separate from your wallet. Write it down and save the
            encrypted backup.
          </Step>
          <Step title="Shield">Deposit an admitted asset from your wallet. The deposit is public, the note it creates is not.{!IS_TESTNET && " On mainnet the Vault takes USDG and WETH (or ETH, which the site wraps), up to 1,000 USDG or 0.5 ETH per deposit while it is unaudited."}</Step>
          <Step title="Use it privately">Send to another Curveil account, swap or add liquidity, all from your notes{IS_TESTNET ? ", or fund a perpetual position" : ""}.</Step>
          <Step title="Withdraw">Send any amount to any address. Withdrawals cost 0.10%.</Step>
        </Steps>
        <Callout kind="example" title="Withdrawing 1,000 USDG">
          <Calc rows={[["Amount", "1,000.00 USDG"], ["Withdrawal fee, 0.10%", "−1.00 USDG"]]} total={["Recipient gets", "999.00 USDG"]} />
          <p>If a broadcaster sends the transaction for you, its fee is shown and taken from the notes as well.</p>
        </Callout>
        <Callout kind="tip" title="Avoid linking yourself">
          Withdrawing the exact amount you deposited, soon after, to the same address makes the link easy to guess. Waiting and using round, common amounts helps.
        </Callout>
      </Section>

      <Section title="Keep your account safe">
        <Callout kind="warn">
          Losing both the recovery phrase and the backup can mean losing the funds for good. Nobody, including Curveil, can recover them. Curveil will never ask for your wallet
          seed phrase.
        </Callout>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ launches

/** The templates the factory offers right now, read from the API. */
function LiveTemplates() {
  const t = useTemplates();
  if (t.isError) return null;
  return (
    <Table
      head={["Template", "Quote", "Graduates at"]}
      rows={t.data ? t.data.templates.filter((x) => x.enabled).map((x) => [x.label, quoteSym(x.quote), `${x.graduationThresholdQuote.toLocaleString("en-US")} ${quoteSym(x.quote)} net`]) : [[<Sk key="a" w="10ch" />, <Sk key="b" w="5ch" />, <Sk key="c" w="12ch" />]]}
    />
  );
}

export function LaunchGuide() {
  return (
    <>
      <Section title="How a launch works">
        <p className="dk-p">
          A launch starts on a bonding curve: the price rises as people buy and falls as they sell. When enough has been raised, the token graduates into a public DAMM pool
          and the curve closes. Each launch uses a versioned template fixed before trading starts.
        </p>
        <Table
          head={["Every template", "Value"]}
          rows={[
            ["Total supply", "1,000,000,000"],
            ["Sold on the curve", "800,000,000"],
            ["Kept for the pool at graduation", "200,000,000"],
            ["Curve fee", "1%, half to the creator, half to the protocol"],
          ]}
        />
        <LiveTemplates />
      </Section>

      <Section title="Graduation progress">
        <p className="dk-p">Progress is <C>min(100%, net reserves ÷ threshold)</C>. Fees are not counted, and every sell lowers progress again.</p>
        <Callout kind="example" title="Halfway there">
          <Calc rows={[["USDG bought in, after fees", "15,000"], ["USDG sold back out", "−2,500"]]} total={["Net reserves", "12,500 ÷ 25,000 = 50%"]} />
        </Callout>
      </Section>

      <Section title="What happens at graduation">
        <Steps>
          <Step title="Trading on the curve stops">The buy that reaches the threshold is the last one.</Step>
          <Step title="Anyone triggers migration">The reserves and the 200,000,000 kept tokens go into a new DAMM pool.</Step>
          <Step title="The pool's LP is locked">The creator's 20% is locked for 180 days and the protocol's 80% for 365 days.</Step>
        </Steps>
        <Callout kind="note">A lock limits withdrawal of the pool's liquidity. It does not guarantee the price or the quality of the token.</Callout>
      </Section>

      <Section title="Buy on a curve from code">
        <p className="dk-p">Quote first, then send the buy with a minimum so a price move cannot fill you worse than you accepted.</p>
        <Code>{`import { approveTx, buyTx, quoteBuy, withSlippage } from "@curveil/sdk";
import { parseUnits } from "viem";

const quoteIn = parseUnits("100", 6);                   // 100 USDG
const { tokensOut, fee } = await quoteBuy(chain, curve, quoteIn);   // fee = 1 USDG

await wallet.sendTransaction(approveTx(usdg, curve, quoteIn));
await wallet.sendTransaction(buyTx({ curve, quoteIn, minTokensOut: withSlippage(tokensOut, 100), to: user }));`}</Code>
      </Section>
    </>
  );
}

export function LaunchpadsGuide() {
  return (
    <>
      <Section title="What a launchpad is">
        <p className="dk-p">
          A launchpad is a brand and a fee share registered on the <C>LaunchpadRegistry</C> contract. There is nothing to deploy. Tokens launched through it use the same
          templates, curves, graduation and LP escrow as every other launch, so the rules for traders are the same everywhere.
        </p>
      </Section>
      <Section title="How a launchpad earns">
        <p className="dk-p">
          The launchpad earns part of the protocol's half of each curve fee, up to a protocol cap. Creators keep their full share. Each token fixes the share when it is
          created, so a later change never affects tokens already launched.
        </p>
        <Callout kind="example" title="A 25% share on the standard template">
          <Calc
            rows={[
              ["Curve trades on your tokens", "10,000 USDG"],
              ["Curve fee, 1%", "100 USDG"],
              ["Creator's half", "50 USDG"],
              ["Protocol's half", "50 USDG"],
            ]}
            total={["Your 25% of the protocol's half", "12.50 USDG"]}
          />
        </Callout>
      </Section>
      <Cards cols={2}>
        <DocCard page="launchpad-guide" icon={<Icon name="pad" />} title="Run a launchpad">Register, build your site and collect fees, step by step.</DocCard>
        <DocCard page="quickstart" icon={<Icon name="code" />} title="Quickstart">Install the SDK and make your first call.</DocCard>
      </Cards>
    </>
  );
}

// ------------------------------------------------------------------ perps

export function PerpsGuide() {
  return (
    <>
      <Section title="How it works">
        <p className="dk-p">
          A perpetual tracks the price of ETH, BTC or SOL without expiring. You post USDG as margin and choose a leverage. Each position has its own margin (isolated), so a loss on
          one never touches another. Traders trade against a liquidity vault, which takes the other side.
        </p>
        <Table
          head={[IS_TESTNET ? "Setting on testnet" : "Setting", "Value"]}
          rows={[
            ["Markets", "ETH-USD, BTC-USD, SOL-USD"],
            ["Margin", "USDG, isolated per position"],
            ["Leverage", "Up to 5× on ETH and BTC, up to 2× on SOL"],
            ["Open and close fee", "0.08% of size each"],
            ["Maintenance margin", "2.00% of size"],
            ["Liquidation fee", "0.50% of size"],
            ["Most a position can gain", "100% of size"],
          ]}
        />
        <p className="dk-p small">The <Link to="/app/perps">Perps page</Link> shows the live values for each market.</p>
      </Section>

      <Section title="A worked example">
        <p className="dk-p">You go long ETH at 3,000 with 100 USDG of margin at 3×. The open fee comes out of the margin, so the size is slightly under 300.</p>
        <Callout kind="example" title="Long ETH, 100 USDG at 3×, entry 3,000">
          <Calc
            rows={[
              ["Size", "100 × 3 ÷ (1 + 3 × 0.08%) = 299.28 USDG"],
              ["Open fee, 0.08%", "0.24 USDG"],
              ["Margin after fee", "99.76 USDG"],
              ["Liquidation price", "about 2,062"],
            ]}
          />
          <p>If ETH rises 10% to 3,300 and you close, you gain 29.93 USDG and pay a 0.24 USDG close fee (0.08% of size), so you get back about 129.45 USDG before funding.</p>
        </Callout>
        <p className="dk-p">
          The liquidation price is where your margin after fees falls to the maintenance margin plus the close fee. Higher leverage moves it closer to your entry: at 5× the same
          trade is liquidated near 2,460.
        </p>
      </Section>

      <Section title="Funding">
        <p className="dk-p">
          When more is open on one side than the other, the larger side pays the smaller side every hour, in proportion to size. This pulls open interest back into
          balance. When both sides match, or the market is empty, nobody pays.
        </p>
      </Section>

      <Section title="Orders, take profit and stop loss">
        <p className="dk-p">
          You submit a request and a keeper fills it at the next signed price, usually within seconds, never worse than your slippage limit. Take profit and stop loss orders
          close the position automatically when the price reaches them.
        </p>
      </Section>

      <Section title="Prices and safety">
        <p className="dk-p">
          {manifest.perps?.priceSource === "curveil-test-signer"
            ? "Testnet prices are a median of four exchanges, signed by a Curveil test key. Stale or inconsistent prices block new positions."
            : `Prices come from Pyth, an independent oracle network, and are checked on-chain by Pyth's contract${IS_TESTNET ? "" : " and against a Chainlink reference feed"}. Your request fills at the first Pyth price after you send it, so nobody can pick a better or worse one. Stale or uncertain prices block new positions.`}
        </p>
        <Callout kind="warn">
          Shielded margin hides where the money came from, but the position's size, direction and liquidation are public, and liquidation still applies.
        </Callout>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ token, fees, risks

export function TokenGuide() {
  return (
    <>
      <Section title="Proposed design">
        <Table
          head={["", "Proposed"]}
          rows={[
            ["Standard", "ERC-20, 18 decimals"],
            ["Maximum supply", "1,000,000,000, no further minting"],
            ["Transfer tax", "0%"],
            ["Presale or team allocation", "None"],
            ["How supply enters", "Through the public launch mechanism"],
          ]}
        />
      </Section>
      <Section title="What it is not">
        <p className="dk-p">
          The token does not represent equity, deposits or guaranteed income. Buybacks do not guarantee the price rises. Core rights, like withdrawing a private claim, never
          require holding it.
        </p>
        {manifest.token.address ? (
          <Callout kind="note">
            $CURVEIL is live. Contract address: <CaChip />
          </Callout>
        ) : (
          <Callout kind="note">Nothing about $CURVEIL is live. Everything on this page is a proposal.</Callout>
        )}
      </Section>
    </>
  );
}

const FEES: [string, string, string][] = [
  ["Standard public pool", "0.30% base", "80% to liquidity providers, 20% to the protocol"],
  ["Dynamic pool fee ceiling", "1.00%", "Same split"],
  ["Router", "0%", "Nobody"],
  ["Bonding-curve trade", "1.00%", "50% creator, 50% protocol (part to the launchpad)"],
  ["Shielding", "0%", "Nobody"],
  ["Private transfer", "0%", "Nobody (a broadcaster may charge for gas)"],
  ["Withdrawal from the Vault", "0.10%", "Protocol"],
  ["Shielded swap", "Pool fee only", "As the pool"],
  ["Perpetual open or close", "0.08% of size", "Liquidity vault, with a share to the protocol"],
];

export function FeesGuide() {
  return (
    <>
      <Section title="Every fee">
        <p className="dk-p">{IS_TESTNET ? "All fees below are proposed." : "These are the fees the mainnet contracts charge today."} Gas, broadcaster fees and funding are separate, and every quote shows its full breakdown before you confirm.</p>
        <Table head={["Action", "Fee", "Who receives it"]} rows={FEES} />
      </Section>
      <Section title="Examples">
        <Callout kind="example" title="Swapping 1,000 USDG in a 0.30% pool">
          <Calc rows={[["Fee, 0.30%", "3.00 USDG"], ["To liquidity providers, 80%", "2.40 USDG"], ["To the protocol, 20%", "0.60 USDG"]]} />
        </Callout>
        <Callout kind="example" title="Buying 100 USDG of a token on its curve">
          <Calc rows={[["Fee, 1.00%", "1.00 USDG"], ["To the creator", "0.50 USDG"], ["To the protocol", "0.50 USDG"]]} total={["Spent on tokens", "99.00 USDG"]} />
        </Callout>
        <Callout kind="example" title="Opening and closing a 300 USDG perpetual">
          <Calc rows={[["Open, 0.08%", "0.24 USDG"], ["Close at the same price, 0.08%", "0.24 USDG"]]} total={["Round trip", "0.48 USDG plus funding"]} />
        </Callout>
      </Section>
    </>
  );
}

const RISKS: [string, string][] = [
  [
    "Code can fail",
    IS_TESTNET
      ? "Smart-contract and cryptographic bugs can lose funds. Independent audits are planned before mainnet and are not done yet."
      : "Smart-contract bugs can lose funds. The contracts live today have not had an independent audit, so only use amounts you can afford to lose.",
  ],
  ["Prices move", "Market prices change quickly. Liquidity can be worth less than simply holding the two assets."],
  ["Leverage cuts both ways", "Leveraged positions can be liquidated, including ones funded from the Vault."],
  ["Privacy has limits", "Shielding does not make market actions, deposits, withdrawals or their timing private."],
  ["Recovery is on you", "Losing your Vault recovery phrase and backup can make funds unrecoverable."],
  [
    "Issuers keep control",
    "USDG's issuer can freeze any address, pause transfers, mint, and change the token's code, since it is an upgradeable contract. WETH on Robinhood Chain is a bridged, upgradeable token too. If an issuer freezes a pool, curve or the Vault, that asset cannot move there until it is unfrozen, and Curveil cannot override it.",
  ],
  ["Admin changes are delayed, not impossible", "Curveil's contracts are owned by a 72-hour timelock controlled by a 3-of-3 multisig, so all three signers must agree. Every change is public before it takes effect, and none can move user funds, but you should watch the queue on the Transparency page."],
  ["Services can stop", "Oracles, RPC providers and broadcasters can fail or be delayed."],
];

export function RisksGuide() {
  return (
    <>
      <Callout kind="warn">
        {IS_TESTNET
          ? "Curveil is experimental software on testnet. Do not use it with money you cannot afford to lose once it reaches mainnet."
          : "Curveil is new software. Do not use it with money you cannot afford to lose."}
      </Callout>
      <Section title="Main risks">
        <div className="dk-risks">
          {RISKS.map(([t, d]) => (
            <div key={t}>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
        <p className="small muted">Curveil is not affiliated with or endorsed by Robinhood.</p>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ get started

/** A plain walkthrough for a first visit, in the order most people take it. */
export function GetStartedGuide() {
  const usdgCap = IS_TESTNET ? "" : " Each deposit is capped at 1,000 USDG or 0.5 ETH while Curveil is unaudited.";
  return (
    <>
      <Section title="Before you start">
        <ul className="dk-list">
          <li>A wallet such as MetaMask, connected to <strong>Robinhood Chain</strong>.</li>
          <li>A little <strong>ETH</strong> for gas. Fees are small, so a little lasts a long time.</li>
          <li>The assets you want to use. USDG is the dollar used for perps margin.</li>
        </ul>
      </Section>

      <Section title="The steps">
        <Steps>
          <Step title="1. Connect and pick a mode">
            <p className="dk-p">Press <C>Connect wallet</C> in the header. Next to it, the <C>Public / Shielded</C> switch decides what pays for swaps, liquidity and perps.</p>
            <Table
              head={["Mode", "Pays from", "Who can see it"]}
              rows={[
                ["Public", "Your wallet", "Everyone sees your wallet made the trade, like any exchange."],
                ["Shielded", "Your private vault", "The trade is visible, but not who paid. Needs a vault account with funds (step 6)."],
              ]}
            />
          </Step>

          <Step title="2. Swap tokens">
            <p className="dk-p">
              Open <Link to="/app/swap">Swap</Link>, pick what you pay and what you get, and type an amount. You see the route, the expected output, the minimum you receive, fees
              and price impact before you sign. The first time you use a token, your wallet asks for an extra approval.
            </p>
            <Callout kind="note">Keep slippage low. Above 3% a trade can fill at a much worse price.</Callout>
          </Step>

          <Step title="3. Add liquidity and earn fees">
            <p className="dk-p">
              Open <Link to="/app/pools">Pools</Link>, choose a pool and press <C>Add liquidity</C>. Your position shows its value and unclaimed fees, and you can claim or remove
              it at any time.
            </p>
            <ul className="dk-list">
              <li><strong>DAMM</strong> pools are simple: your liquidity earns at every price.</li>
              <li><strong>DLMM</strong> pools let you choose a price range. You earn more while the price is inside it, and nothing outside it.</li>
            </ul>
          </Step>

          <Step title="4. Launch a token">
            <p className="dk-p">
              Open <Link to="/app/launch">Launches</Link> and press <C>Create a token</C>. Pick a pair (USDG or ETH) and a size, then a name and symbol, which can never change.
              The token trades right away.
            </p>
            <ul className="dk-list">
              <li><strong>Bonding curve:</strong> 80% of the 1 billion supply is sold on a curve. The more is bought, the higher the price. Each trade pays a 1% fee, and half goes to the creator.</li>
              <li><strong>Graduation:</strong> once the curve raises its target, the reserve and the remaining 20% move into a regular DAMM pool, and the token trades on Swap.</li>
              <li><strong>Locked liquidity:</strong> the pool's liquidity is locked for 180 days (creator) and 365 days (protocol).</li>
            </ul>
          </Step>

          <Step title="5. Trade perps">
            <p className="dk-p">
              Open <Link to="/app/perps">Perps</Link> and pick a market: ETH or BTC up to 5×, SOL up to 2×. Choose Long or Short, your USDG margin and leverage, and check the
              liquidation price before you submit. Prices come from Pyth and are checked on-chain.
            </p>
            <ul className="dk-list">
              <li>Your order is a request that a keeper fills at the next price, usually within seconds. If the price moved past your limit, your margin comes back.</li>
              <li>You can add margin, set take-profit or stop-loss, and close all or part of a position.</li>
              <li>Funding is paid or received every hour. If margin falls to the maintenance level, the position is liquidated.</li>
            </ul>
            <Callout kind="note">To earn as the counterparty instead, deposit USDG under <C>Provide liquidity</C> on the Perps page. It earns most trading fees and takes the other side of every trade.</Callout>
          </Step>

          <Step title="6. Go private with the vault">
            <p className="dk-p">
              Open <Link to="/app/vault">Vault</Link> and press <C>Create account</C>. Write down the 24-word recovery phrase in order and set a passphrase for this browser. The
              phrase is separate from your wallet; losing it can mean losing shielded funds.
            </p>
            <ul className="dk-list">
              <li><strong>Shield:</strong> deposit an asset from your wallet. The deposit is public; what you do with it afterwards is not.{usdgCap}</li>
              <li><strong>Send privately:</strong> paste someone's <C>cvl1…</C> address and press <C>Prove and send</C>. Your browser builds a zero-knowledge proof, so sender, recipient and amount stay hidden.</li>
              <li><strong>Withdraw:</strong> send to any public address. Nobody can link it back to your deposits.</li>
              <li><strong>Trade privately:</strong> flip the header switch to Shielded and use Swap, Pools or Perps as usual.</li>
            </ul>
            <Callout kind="note">On a new device, choose <C>Recover account</C> and enter your 24 words or a backup file. The vault finds your funds again.</Callout>
          </Step>
        </Steps>
      </Section>

      <Section title="What stays private">
        <Table
          head={["Action", "Everyone can see", "Stays private"]}
          rows={[
            ["Public swap, pool, launch or perps trade", "Everything, including your wallet", "Nothing"],
            ["Shield (deposit)", "Your wallet, the asset and amount", "What you do with it afterwards"],
            ["Private send", "That a transfer happened", "Sender, recipient and amount"],
            ["Shielded swap, pool or perps", "The trade and its size", "Who paid and who holds the result"],
            ["Withdraw", "Recipient and amount", "Which deposit it came from"],
          ]}
        />
        <Callout kind="note">Curveil is not independently audited yet. Start with amounts you can afford to lose, and read the <Link to="/docs" search={{ page: "risks" }}>risks</Link>.</Callout>
      </Section>
    </>
  );
}
