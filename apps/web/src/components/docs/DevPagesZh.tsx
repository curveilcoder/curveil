/**
 * The developer pages of /docs in Simplified Chinese, mirroring DevPages.tsx. Code samples are
 * shared with the English pages, so they never drift apart. 繁體 comes from useZh().
 */
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Sk } from "../Skeleton";
import { Faucet } from "../Faucet";
import { ApiReference } from "../ApiReference";
import { API_URL, BROADCASTER_URL, EXAMPLE_URL, IS_TESTNET, explorerAddress, manifest, shortAddress } from "../../lib/config";
import { api } from "../../lib/launchpads";
import { fmtBps } from "../../lib/format";
import { useZh } from "../../lib/i18n";
import { Callout, C, Code, CodeTabs, Section, Step, Steps } from "./Kit";
import {
  API_TABS, BROADCAST_ENDPOINTS, COLLECT_CODE, ERRORS_JSON, INSTALL_TABS, LAUNCH_CODE, READ_TABS, REGISTER_CODE, SITE_CODE, SLUG_CODE, WEBHOOK_CODE,
} from "./DevPages";

const BROADCAST_ZH: Record<string, string> = {
  "/v1/broadcast/info": "广播器地址、Gas 余额、健康状况、各资产的费用、各操作的费用倍数、支持转发的适配器，以及它能看到的信息",
  "/v1/broadcast/quote": "需要绑定到转账、提款或隐私执行中的费用和收费地址",
  "/v1/broadcast/submit": "校验、模拟并发送绑定证明的转账、提款或隐私执行（兑换、添加或撤出流动性）",
  "/v1/broadcast/:id": "已提交、已确认、失败或已丢弃，并附交易哈希",
};

export function ApiGuide() {
  const z = useZh();
  return z(
    <>
      <Section title="基础 URL" id="base-url">
        <p className="dk-p">所有接口都在同一个基础 URL 下，并返回 JSON。完整的 OpenAPI 3.1 规范位于 <a href={`${API_URL}/v1/openapi.json`} target="_blank" rel="noreferrer"><C>/v1/openapi.json</C></a>，任何客户端生成器都可以使用。</p>
        <Code lang="txt" title="基础 URL">{API_URL}</Code>
      </Section>
      <Section title="认证与限额" id="authentication-and-limits">
        <p className="dk-p">
          读取接口无需密钥，每个 IP 每分钟可请求 300 次。以 Bearer Token 方式发送 <Link to="/app/profile" search={{ tab: "developer", sub: "keys" }}>API 密钥</Link>可提高到 3,000 次。每个响应都会在 <C>X-RateLimit-Limit</C> 和 <C>X-RateLimit-Tier</C> 中说明适用的限额。
        </p>
        <CodeTabs tabs={API_TABS} />
        <Callout kind="warn">请把密钥保存在你的服务器上。放在浏览器代码里的密钥，任何打开你网站的人都能复制。</Callout>
      </Section>
      <Section title="错误" id="errors">
        <p className="dk-p">错误使用标准 HTTP 状态码，响应体中包含稳定的错误代码和可读的说明。收到 429 时，请等待 <C>Retry-After</C> 中给出的秒数。</p>
        <Code lang="json" title="429 Too Many Requests">{ERRORS_JSON}</Code>
      </Section>
      <Section title="接口" id="endpoints">
        <div className="panel"><ApiReference /></div>
      </Section>
    </>,
  );
}

