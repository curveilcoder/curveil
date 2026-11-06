/**
 * Shielded execution from the browser: pick notes for each leg, plan the `execute` call, prove
 * every leg with the withdraw circuit (each proof binds the whole action), and hand back a
 * Ready action for the broadcaster or the user's wallet.
 */
import {
  commitment,
  planExecute,
  toSolidityProof,
  withProofs,
  type ExecutePlan,
  type OutputPlanSpec,
} from "@curveil/vault-core";
import { type Address, type Hex } from "viem";
import { DEADLINE_SECONDS, artifacts, checkSignals, pick, ready, toJson, type Ready } from "./actions";
import { prove, type ProveStage } from "./prover";
import type { VaultStatus } from "./store";

/** One leg: `amount` of `resource` goes to the adapter, `fee` to the broadcaster. */
export type ExecLeg = { resource: string; amount: bigint; fee: bigint };

export function adapterAddress(status: VaultStatus, name: "ShieldedSwapAdapter" | "ShieldedLiquidityAdapter" | "ShieldedPerpsAdapter") {
  return status.adapters?.find((a) => a.name === name) ?? null;
}

export async function prepareExecution(o: {
  status: VaultStatus;
  adapter: Address;
  params: Hex;
  legs: ExecLeg[];
  /** In the adapter's output order. Use `"self"` as `to` for a note back to this account. */
  outputs: (Exclude<OutputPlanSpec, { kind: "note" }> | { kind: "note"; to: "self"; resource: bigint; fee?: bigint })[];
  feeRecipient: Address;
  onStage?: (s: ProveStage, step?: string) => void;
}): Promise<{ ready: Ready; plan: ExecutePlan; ms: number }> {
  const { keys, tree } = ready(o.status);
  if (o.status.version !== 2) throw new Error("This network's vault cannot run shielded actions yet.");
  const domain = BigInt(o.status.noteDomain);
  const legs = o.legs.map((l) => ({ resource: BigInt(l.resource), amount: l.amount, fee: l.fee, inputs: pick(l.resource, l.amount + l.fee) }));
  const plan = planExecute({
    spendingKey: keys.spendingKey,
    tree,
    chainId: o.status.chainId,
    pool: o.status.pool,
    domain,
    adapter: o.adapter,
    params: o.params,
    legs,
    outputs: o.outputs.map((x) => (x.kind === "note" ? { ...x, to: keys } : x)),
    changeTo: keys,
    feeRecipient: o.feeRecipient,
    withdrawFeeBps: o.status.withdrawFeeBps,
    deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
  });

  const files = artifacts(o.status, "withdraw");
  const proofs = [];
  let ms = 0;
  for (let i = 0; i < plan.legs.length; i++) {
    const leg = plan.legs[i]!;
    const step = plan.legs.length > 1 ? `leg ${i + 1} of ${plan.legs.length}` : undefined;
    const r = await prove(leg.circuitInput, files, (s) => o.onStage?.(s, step));
    checkSignals(leg, r.publicSignals);
    proofs.push(toSolidityProof(r.proof));
    ms += r.ms;
  }
  const args = withProofs(plan, proofs);
  const incoming = plan.changes
    .filter((c) => c.amount > 0n)
    .map((c) => ({ commitment: commitment(c, domain).toString(), resource: c.resource.toString(), amount: c.amount.toString() }));
  return {
    plan,
    ms,
    ready: {
      roots: plan.args.legs.map((l) => l.root),
      nullifiers: plan.args.legs.flatMap((l) => [...l.nullifiers]),
      incoming,
      broadcast: { action: "execute", body: { args: toJson(args) } as Record<string, unknown> },
      self: { functionName: "execute", args: [args] },
    },
  };
}
