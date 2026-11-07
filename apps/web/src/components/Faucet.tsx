import { useState } from "react";
import { Sk } from "./Skeleton";
import { useConnection, useReadContracts, useWriteContract, usePublicClient } from "wagmi";
import { BaseError, ContractFunctionRevertedError, formatUnits } from "viem";
import { manifest, curveilChain, explorerAddress } from "../lib/config";
import { faucetAbi, erc20Abi } from "../lib/abis";
import { TxStatus, type TxPhase } from "./TxStatus";
import { useT, tNow } from "../lib/i18n";

const faucet = manifest.contracts.TestFaucet?.address as `0x${string}` | undefined;
const assets = manifest.assets.filter((a) => a.testOnly);

function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data?.errorName === "CoolingDown") {
        const at = Number(revert.data.args?.[1] ?? 0n);
        return tNow(`You already claimed in the last 24 hours. Try again after ${new Date(at * 1000).toLocaleString()}.`, `你在过去 24 小时内已经领取过。请在 ${new Date(at * 1000).toLocaleString()} 之后再试。`);
      }
      if (revert.data?.errorName === "DripDisabled") return tNow("The faucet is paused for this token.", "该代币的水龙头已暂停。");
    }
    if (e.name === "UserRejectedRequestError" || /rejected|denied/i.test(e.shortMessage)) return tNow("You cancelled the request in your wallet. Nothing was sent.", "你在钱包中取消了请求，未发送任何内容。");
    if (/insufficient funds/i.test(e.shortMessage)) return tNow("Your wallet needs a little testnet ETH for gas.", "你的钱包需要少量测试网 ETH 作为 gas。");
    return e.shortMessage;
  }
  return tNow("The transaction could not be sent.", "交易无法发送。");
}

/** Testnet faucet: a real on-chain claim of tUSDG and tWETH. */
export function Faucet() {
  const t = useT();
  const { address, chainId, isConnected } = useConnection();
  const client = usePublicClient();
  const write = useWriteContract();
  const [phase, setPhase] = useState<TxPhase>({ kind: "idle" });

  const reads = useReadContracts({
    allowFailure: false,
    query: { enabled: Boolean(address && faucet), refetchInterval: 20_000 },
    contracts: address && faucet
      ? assets.flatMap((a) => [
          { address: a.address as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [address] } as const,
          { address: faucet, abi: faucetAbi, functionName: "availableAt", args: [address, a.address as `0x${string}`] } as const,
        ])
      : [],
  });

  if (!faucet || manifest.network !== "testnet") return null;

  const now = Math.floor(Date.now() / 1000);
  const rows = assets.map((a, i) => {
    const bal = reads.data?.[i * 2] as bigint | undefined;
    const at = reads.data?.[i * 2 + 1] as bigint | undefined;
    return { ...a, bal, at: at === undefined ? undefined : Number(at) };
  });
  const coolingDown = rows.some((r) => r.at !== undefined && r.at > now);
  const wrongChain = isConnected && chainId !== curveilChain.id;

  async function claim() {
    if (!client || !faucet) return;
    setPhase({ kind: "awaiting_wallet" });
    try {
      const hash = await write.mutateAsync({ address: faucet, abi: faucetAbi, functionName: "claimMany", args: [assets.map((a) => a.address as `0x${string}`)] });
      setPhase({ kind: "submitted", hash });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setPhase({ kind: "failed", message: t("The transaction reverted. No tokens were sent.", "交易已回滚，未发送任何代币。"), hash });
        return;
      }
      setPhase({ kind: "confirmed", hash, block: receipt.blockNumber });
      void reads.refetch();
    } catch (e) {
      setPhase({ kind: "failed", message: describeError(e) });
    }
  }

  return (
    <div className="panel stack" id="faucet">
      <div>
        <p className="eyebrow">{t("Testnet faucet", "测试网水龙头")}</p>
        <h3>{t("Get test USDG and WETH", "领取测试 USDG 和 WETH")}</h3>
        <p className="muted small" style={{ margin: "8px 0 0" }}>
          {t("Claims 10,000 tUSDG and 5 tWETH once every 24 hours. These are Curveil test tokens with no value.", "每 24 小时可领取 10,000 tUSDG 和 5 tWETH。这些是没有价值的 Curveil 测试代币。")}{" "}
          <a href={explorerAddress(faucet)} target="_blank" rel="noreferrer">{t("Faucet contract", "水龙头合约")}</a>
        </p>
      </div>
      {!isConnected && <p className="notice">{t("Connect a wallet to claim. You need a little testnet ETH for gas.", "连接钱包即可领取。你需要少量测试网 ETH 作为 gas。")}</p>}
      {wrongChain && <p className="notice warn">{t("Your wallet is on another network. Use the switch button in the header first.", "你的钱包在其他网络上，请先使用页头的切换按钮。")}</p>}
      {isConnected && !wrongChain && (
        <>
          <div className="table-scroll" tabIndex={0}>
            <table className="data" style={{ minWidth: 0 }}>
              <thead>
                <tr><th>{t("Token", "代币")}</th><th>{t("Your balance", "你的余额")}</th><th>{t("Next claim", "下次领取")}</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.address}>
                    <td><a href={explorerAddress(r.address)} target="_blank" rel="noreferrer">{r.symbol}</a></td>
                    <td className="mono">
                      {reads.isError ? t("Unavailable", "不可用") : r.bal === undefined ? <Sk w={80} /> : Number(formatUnits(r.bal, r.decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })}
                    </td>
                    <td className="small">{r.at === undefined ? (reads.isError ? t("Unavailable", "不可用") : <Sk w="12ch" />) : r.at === 0 || r.at <= now ? t("Available now", "现在可领") : new Date(r.at * 1000).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reads.isError && <p className="notice bad">{t("Could not read balances from the chain. Check your connection and retry.", "无法从链上读取余额，请检查网络后重试。")}</p>}
          <div>
            <button className="btn btn-primary" onClick={claim} disabled={coolingDown || phase.kind === "awaiting_wallet" || phase.kind === "submitted"}>
              {coolingDown ? t("Claimed today", "今日已领取") : phase.kind === "awaiting_wallet" ? t("Confirm in your wallet…", "请在钱包中确认…") : phase.kind === "submitted" ? t("Waiting for confirmation…", "等待确认…") : t("Claim test tokens", "领取测试代币")}
            </button>
          </div>
        </>
      )}
      <TxStatus phase={phase} />
    </div>
  );
}
