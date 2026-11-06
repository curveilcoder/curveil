import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address");
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex hash");

export const NETWORKS = { testnet: 46630, mainnet: 4663 } as const;
export type NetworkName = keyof typeof NETWORKS;

export const ContractEntry = z.object({
  address,
  deployBlock: z.number().int().nonnegative(),
  deployTx: hash,
  codeHash: hash,
  abiHash: hash,
  source: z.string(),
  verified: z.boolean(),
});

export const AssetEntry = z.object({
  symbol: z.string(),
  label: z.string(),
  /** The token's full name, as its issuer gives it. */
  name: z.string().optional(),
  /** Path of the official logo on the site (served by Curveil, never fetched from a third party). */
  logo: z.string().regex(/^\/tokens\/[a-z0-9-]+\.(png|svg|webp)$/).optional(),
  address,
  decimals: z.number().int().min(0).max(36),
  testOnly: z.boolean(),
});

/** A perps market: its on-chain id, what it trades, and the price feed that settles it. */
export const PerpMarketEntry = z.object({
  id: z.number().int().positive(),
  symbol: z.string(),
  base: z.string(),
  /** Feed name; the on-chain feed id is keccak256 of it. */
  feed: z.string(),
  feedId: hash,
  /** Chainlink reference feed used for the deviation check, if any. */
  reference: address.nullable(),
  /** Pyth price id for the feed, when the price source is "pyth". */
  pythId: hash.nullable().optional(),
});

/**
 * The deployment manifest: the single source of truth for what is deployed where.
 * The website, API, SDK and keepers all read it. Nothing else hardcodes an address.
 */
export const Manifest = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string(),
    network: z.enum(["testnet", "mainnet"]),
    chainId: z.number().int(),
    generatedAt: z.string(),
    rpc: z.object({ public: z.array(z.string().url()) }),
    explorer: z.string().url(),
    token: z.object({ symbol: z.literal("CURVEIL"), address: address.nullable() }),
    social: z.object({ x: z.string().url().nullable() }),
    admin: z.object({
      owner: address,
      safe: address.nullable(),
      timelock: address.nullable(),
      timelockDelaySeconds: z.number().int().nullable(),
    }),
    assets: z.array(AssetEntry),
    contracts: z.record(z.string(), ContractEntry),
    circuits: z.array(
      z.object({ name: z.string(), version: z.string(), wasmHash: hash, zkeyHash: hash, vkeyHash: hash.optional(), setup: z.string().optional() }),
    ),
    /** Present once perps are deployed (Phase 5). */
    perps: z
      .object({
        /** "pyth" (PythReportVerifier over Pyth's contract) or "curveil-test-signer" (testnet only). */
        priceSource: z.string(),
        reportVerifier: address,
        /** Pyth's price contract, when the price source is "pyth". Updates come from Hermes. */
        pyth: address.nullable().optional(),
        /** The test signer's address (testnet only). */
        priceSigner: address.nullable(),
        markets: z.array(PerpMarketEntry),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    if (NETWORKS[m.network] !== m.chainId) {
      ctx.addIssue({ code: "custom", message: `chainId ${m.chainId} does not match network ${m.network}` });
    }
    if (m.network === "mainnet" && m.perps?.priceSource === "curveil-test-signer") {
      ctx.addIssue({ code: "custom", message: "mainnet perps must not use the test price signer" });
    }
    if (m.perps?.priceSource === "pyth" && (!m.perps.pyth || m.perps.markets.some((x) => !x.pythId))) {
      ctx.addIssue({ code: "custom", message: "pyth perps need perps.pyth and a pythId for every market" });
    }
    if (m.network === "mainnet" && m.assets.some((a) => a.testOnly)) {
      ctx.addIssue({ code: "custom", message: "mainnet manifest must not contain test-only assets" });
    }
  });

export type Manifest = z.infer<typeof Manifest>;
export type ContractEntry = z.infer<typeof ContractEntry>;
export type AssetEntry = z.infer<typeof AssetEntry>;
export type PerpMarketEntry = z.infer<typeof PerpMarketEntry>;
