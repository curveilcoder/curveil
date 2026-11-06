import { parseAbi } from "viem";
// Hand-written fragments of the contracts the app calls, kept `as const` for typed reads and
// writes. Full ABIs ship in @curveil/manifest/abis and are checked against these in abis.test.ts.

export const faucetAbi = [
  { type: "function", name: "claimMany", stateMutability: "nonpayable", inputs: [{ name: "tokens", type: "address[]" }], outputs: [] },
  { type: "function", name: "availableAt", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "drips", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "amount", type: "uint256" }, { name: "enabled", type: "bool" }] },
  { type: "error", name: "CoolingDown", inputs: [{ name: "token", type: "address" }, { name: "availableAt", type: "uint256" }] },
  { type: "error", name: "DripDisabled", inputs: [{ name: "token", type: "address" }] },
] as const;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const hop = { type: "tuple[]", name: "hops", components: [{ name: "pool", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }] } as const;

// Custom errors from the router, pools and pairs, so wallet and simulation errors decode to names.
const marketErrors = [
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "InvalidPath", inputs: [] },
  { type: "error", name: "UnknownPool", inputs: [{ name: "pool", type: "address" }] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "amountOut", type: "uint256" }, { name: "minOut", type: "uint256" }] },
  { type: "error", name: "PoolMissing", inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }] },
  { type: "error", name: "InsufficientAmount", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "InsufficientLiquidity", inputs: [] },
  { type: "error", name: "InsufficientInput", inputs: [] },
  { type: "error", name: "TooManyBins", inputs: [] },
  { type: "error", name: "ActiveIdSlippage", inputs: [{ name: "expected", type: "uint24" }, { name: "actual", type: "uint24" }] },
  { type: "error", name: "CompositionViolation", inputs: [{ name: "id", type: "uint24" }] },
  { type: "error", name: "ZeroShares", inputs: [{ name: "id", type: "uint24" }] },
  { type: "error", name: "InsufficientShares", inputs: [{ name: "id", type: "uint24" }] },
  { type: "error", name: "SlippageExceeded", inputs: [{ name: "amountX", type: "uint256" }, { name: "amountY", type: "uint256" }] },
  { type: "error", name: "PoolExists", inputs: [{ name: "pool", type: "address" }] },
  { type: "error", name: "PairExists", inputs: [{ name: "pair", type: "address" }] },
  { type: "error", name: "AssetNotAdmitted", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "TierDisabled", inputs: [{ name: "tier", type: "uint8" }] },
  { type: "error", name: "PresetDisabled", inputs: [{ name: "binStep", type: "uint16" }] },
  { type: "error", name: "PriceOutOfRange", inputs: [] },
] as const;

export const routerAbi = [
  {
    type: "function",
    name: "swapExactIn",
    stateMutability: "nonpayable",
    inputs: [hop, { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteExactIn",
    stateMutability: "view",
    inputs: [hop, { name: "amountIn", type: "uint256" }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "fees", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "addLiquidityDamm",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "d",
        type: "tuple",
        components: [
          { name: "tokenA", type: "address" },
          { name: "tokenB", type: "address" },
          { name: "amountADesired", type: "uint256" },
          { name: "amountBDesired", type: "uint256" },
          { name: "amountAMin", type: "uint256" },
          { name: "amountBMin", type: "uint256" },
          { name: "to", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountA", type: "uint256" }, { name: "amountB", type: "uint256" }, { name: "liquidity", type: "uint256" }],
  },
  {
    type: "function",
    name: "removeLiquidityDamm",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "liquidity", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountA", type: "uint256" }, { name: "amountB", type: "uint256" }],
  },
  {
    type: "function",
    name: "addLiquidityDlmm",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "d",
        type: "tuple",
        components: [
          { name: "pair", type: "address" },
          { name: "amountX", type: "uint256" },
          { name: "amountY", type: "uint256" },
          { name: "activeIdExpected", type: "uint24" },
          { name: "idSlippage", type: "uint24" },
          { name: "deltaIds", type: "int256[]" },
          { name: "distributionX", type: "uint256[]" },
          { name: "distributionY", type: "uint256[]" },
          { name: "to", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "usedX", type: "uint256" }, { name: "usedY", type: "uint256" }, { name: "ids", type: "uint256[]" }, { name: "minted", type: "uint256[]" }],
  },
  ...marketErrors,
] as const;

export const dammPoolAbi = [
  { type: "function", name: "claimFees", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }, { type: "uint128" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  ...marketErrors,
] as const;

const binTuple = {
  type: "tuple",
  components: [
    { name: "x", type: "uint128" },
    { name: "y", type: "uint128" },
    { name: "shares", type: "uint256" },
    { name: "growthX", type: "uint256" },
    { name: "growthY", type: "uint256" },
  ],
} as const;

export const dlmmPairAbi = [
  { type: "function", name: "activeId", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "getBins", stateMutability: "view", inputs: [{ name: "ids", type: "uint24[]" }], outputs: [{ ...binTuple, name: "bins", type: "tuple[]" }] },
  {
    type: "function",
    name: "removeLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "ids", type: "uint24[]" },
      { name: "shares", type: "uint256[]" },
      { name: "minX", type: "uint256" },
      { name: "minY", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }, { type: "uint256" }],
  },
  { type: "function", name: "claimFees", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "ids", type: "uint24[]" }], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  ...marketErrors,
] as const;

export const dammFactoryAbi = [
  { type: "function", name: "createPool", stateMutability: "nonpayable", inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "tierId", type: "uint8" }], outputs: [{ name: "pool", type: "address" }] },
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "tier",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "baseFeeBps", type: "uint16" },
          { name: "maxFeeBps", type: "uint16" },
          { name: "protocolShareBps", type: "uint16" },
          { name: "variableFeeControl", type: "uint16" },
          { name: "filterPeriod", type: "uint32" },
          { name: "decayPeriod", type: "uint32" },
          { name: "reductionBps", type: "uint16" },
          { name: "maxVolatilityBps", type: "uint32" },
        ],
      },
      { name: "enabled", type: "bool" },
    ],
  },
  ...marketErrors,
] as const;

