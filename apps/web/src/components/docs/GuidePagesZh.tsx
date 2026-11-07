/**
 * The guide pages of /docs in Simplified Chinese. They mirror GuidePages.tsx section for section,
 * with the same anchors, so links into a page work in either language. 繁體 comes from useZh().
 */
import { Link } from "@tanstack/react-router";
import { API_URL, IS_TESTNET, manifest } from "../../lib/config";
import { useZh } from "../../lib/i18n";
import { CaChip } from "../CaChip";
import { Calc, Callout, Cards, C, Code, CodeTabs, DocCard, Icon, Section, Step, Steps, Table } from "./Kit";
import { LiveStatus, LiveTemplates, SDK_TARBALL, clientLine, origin } from "./GuidePages";

// ------------------------------------------------------------------ docs home

export function DocsHome() {
  const z = useZh();
  return z(
    <div className="dk-home">
      <header className="dk-hero">
        <h1>Curveil 文档</h1>
        <p>
          在公开资金池中交易、发行代币、运营自己的发射台、在金库中私密持有资产，以及开立杠杆仓位。了解每个部分如何运作，或使用 SDK 和 API 在其上构建。
        </p>
        <div className="dk-hero-actions">
          <Link to="/docs" search={{ page: "quickstart" }} className="btn btn-primary">快速上手 <span aria-hidden="true">→</span></Link>
          <Link to="/docs" search={{ page: "api" }} className="btn">API 参考</Link>
        </div>
      </header>

      <CodeTabs
        tabs={[
          { label: "安装", lang: "sh", code: `npm install viem ${origin()}${SDK_TARBALL}` },
          {
            label: "读取发行列表",
            code: `import { createClient } from "@curveil/sdk";

const curveil = ${clientLine};
const { launches } = await curveil.launches({ sort: "volume", limit: 3 });

for (const l of launches) console.log(l.symbol, l.state);`,
          },
          { label: "curl", lang: "sh", code: `curl "${API_URL}/v1/launches?sort=volume&limit=3"` },
        ]}
      />

      <Section title="使用场景" id="use-cases">
        <Cards>
          <DocCard page="markets" icon={<Icon name="pool" />} title="提供流动性">从 DLMM 价格区间或全区间 DAMM 资金池赚取手续费。</DocCard>
          <DocCard page="swap" icon={<Icon name="swap" />} title="兑换代币">在两类资金池之间路由，并按你设定的最低值成交。</DocCard>
          <DocCard page="launch" icon={<Icon name="launch" />} title="发行代币">从联合曲线起步，毕业后进入锁定的资金池。</DocCard>
          <DocCard page="launchpad-guide" icon={<Icon name="pad" />} title="运营发射台">在共享的发行合约上使用你的品牌并获得手续费分成。</DocCard>
          <DocCard page="vault" icon={<Icon name="vault" />} title="使用隐私金库">通过隐私票据持有、转账和交易。</DocCard>
          <DocCard page="perps" icon={<Icon name="perps" />} title="交易永续合约">ETH 和 BTC 最高 5 倍，SOL 最高 2 倍，逐仓保证金。</DocCard>
        </Cards>
      </Section>

      <Section title="在 Curveil 上构建" id="build-on-curveil">
        <Cards>
          <DocCard page="quickstart" icon={<Icon name="code" />} title="快速上手">几分钟内安装 SDK 并发出第一个调用。</DocCard>
          <DocCard page="api" icon={<Icon name="api" />} title="API 参考">每个接口的参数和返回值。</DocCard>
          <DocCard page="contracts" icon={<Icon name="contract" />} title="合约">本网络上的地址、源代码和验证情况。</DocCard>
          {IS_TESTNET && <DocCard page="testnet" icon={<Icon name="faucet" />} title="测试网工具">测试代币和金库广播器。</DocCard>}
          <DocCard page="fees" icon={<Icon name="fees" />} title="费用">谁支付什么，附计算示例。</DocCard>
          <DocCard page="risks" icon={<Icon name="risk" />} title="风险">使用前先了解可能出现的问题。</DocCard>
        </Cards>
      </Section>

      <div className="dk-cta">
        <div>
          <h2>获取 API 密钥</h2>
          <p>不使用密钥也可以读取数据，上限为每分钟 300 次请求。用钱包登录即可创建密钥，上限提高到每分钟 3,000 次。</p>
        </div>
        <Link to="/app/profile" search={{ tab: "developer", sub: "keys" }} className="btn btn-primary">创建密钥 <span aria-hidden="true">→</span></Link>
      </div>

      <LiveStatus
        title="已上线的功能"
        lead={IS_TESTNET
          ? "所有功能都运行在测试网上，使用没有价值的测试代币。标注为“拟定”的数值是计划中的设置，而不是当前部署的数值。"
          : "市场、代币发行、发射台、永续合约和隐私金库已在 Robinhood Chain 上线。它们尚未经过独立审计，每笔金库存款都设有上限。这里没有标注为已上线的功能目前都不可用。"}
      />
    </div>,
  );
}

