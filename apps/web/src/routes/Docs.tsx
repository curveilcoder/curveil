import { useEffect, useRef, useState } from "react";
import "../styles/docs.css";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { DOC_GROUPS, DOC_PAGES, type DocPage } from "../lib/docs";
import { ContractPage } from "../components/docs/ContractPages";
import { DevPage } from "../components/docs/DevPages";
import { DocsHome, FeesGuide, GetStartedGuide, LaunchGuide, LaunchpadsGuide, MarketsGuide, PerpsGuide, RisksGuide, SwapGuide, TokenGuide, VaultGuide } from "../components/docs/GuidePages";

function Body({ page }: { page: DocPage }) {
  switch (page) {
    case "overview": return <DocsHome />;
    case "get-started": return <GetStartedGuide />;
    case "markets": return <MarketsGuide />;
    case "swap": return <SwapGuide />;
    case "vault": return <VaultGuide />;
    case "launch": return <LaunchGuide />;
    case "launchpads": return <LaunchpadsGuide />;
    case "perps": return <PerpsGuide />;
    case "token": return <TokenGuide />;
    case "fees": return <FeesGuide />;
    case "risks": return <RisksGuide />;
    case "contracts":
    case "admin":
    case "assets":
      return <ContractPage page={page} />;
    case "quickstart":
    case "launchpad-guide":
    case "api":
    case "testnet":
      return <DevPage page={page} />;
  }
}

type Heading = { id: string; text: string; level: 2 | 3 };

/** "On this page": the article's section and step headings, with the one in view marked. */
function OnThisPage({ root, page }: { root: React.RefObject<HTMLElement | null>; page: DocPage }) {
  const [items, setItems] = useState<Heading[]>([]);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const read = () => {
      const hs = [...el.querySelectorAll<HTMLElement>("section.dk-section, li.dk-step")].map((n) => ({
        id: n.id,
        text: n.querySelector(".dk-anchor")?.textContent ?? "",
        level: (n.tagName === "LI" ? 3 : 2) as 2 | 3,
      }));
      setItems((cur) => (JSON.stringify(cur) === JSON.stringify(hs) ? cur : hs));
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [root, page]);

  useEffect(() => {
    const onScroll = () => {
      let cur: string | null = items[0]?.id ?? null;
      for (const h of items) {
        const n = document.getElementById(h.id);
        if (n && n.getBoundingClientRect().top < 140) cur = h.id;
      }
      setActive(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [items]);

  if (items.length < 2) return null;
  return (
    <nav className="docs-otp" aria-label="On this page">
      <p className="docs-otp-title">On this page</p>
      {items.map((h) => (
        <a key={h.id} href={`#${h.id}`} className={`${h.level === 3 ? "sub" : ""}${active === h.id ? " on" : ""}`}>{h.text}</a>
      ))}
    </nav>
  );
}

export function Docs() {
  const { page = "overview" } = useSearch({ from: "/docs" });
  const navigate = useNavigate({ from: "/docs" });
  const { hash } = useLocation();
  const [q, setQ] = useState("");
  const body = useRef<HTMLElement>(null);
  const at = DOC_PAGES.findIndex((p) => p.id === page);
  const cur = DOC_PAGES[at]!;
  const prev = DOC_PAGES[at - 1];
  const next = DOC_PAGES[at + 1];
  const home = page === "overview";

  // A new page starts at the top, unless the link points somewhere on it.
  useEffect(() => {
    if (hash) document.getElementById(hash)?.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [page, hash]);

  const needle = q.trim().toLowerCase();
  const groups = DOC_GROUPS.map((g) => ({
    ...g,
    pages: g.pages.filter((p) => !needle || p.title.toLowerCase().includes(needle) || p.desc.toLowerCase().includes(needle)),
  })).filter((g) => g.pages.length > 0);

  return (
    <div className="docs">
      <div className={`docs-grid${home ? " is-home" : ""}`}>
        <nav className="docs-side" aria-label="Docs">
          <label className="docs-pick">
            <span className="sr-only">Page</span>
            <select value={page} onChange={(e) => navigate({ search: { page: e.target.value as DocPage } })}>
              {DOC_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.pages.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="docs-search">
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
            <span className="sr-only">Search docs</span>
            <input type="search" placeholder="Search docs" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="docs-toc">
            {groups.map((g) => (
              <div key={g.label} className="docs-group">
                <p className="docs-group-label">{g.label}</p>
                {g.pages.map((p) => (
                  <Link key={p.id} to="/docs" search={{ page: p.id }} aria-current={p.id === page ? "page" : undefined} onClick={() => setQ("")}>{p.title}</Link>
                ))}
              </div>
            ))}
            {groups.length === 0 && <p className="small muted docs-none">No page matches “{q}”.</p>}
          </div>
        </nav>

        <article className="docs-body" ref={body}>
          {!home && (
            <header className="docs-head">
              <p className="docs-crumbs">
                <Link to="/docs" search={{ page: "overview" }}>Docs</Link>
                <span aria-hidden="true">/</span>
                <span>{cur.group}</span>
              </p>
              <h1>{cur.title}</h1>
              <p className="docs-lede">{cur.desc}</p>
            </header>
          )}
          <div className="docs-content">
            <Body page={page} />
          </div>
          <nav className="docs-pager" aria-label="Next and previous page">
            {prev ? <Link to="/docs" search={{ page: prev.id }}><span className="small muted">← Previous</span>{prev.title}</Link> : <span />}
            {next && <Link to="/docs" search={{ page: next.id }} className="next"><span className="small muted">Next →</span>{next.title}</Link>}
          </nav>
        </article>

        {!home && <aside className="docs-aside"><OnThisPage root={body} page={page} /></aside>}
      </div>
    </div>
  );
}