export const dlmmFactoryAbi = [
  { type: "function", name: "createPair", stateMutability: "nonpayable", inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "binStep", type: "uint16" }, { name: "activeId", type: "uint24" }], outputs: [{ name: "pair", type: "address" }] },
  { type: "function", name: "getPair", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint16" }], outputs: [{ type: "address" }] },
  { type: "function", name: "binSteps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16[]" }] },
  { type: "function", name: "presets", stateMutability: "view", inputs: [{ name: "binStep", type: "uint16" }], outputs: [{ name: "baseFeeBps", type: "uint16" }, { name: "enabled", type: "bool" }] },
  { type: "function", name: "protocolShareBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  ...marketErrors,
] as const;

// ------------------------------------------------------------------ launches

const launchErrors = [
  { type: "error", name: "Expired", inputs: [] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "amountOut", type: "uint256" }, { name: "minOut", type: "uint256" }] },
  { type: "error", name: "ExceedsCirculating", inputs: [{ name: "amount", type: "uint256" }, { name: "circulating", type: "uint256" }] },
  { type: "error", name: "NotTrading", inputs: [{ name: "state", type: "uint8" }] },
  { type: "error", name: "NotGraduationReady", inputs: [{ name: "state", type: "uint8" }] },
  { type: "error", name: "NotCreatorRecipient", inputs: [] },
  { type: "error", name: "InvalidName", inputs: [] },
  { type: "error", name: "InvalidSymbol", inputs: [] },
  { type: "error", name: "InvalidURI", inputs: [] },
  { type: "error", name: "Paused", inputs: [] },
  { type: "error", name: "TemplateDisabled", inputs: [{ name: "id", type: "uint256" }] },
  { type: "error", name: "ReceivedAmountMismatch", inputs: [{ name: "token", type: "address" }, { name: "expected", type: "uint256" }, { name: "received", type: "uint256" }] },
  { type: "error", name: "NotBeneficiary", inputs: [] },
  { type: "error", name: "StillLocked", inputs: [{ name: "unlockAt", type: "uint64" }] },
  { type: "error", name: "AlreadyClaimed", inputs: [] },
  { type: "error", name: "UnknownLock", inputs: [{ name: "id", type: "uint256" }] },
] as const;

export const launchFactoryAbi = [
  {
    type: "function",
    name: "createLaunch",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "templateId", type: "uint256" },
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataURI", type: "string" },
          { name: "creatorRecipient", type: "address" },
          { name: "operator", type: "address" },
          { name: "initialBuy", type: "uint256" },
          { name: "minTokensOut", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "token", type: "address" }, { name: "curve", type: "address" }],
  },
  { type: "function", name: "creationPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "event",
    name: "LaunchCreated",
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "curve", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "templateId", type: "uint256", indexed: false },
      { name: "name", type: "string", indexed: false },
      { name: "symbol", type: "string", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
      { name: "creatorRecipient", type: "address", indexed: false },
    ],
  },
  ...launchErrors,
] as const;

export const bondingCurveAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [{ name: "quoteIn", type: "uint256" }, { name: "minTokensOut", type: "uint256" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }],
    outputs: [{ name: "tokensOut", type: "uint256" }, { name: "quoteUsed", type: "uint256" }],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokensIn", type: "uint256" }, { name: "minQuoteOut", type: "uint256" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" }],
    outputs: [{ name: "quoteOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteBuy",
    stateMutability: "view",
    inputs: [{ name: "quoteIn", type: "uint256" }],
    outputs: [{ name: "tokensOut", type: "uint256" }, { name: "fee", type: "uint256" }, { name: "quoteUsed", type: "uint256" }],
  },
  {
    type: "function",
    name: "quoteSell",
    stateMutability: "view",
    inputs: [{ name: "tokensIn", type: "uint256" }],
    outputs: [{ name: "quoteOut", type: "uint256" }, { name: "fee", type: "uint256" }],
  },
  { type: "function", name: "graduate", stateMutability: "nonpayable", inputs: [], outputs: [{ name: "pool", type: "address" }, { name: "liquidity", type: "uint256" }] },
  { type: "function", name: "claimFees", stateMutability: "nonpayable", inputs: [{ name: "b", type: "uint8" }], outputs: [{ name: "amount", type: "uint256" }] },
  { type: "function", name: "setCreatorRecipient", stateMutability: "nonpayable", inputs: [{ name: "recipient", type: "address" }], outputs: [] },
  { type: "function", name: "state", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "reserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "circulating", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  ...launchErrors,
] as const;

export const lpEscrowAbi = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }, { name: "to", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "claimFees",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }, { name: "to", type: "address" }],
    outputs: [{ name: "amount0", type: "uint256" }, { name: "amount1", type: "uint256" }],
  },
  ...launchErrors,
] as const;

// Launchpad errors (Phase 6), so reverts from createLaunch decode to names.
export const factoryErrors = parseAbi([
  "error NotAdmin()",
  "error NotPendingAdmin()",
  "error UnknownOperator()",
  "error BadSlug()",
  "error SlugTaken()",
  "error ShareTooHigh()",
  "error BadTemplates()",
  "error URITooLong()",
  "error BadRecipients()",
  "error NotRegistry()",
  "error OperatorNotAllowed(address operator)",
]);