// ------------------------------------------------------------------ markets

export function MarketsGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="两种资金池" id="two-kinds-of-pools">
        <p className="dk-p">Curveil 上的每个资金池都属于以下两种之一。两者都是公开的，任何人都可以与之交易或添加流动性。</p>
        <Table
          head={["", "DLMM", "DAMM"]}
          rows={[
            ["形态", "流动性分布在独立的价格区间中", "一条全区间曲线，x × y = k"],
            ["你可以选择", "资金覆盖哪些价格区间", "只需选择添加多少"],
            ["手续费归属", "正在被交易的区间中的流动性", "所有提供者，按份额分配"],
            ["适合", "把资金集中在你预期的价格附近", "设置后无需打理，任何价格都有效"],
          ]}
        />
      </Section>

      <Section title="DLMM 区间如何定价" id="how-dlmm-bins-are-priced">
        <p className="dk-p">
          每个区间都有固定价格。区间 <C>i</C> 的价格为 <C>Pᵢ = P₀ × (1 + s)ⁱ</C>，其中 <C>P₀</C> 是资金池的初始价格，<C>s</C> 是区间步长。
          只有包含当前价格的区间会发生交易，因此此刻只有该区间中的流动性在赚取手续费。
        </p>
        <Callout kind="example" title="以 1.00 USDG 为中心、步长 0.25% 的区间">
          <Calc
            rows={[
              ["区间 −4", "1.00 × 1.0025⁻⁴ = 0.9901"],
              ["区间 0", "1.0000"],
              ["区间 +4", "1.00 × 1.0025⁴ = 1.0100"],
            ]}
          />
          <p>分布在区间 −4 到 +4 的流动性，在价格保持在约 0.99 到 1.01 之间时赚取手续费，超出该范围则处于闲置状态。</p>
        </Callout>
        <p className="dk-p">各区间是相互独立的权益，从不合并。当价格穿过你的区间时，你的仓位会从一种资产转换为另一种资产。</p>
      </Section>

      <Section title="DAMM 手续费如何变动" id="how-the-damm-fee-moves">
        <p className="dk-p">DAMM 资金池收取 <C>min(最高费率, 基础费率 + 波动部分)</C>。价格快速变动时费率上升，之后会回落。</p>
        <Callout kind="example" title="基础费率 0.30%，最高 1.00%">
          <Calc
            rows={[
              ["平静市场，波动 0.00%", "0.30%"],
              ["活跃市场，波动 0.15%", "0.45%"],
              ["剧烈波动，波动 0.90%", "1.00%（封顶）"],
            ]}
          />
        </Callout>
      </Section>

      <Section title="创建资金池" id="create-a-pool">
        <Steps>
          <Step title="选择资产">打开<Link to="/app/pools/new">创建资金池</Link>，选择两种准入资产。资产列表见<Link to="/docs" search={{ page: "assets" }}>准入资产</Link>。</Step>
          <Step title="选择类型">选择 DLMM 并使用一个已启用的区间步长（每个步长都有对应费率），或选择 DAMM。资金池创建后这些设置无法更改。</Step>
          <Step title="设置初始价格">DLMM 由你输入初始价格，资金池从对应的区间开始。DAMM 则由首笔存入的比例决定价格。确认前请与其他市场核对价格。</Step>
          <Step title="添加流动性">之后随时可以在资金池页面通过<strong>添加流动性</strong>追加。</Step>
        </Steps>
        <Callout kind="warn">
          资金池存在并不代表代币安全。弹性供应（rebasing）、转账收费以及其他会改变余额的代币不被接受，因为资金池无法正确记账。
        </Callout>
      </Section>
    </>,
  );
}

