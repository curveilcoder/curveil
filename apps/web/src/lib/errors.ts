import { BaseError, ContractFunctionRevertedError } from "viem";
import { IS_TESTNET } from "./config";

const MESSAGES: Record<string, string> = {
  Expired: "The deadline passed before the transaction was included. Nothing changed; request a new quote.",
  InsufficientOutput: "The price moved past your minimum output. Nothing was swapped. Requote, or widen slippage if you accept the new price.",
  InsufficientAmount: "The pool's ratio moved past your minimums. Nothing was deposited or withdrawn. Refresh and try again.",
  InsufficientLiquidity: "There is not enough liquidity on this route for that amount.",
  TooManyBins: "This trade would cross too many bins in one transaction. Try a smaller amount.",
  ActiveIdSlippage: "The active bin moved since you prepared this deposit. Nothing was deposited. Review the new range and try again.",
  CompositionViolation: "A bin received the wrong token for its side of the active price. Refresh the preview and try again.",
  ZeroShares: "One bin would receive too little to mint any shares. Increase the amount or narrow the range.",
  InsufficientShares: "You do not own that many shares in one of the bins.",
  SlippageExceeded: "The bins changed and would return less than your minimum. Nothing was withdrawn.",
  PoolExists: "A pool for this pair already exists. Add liquidity to it instead.",
  PairExists: "A pair with this bin step already exists. Add liquidity to it instead.",
  AssetNotAdmitted: "One of these assets is not admitted by the asset registry, so a pool cannot be created for it.",
  TierDisabled: "That fee tier is not enabled.",
  PresetDisabled: "That bin step is not enabled.",
  PriceOutOfRange: "That price is outside the range this bin step can represent.",
  UnknownPool: "The route uses a pool that the Curveil factories did not create. It was rejected.",
  InvalidPath: "The route is not valid for these tokens.",
  PoolMissing: "No pool exists for this pair yet.",
  ZeroAmount: "Enter an amount above zero.",
  ExceedsCirculating: "That is more tokens than are in circulation on this curve.",
  NotTrading: "This curve is no longer trading. It has reached its threshold or graduated. Refresh the page.",
  NotGraduationReady: "This curve has not reached its graduation threshold yet, or has already graduated.",
  NotCreatorRecipient: "Only the current creator fee recipient can change it.",
  InvalidName: "The name must be 1 to 32 bytes.",
  InvalidSymbol: "The symbol must be 1 to 10 characters, A to Z and 0 to 9 only.",
  InvalidURI: "The metadata link is longer than 200 bytes.",
  Paused: "Launch creation is paused. Trading on existing curves is not affected.",
  TemplateDisabled: "That template is not enabled for new launches.",
  ReceivedAmountMismatch: "The token transferred a different amount than requested (fee-on-transfer tokens are not supported). Nothing changed.",
  NotBeneficiary: "Only the lock's beneficiary can do that.",
  StillLocked: "This liquidity is still locked. Check the unlock time.",
  AlreadyClaimed: "This lock was already claimed.",
  UnknownLock: "No lock with that id exists.",
  OperatorNotAllowed: "That launchpad is paused, suspended, or does not offer this template. Nothing was created.",
  SlugTaken: "That launchpad name is already registered. Pick another.",
  BadSlug: "The launchpad name must be 3 to 32 characters: a-z, 0-9 and '-', not starting or ending with '-'.",
  ShareTooHigh: "That fee share is above the protocol's cap.",
  BadTemplates: "Pick at least one template that exists.",
  URITooLong: "The brand details are too long (2048 bytes at most).",
  BadRecipients: "Recipients must be 1 to 8 different addresses whose shares add up to 100%.",
  NotAdmin: "Only the launchpad's admin can change it.",
  NotPendingAdmin: "Only the address the admin role was offered to can accept it.",
  UnknownOperator: "That launchpad is not registered.",
};

const NETWORK_TROUBLE = "The network could not check this transaction, so nothing was sent. Try again in a moment.";
/** RPC failures carry the request URL and body: never show those. */
const noisy = (s: string) => /URL:|Request body|Request Arguments|internal error|historical state/i.test(s);
const firstLine = (s: string) => {
  const line = s.split("\n")[0]!.trim();
  return line.length > 220 ? `${line.slice(0, 217)}…` : line;
};

/** Turns wallet, RPC and contract errors into one plain sentence. */
export function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name && MESSAGES[name]) return MESSAGES[name]!;
      if (name) return `The contract rejected the transaction (${name}). Nothing changed.`;
      if (revert.reason && !noisy(revert.reason)) return `The contract rejected the transaction: ${firstLine(revert.reason)}`;
      if (revert.reason) return NETWORK_TROUBLE;
    }
    if (e.name === "UserRejectedRequestError" || /rejected|denied/i.test(e.shortMessage)) return "You cancelled the request in your wallet. Nothing was sent.";
    if (/insufficient funds/i.test(e.shortMessage)) return `Your wallet needs a little${IS_TESTNET ? " testnet" : ""} ETH for gas.`;
    if (/exceeds balance|transfer amount exceeds/i.test(e.message)) return "Your balance is lower than the amount.";
    return noisy(e.shortMessage) ? NETWORK_TROUBLE : firstLine(e.shortMessage);
  }
  return e instanceof Error ? (noisy(e.message) ? NETWORK_TROUBLE : firstLine(e.message)) : "The transaction could not be sent.";
}
