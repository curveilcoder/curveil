import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Logo } from "./Logo";
import { DitherCanvas, WAVES } from "./Dither";
import { TxToasts } from "./TxToasts";
import { SignInGate } from "./SignInGate";
import { ConnectButton } from "./ConnectButton";
import { manifest } from "../lib/config";
import { FundingSwitch } from "./FundingSwitch";
import { LOCALES, setLocale, useLocale, useT, type Locale } from "../lib/i18n";

type NavLink = readonly [to: string, label: string, hint: string];
type NavItem = { label: string; zh?: string; to?: string; links?: readonly NavLink[]; not?: string; also?: readonly string[]; isActive?: (path: string, search: Record<string, unknown>) => boolean };

function navActive(item: NavItem, path: string, search: Record<string, unknown>): boolean {
  if (item.isActive) return item.isActive(path, search);
  const hit = [item.to!, ...(item.also ?? [])].some((p) => path === p || path.startsWith(p + "/"));
  return hit && !(item.not && path.startsWith(item.not));
}

/** Docs pages for builders: the Developers link owns them, Docs owns the rest. */
const DEV_PAGES = ["quickstart", "api", "launchpad-guide", "testnet"];

const DEV_LINK: NavItem = { label: "Developers", zh: "开发者", to: "/developers", isActive: (path, search) => path.startsWith("/docs") && DEV_PAGES.includes(String(search.page)) };
const DOCS_LINK: NavItem = { label: "Docs", zh: "文档", to: "/docs", isActive: (path, search) => path.startsWith("/docs") && !DEV_PAGES.includes(String(search.page)) };

/** The app's navigation: one direct link per product, so each name says where it goes. */
const APP_NAV: readonly NavItem[] = [
  { label: "Perps", zh: "永续合约", to: "/app/perps" },
  { label: "Swap", zh: "兑换", to: "/app/swap" },
  { label: "Pools", zh: "资金池", to: "/app/pools", also: ["/app/liquidity"] },
  { label: "Launches", zh: "发币", to: "/app/launch" },
  { label: "Vault", zh: "金库", to: "/app/vault" },
];

/** The marketing site's navigation: reading only. The app is one button away. */
const SITE_NAV: readonly NavItem[] = [DOCS_LINK, DEV_LINK];

/** The dApp lives under /app; everything else is the marketing site. */
export const isAppPath = (path: string) => path === "/app" || path.startsWith("/app/");

function NavMenu({ item, pathname, openMenu, setOpenMenu, onNavigate }: {
  item: NavItem & { links: readonly NavLink[] };
  pathname: string;
  openMenu: string | null;
  setOpenMenu: (m: string | null) => void;
  onNavigate: () => void;
}) {
  const expanded = openMenu === item.label;
  const active = item.links.some(([to]) => pathname.startsWith(to));
  // The most specific link wins when one link's path starts with another's.
  const current = item.links.filter(([to]) => pathname.startsWith(to)).sort((x, y) => y[0].length - x[0].length)[0]?.[0];
  const id = `nav-${item.label.toLowerCase()}`;
  return (
    <div
      className="nav-group"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpenMenu(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && expanded) {
          setOpenMenu(null);
          (e.currentTarget.querySelector("button") as HTMLButtonElement | null)?.focus();
        }
      }}
    >
      <button
        type="button"
        className="nav-trigger"
        aria-expanded={expanded}
        aria-controls={id}
        data-status={active ? "active" : undefined}
        onClick={() => setOpenMenu(expanded ? null : item.label)}
      >
        {item.label}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>
      <div className="nav-menu" id={id} hidden={!expanded}>
        <span className="nav-menu-title">{item.label}</span>
        {item.links.map(([to, label, hint]) => (
          <Link
            key={to}
            to={to}
            data-status={to === current ? "active" : undefined}
            onClick={() => {
              setOpenMenu(null);
              onNavigate();
            }}
          >
            <span>{label}</span>
            <small>{hint}</small>
          </Link>
        ))}
      </div>
    </div>
  );
}

const X_PATH = "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