// ------------------------------------------------------------------ swaps

export function SwapGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="路由如何确定" id="how-a-route-is-found">
        <p className="dk-p">
          路由器会在 DLMM 和 DAMM 资金池中查找直接路径和两跳路径，并报出扣除手续费后输出最多的那一条。两跳路径会经过一个中间资产，例如 WETH → USDG → 某个新发行的代币。
        </p>
      </Section>

      <Section title="滑点与最低到账" id="slippage-and-the-minimum-you-receive">
        <p className="dk-p">
          从报价到交易上链之间，价格可能发生变化。你设定一个容差，如果兑换的输出低于 <C>floor(预期输出 × (1 − 容差))</C>，交易就会回滚。
        </p>
        <Callout kind="example" title="以 0.5% 容差卖出 0.3 WETH">
          <Calc rows={[["报价输出", "1,000.00 USDG"], ["容差", "0.5%"]]} total={["最低到账", "995.00 USDG"]} />
          <p>如果价格变动导致兑换只能得到 994.99 USDG 或更少，交易会回滚，你保留 WETH，仅损失 Gas 费。</p>
        </Callout>
        <Callout kind="note">滑点限制并不能消除所有排序或 MEV 风险。参考价格仅供参考，你实际收到多少只取决于可执行的报价。</Callout>
      </Section>

      <Section title="用代码兑换" id="swap-from-code">
        <p className="dk-p">
          SDK 会构建路由器调用。传入路径的每一跳、输入数量和最低输出，在授权路由器使用输入代币后，用任意钱包库发送交易即可。
        </p>
        <Code>{`import { approveTx, swapExactInTx, withSlippage } from "@curveil/sdk";

const m = await curveil.manifest();
const router = m.contracts.CurveilRouter.address;

await wallet.sendTransaction(approveTx(weth, router, amountIn));
await wallet.sendTransaction(swapExactInTx({
  router,
  hops: [{ pool, tokenIn: weth, tokenOut: usdg }],
  amountIn,
  minOut: withSlippage(expectedOut, 50),   // 50 bps = 0.5%
  to: user,
}));`}</Code>
      </Section>
    </>,
  );
}

// ------------------------------------------------------------------ vault

export function VaultGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="哪些信息保持私密" id="what-stays-private">
        <p className="dk-p">
          存入隐私会把一种准入资产变成一张加密票据，只有你的 Curveil 账户能打开。在你设备上生成的零知识证明负责花费旧票据并创建新票据。链上会验证证明，但无从得知票据属于谁。
        </p>
        <Table
          head={["", "链上公开", "私密"]}
          rows={[
            ["存款（存入隐私）", "存款人、资产、金额、时间", "变成了哪张票据"],
            ["私密转账", "发生了一笔转账及其时间", "发送方、接收方和金额"],
            ["隐私兑换或永续合约", "市场操作及其金额", "由哪个账户支付、谁持有结果"],
            ["提款", "收款人、资产、金额、时间", "由哪些票据支付"],
            ["余额", "无", "每个账户的余额"],
          ]}
        />
      </Section>

      <Section title="使用金库" id="use-the-vault">
        <Steps>
          <Step title="创建你的 Curveil 账户">
            打开<Link to="/app/vault">金库</Link>。你会得到一个独立于钱包的恢复短语。请把它抄写下来，并保存加密备份。
          </Step>
          <Step title="存入隐私">从钱包存入一种准入资产。存款是公开的，但它生成的票据不是。{!IS_TESTNET && "在主网上，金库接受 USDG 和 WETH（或 ETH，网站会自动包装），在未审计期间每笔存款上限为 1,000 USDG 或 0.5 ETH。"}</Step>
          <Step title="私密使用">转账给其他 Curveil 账户、兑换或添加流动性，全部从你的票据中支付{IS_TESTNET ? "，也可以为永续合约仓位提供资金" : ""}。</Step>
          <Step title="提取">把任意金额发送到任意地址。提款手续费为 0.10%。</Step>
        </Steps>
        <Callout kind="example" title="提取 1,000 USDG">
          <Calc rows={[["金额", "1,000.00 USDG"], ["提款手续费 0.10%", "−1.00 USDG"]]} total={["收款人到账", "999.00 USDG"]} />
          <p>如果由广播器替你发送交易，它的费用也会显示出来，并同样从票据中扣除。</p>
        </Callout>
        <Callout kind="tip" title="避免暴露关联">
          在存款后不久，把与存款完全相同的金额提到同一个地址，很容易让人猜出其中的关联。等待一段时间并使用常见的整数金额会有帮助。
        </Callout>
      </Section>

      <Section title="保护好你的账户" id="keep-your-account-safe">
        <Callout kind="warn">
          如果同时丢失恢复短语和备份，资金可能永久丢失。任何人（包括 Curveil）都无法找回。Curveil 永远不会向你索要钱包助记词。
        </Callout>
      </Section>
    </>,
  );
}