export function Quickstart() {
  const z = useZh();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return z(
    <>
      <Section title="开始之前" id="before-you-start">
        <p className="dk-p">
          你需要 Node 18 或更高版本（或浏览器、Worker、Deno、Bun），以及一个持有{IS_TESTNET ? "测试代币" : "少量 ETH 作为 Gas"}的钱包，用于需要发送交易的步骤。{IS_TESTNET && <>可以在<Link to="/docs" search={{ page: "testnet" }}>测试网工具</Link>中领取。</>}
        </p>
      </Section>
      <Section title="构建你的第一个集成" id="steps">
        <Steps>
          <Step title="安装 SDK" id="install-the-sdk">
            <p className="dk-p">
              <C>@curveil/sdk</C> 可在浏览器、Worker、Deno、Bun 和 Node 18+ 中运行，唯一的对等依赖是 <C>viem</C>。在发布到 npm 之前，请安装本站提供的构建版本：
            </p>
            <CodeTabs tabs={INSTALL_TABS(origin)} />
          </Step>

          <Step title="读取数据" id="read-data">
            <p className="dk-p">读取无需密钥（每个 IP 每分钟 300 次请求）。使用 <Link to="/app/profile" search={{ tab: "developer", sub: "keys" }}>API 密钥</Link>可提高到 3,000 次。</p>
            <CodeTabs tabs={READ_TABS} />
          </Step>

          <Step title="在你的发射台上发行代币" id="launch-tokens-on-your-launchpad">
            <p className="dk-p">
              请先<Link to="/docs" search={{ page: "launchpad-guide" }}>注册一个发射台</Link>。SDK 返回适用于任何钱包库的普通 <C>{"{ to, data, value }"}</C> 交易；发行会记录你的发射台及其手续费分成，并在代币的整个生命周期内保持不变。
            </p>
            <Code>{LAUNCH_CODE}</Code>
          </Step>

          <Step title="接收 Webhook" id="receive-webhooks">
            <p className="dk-p">
              在个人资料中<Link to="/app/profile" search={{ tab: "developer", sub: "webhooks" }}>添加一个接收地址</Link>，保管好它的签名密钥，并在信任每次推送之前，先用原始请求体校验签名。
            </p>
            <Code>{WEBHOOK_CODE}</Code>
            <Callout kind="note" title="不使用 SDK 进行校验">
              签名请求头为 <C>Curveil-Signature: t=&lt;unix 秒&gt;,v1=&lt;"t.body" 的十六进制 HMAC-SHA256&gt;</C>。用你的密钥计算同样的 HMAC，以恒定时间比较，并拒绝超过 5 分钟的时间戳。
            </Callout>
          </Step>
        </Steps>
      </Section>
      <Section title="下一步" id="where-to-go-next">
        <ul className="dk-list">
          <li><Link to="/docs" search={{ page: "api" }}>API 参考</Link>，由 <a href={`${API_URL}/v1/openapi.json`} target="_blank" rel="noreferrer" className="mono">/v1/openapi.json</a> 生成（OpenAPI 3.1，可用于任何生成器）。</li>
          <li>合约地址、ABI 和验证信息：<a href={`${API_URL}/v1/manifest/${manifest.network}`} target="_blank" rel="noreferrer" className="mono">/v1/manifest/{manifest.network}</a>，版本 {manifest.version}。</li>
          <li>
            一个完全基于 SDK 构建的完整发射台前端：代码仓库中的 <C>apps/launchpad-example</C>
            {EXAMPLE_URL && <>，在线地址 <a href={EXAMPLE_URL} target="_blank" rel="noreferrer">{EXAMPLE_URL.replace(/^https:\/\//, "")}</a></>}。
          </li>
        </ul>
      </Section>
    </>,
  );
}

const MANAGE: [string, string][] = [
  ["setBrandTx(registry, operator, brandURI)", "名称、标语、主题色、网站和 Logo，仅用于展示。"],
  ["setShareTx(registry, operator, shareBps)", "你的手续费分成，不超过上限。只对之后创建的发行生效。"],
  ["setTemplatesTx(registry, operator, ids)", "你的发射台提供哪些发行模板。只影响新的发行。"],
  ["setActiveTx(registry, operator, false)", "暂停新的发行。已发行的代币继续交易。"],
  ["setRecipientsTx(registry, operator, recipients, tokens)", "谁接收你的手续费。列出的代币中已收到的手续费会先付给原来的收款人。"],
  ["transferAdminTx(registry, operator, next)", "把发射台移交给另一个钱包，该钱包随后发送 acceptAdminTx(registry, operator)。"],
];

export function LaunchpadGuide() {
  const z = useZh();
  const info = useQuery({ queryKey: ["factory"], queryFn: () => api.factory(), staleTime: 30_000 });
  const registry = manifest.contracts.LaunchpadRegistry?.address;
  const launchFactory = manifest.contracts.LaunchFactory?.address;
  const cap = info.data?.maxShareBps;
  return z(
    <>
      <Section title="概览" id="overview">
        <p className="dk-p">
          发射台是在 <C>LaunchpadRegistry</C> 上注册的一个品牌和一份手续费分成，无需部署任何合约：通过它发行的每个代币都使用与 Curveil 其他发行相同的合约，曲线、毕业和 LP 托管完全一致。网站由你搭建和托管，通过它发行的代币，每笔曲线手续费中协议的那部分都会分给你一部分。以下步骤使用 <C>@curveil/sdk</C> 为你构建每笔交易，任何钱包库甚至区块浏览器都可以发送它们。
        </p>
        <dl className="kv">
          <div><dt>LaunchpadRegistry</dt><dd className="mono small">{registry ? <a href={explorerAddress(registry)} target="_blank" rel="noreferrer" title={registry}>{shortAddress(registry)}</a> : "本网络未部署"}</dd></div>
          <div><dt>LaunchFactory</dt><dd className="mono small">{launchFactory ? <a href={explorerAddress(launchFactory)} target="_blank" rel="noreferrer" title={launchFactory}>{shortAddress(launchFactory)}</a> : "本网络未部署"}</dd></div>
          <div><dt>手续费分成上限</dt><dd>{cap !== undefined ? fmtBps(cap) : info.isLoading ? <Sk w="6ch" /> : "–"}</dd></div>
          <div><dt>已注册的发射台</dt><dd>{info.data?.operatorCount ?? (info.isLoading ? <Sk w="3ch" /> : "–")}</dd></div>
        </dl>
      </Section>

      <Section title="开始设置" id="steps">
        <Steps>
          <Step title="选择名称" id="pick-a-name">
            <p className="dk-p">
              名称（slug）是永久的，会出现在链接和 API 中：3 到 32 个字符，只能使用 a-z、0-9 和“-”，且不能以“-”开头或结尾。读取注册表即可查看名称是否可用。
            </p>
            <Code>{SLUG_CODE}</Code>
          </Step>

          <Step title="注册" id="register-it">
            <p className="dk-p">
              只需一笔交易。发送交易的钱包成为发射台的管理员。发射台地址在发送前就能算出，每次发行都会把这个地址记录为其运营方。收款人为 1 到 8 个地址，权重之和为 10,000。
            </p>
            <Code>{REGISTER_CODE}</Code>
            <p className="dk-p">
              分成来自每笔曲线手续费中协议的那部分，并不是额外收费，创建者的份额保持不变。在标准模板下（手续费 1%，一半归创建者），25% 的分成意味着每笔曲线交易的 0.125% 归你的发射台。每次发行在创建时就固定了分成比例，所以之后的调整不会影响已有代币。
            </p>
          </Step>

          <Step title="搭建网站" id="build-the-website">
            <p className="dk-p">
              你的网站从 API 读取自己的设置和发行列表，并发送由 SDK 构建的交易，无需运行索引器。从你的网站发起的发行会把你的发射台地址作为 <C>operator</C> 传入，就像<Link to="/docs" search={{ page: "quickstart" }}>快速上手</Link>的第 3 步那样。
            </p>
            <Code>{SITE_CODE}</Code>
            <ul className="dk-list">
              <li>
                一个只用 SDK 和 viem 构建的完整发射台网站位于 <C>apps/launchpad-example</C>
                {EXAMPLE_URL && <>，在线地址 <a href={EXAMPLE_URL} target="_blank" rel="noreferrer">{EXAMPLE_URL.replace(/^https:\/\//, "")}</a></>}。复制它并设置你的 slug 即可。
              </li>
              <li>
                自定义域名（可选）：用管理员钱包登录，通过 <C>setOperatorProfile({"{ operator, domain }"})</C> 保存，添加 <C>curveil.operator(slug)</C> 返回的 <C>domainSetup.record</C> 中的 DNS TXT 记录，然后调用 <C>verifyDomain(operator)</C>。之后你的网站就可以用 <C>operatorByDomain(location.hostname)</C> 找到自己。
              </li>
              <li><Link to="/app/profile" search={{ tab: "developer", sub: "webhooks" }}>Webhook</Link> 会在代币发行、交易或毕业时通知你的后端。</li>
            </ul>
          </Step>

          <Step title="领取手续费" id="collect-your-fees">
            <p className="dk-p">
              你的手续费累积在每个代币的曲线中。“领取”会把它们转入你的发射台地址并按权重拆分；“释放”会付款给某一个收款人。任何人都可以发送这些交易，而资金只会流向你的收款人。
            </p>
            <Code>{COLLECT_CODE}</Code>
            <p className="dk-p">
              通过其他方式进入发射台地址的手续费，可以用 <C>distributeTx(operator, token)</C> 拆分。
            </p>
          </Step>

          <Step title="修改设置" id="change-settings">
            <p className="dk-p">只有管理员钱包可以发送这些交易。每个辅助函数都由 SDK 导出，并发往注册表合约。</p>
            <div className="table-scroll" tabIndex={0}>
              <table className="data">
                <thead><tr><th>交易</th><th>修改内容</th></tr></thead>
                <tbody>{MANAGE.map(([f, d]) => <tr key={f}><td className="mono">{f}</td><td>{d}</td></tr>)}</tbody>
              </table>
            </div>
            <Callout kind="note" title="任何人都不能修改的内容">
              包括你自己：进行中发行的规则、曲线储备、毕业和 LP 托管，以及支付超过实际收取的金额。协议可以暂停违反条款的发射台；这与暂停的效果相同，会阻止新的发行，并且只有协议能解除。
            </Callout>
          </Step>
        </Steps>
      </Section>
    </>,
  );
}

export function TestnetTools() {
  const z = useZh();
  return z(
    <>
      <Section title="测试代币" id="test-tokens">
        <Faucet />
      </Section>
      <Section title="金库广播器" id="vault-broadcaster">
        <p className="dk-p">
          广播器提交绑定了证明的金库交易，并替你支付 Gas，费用从票据中扣除。它无法更改收款人、金额或费用，也不保留日志。任何人也可以改用自己的钱包提交相同的调用数据。
        </p>
        <Code lang="txt" title="基础 URL">{BROADCASTER_URL}</Code>
        <div className="table-scroll" tabIndex={0}>
          <table className="data">
            <thead><tr><th>方法</th><th>路径</th><th>返回</th></tr></thead>
            <tbody>
              {BROADCAST_ENDPOINTS.map(([m, p, d]) => (
                <tr key={p}>
                  <td className="mono">{m}</td>
                  <td className="mono">{p}</td>
                  <td>{BROADCAST_ZH[p!] ?? d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dk-p">
          金库的构造规范见 <C>docs/vault-spec.md</C>。只需恢复短语和 RPC 节点即可使用的独立客户端位于 <C>packages/vault-core/scripts/vault-cli.ts</C>（指南：<C>docs/vault-alternative-client.md</C>）。
        </p>
      </Section>
    </>,
  );
}
