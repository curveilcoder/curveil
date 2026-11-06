/**
 * Builds manifests/<network>.json from Foundry deploy output and live chain reads.
 * Usage: NETWORK=testnet pnpm build:manifest
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, keccak256, toBytes, getAddress } from "viem";
import { parseManifest, NETWORKS, type NetworkName, type ContractEntry, type AssetEntry } from "../src/index";

const network = (process.env.NETWORK ?? "testnet") as NetworkName;
const chainId = NETWORKS[network];
const contractsDir = resolve(import.meta.dirname, "../../contracts");
const nets = JSON.parse(readFileSync(resolve(import.meta.dirname, "../networks.json"), "utf8"));
const net = nets[network];

/** `frozenAbi`: the ABI is kept in abis/<name>.json (a superseded deployment whose source changed). */
type Deployed = { name: string; artifact: string; source: string; frozenAbi?: boolean };
// Logical name -> compiled artifact. Extend as each phase adds contracts.
const CONTRACTS: Record<string, Deployed> = {
  AssetRegistry: { name: "AssetRegistry", artifact: "AssetRegistry.sol/AssetRegistry.json", source: "src/shared/AssetRegistry.sol" },
  TestUSDG: { name: "TestToken", artifact: "TestToken.sol/TestToken.json", source: "src/testnet/TestToken.sol" },
  TestWETH: { name: "TestToken", artifact: "TestToken.sol/TestToken.json", source: "src/testnet/TestToken.sol" },
  TestFaucet: { name: "TestFaucet", artifact: "TestFaucet.sol/TestFaucet.json", source: "src/testnet/TestFaucet.sol" },
  DammFactory: { name: "DammFactory", artifact: "DammFactory.sol/DammFactory.json", source: "src/markets/DammFactory.sol" },
  DlmmFactory: { name: "DlmmFactory", artifact: "DlmmFactory.sol/DlmmFactory.json", source: "src/markets/DlmmFactory.sol" },
  CurveilRouter: { name: "CurveilRouter", artifact: "CurveilRouter.sol/CurveilRouter.json", source: "src/markets/CurveilRouter.sol" },
  AdmissionController: { name: "AdmissionController", artifact: "AdmissionController.sol/AdmissionController.json", source: "src/launch/AdmissionController.sol" },
  LaunchTemplateRegistry: { name: "LaunchTemplateRegistry", artifact: "LaunchTemplateRegistry.sol/LaunchTemplateRegistry.json", source: "src/launch/LaunchTemplateRegistry.sol" },
  LaunchFactory: { name: "LaunchFactory", artifact: "LaunchFactory.sol/LaunchFactory.json", source: "src/launch/LaunchFactory.sol" },
  GraduationMigrator: { name: "GraduationMigrator", artifact: "GraduationMigrator.sol/GraduationMigrator.json", source: "src/launch/GraduationMigrator.sol" },
  LpEscrow: { name: "LpEscrow", artifact: "LpEscrow.sol/LpEscrow.json", source: "src/launch/LpEscrow.sol" },
  PoseidonT3: { name: "PoseidonT3", artifact: "PoseidonT3.sol/PoseidonT3.json", source: "node_modules/poseidon-solidity/PoseidonT3.sol" },
  PoseidonT5: { name: "PoseidonT5", artifact: "PoseidonT5.sol/PoseidonT5.json", source: "node_modules/poseidon-solidity/PoseidonT5.sol" },
  TransferVerifier: { name: "TransferVerifier", artifact: "TransferVerifier.sol/TransferVerifier.json", source: "src/vault/verifiers/TransferVerifier.sol" },
  WithdrawVerifier: { name: "WithdrawVerifier", artifact: "WithdrawVerifier.sol/WithdrawVerifier.json", source: "src/vault/verifiers/WithdrawVerifier.sol" },
  ShieldedPool: { name: "ShieldedPool", artifact: "ShieldedPool.sol/ShieldedPool.json", source: "src/vault/ShieldedPool.sol" },
  // Phase 3 pool (v1, no shielded execution). Still honours withdrawals; superseded by ShieldedPool v2.
  ShieldedPoolV1: { name: "ShieldedPoolV1", artifact: "", source: "src/vault/ShieldedPool.sol (v1)", frozenAbi: true },
  ShieldedSwapAdapter: { name: "ShieldedSwapAdapter", artifact: "ShieldedSwapAdapter.sol/ShieldedSwapAdapter.json", source: "src/vault/adapters/ShieldedSwapAdapter.sol" },
  ShieldedLiquidityAdapter: { name: "ShieldedLiquidityAdapter", artifact: "ShieldedLiquidityAdapter.sol/ShieldedLiquidityAdapter.json", source: "src/vault/adapters/ShieldedLiquidityAdapter.sol" },
  PositionHolder: { name: "PositionHolder", artifact: "PositionHolder.sol/PositionHolder.json", source: "src/vault/adapters/PositionHolder.sol" },
  SignedReportVerifier: { name: "SignedReportVerifier", artifact: "SignedReportVerifier.sol/SignedReportVerifier.json", source: "src/perps/oracle/SignedReportVerifier.sol" },
  PythReportVerifier: { name: "PythReportVerifier", artifact: "PythReportVerifier.sol/PythReportVerifier.json", source: "src/perps/oracle/PythReportVerifier.sol" },
  OracleAdapter: { name: "OracleAdapter", artifact: "OracleAdapter.sol/OracleAdapter.json", source: "src/perps/OracleAdapter.sol" },
  PerpLiquidityVault: { name: "PerpLiquidityVault", artifact: "PerpLiquidityVault.sol/PerpLiquidityVault.json", source: "src/perps/PerpLiquidityVault.sol" },
  PerpEngine: { name: "PerpEngine", artifact: "PerpEngine.sol/PerpEngine.json", source: "src/perps/PerpEngine.sol" },
  OrderManager: { name: "OrderManager", artifact: "OrderManager.sol/OrderManager.json", source: "src/perps/OrderManager.sol" },
  PerpLens: { name: "PerpLens", artifact: "PerpLens.sol/PerpLens.json", source: "src/perps/PerpLens.sol" },
  ShieldedPerpsAdapter: { name: "ShieldedPerpsAdapter", artifact: "ShieldedPerpsAdapter.sol/ShieldedPerpsAdapter.json", source: "src/vault/adapters/ShieldedPerpsAdapter.sol" },
  LaunchpadRegistry: { name: "LaunchpadRegistry", artifact: "LaunchpadRegistry.sol/LaunchpadRegistry.json", source: "src/factory/LaunchpadRegistry.sol" },
  // The implementation each operator's splitter clones. Operator addresses come from the indexer.
  FeeSplitter: { name: "FeeSplitter", artifact: "FeeSplitter.sol/FeeSplitter.json", source: "src/factory/FeeSplitter.sol" },
  // Phase 7 governance: the timelock that owns admin roles on mainnet, one treasury per fee source.
  CurveilTimelock: { name: "CurveilTimelock", artifact: "CurveilTimelock.sol/CurveilTimelock.json", source: "src/governance/CurveilTimelock.sol" },
  BuybackBurner: { name: "BuybackBurner", artifact: "BuybackBurner.sol/BuybackBurner.json", source: "src/governance/BuybackBurner.sol" },
  ...Object.fromEntries(
    ["Markets", "Launch", "Vault", "Perps", "Factory"].map((s) => [
      `Treasury${s}`,
      { name: "ProtocolTreasury", artifact: "ProtocolTreasury.sol/ProtocolTreasury.json", source: "src/governance/ProtocolTreasury.sol" },
    ]),
  ),
};