// ------------------------------------------------------------------ launches

export function LaunchGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="发行如何运作" id="how-a-launch-works">
        <p className="dk-p">
          发行从联合曲线开始：有人买入时价格上涨，卖出时价格下跌。募集到足够金额后，代币毕业进入一个公开的 DAMM 资金池，曲线随即关闭。每次发行都使用在交易开始前就已固定的版本化模板。
        </p>
        <Table
          head={["所有模板", "数值"]}
          rows={[
            ["总供应量", "1,000,000,000"],
            ["在曲线上出售", "800,000,000"],
            ["毕业时留给资金池", "200,000,000"],
            ["曲线手续费", "1%，创建者和协议各得一半"],
          ]}
        />
        <LiveTemplates />
      </Section>

      <Section title="毕业进度" id="graduation-progress">
        <p className="dk-p">进度为 <C>min(100%, 净储备 ÷ 门槛)</C>。手续费不计入，每一笔卖出都会让进度回落。</p>
        <Callout kind="example" title="完成一半">
          <Calc rows={[["扣除手续费后买入的 USDG", "15,000"], ["卖出换回的 USDG", "−2,500"]]} total={["净储备", "12,500 ÷ 25,000 = 50%"]} />
        </Callout>
      </Section>

      <Section title="毕业时会发生什么" id="what-happens-at-graduation">
        <Steps>
          <Step title="曲线交易停止">达到门槛的那笔买入就是最后一笔。</Step>
          <Step title="任何人都可以触发迁移">储备和预留的 200,000,000 枚代币进入一个新的 DAMM 资金池。</Step>
          <Step title="资金池的 LP 被锁定">创建者的 20% 锁定 180 天，协议的 80% 锁定 365 天。</Step>
        </Steps>
        <Callout kind="note">锁仓限制的是资金池流动性的提取，并不保证代币的价格或质量。</Callout>
      </Section>

      <Section title="用代码在曲线上买入" id="buy-on-a-curve-from-code">
        <p className="dk-p">先报价，再带上最低数量发送买单，这样价格变动时成交也不会差于你接受的水平。</p>
        <Code>{`import { approveTx, buyTx, quoteBuy, withSlippage } from "@curveil/sdk";
import { parseUnits } from "viem";

const quoteIn = parseUnits("100", 6);                   // 100 USDG
const { tokensOut, fee } = await quoteBuy(chain, curve, quoteIn);   // fee = 1 USDG

await wallet.sendTransaction(approveTx(usdg, curve, quoteIn));
await wallet.sendTransaction(buyTx({ curve, quoteIn, minTokensOut: withSlippage(tokensOut, 100), to: user }));`}</Code>
      </Section>
    </>,
  );
}

