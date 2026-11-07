import { BaseError, ContractFunctionRevertedError } from "viem";
import { IS_TESTNET } from "./config";
import { tNow } from "./i18n";

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

const MESSAGES_ZH: Record<string, string> = {
  Expired: "交易被打包前已超过截止时间。没有任何变化，请重新获取报价。",
  InsufficientOutput: "价格变动超出了你的最低输出。没有完成兑换。请重新报价，如果接受新价格也可以放宽滑点。",
  InsufficientAmount: "资金池比例变动超出了你的最低要求。没有存入或提取任何资产。请刷新后重试。",
  InsufficientLiquidity: "这条路径上的流动性不足以支撑该金额。",
  TooManyBins: "这笔交易在一次交易中会跨越过多区间。请尝试更小的金额。",
  ActiveIdSlippage: "在你准备这笔存款后，活跃区间发生了变化。没有存入任何资产。请查看新的区间后重试。",
  CompositionViolation: "某个区间收到的代币与它在当前价格一侧应有的代币不符。请刷新预览后重试。",
  ZeroShares: "某个区间收到的金额太少，无法铸造份额。请增加金额或缩小区间范围。",
  InsufficientShares: "你在其中一个区间中没有那么多份额。",
  SlippageExceeded: "区间已变化，返还金额将低于你的最低要求。没有提取任何资产。",
  PoolExists: "该交易对的资金池已存在。请直接向它添加流动性。",
  PairExists: "该区间步长的交易对已存在。请直接向它添加流动性。",
  AssetNotAdmitted: "其中一种资产未被资产注册表准入，因此无法为它创建资金池。",
  TierDisabled: "该费率档位未启用。",
  PresetDisabled: "该区间步长未启用。",
  PriceOutOfRange: "该价格超出了此区间步长能表示的范围。",
  UnknownPool: "该路径使用了不是由 Curveil 工厂合约创建的资金池，已被拒绝。",
  InvalidPath: "该路径对这些代币无效。",
  PoolMissing: "该交易对还没有资金池。",
  ZeroAmount: "请输入大于零的金额。",
  ExceedsCirculating: "该数量超过了这条曲线上的流通量。",
  NotTrading: "这条曲线已停止交易，它已达到门槛或已毕业。请刷新页面。",
  NotGraduationReady: "这条曲线尚未达到毕业门槛，或已经毕业。",
  NotCreatorRecipient: "只有当前的创建者手续费收款人可以修改它。",
  InvalidName: "名称长度必须为 1 到 32 字节。",
  InvalidSymbol: "代号必须为 1 到 10 个字符，只能使用 A 到 Z 和 0 到 9。",
  InvalidURI: "元数据链接超过了 200 字节。",
  Paused: "创建代币发行已暂停。现有曲线上的交易不受影响。",
  TemplateDisabled: "该模板未对新发行启用。",
  ReceivedAmountMismatch: "代币转账的数量与请求的不同（不支持转账收费代币）。没有任何变化。",
  NotBeneficiary: "只有锁仓的受益人可以执行此操作。",
  StillLocked: "这部分流动性仍在锁定中。请查看解锁时间。",
  AlreadyClaimed: "这个锁仓已经领取过了。",
  UnknownLock: "不存在该 ID 的锁仓。",
  OperatorNotAllowed: "该发射台已暂停、被停用，或不提供此模板。没有创建任何内容。",
  SlugTaken: "该发射台名称已被注册。请换一个。",
  BadSlug: "发射台名称必须为 3 到 32 个字符：a-z、0-9 和“-”，且不能以“-”开头或结尾。",
  ShareTooHigh: "该手续费分成超过了协议上限。",
  BadTemplates: "请至少选择一个存在的模板。",
  URITooLong: "品牌信息太长（最多 2048 字节）。",
  BadRecipients: "收款人必须是 1 到 8 个不同的地址，且份额之和为 100%。",
  NotAdmin: "只有发射台的管理员可以修改它。",
  NotPendingAdmin: "只有被提名为管理员的地址可以接受该角色。",
  UnknownOperator: "该发射台未注册。",
};

const NETWORK_TROUBLE = () => tNow("The network could not check this transaction, so nothing was sent. Try again in a moment.", "网络无法检查这笔交易，因此没有发送任何内容。请稍后重试。");
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
      if (name && MESSAGES[name]) return tNow(MESSAGES[name]!, MESSAGES_ZH[name] ?? MESSAGES[name]!);
      if (name) return tNow(`The contract rejected the transaction (${name}). Nothing changed.`, `合约拒绝了这笔交易（${name}）。没有任何变化。`);
      if (revert.reason && !noisy(revert.reason)) return tNow(`The contract rejected the transaction: ${firstLine(revert.reason)}`, `合约拒绝了这笔交易：${firstLine(revert.reason)}`);
      if (revert.reason) return NETWORK_TROUBLE();
    }
    if (e.name === "UserRejectedRequestError" || /rejected|denied/i.test(e.shortMessage)) return tNow("You cancelled the request in your wallet. Nothing was sent.", "你在钱包中取消了请求。没有发送任何内容。");
    if (/insufficient funds/i.test(e.shortMessage)) return tNow(`Your wallet needs a little${IS_TESTNET ? " testnet" : ""} ETH for gas.`, `你的钱包需要少量${IS_TESTNET ? "测试网 " : ""} ETH 支付 Gas。`);
    if (/exceeds balance|transfer amount exceeds/i.test(e.message)) return tNow("Your balance is lower than the amount.", "你的余额低于该金额。");
    return noisy(e.shortMessage) ? NETWORK_TROUBLE() : firstLine(e.shortMessage);
  }
  return e instanceof Error ? (noisy(e.message) ? NETWORK_TROUBLE() : firstLine(e.message)) : tNow("The transaction could not be sent.", "无法发送这笔交易。");
}