// Contracts created by factories at runtime. Their ABIs ship with the manifest package;
// their addresses come from factory events through the indexer.
const RUNTIME_ABIS: Record<string, string> = {
  DammPool: "DammPool.sol/DammPool.json",
  DlmmPair: "DlmmPair.sol/DlmmPair.json",
  BondingCurve: "BondingCurve.sol/BondingCurve.json",
  CurveilLaunchToken: "CurveilLaunchToken.sol/CurveilLaunchToken.json",
};

// Bump when a phase adds or changes contracts.
const PROTOCOL_VERSION = "0.7.0";
/** Contracts whose compiled ABI differs from the published one; kept as published unless accepted. */
const abiChanges = new Set<string>();

function readJsonIfExists(path: string) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

const deployment = JSON.parse(readFileSync(resolve(contractsDir, `deployments/${network}.foundation.json`), "utf8"));
const addressOf: Record<string, string | undefined> = {
  AssetRegistry: deployment.assetRegistry,
  TestUSDG: network === "testnet" ? deployment.usdg : undefined,
  TestWETH: network === "testnet" ? deployment.weth : undefined,
  TestFaucet: deployment.testFaucet !== "0x0000000000000000000000000000000000000000" ? deployment.testFaucet : undefined,
};

const markets = readJsonIfExists(resolve(contractsDir, `deployments/${network}.markets.json`));
if (markets) {
  addressOf.DammFactory = markets.dammFactory;
  addressOf.DlmmFactory = markets.dlmmFactory;
  addressOf.CurveilRouter = markets.router;
}