export function LaunchpadsGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="什么是发射台" id="what-a-launchpad-is">
        <p className="dk-p">
          发射台是在 <C>LaunchpadRegistry</C> 合约上注册的一个品牌和一份手续费分成，无需部署任何合约。通过它发行的代币使用与其他所有发行相同的模板、曲线、毕业规则和 LP 托管，因此对交易者来说规则处处相同。
        </p>
      </Section>
      <Section title="发射台如何赚钱" id="how-a-launchpad-earns">
        <p className="dk-p">
          发射台从每笔曲线手续费中协议的那一半里分得一部分，不超过协议上限。创建者的份额保持不变。每个代币在创建时就固定了分成比例，所以之后的调整不会影响已发行的代币。
        </p>
        <Callout kind="example" title="标准模板下 25% 的分成">
          <Calc
            rows={[
              ["你的代币在曲线上的交易额", "10,000 USDG"],
              ["曲线手续费 1%", "100 USDG"],
              ["创建者的一半", "50 USDG"],
              ["协议的一半", "50 USDG"],
            ]}
            total={["你从协议那一半中分得 25%", "12.50 USDG"]}
          />
        </Callout>
      </Section>
      <Cards cols={2}>
        <DocCard page="launchpad-guide" icon={<Icon name="pad" />} title="运营发射台">一步步完成注册、搭建网站和领取手续费。</DocCard>
        <DocCard page="quickstart" icon={<Icon name="code" />} title="快速上手">安装 SDK 并发出第一个调用。</DocCard>
      </Cards>
    </>,
  );
}

// ------------------------------------------------------------------ perps

export function PerpsGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="运作方式" id="how-it-works">
        <p className="dk-p">
          永续合约跟踪 ETH、BTC 或 SOL 的价格，没有到期日。你存入 USDG 作为保证金并选择杠杆。每个仓位有独立的保证金（逐仓），因此一个仓位的亏损不会影响另一个。交易者与流动性金库对手交易，由金库承担另一方。
        </p>
        <Table
          head={[IS_TESTNET ? "测试网设置" : "设置", "数值"]}
          rows={[
            ["市场", "ETH-USD、BTC-USD、SOL-USD"],
            ["保证金", "USDG，每个仓位逐仓"],
            ["杠杆", "ETH 和 BTC 最高 5 倍，SOL 最高 2 倍"],
            ["开仓和平仓手续费", "各为仓位规模的 0.08%"],
            ["维持保证金", "仓位规模的 2.00%"],
            ["强平费", "仓位规模的 0.50%"],
            ["单个仓位最大盈利", "仓位规模的 100%"],
          ]}
        />
        <p className="dk-p small"><Link to="/app/perps">永续合约页面</Link>会显示每个市场的实时数值。</p>
      </Section>

      <Section title="计算示例" id="a-worked-example">
        <p className="dk-p">你在 3,000 以 100 USDG 保证金、3 倍杠杆做多 ETH。开仓手续费从保证金中扣除，所以仓位规模略低于 300。</p>
        <Callout kind="example" title="做多 ETH，100 USDG，3 倍，开仓价 3,000">
          <Calc
            rows={[
              ["仓位规模", "100 × 3 ÷ (1 + 3 × 0.08%) = 299.28 USDG"],
              ["开仓手续费 0.08%", "0.24 USDG"],
              ["扣费后保证金", "99.76 USDG"],
              ["强平价格", "约 2,062"],
            ]}
          />
          <p>如果 ETH 上涨 10% 到 3,300 后平仓，你盈利 29.93 USDG，并支付 0.24 USDG 平仓手续费（仓位规模的 0.08%），在计算资金费前约拿回 129.45 USDG。</p>
        </Callout>
        <p className="dk-p">
          强平价格是扣费后保证金跌到维持保证金加平仓手续费时的价格。杠杆越高，强平价离开仓价越近：同样的交易用 5 倍杠杆，强平价在 2,460 附近。
        </p>
      </Section>

      <Section title="资金费" id="funding">
        <p className="dk-p">
          当一方的持仓多于另一方时，较大的一方每小时按仓位规模向较小的一方支付资金费，从而让多空持仓重新趋于平衡。双方持仓相等或市场无人持仓时，无人支付。
        </p>
      </Section>

      <Section title="订单、止盈和止损" id="orders-take-profit-and-stop-loss">
        <p className="dk-p">
          你提交一个请求，执行者（keeper）会以下一个签名价格成交，通常在几秒内完成，且绝不会差于你的滑点限制。止盈和止损订单会在价格到达时自动平仓。
        </p>
      </Section>

      <Section title="价格与安全" id="prices-and-safety">
        <p className="dk-p">
          {manifest.perps?.priceSource === "curveil-test-signer"
            ? "测试网价格取四家交易所的中位数，由 Curveil 测试密钥签名。过时或不一致的价格会阻止开新仓。"
            : `价格来自独立的预言机网络 Pyth，并由 Pyth 合约在链上校验${IS_TESTNET ? "" : "，同时与 Chainlink 参考价格比对"}。你的请求按发送之后的第一个 Pyth 价格成交，因此没有人能挑选更好或更差的价格。过时或不确定的价格会阻止开新仓。`}
        </p>
        <Callout kind="warn">
          隐私保证金隐藏的是资金来源，但仓位的规模、方向和强平都是公开的，强平规则同样适用。
        </Callout>
      </Section>
    </>,
  );
}

