/**
 * The shielded side of Add liquidity: spends vault notes of the market's tokens into the
 * liquidity adapter, which opens a position held by its own holder contract. The position comes
 * back as a share note; any unused tokens come back as notes, all in the same transaction.
 */
import { newPositionId, shareResource } from "@curveil/vault-core";
import { getAddress, type Hex } from "viem";
import { Exposure, ModePicker, VaultSubmit, senderExposure, useBroadcaster, useMode, useVaultAction } from "./VaultAction";
import { pairLabel, type MarketPool } from "../lib/markets";
import { fmtAmount } from "../lib/format";
import { feeFor, pickFeeToken } from "../lib/vault/actions";
import { adapterAddress, prepareExecution } from "../lib/vault/execute";
import { balances, type VaultStatus } from "../lib/vault/store";

const same = (a: string, b: string) => getAddress(a) === getAddress(b);

/** Vault assets for a market's two tokens, or null when either cannot be held in the vault. */
export function marketAssets(status: VaultStatus, pool: MarketPool) {
  const a0 = status.assets.find((a) => same(a.address, pool.token0.address));
  const a1 = status.assets.find((a) => same(a.address, pool.token1.address));
  return a0 && a1 ? ([a0, a1] as const) : null;
}

export function ShieldedEntry({
  status,
  pool,
  amounts,
  params,
  blocked,
  onDone,
}: {
  status: VaultStatus;
  pool: MarketPool;
  amounts: readonly [bigint, bigint];
  /** The adapter parameters for a new position id. */
  params: (positionId: bigint) => Hex;
  blocked: string | null;
  onDone: () => void;
}) {
  const b = useBroadcaster();
  const act = useVaultAction();
  const adapter = adapterAddress(status, "ShieldedLiquidityAdapter");
  const assets = marketAssets(status, pool);
  const tokens = [pool.token0, pool.token1] as const;
  const spendable = assets ? assets.map((a) => balances(a.resource).spendable) : [0n, 0n];
  // The fee rides on a leg, so it must be one of the tokens actually deposited.
  const feeToken = pickFeeToken(
    b.info,
    tokens.flatMap((t, i) => (amounts[i]! > 0n ? [{ address: t.address, available: spendable[i]! > amounts[i]! ? spendable[i]! - amounts[i]! : 0n }] : [])),
  );
  const feeTok = feeToken ? (tokens.find((t) => same(t.address, feeToken)) ?? null) : null;
  const [mode, setMode] = useMode(b, feeToken !== null);
  const fee = mode === "broadcaster" ? (feeFor(b.info, "execute", feeToken) ?? 0n) : 0n;
  const need = (i: number) => amounts[i]! + (mode === "broadcaster" && feeToken && same(feeToken, tokens[i]!.address) ? fee : 0n);
  const short = [0, 1].find((i) => amounts[i]! > 0n && need(i) > spendable[i]!);
  const disabledAsset = assets?.find((a) => !a.shieldingEnabled);
  const problem = !adapter || adapter.status !== "active"
    ? "Shielded liquidity entries are closed on this network right now."
    : !assets
      ? "Both of this market's tokens must be vault assets."
      : disabledAsset
        ? `Shielding of ${disabledAsset.symbol} is switched off, so unused tokens could not come back as notes.`
        : mode === "broadcaster" && !feeToken
            ? "The broadcaster cannot take its fee from this deposit. Submit from your wallet."
            : null;

  function go() {
    if (!adapter || !assets || problem || blocked || short !== undefined) return;
    const positionId = newPositionId();
    const share = shareResource(adapter.address, positionId);
    void act
      .run({
        status,
        action: "execute",
        label: `Shielded ${pairLabel(pool)} liquidity: ${tokens.map((t, i) => `${fmtAmount(amounts[i]!, t.decimals)} ${t.symbol}`).join(" + ")}`,
        mode,
        feeToken,
        prove: async (f, fr, onStage) => {
          const legs = tokens.flatMap((t, i) =>
            amounts[i]! > 0n ? [{ resource: assets[i]!.resource, amount: amounts[i]!, fee: f > 0n && feeToken && same(feeToken, t.address) ? f : 0n }] : [],
          );
          const r = await prepareExecution({
            status,
            adapter: adapter.address,
            params: params(positionId),
            legs,
            outputs: [
              { kind: "note", to: "self", resource: share },
              { kind: "note", to: "self", resource: BigInt(assets[0].resource) },
              { kind: "note", to: "self", resource: BigInt(assets[1].resource) },
            ],
            feeRecipient: fr,
            onStage,
          });
          return r.ready;
        },
      })
      .then((ok) => ok && onDone());
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <ModePicker mode={mode} onMode={setMode} b={b} action="execute" feeToken={feeTok} />
      <p className="vx-hint">
        No entry fee.{mode === "broadcaster" && feeTok ? ` Broadcaster fee: ${fmtAmount(fee, feeTok.decimals, 6)} ${feeTok.symbol}, taken from your notes.` : ""} Unused tokens return to your vault as notes.
      </p>
      <Exposure
        pub={[
          "That a shielded position was opened in this market, and when",
          "The amounts deposited and where they sit (the pool's events show them)",
          "The new holder contract that keeps the liquidity",
          ...senderExposure(mode),
        ]}
        priv={["Which vault account owns the position", "Which of your notes paid for it", "Later private transfers of its shares"]}
      />
      {problem && <p className="notice warn small" style={{ margin: 0 }}>{problem}</p>}
      <VaultSubmit mode={mode} act={act} disabled={Boolean(blocked) || Boolean(problem) || short !== undefined} onClick={go}>
        {blocked ?? (short !== undefined ? `Not enough ${tokens[short]!.symbol} in your vault` : "Prove and add liquidity")}
      </VaultSubmit>
    </div>
  );
}
