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

/** Top-level navigation: one direct link per product, so each name says where it goes. */
const NAV: readonly NavItem[] = [
  { label: "Swap", to: "/swap" },
  { label: "Pools", to: "/pools", also: ["/liquidity"] },
  { label: "Launches", to: "/launch" },
  { label: "Perps", to: "/perps" },
  { label: "Vault", to: "/vault" },
  { label: "Developers", to: "/developers", isActive: (path, search) => path.startsWith("/docs") && DEV_PAGES.includes(String(search.page)) },
  { label: "Docs", to: "/docs", isActive: (path, search) => path.startsWith("/docs") && !DEV_PAGES.includes(String(search.page)) },
]

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

function HeaderChips({ className }: { className: string }) {
  return (
    <div className={`header-chips ${className}`}>
      <XLink />
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
        <div className="wrap header-row">
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
            <HeaderChips className="in-menu" />
          </nav>
          <div className="header-actions">
            <HeaderChips className="in-bar" />
            <FundingSwitch className="hide-sm" />
            <ConnectButton />
            <button className="btn btn-sm menu-toggle" aria-expanded={open} aria-label="Menu" onClick={() => setOpen((o) => !o)}>
              {open ? "Close" : "Menu"}
            </button>
          </div>
        </div>
        <div className={`route-progress${loading ? " on" : ""}`} aria-hidden="true" />
      </header>
      <main id="main" className="main">{children}</main>
      <TxToasts />
      <SignInGate />
      <footer className={`footer${over ? "" : " footer-plain"}`}>
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
      </footer>
    </>
  );
}