// ------------------------------------------------------------------ token, fees, risks

export function TokenGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="拟定设计" id="proposed-design">
        <Table
          head={["", "拟定"]}
          rows={[
            ["标准", "ERC-20，18 位小数"],
            ["最大供应量", "1,000,000,000，不再增发"],
            ["转账税", "0%"],
            ["预售或团队分配", "无"],
            ["供应如何进入市场", "通过公开发行机制"],
          ]}
        />
      </Section>
      <Section title="它不是什么" id="what-it-is-not">
        <p className="dk-p">
          该代币不代表股权、存款或有保证的收益。回购并不保证价格上涨。核心权利（例如提取隐私资产）永远不需要持有该代币。
        </p>
        {manifest.token.address ? (
          <Callout kind="note">
            $CURVEIL 已上线。合约地址：<CaChip />
          </Callout>
        ) : (
          <Callout kind="note">$CURVEIL 的任何部分都尚未上线。本页内容均为提案。</Callout>
        )}
      </Section>
    </>,
  );
}

const FEES: [string, string, string][] = [
  ["标准公开资金池", "基础 0.30%", "80% 给流动性提供者，20% 给协议"],
  ["动态资金池费率上限", "1.00%", "分配方式相同"],
  ["路由器", "0%", "无"],
  ["联合曲线交易", "1.00%", "50% 给创建者，50% 给协议（部分给发射台）"],
  ["存入隐私", "0%", "无"],
  ["私密转账", "0%", "无（广播器可能收取 Gas 费）"],
  ["从金库提款", "0.10%", "协议"],
  ["隐私兑换", "仅资金池费用", "与资金池相同"],
  ["永续合约开仓或平仓", "仓位规模的 0.08%", "流动性金库，部分给协议"],
];

export function FeesGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="所有费用" id="every-fee">
        <p className="dk-p">{IS_TESTNET ? "以下费用均为拟定。" : "以下是主网合约目前收取的费用。"}Gas 费、广播器费用和资金费另计，每次报价在你确认前都会显示完整的费用明细。</p>
        <Table head={["操作", "费用", "收取方"]} rows={FEES} />
      </Section>
      <Section title="示例" id="examples">
        <Callout kind="example" title="在 0.30% 的资金池中兑换 1,000 USDG">
          <Calc rows={[["手续费 0.30%", "3.00 USDG"], ["给流动性提供者 80%", "2.40 USDG"], ["给协议 20%", "0.60 USDG"]]} />
        </Callout>
        <Callout kind="example" title="在曲线上买入价值 100 USDG 的代币">
          <Calc rows={[["手续费 1.00%", "1.00 USDG"], ["给创建者", "0.50 USDG"], ["给协议", "0.50 USDG"]]} total={["用于购买代币", "99.00 USDG"]} />
        </Callout>
        <Callout kind="example" title="开仓并平仓一个 300 USDG 的永续合约">
          <Calc rows={[["开仓 0.08%", "0.24 USDG"], ["以相同价格平仓 0.08%", "0.24 USDG"]]} total={["一来一回", "0.48 USDG 加资金费"]} />
        </Callout>
      </Section>
    </>,
  );
}

