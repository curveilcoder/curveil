import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Logo } from "./Logo";
import { DitherCanvas, WAVES } from "./Dither";
import { TxToasts } from "./TxToasts";
import { SignInGate } from "./SignInGate";
import { ConnectButton } from "./ConnectButton";
import { manifest } from "../lib/config";
import { FundingSwitch } from "./FundingSwitch";

type NavLink = readonly [to: string, label: string, hint: string];
type NavItem = { label: string; to?: string; links?: readonly NavLink[]; not?: string; also?: readonly string[]; isActive?: (path: string, search: Record<string, unknown>) => boolean };

function navActive(item: NavItem, path: string, search: Record<string, unknown>): boolean {
  if (item.isActive) return item.isActive(path, search);
  const hit = [item.to!, ...(item.also ?? [])].some((p) => path === p || path.startsWith(p + "/"));
  return hit && !(item.not && path.startsWith(item.not));
}

/** Docs pages for builders: the Developers link owns them, Docs owns the rest. */
const DEV_PAGES = ["quickstart", "api", "launchpad-guide", "testnet"];

const DEV_LINK: NavItem = { label: "Developers", to: "/developers", isActive: (path, search) => path.startsWith("/docs") && DEV_PAGES.includes(String(search.page)) };
const DOCS_LINK: NavItem = { label: "Docs", to: "/docs", isActive: (path, search) => path.startsWith("/docs") && !DEV_PAGES.includes(String(search.page)) };

/** The app's navigation: one direct link per product, so each name says where it goes. */
const APP_NAV: readonly NavItem[] = [
  { label: "Perps", to: "/app/perps" },
  { label: "Swap", to: "/app/swap" },
  { label: "Pools", to: "/app/pools", also: ["/app/liquidity"] },
  { label: "Launches", to: "/app/launch" },
  { label: "Vault", to: "/app/vault" },
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

function HeaderChips({ className }: { className: string }) {
  return (
    <div className={`header-chips ${className}`}>
      <XLink />
      <GitHubLink />
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
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
      <a href="#main" className="sr-only">Skip to content</a>
      {manifest.network === "testnet" && (
        <div className="testnet-banner" role="region" aria-label="Testnet notice" ref={banner}>
          Testnet (chain {manifest.chainId}). Tokens here have no value. <Link to="/docs" search={{ page: "testnet" }} hash="faucet">Get test tokens</Link>
        </div>
      )}
      <header ref={header} className={`header${over ? " over" : ""}${scrolled || open ? " scrolled" : ""}`}>
        <div className="wrap header-row app-wide">
          <Link to="/" className="brand" aria-label="Curveil home">
            <Logo size={28} />
            <span>CURVEIL</span>
          </Link>
          <nav className={`nav${open ? " open" : ""}`} aria-label="Main">
            {NAV.map((item) =>
              item.links ? (
                <NavMenu key={item.label} item={{ ...item, links: item.links }} pathname={pathname} openMenu={openMenu} setOpenMenu={setOpenMenu} onNavigate={() => setOpen(false)} />
              ) : (
                <Link key={item.to} to={item.to!} activeOptions={{ exact: true }} className="nav-link" data-status={navActive(item, pathname, search) ? "active" : undefined} aria-current={navActive(item, pathname, search) ? "page" : undefined} onClick={() => setOpen(false)}>
                  {item.label}
                </Link>
              ),
            )}
            {!inApp && <HeaderChips className="in-menu" />}
          </nav>
          <div className="header-actions">
            {!inApp && <HeaderChips className="in-bar" />}
            {inApp ? (
              <>
                <FundingSwitch className="hide-sm" />
                <ConnectButton />
              </>
            ) : (
              <Link to="/app/perps" className="btn btn-primary btn-sm launch-app">Launch app</Link>
            )}
            <button className="btn btn-sm menu-toggle" aria-expanded={open} aria-label="Menu" onClick={() => setOpen((o) => !o)}>
              {open ? "Close" : "Menu"}
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
              Curveil is experimental software. Smart contracts, cryptography and markets carry risk, including total loss.
              Liquidity can underperform holding. Perpetual positions can be liquidated. Nothing here is investment advice.
            </p>
            <p style={{ maxWidth: "52ch" }}>Curveil is not affiliated with, endorsed by, or sponsored by Robinhood.</p>
          </div>
          <div>
            <h2>Learn</h2>
            <ul>
              <li><Link to="/docs">How Curveil works</Link></li>
              <li><Link to="/docs" search={{ page: "fees" }}>Fees</Link></li>
              <li><Link to="/docs" search={{ page: "risks" }}>Risks</Link></li>
              <li><Link to="/docs" search={{ page: "contracts" }}>Contracts</Link></li>
            </ul>
          </div>
          <div>
            <h2>Build</h2>
            <ul>
              <li><Link to="/docs" search={{ page: "quickstart" }}>Developer quickstart</Link></li>
              <li><Link to="/docs" search={{ page: "launchpad-guide" }}>Run a launchpad</Link></li>
              <li><Link to="/docs" search={{ page: "api" }}>API reference</Link></li>
              <li><a href={manifest.explorer} target="_blank" rel="noreferrer">Chain explorer</a></li>
            </ul>
          </div>
        </div>
      </footer>}
    </>
  );
}