const launch = readJsonIfExists(resolve(contractsDir, `deployments/${network}.launch.json`));
if (launch) {
  addressOf.AdmissionController = launch.admissionController;
  addressOf.LaunchTemplateRegistry = launch.launchTemplateRegistry;
  addressOf.LaunchFactory = launch.launchFactory;
  addressOf.GraduationMigrator = launch.graduationMigrator;
  addressOf.LpEscrow = launch.lpEscrow;
}

const vault = readJsonIfExists(resolve(contractsDir, `deployments/${network}.vault.json`));
if (vault) {
  addressOf.TransferVerifier = vault.transferVerifier;
  addressOf.WithdrawVerifier = vault.withdrawVerifier;
  addressOf.ShieldedPool = vault.shieldedPool;
}

// Phase 4: ShieldedPool v2 with shielded execution replaces the v1 pool in the manifest.
const execution = readJsonIfExists(resolve(contractsDir, `deployments/${network}.execution.json`));
if (execution) {
  addressOf.ShieldedPoolV1 = execution.legacyPool;
  addressOf.ShieldedPool = execution.shieldedPool;
  addressOf.ShieldedSwapAdapter = execution.swapAdapter;
  addressOf.ShieldedLiquidityAdapter = execution.liquidityAdapter;
  addressOf.PositionHolder = execution.positionHolderImplementation;
}

// Phase 5: perps. The report verifier is ours only on testnet (curveil-test-signer); on mainnet
// it belongs to the oracle network and is listed under perps.reportVerifier instead.
const perpsDeployment = readJsonIfExists(resolve(contractsDir, `deployments/${network}.perps.json`));
if (perpsDeployment) {
  if (perpsDeployment.priceSource === "curveil-test-signer") addressOf.SignedReportVerifier = perpsDeployment.reportVerifier;
  if (perpsDeployment.priceSource === "pyth") addressOf.PythReportVerifier = perpsDeployment.reportVerifier;
  addressOf.OracleAdapter = perpsDeployment.oracleAdapter;
  addressOf.PerpLiquidityVault = perpsDeployment.perpLiquidityVault;
  addressOf.PerpEngine = perpsDeployment.perpEngine;
  addressOf.OrderManager = perpsDeployment.orderManager;
  addressOf.PerpLens = perpsDeployment.perpLens;
  addressOf.ShieldedPerpsAdapter = perpsDeployment.shieldedPerpsAdapter;
}

// Phase 6: launchpad operators.
const factoryDeployment = readJsonIfExists(resolve(contractsDir, `deployments/${network}.factory.json`));
if (factoryDeployment) {
  addressOf.LaunchpadRegistry = factoryDeployment.launchpadRegistry;
  addressOf.FeeSplitter = factoryDeployment.feeSplitterImplementation;
}

// Phase 7: governance.
const governance = readJsonIfExists(resolve(contractsDir, `deployments/${network}.governance.json`));
if (governance) {
  addressOf.CurveilTimelock = governance.timelock;
  addressOf.BuybackBurner = governance.buybackBurner;
  for (const [source, addr] of Object.entries(governance.treasuries as Record<string, string>)) {
    addressOf[`Treasury${source[0]!.toUpperCase()}${source.slice(1)}`] = addr;
  }
}

// Deploy transactions and receipts from every deploy script that has run on this chain.
const externalLibs = readJsonIfExists(resolve(contractsDir, `deployments/${network}.libraries.json`));
const broadcast = { transactions: [] as any[], receipts: [] as any[] };
for (const script of ["DeployFoundation.s.sol", "DeployMarkets.s.sol", "DeployLaunch.s.sol", "DeployVault.s.sol", "DeployExecution.s.sol", "DeployPerps.s.sol", "DeployFactory.s.sol", "DeployGovernance.s.sol"]) {
  const run = readJsonIfExists(resolve(contractsDir, `broadcast/${script}/${chainId}/run-latest.json`));
  if (run) {
    broadcast.transactions.push(...run.transactions);
    broadcast.receipts.push(...run.receipts);
    // Linked libraries (Poseidon) deployed by Forge for this script: "path:Name:0xaddress".
    for (const lib of (run.libraries ?? []) as string[]) {
      const [, libName, libAddr] = lib.split(":");
      if (libName && libAddr && CONTRACTS[libName]) addressOf[libName] = libAddr;
    }
  }
}

