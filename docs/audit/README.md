# Curveil audit packages

Curveil goes to mainnet module by module. Each module ships only after its own audit passes:

| Package | Contracts | Goes live after |
| --- | --- | --- |
| [1. Markets, launches and launchpads](package-1-markets-launch.md) | Markets (DAMM, DLMM, router), launch (templates, curves, graduation, LP escrow), launchpads (registry, fee splitters), shared (asset registry, transfer helper), governance (timelock, treasuries, buyback and burn) | This audit |
| 2. Shielded vault | ShieldedPool, Groth16 verifiers, execution adapters, and the `transfer` and `withdraw` circuits | This audit, a ZK audit of the circuits, and the multi-party trusted setup ceremony |
| 3. Perps | PerpEngine, OrderManager, PerpLiquidityVault, OracleAdapter, report verifier, shielded perps adapter | This audit and a signed oracle agreement for low-latency price reports |

## How a package is frozen

1. The package names one commit and an annotated git tag (`audit-<n>-<name>`). Auditors review that tag and nothing else.
2. Fixes made during the audit go on top as separate commits, one per finding, each named after the finding id. The auditor reviews the diff from the tag.
3. Mainnet deploys only from a tag the auditor has signed off. The deployment manifest records the commit, and every contract is source-verified on Blockscout, so anyone can check that the deployed bytecode matches the audited source.

## Reproducing the build

```sh
pnpm install
cd packages/contracts
forge build            # solc 0.8.28, optimizer 200 runs, cancun, no via-ir
forge test             # unit, fuzz (512 runs) and invariant (128 runs, depth 64) tests
forge coverage --report summary --ir-minimum --no-match-contract ShieldedExecuteTest
slither . --filter-paths "node_modules|lib|test|script"
```

`ShieldedExecuteTest` uses a proof fixture tied to exact contract addresses. Coverage builds without the optimizer, so the addresses change and that one suite cannot run under coverage. It passes under `forge test`.

Toolchain at freeze: Foundry 1.5.1, OpenZeppelin Contracts 5.6.1, Slither 0.11.6, circomspect 0.9.0.
