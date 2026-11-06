import { useState } from "react";
import { Sk } from "./Skeleton";
import { useConnection, useReadContracts, useWriteContract, usePublicClient } from "wagmi";
import { BaseError, ContractFunctionRevertedError, formatUnits } from "viem";
import { manifest, curveilChain, explorerAddress } from "../lib/config";
import { faucetAbi, erc20Abi } from "../lib/abis";
import { TxStatus, type TxPhase } from "./TxStatus";

const faucet = manifest.contracts.TestFaucet?.address as `0x${string}` | undefined;
const assets = manifest.assets.filter((a) => a.testOnly);

function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.data?.errorName === "CoolingDown") {
        const at = Number(revert.data.args?.[1] ?? 0n);
        return `You already claimed in the last 24 hours. Try again after ${new Date(at * 1000).toLocaleString()}.`;
      }
      if (revert.data?.errorName === "DripDisabled") return "The faucet is paused for this token.";
    }
    if (e.name === "UserRejectedRequestError" || /rejected|denied/i.test(e.shortMessage)) return "You cancelled the request in your wallet. Nothing was sent.";
    if (/insufficient funds/i.test(e.shortMessage)) return "Your wallet needs a little testnet ETH for gas.";
    return e.shortMessage;
  }
  return "The transaction could not be sent.";
}

/** Testnet faucet: a real on-chain claim of tUSDG and tWETH. */
export function Faucet() {
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
        setPhase({ kind: "failed", message: "The transaction reverted. No tokens were sent.", hash });
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
        <p className="eyebrow">Testnet faucet</p>
        <h3>Get test USDG and WETH</h3>
        <p className="muted small" style={{ margin: "8px 0 0" }}>
          Claims 10,000 tUSDG and 5 tWETH once every 24 hours. These are Curveil test tokens with no value.{" "}
          <a href={explorerAddress(faucet)} target="_blank" rel="noreferrer">Faucet contract</a>
        </p>
      </div>
      {!isConnected && <p className="notice">Connect a wallet to claim. You need a little testnet ETH for gas.</p>}
      {wrongChain && <p className="notice warn">Your wallet is on another network. Use the switch button in the header first.</p>}
      {isConnected && !wrongChain && (
        <>
          <div className="table-scroll" tabIndex={0}>
            <table className="data" style={{ minWidth: 0 }}>
              <thead>
                <tr><th>Token</th><th>Your balance</th><th>Next claim</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.address}>
                    <td><a href={explorerAddress(r.address)} target="_blank" rel="noreferrer">{r.symbol}</a></td>
                    <td className="mono">
                      {reads.isError ? "Unavailable" : r.bal === undefined ? <Sk w={80} /> : Number(formatUnits(r.bal, r.decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 })}
                    </td>
                    <td className="small">{r.at === undefined ? (reads.isError ? "Unavailable" : <Sk w="12ch" />) : r.at === 0 || r.at <= now ? "Available now" : new Date(r.at * 1000).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reads.isError && <p className="notice bad">Could not read balances from the chain. Check your connection and retry.</p>}
          <div>
            <button className="btn btn-primary" onClick={claim} disabled={coolingDown || phase.kind === "awaiting_wallet" || phase.kind === "submitted"}>
              {coolingDown ? "Claimed today" : phase.kind === "awaiting_wallet" ? "Confirm in your wallet…" : phase.kind === "submitted" ? "Waiting for confirmation…" : "Claim test tokens"}
            </button>
          </div>
        </>
      )}
      <TxStatus phase={phase} />
    </div>
  );
}