const RISKS: [string, string][] = [
  [
    "代码可能出错",
    IS_TESTNET
      ? "智能合约和密码学漏洞可能导致资金损失。主网上线前计划进行独立审计，目前尚未完成。"
      : "智能合约漏洞可能导致资金损失。目前上线的合约尚未经过独立审计，请只投入你能承受损失的金额。",
  ],
  ["价格会波动", "市场价格变化很快。提供流动性的价值可能低于直接持有这两种资产。"],
  ["杠杆是双刃剑", "杠杆仓位可能被强平，包括由金库出资的仓位。"],
  ["隐私有边界", "存入隐私并不会让市场操作、存款、提款或它们的时间变得私密。"],
  ["恢复靠你自己", "丢失金库恢复短语和备份可能导致资金无法找回。"],
  [
    "发行方保留控制权",
    "USDG 的发行方可以冻结任何地址、暂停转账、增发，并且可以修改代币代码，因为它是可升级合约。Robinhood Chain 上的 WETH 也是跨链桥接的可升级代币。如果发行方冻结了某个资金池、曲线或金库，该资产在解冻前都无法在那里转移，Curveil 也无法推翻。",
  ],
  ["管理变更会延迟，但并非不可能", "Curveil 的合约由一个 72 小时时间锁持有，时间锁由 3/3 多签控制，因此三位签名人必须一致同意。每项变更在生效前都会公开，且都无法挪用用户资金，但你仍应在透明度页面关注变更队列。"],
  ["服务可能中断", "预言机、RPC 提供商和广播器可能出现故障或延迟。"],
];

export function RisksGuide() {
  const z = useZh();
  return z(
    <>
      <Callout kind="warn">
        {IS_TESTNET
          ? "Curveil 是运行在测试网上的实验性软件。上线主网后，请不要投入你无法承受损失的资金。"
          : "Curveil 是新软件。请不要投入你无法承受损失的资金。"}
      </Callout>
      <Section title="主要风险" id="main-risks">
        <div className="dk-risks">
          {RISKS.map(([t, d]) => (
            <div key={t}>
              <h3>{t}</h3>
              <p>{d}</p>
            </div>
          ))}
        </div>
        <p className="small muted">Curveil 与 Robinhood 无关联，也未获其认可。</p>
      </Section>
    </>,
  );
}

// ------------------------------------------------------------------ get started

