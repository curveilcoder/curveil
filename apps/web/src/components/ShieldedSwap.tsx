/**
 * The shielded side of Swap: spends vault notes of the input token into the swap adapter and
 * returns the output as a new note, atomically. Only the pool fee is charged.
 */
import { encodeSwapParams, type Hop } from "@curveil/vault-core";
import { getAddress, type Address } from "viem";
import { Exposure, ModePicker, VaultSubmit, senderExposure, useBroadcaster, useMode, useVaultAction } from "./VaultAction";
import { fmtAmount } from "../lib/format";
import { feeFor, pickFeeToken } from "../lib/vault/actions";
import { adapterAddress, prepareExecution } from "../lib/vault/execute";
import { balances, type VaultStatus } from "../lib/vault/store";
import { useT } from "../lib/i18n";

type Tok = { address: Address; symbol: string; decimals: number };
const same = (a: string, b: string) => getAddress(a) === getAddress(b);

export function ShieldedSwapAction({
  status,
  tokIn,
  tokOut,
  amountIn,
  hops,
  expectedOut,
  minOut,
  blocked,
  onDone,
}: {
  status: VaultStatus;
  tokIn: Tok;
  tokOut: Tok;
  amountIn: bigint | null;
  hops: readonly Hop[] | null;
  expectedOut: bigint | null;
  minOut: bigint | null;
  /** Why the form cannot submit yet (no amount, no route, …), shown on the button. */
  blocked: string | null;
  onDone: () => void;
}) {
  const t = useT();
  const b = useBroadcaster();
  const act = useVaultAction();
  const adapter = adapterAddress(status, "ShieldedSwapAdapter");
  const assetIn = status.assets.find((a) => same(a.address, tokIn.address));
  const assetOut = status.assets.find((a) => same(a.address, tokOut.address));
  const spendable = assetIn ? balances(assetIn.resource).spendable : 0n;
  const amount = amountIn ?? 0n;
  const feeToken = pickFeeToken(b.info, [
    { address: tokIn.address, available: spendable > amount ? spendable - amount : 0n },
    { address: tokOut.address, available: expectedOut ?? 0n },
  ]);
  const feeTok = feeToken ? (same(feeToken, tokIn.address) ? tokIn : tokOut) : null;
  const [mode, setMode] = useMode(b, feeToken !== null);
  const fee = mode === "broadcaster" ? (feeFor(b.info, "execute", feeToken) ?? 0n) : 0n;
  const feeOnInput = mode === "broadcaster" && feeToken !== null && same(feeToken, tokIn.address);
  const problem = !adapter || adapter.status !== "active"
    ? t("Shielded swaps are closed on this network right now.", "该网络目前已关闭隐私兑换。")
    : !assetIn
      ? t(`${tokIn.symbol} is not held in the vault.`, `金库中没有持有 ${tokIn.symbol}。`)
      : !assetOut
        ? t(`${tokOut.symbol} cannot be held in the vault.`, `${tokOut.symbol} 不能存放在金库中。`)
        : !assetOut.shieldingEnabled
          ? t(`Shielding of ${tokOut.symbol} is switched off, so a swap cannot create ${tokOut.symbol} notes.`, `${tokOut.symbol} 的存入隐私已关闭，因此兑换无法生成 ${tokOut.symbol} 票据。`)
          : mode === "broadcaster" && !feeToken
              ? t("The broadcaster cannot take its fee from this swap. Submit from your wallet.", "广播者无法从这笔兑换中扣除手续费，请用钱包提交。")
              : null;

  // The form already flags an amount above the vault balance; the button says it too.
  const short = amount > 0n && amount + (feeOnInput ? fee : 0n) > spendable;
  function go() {
    if (!adapter || !assetIn || !assetOut || !hops || minOut === null || amount === 0n || problem || short) return;
    const params = encodeSwapParams(hops, minOut);
    void act
      .run({
        status,
        action: "execute",
        label: t(`Shielded swap of ${fmtAmount(amount, tokIn.decimals)} ${tokIn.symbol} to ${tokOut.symbol}`, `隐私兑换 ${fmtAmount(amount, tokIn.decimals)} ${tokIn.symbol} 为 ${tokOut.symbol}`),
        mode,
        feeToken,
        prove: async (f, fr, onStage) => {
          const onIn = f > 0n && feeToken !== null && same(feeToken, tokIn.address);
          const r = await prepareExecution({
            status,
            adapter: adapter.address,
            params,
            legs: [{ resource: assetIn.resource, amount, fee: onIn ? f : 0n }],
            outputs: [{ kind: "note", to: "self", resource: BigInt(assetOut.resource), fee: onIn ? 0n : f }],
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
      <Exposure
        pub={[...t(["That a shielded swap happened, and when", "The route, the amount in and the amount out (the pools' swap events show them)"], ["发生过一笔隐私兑换，以及时间", "路由、输入数量和输出数量（资金池的兑换事件会显示）"]), ...senderExposure(mode)]}
        priv={t(["Which vault account paid and received", "Which of your notes were spent", "Your remaining shielded balances"], ["哪个金库账户付款和收款", "花费了你的哪些票据", "你剩余的隐私余额"])}
      />
      {problem && <p className="notice warn small" style={{ margin: 0 }}>{problem}</p>}
      <VaultSubmit mode={mode} act={act} disabled={Boolean(blocked) || Boolean(problem) || short || !hops || minOut === null} onClick={go}>
        {blocked ?? (short ? t(`Not enough ${tokIn.symbol} in your vault${feeOnInput && amount <= spendable ? " for the fee" : ""}`, `金库中的 ${tokIn.symbol} 不足${feeOnInput && amount <= spendable ? "以支付手续费" : ""}`) : t("Prove and swap", "生成证明并兑换"))}
      </VaultSubmit>
    </div>
  );
}