// Circuit artifacts and their hashes from the trusted setup record.
const setup = readJsonIfExists(resolve(import.meta.dirname, `../../circuits/artifacts/${network}/setup.json`));
const circuits = setup
  ? Object.entries(setup.circuits as Record<string, { schema: string; wasm: string; zkey: string; vkey: string }>).map(([name, c]) => ({
      name,
      version: c.schema,
      wasmHash: `0x${c.wasm}`,
      zkeyHash: `0x${c.zkey}`,
      vkeyHash: `0x${c.vkey}`,
      setup: setup.label as string,
    }))
  : [];
const client = createPublicClient({ transport: http(net.rpc[0]) });

/**
 * Verified on the explorer (Blockscout), or on Sourcify, which Blockscout reads from. The explorer
 * can be unreachable from build machines behind its bot check, so Sourcify is asked as well.
 */
async function isVerified(addr: string): Promise<boolean> {
  try {
    const r = await fetch(`${net.explorer}/api/v2/smart-contracts/${addr}`);
    if (r.ok && ((await r.json()) as { is_verified?: boolean }).is_verified === true) return true;
  } catch {
    /* fall through to Sourcify */
  }
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${addr}`);
    if (!r.ok) return false;
    const j = (await r.json()) as { match?: string | null };
    return j.match === "match" || j.match === "exact_match";
  } catch {
    return false;
  }
}

async function entryFor(key: string, addr: string): Promise<ContractEntry> {
  const meta = CONTRACTS[key]!;
  // Top-level deployments, or contracts created inside a deploy transaction (constructor CREATE).
  type Tx = { hash: string; contractAddress?: string; additionalContracts?: { address: string }[] };
  const same = (a?: string) => Boolean(a) && getAddress(a!) === getAddress(addr);
  const tx = (broadcast.transactions as Tx[]).find((t) => same(t.contractAddress) || (t.additionalContracts ?? []).some((c) => same(c.address)));
  // A library that was already on chain (CREATE2 by someone else) has no Curveil broadcast.
  const known = !tx ? (externalLibs?.[key] as { address: string; deployTx: string; deployBlock: number } | undefined) : undefined;
  if (!tx && !(known && same(known.address))) throw new Error(`No deploy transaction found for ${key} at ${addr}`);
  const receipt = tx
    ? broadcast.receipts.find((r: { transactionHash: string }) => r.transactionHash === tx.hash)
    : { blockNumber: known!.deployBlock };
  const code = await client.getCode({ address: addr as `0x${string}` });
  if (!code || code === "0x") throw new Error(`${key} has no code at ${addr}`);
  const abiPath = resolve(import.meta.dirname, `../abis/${meta.name}.json`);
  let artifact = meta.frozenAbi
    ? { abi: JSON.parse(readFileSync(abiPath, "utf8")) }
    : JSON.parse(readFileSync(resolve(contractsDir, "out", meta.artifact), "utf8"));
  if (!meta.frozenAbi) {
    const next = JSON.stringify(artifact.abi, null, 2) + "\n";
    const prev = existsSync(abiPath) ? readFileSync(abiPath, "utf8") : null;
    // The compiled source may be newer than what is deployed: never change a published ABI silently.
    if (prev !== null && prev !== next && !process.argv.includes("--accept-abi-changes")) {
      abiChanges.add(meta.name);
      artifact = { ...artifact, abi: JSON.parse(prev) };
    } else writeFileSync(abiPath, next);
  }
  return {
    address: getAddress(addr),
    deployBlock: Number(BigInt(receipt.blockNumber)),
    deployTx: tx ? tx.hash : known!.deployTx,
    codeHash: keccak256(code),
    abiHash: keccak256(toBytes(JSON.stringify(artifact.abi))),
    source: meta.source,
    verified: await isVerified(addr),
  };
}

async function main() {
  const live = await client.getChainId();
  if (live !== chainId) throw new Error(`RPC reports chain ${live}, expected ${chainId}`);

  const contracts: Record<string, ContractEntry> = {};
  for (const [key, addr] of Object.entries(addressOf)) {
    if (addr) contracts[key] = await entryFor(key, addr);
  }
  for (const [name, artifactPath] of Object.entries(RUNTIME_ABIS)) {
    const artifact = JSON.parse(readFileSync(resolve(contractsDir, "out", artifactPath), "utf8"));
    writeFileSync(resolve(import.meta.dirname, `../abis/${name}.json`), JSON.stringify(artifact.abi, null, 2) + "\n");
  }

  const testOnly = network === "testnet" && Boolean(addressOf.TestUSDG);
  const assets: AssetEntry[] = [
    { symbol: testOnly ? "tUSDG" : "USDG", label: "USDG", name: testOnly ? "Test Global Dollar" : "Global Dollar", logo: "/tokens/usdg.png", address: getAddress(deployment.usdg), decimals: 6, testOnly },
    { symbol: testOnly ? "tWETH" : "WETH", label: "WETH", name: testOnly ? "Test Wrapped Ether" : "Wrapped Ether", logo: "/tokens/weth.png", address: getAddress(deployment.weth), decimals: 18, testOnly },
  ];
  // Assets admitted after the deploy (AdmissionController.admit), listed in assets/<network>.json.
  // Each must be admitted on chain, or pools could not be created with it.
  const extraPath = resolve(import.meta.dirname, `../assets/${network}.json`);
  if (existsSync(extraPath)) {
    const registry = contracts.AssetRegistry!.address as `0x${string}`;
    for (const a of JSON.parse(readFileSync(extraPath, "utf8")) as Omit<AssetEntry, "testOnly">[]) {
      const ok = await client.readContract({
        address: registry,
        abi: [{ type: "function", name: "isAdmitted", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" }],
        functionName: "isAdmitted",
        args: [getAddress(a.address)],
      });
      if (!ok) throw new Error(`${a.symbol} (${a.address}) is not admitted in the AssetRegistry ${registry}`);
      assets.push({ ...a, address: getAddress(a.address), testOnly: false });
    }
  }

  const prevPath = resolve(import.meta.dirname, `../manifests/${network}.json`);
  const prev = existsSync(prevPath) ? JSON.parse(readFileSync(prevPath, "utf8")) : null;
  const build = prev ? Number(String(prev.version).split(".").pop()) + 1 : 1;
  // e.g. 0.2.0-testnet.3: protocol version, network, build number on that network.

  // The AdmissionController owns the AssetRegistry once Phase 2 is deployed; report its owner.
  const owner = await client.readContract({
    address: (contracts.AdmissionController ?? contracts.AssetRegistry)!.address as `0x${string}`,
    abi: [{ type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }],
    functionName: "owner",
  });

  // Perps markets: what each market id trades and which price feed settles it.
  const config = JSON.parse(readFileSync(resolve(contractsDir, `config/${network}.json`), "utf8"));
  const zero = "0x0000000000000000000000000000000000000000";
  const perps = perpsDeployment
    ? {
        priceSource: perpsDeployment.priceSource as string,
        reportVerifier: getAddress(perpsDeployment.reportVerifier),
        priceSigner: perpsDeployment.priceSource === "curveil-test-signer" ? getAddress(config.perps.priceSigner) : null,
        pyth: perpsDeployment.priceSource === "pyth" ? getAddress(config.perps.pyth.address) : null,
        markets: (config.perps.markets as { id: number; symbol: string; base: string; feed: string; reference: string; pythId?: string }[]).map((m) => ({
          id: m.id,
          symbol: m.symbol,
          base: m.base,
          feed: m.feed,
          feedId: keccak256(toBytes(m.feed)),
          reference: m.reference && m.reference !== zero ? getAddress(m.reference) : null,
          pythId: perpsDeployment.priceSource === "pyth" && m.pythId ? (m.pythId.toLowerCase() as `0x${string}`) : null,
        })),
      }
    : undefined;

  const manifest = parseManifest({
    schemaVersion: 1,
    version: `${PROTOCOL_VERSION}-${network}.${build}`,
    network,
    chainId,
    generatedAt: new Date().toISOString(),
    rpc: { public: net.rpc },
    explorer: net.explorer,
    token: net.token,
    social: net.social,
    admin: {
      owner,
      // Only a contract counts as the multisig: the testnet rehearsal uses the deployer key.
      safe: governance && (await client.getCode({ address: governance.safe })) ? getAddress(governance.safe) : null,
      timelock: governance ? getAddress(governance.timelock) : null,
      timelockDelaySeconds: governance ? Number(governance.timelockDelay) : null,
    },
    assets,
    contracts,
    circuits,
    perps,
  });

  writeFileSync(prevPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${prevPath} (${manifest.version}, ${Object.keys(contracts).length} contracts)`);
  if (abiChanges.size) {
    console.log(`Kept the published ABI of ${[...abiChanges].join(", ")}: the source changed since. If these contracts were redeployed from the new source, run again with --accept-abi-changes.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