export function GetStartedGuide() {
  const z = useZh();
  const usdgCap = IS_TESTNET ? "" : "在 Curveil 未经审计期间，每笔存款上限为 1,000 USDG 或 0.5 ETH。";
  return z(
    <>
      <Section title="开始之前" id="before-you-start">
        <ul className="dk-list">
          <li>一个钱包（例如 MetaMask），并连接到 <strong>Robinhood Chain</strong>。</li>
          <li>少量 <strong>ETH</strong> 用作 Gas 费。手续费很低，一点就够用很久。</li>
          <li>你想使用的资产。USDG 是永续合约保证金使用的美元稳定币。</li>
        </ul>
      </Section>

      <Section title="操作步骤" id="the-steps">
        <Steps>
          <Step title="1. 连接钱包并选择模式">
            <p className="dk-p">点击页头的 <C>连接钱包</C>。旁边的 <C>公开 / 隐私</C> 开关决定兑换、流动性和永续合约由哪里付款。</p>
            <Table
              head={["模式", "付款来源", "谁能看到"]}
              rows={[
                ["公开", "你的钱包", "所有人都能看到是你的钱包完成了交易，和任何交易所一样。"],
                ["隐私", "你的隐私金库", "交易可见，但看不到是谁付的款。需要一个有余额的金库账户（第 6 步）。"],
              ]}
            />
          </Step>

          <Step title="2. 兑换代币">
            <p className="dk-p">
              打开<Link to="/app/swap">兑换</Link>，选择支付和获得的代币，输入金额。签名前你会看到路由、预期输出、最低到账、手续费和价格影响。第一次使用某个代币时，钱包会要求额外授权一次。
            </p>
            <Callout kind="note">请保持较低的滑点。超过 3% 时，交易可能以差得多的价格成交。</Callout>
          </Step>

          <Step title="3. 添加流动性并赚取手续费">
            <p className="dk-p">
              打开<Link to="/app/pools">资金池</Link>，选择一个资金池并点击 <C>添加流动性</C>。你的仓位会显示其价值和未领取的手续费，你可以随时领取或撤出。
            </p>
            <ul className="dk-list">
              <li><strong>DAMM</strong> 资金池很简单：你的流动性在任何价格下都能赚取收益。</li>
              <li><strong>DLMM</strong> 资金池让你选择价格区间。价格在区间内时收益更高，区间外则没有收益。</li>
            </ul>
          </Step>

          <Step title="4. 发行代币">
            <p className="dk-p">
              打开<Link to="/app/launch">代币发行</Link>并点击 <C>创建代币</C>。选择交易对（USDG 或 ETH）和规模，再填写名称和代号，这两项永远无法修改。代币创建后立即可以交易。
            </p>
            <ul className="dk-list">
              <li><strong>联合曲线：</strong>10 亿总供应量中的 80% 在曲线上出售。买入越多，价格越高。每笔交易收取 1% 手续费，其中一半归创建者。</li>
              <li><strong>毕业：</strong>曲线募集到目标金额后，储备和剩余 20% 的代币进入一个普通的 DAMM 资金池，代币随后在兑换页面交易。</li>
              <li><strong>锁定流动性：</strong>资金池的流动性锁定 180 天（创建者）和 365 天（协议）。</li>
            </ul>
          </Step>

          <Step title="5. 交易永续合约">
            <p className="dk-p">
              打开<Link to="/app/perps">永续合约</Link>并选择市场：ETH 或 BTC 最高 5 倍，SOL 最高 2 倍。选择做多或做空、USDG 保证金和杠杆，提交前请检查强平价格。价格来自 Pyth，并在链上校验。
            </p>
            <ul className="dk-list">
              <li>你的订单是一个请求，由执行者以下一个价格成交，通常在几秒内完成。如果价格越过了你的限制，保证金会退回。</li>
              <li>你可以追加保证金、设置止盈或止损，以及全部或部分平仓。</li>
              <li>资金费每小时支付或收取一次。如果保证金跌到维持水平，仓位会被强平。</li>
            </ul>
            <Callout kind="note">如果想作为对手方赚取收益，可以在永续合约页面的 <C>提供流动性</C> 中存入 USDG。它能赚取大部分交易手续费，并承担每笔交易的对手方。</Callout>
          </Step>

          <Step title="6. 使用金库进入隐私模式">
            <p className="dk-p">
              打开<Link to="/app/vault">金库</Link>并点击 <C>创建账户</C>。按顺序抄写 24 个单词的恢复短语，并为这个浏览器设置一个密码。恢复短语独立于你的钱包；丢失它可能导致隐私资金丢失。
            </p>
            <ul className="dk-list">
              <li><strong>存入隐私：</strong>从钱包存入一种资产。存款是公开的；之后你用它做什么则不公开。{usdgCap}</li>
              <li><strong>私密转账：</strong>粘贴对方的 <C>cvl1…</C> 地址并点击 <C>生成证明并发送</C>。你的浏览器会生成零知识证明，因此发送方、接收方和金额都保持隐藏。</li>
              <li><strong>提取：</strong>发送到任意公开地址。没人能把它和你的存款联系起来。</li>
              <li><strong>私密交易：</strong>把页头开关切换到隐私，然后像平常一样使用兑换、资金池或永续合约。</li>
            </ul>
            <Callout kind="note">在新设备上，选择 <C>恢复账户</C> 并输入 24 个单词或备份文件，金库就会重新找到你的资金。</Callout>
          </Step>
        </Steps>
      </Section>

      <Section title="哪些信息保持私密" id="what-stays-private">
        <Table
          head={["操作", "所有人可见", "保持私密"]}
          rows={[
            ["公开兑换、资金池、发行或永续合约交易", "全部信息，包括你的钱包", "无"],
            ["存入隐私（存款）", "你的钱包、资产和金额", "之后你用它做什么"],
            ["私密转账", "发生了一笔转账", "发送方、接收方和金额"],
            ["隐私兑换、资金池或永续合约", "交易及其规模", "谁付的款、谁持有结果"],
            ["提取", "收款人和金额", "来自哪笔存款"],
          ]}
        />
        <Callout kind="note">Curveil 尚未经过独立审计。请从你能承受损失的金额开始，并阅读<Link to="/docs" search={{ page: "risks" }}>风险</Link>说明。</Callout>
      </Section>
    </>,
  );
}