function XLink() {
  const x = manifest.social.x;
  const icon = <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d={X_PATH} fill="currentColor" /></svg>;
  if (!x) {
    return (
      <span className="chip chip-icon off" role="img" title="The official X account has not been published yet." aria-label="X account not published yet">
        {icon}
      </span>
    );
  }
  return (
    <a className="chip chip-icon" href={x} target="_blank" rel="noreferrer" aria-label="Curveil on X">
      {icon}
    </a>
  );
}

const GITHUB_URL = "https://github.com/curveilcoder/curveil";
const GITHUB_PATH = "M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z";

function GitHubLink() {
  return (
    <a className="chip chip-icon" href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="Curveil on GitHub">
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d={GITHUB_PATH} fill="currentColor" /></svg>
    </a>
  );
}

const TELEGRAM_URL = "https://t.me/curveil";
const CONTACT_EMAIL = "admin@curveil.xyz";
const TELEGRAM_PATH = "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z";

function TelegramLink() {
  return (
    <a className="chip chip-icon" href={TELEGRAM_URL} target="_blank" rel="noreferrer" aria-label="Curveil on Telegram">
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d={TELEGRAM_PATH} fill="currentColor" /></svg>
    </a>
  );
}

/** Language picker: a native select over a globe chip, so it works the same with a mouse, keys and on phones. */
export function LangSwitch({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const cur = LOCALES.find((l) => l.id === locale)!;
  return (
    <label className={`chip lang-switch ${className}`} title="Language / 语言 / 語言">
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0c2.5 2.7 3.8 6 3.8 10S14.5 19.3 12 22m0-20C9.5 4.7 8.2 8 8.2 12s1.3 7.3 3.8 10M2.5 9h19M2.5 15h19" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      <span aria-hidden="true">{cur.short}</span>
      <select aria-label="Language / 语言 / 語言" value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
        {LOCALES.map((l) => <option key={l.id} value={l.id} lang={l.html}>{l.label}</option>)}
      </select>
    </label>
  );
}

function HeaderChips({ className }: { className: string }) {
  return (
    <div className={`header-chips ${className}`}>
      <LangSwitch />
      <XLink />
      <TelegramLink />
      <GitHubLink />
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const loading = useRouterState({ select: (s) => s.status === "pending" });
  // On the home page the header floats over the hero and fills in once the page scrolls.
  const over = pathname === "/";
  const inApp = isAppPath(pathname);
  const NAV = inApp ? APP_NAV : SITE_NAV;
  const header = useRef<HTMLElement>(null);
  const banner = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const measure = () => {
      root.style.setProperty("--header-h", `${header.current?.offsetHeight ?? 0}px`);
      root.style.setProperty("--banner-h", `${banner.current?.offsetHeight ?? 0}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (header.current) ro.observe(header.current);
    if (banner.current) ro.observe(banner.current);
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { ro.disconnect(); window.removeEventListener("scroll", onScroll); };
  }, []);
  return (
    <>
      <a href="#main" className="sr-only">{t("Skip to content", "跳到正文")}</a>
      {manifest.network === "testnet" && (
        <div className="testnet-banner" role="region" aria-label={t("Testnet notice", "测试网提示")} ref={banner}>
          {t(`Testnet (chain ${manifest.chainId}). Tokens here have no value.`, `测试网（链 ID ${manifest.chainId}）。这里的代币没有价值。`)} <Link to="/docs" search={{ page: "testnet" }} hash="faucet">{t("Get test tokens", "领取测试代币")}</Link>
        </div>
      )}
      <header ref={header} className={`header${over ? " over" : ""}${scrolled || open ? " scrolled" : ""}`}>
        <div className="wrap header-row app-wide">
          <Link to="/" className="brand" aria-label={t("Curveil home", "Curveil 首页")}>
            <Logo size={28} />
            <span>CURVEIL</span>
          </Link>
          <nav className={`nav${open ? " open" : ""}`} aria-label={t("Main", "主导航")}>
            {NAV.map((item) =>
              item.links ? (
                <NavMenu key={item.label} item={{ ...item, links: item.links }} pathname={pathname} openMenu={openMenu} setOpenMenu={setOpenMenu} onNavigate={() => setOpen(false)} />
              ) : (
                <Link key={item.to} to={item.to!} activeOptions={{ exact: true }} className="nav-link" data-status={navActive(item, pathname, search) ? "active" : undefined} aria-current={navActive(item, pathname, search) ? "page" : undefined} onClick={() => setOpen(false)}>
                  {t(item.label, item.zh ?? item.label)}
                </Link>
              ),
            )}
            {!inApp && <HeaderChips className="in-menu" />}
          </nav>
          <div className="header-actions">
            {!inApp && <HeaderChips className="in-bar" />}
            {inApp ? (
              <>
                <LangSwitch />
                <FundingSwitch className="hide-sm" />
                <ConnectButton />
              </>
            ) : (
              <Link to="/app/perps" className="btn btn-primary btn-sm launch-app">{t("Launch app", "启动应用")}</Link>
            )}
            <button className="btn btn-sm menu-toggle" aria-expanded={open} aria-label={t("Menu", "菜单")} onClick={() => setOpen((o) => !o)}>
              {open ? t("Close", "关闭") : t("Menu", "菜单")}
            </button>
          </div>
        </div>
        <div className={`route-progress${loading ? " on" : ""}`} aria-hidden="true" />
      </header>
      {/* App pages get the same space below as above; Perps fills the window instead. */}
      <main id="main" className={`main${inApp && !pathname.startsWith("/app/perps") ? " app-main" : ""}`}>{children}</main>
      <TxToasts />
      <SignInGate />
      {!inApp && <footer className={`footer${over ? "" : " footer-plain"}`}>
        {over && <DitherCanvas make={WAVES} aspect={0.11} cell={5} animate className="footer-waves" />}
        <div className="wrap footer-grid">
          <div>
            <div className="brand" style={{ marginBottom: 12 }}>
              <Logo size={24} />
              <span>CURVEIL</span>
            </div>
            <p style={{ maxWidth: "52ch", margin: 0 }}>
              {t(
                "Curveil is experimental software. Smart contracts, cryptography and markets carry risk, including total loss. Liquidity can underperform holding. Perpetual positions can be liquidated. Nothing here is investment advice.",
                "Curveil 是实验性软件。智能合约、密码学和市场都存在风险，包括全部损失。提供流动性的收益可能不如直接持有。永续合约仓位可能被强平。本网站内容均不构成投资建议。",
              )}
            </p>
            <p style={{ maxWidth: "52ch" }}>{t("Curveil is not affiliated with, endorsed by, or sponsored by Robinhood.", "Curveil 与 Robinhood 无关联，也未获得 Robinhood 的认可或赞助。")}</p>
          </div>
          <div>
            <h2>{t("Learn", "了解")}</h2>
            <ul>
              <li><Link to="/docs">{t("How Curveil works", "Curveil 如何运作")}</Link></li>
              <li><Link to="/docs" search={{ page: "fees" }}>{t("Fees", "费用")}</Link></li>
              <li><Link to="/docs" search={{ page: "risks" }}>{t("Risks", "风险")}</Link></li>
              <li><Link to="/docs" search={{ page: "contracts" }}>{t("Contracts", "合约")}</Link></li>
            </ul>
          </div>
          <div>
            <h2>{t("Build", "构建")}</h2>
            <ul>
              <li><Link to="/docs" search={{ page: "quickstart" }}>{t("Developer quickstart", "开发者快速上手")}</Link></li>
              <li><Link to="/docs" search={{ page: "launchpad-guide" }}>{t("Run a launchpad", "运营发射台")}</Link></li>
              <li><Link to="/docs" search={{ page: "api" }}>{t("API reference", "API 参考")}</Link></li>
              <li><a href={manifest.explorer} target="_blank" rel="noreferrer">{t("Chain explorer", "区块浏览器")}</a></li>
            </ul>
          </div>
          <div>
            <h2>{t("Contact", "联系")}</h2>
            <ul>
              {manifest.social.x && <li><a href={manifest.social.x} target="_blank" rel="noreferrer">X</a></li>}
              <li><a href={TELEGRAM_URL} target="_blank" rel="noreferrer">Telegram</a></li>
              <li><a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a></li>
              <li><a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></li>
            </ul>
          </div>
        </div>
      </footer>}
    </>
  );
}
