import { useEffect } from "react";
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, redirect, ScrollRestoration } from "@tanstack/react-router";
import { Shell } from "./components/Shell";
import { Home } from "./routes/Home";
import { DEV_TAB_PAGE, docPage, type DocPage } from "./lib/docs";
import { Profile, ProfileMe, parseProfileSearch } from "./routes/Profile";
import type { VaultSub } from "./routes/Vault";

const VAULT_SUB_IDS: readonly string[] = ["overview", "shield", "send", "withdraw", "notes", "backup"];
import { NotFound } from "./routes/NotFound";

const rootRoute = createRootRoute({
  component: () => (
    <Shell>
      <ScrollRestoration />
      <Outlet />
    </Shell>
  ),
  notFoundComponent: NotFound,
});

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home, head: () => ({ meta: [{ title: "Curveil · Open markets. Private participation." }] }) });
const poolsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pools", component: lazyRouteComponent(() => import("./routes/Markets"), "Pools"), head: () => ({ meta: [{ title: "Pools · Curveil" }] }) });
const poolNewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pools/new", component: lazyRouteComponent(() => import("./routes/Liquidity"), "CreatePoolPage"), head: () => ({ meta: [{ title: "Create a pool · Curveil" }] }) });
const poolRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pools/$pool", component: lazyRouteComponent(() => import("./routes/Pool"), "Pool"), head: () => ({ meta: [{ title: "Pool · Curveil" }] }) });
const poolAddRoute = createRoute({ getParentRoute: () => rootRoute, path: "/pools/$pool/add", component: lazyRouteComponent(() => import("./routes/Liquidity"), "AddLiquidity"), head: () => ({ meta: [{ title: "Add liquidity · Curveil" }] }) });
// Old addresses: Markets became Pools, and adding liquidity starts from a pool's page.
const marketsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/markets", beforeLoad: () => { throw redirect({ to: "/pools", replace: true }); } });
const marketRoute = createRoute({ getParentRoute: () => rootRoute, path: "/markets/$pool", beforeLoad: ({ params }) => { throw redirect({ to: "/pools/$pool", params: { pool: params.pool }, replace: true }); } });
const addr = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : undefined);
const swapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/swap",
  component: lazyRouteComponent(() => import("./routes/Swap"), "Swap"),
  validateSearch: (s: Record<string, unknown>): { from?: `0x${string}`; to?: `0x${string}` } => ({ from: addr(s.from), to: addr(s.to) }),
  head: () => ({ meta: [{ title: "Swap · Curveil" }] }),
});
const liquidityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/liquidity",
  validateSearch: (s: Record<string, unknown>): { tab?: string; pool?: `0x${string}` } => ({ tab: typeof s.tab === "string" ? s.tab : undefined, pool: addr(s.pool) }),
  beforeLoad: ({ search }) => {
    if (search.tab === "create") throw redirect({ to: "/pools/new", replace: true });
    if (search.pool) throw redirect({ to: "/pools/$pool/add", params: { pool: search.pool }, replace: true });
    throw redirect({ to: "/pools", replace: true });
  },
});
const launchRoute = createRoute({ getParentRoute: () => rootRoute, path: "/launch", component: lazyRouteComponent(() => import("./routes/Launch"), "Launch"), head: () => ({ meta: [{ title: "Launches · Curveil" }] }) });
const launchNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/launch/new",
  component: lazyRouteComponent(() => import("./routes/LaunchCreate"), "LaunchCreate"),
  validateSearch: (s: Record<string, unknown>): { operator?: `0x${string}` } => ({ operator: addr(s.operator) }),
  head: () => ({ meta: [{ title: "Create a token · Curveil" }] }) });
const launchTokenRoute = createRoute({ getParentRoute: () => rootRoute, path: "/launch/$token", component: lazyRouteComponent(() => import("./routes/LaunchToken"), "LaunchToken"), head: () => ({ meta: [{ title: "Token · Curveil" }] }) });
// The vault has its own page: it needs no wallet, so it does not belong in a profile.
const vaultRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vault",
  component: lazyRouteComponent(() => import("./routes/Vault"), "VaultPage"),
  validateSearch: (s: Record<string, unknown>): { sub?: VaultSub } => (VAULT_SUB_IDS.includes(s.sub as VaultSub) ? { sub: s.sub as VaultSub } : {}),
  head: () => ({ meta: [{ title: "Vault · Curveil" }] }),
});
// Older links opened the vault as a profile tab.
const toVault = ({ search }: { search: { tab?: string; sub?: string } }) => {
  if (search.tab === "vault") throw redirect({ to: "/vault", search: VAULT_SUB_IDS.includes(search.sub as VaultSub) ? { sub: search.sub as VaultSub } : {}, replace: true });
};
const safeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/safe", component: lazyRouteComponent(() => import("./routes/SafeSign"), "SafeSign"), head: () => ({ meta: [{ title: "Sign the handover · Curveil" }, { name: "robots", content: "noindex" }] }) });
const perpsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/perps", component: lazyRouteComponent(() => import("./routes/Perps"), "Perps"), head: () => ({ meta: [{ title: "Perps · Curveil" }] }) });
// Developers and Transparency are now part of the docs; old links land on the matching page.
const factoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/factory",
  beforeLoad: () => {
    throw redirect({ to: "/docs", search: { page: "launchpad-guide" }, replace: true });
  },
});
const developersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/developers",
  validateSearch: (s: Record<string, unknown>): { tab?: string } => ({ tab: typeof s.tab === "string" ? s.tab : undefined }),
  beforeLoad: ({ search, location }) => {
    const hash = location.hash || undefined;
    const page = hash === "faucet" ? DEV_TAB_PAGE.testnet! : (DEV_TAB_PAGE[search.tab ?? "start"] ?? "quickstart");
    throw redirect({ to: "/docs", search: { page }, hash, replace: true });
  },
});
const transparencyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transparency",
  beforeLoad: () => {
    throw redirect({ to: "/docs", search: { page: "contracts" }, replace: true });
  },
});
const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs",
  component: lazyRouteComponent(() => import("./routes/Docs"), "Docs"),
  validateSearch: (s: Record<string, unknown>): { page?: DocPage } => ({ page: docPage(s.page) }),
  head: () => ({ meta: [{ title: "Docs · Curveil" }] }),
});

const profileMeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/profile", component: ProfileMe, validateSearch: parseProfileSearch, beforeLoad: toVault, head: () => ({ meta: [{ title: "Profile · Curveil" }] }) });
const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile/$address",
  component: Profile,
  validateSearch: parseProfileSearch,
  beforeLoad: toVault,
  head: () => ({ meta: [{ title: "Profile · Curveil" }] }),
});
const routeTree = rootRoute.addChildren([profileMeRoute, profileRoute, homeRoute, poolsRoute, poolNewRoute, poolRoute, poolAddRoute, marketsRoute, marketRoute, swapRoute, liquidityRoute, launchRoute, launchNewRoute, launchTokenRoute, vaultRoute, perpsRoute, safeRoute, factoryRoute, developersRoute, transparencyRoute, docsRoute]);

const RELOAD_KEY = "curveil-stale-reload";
/** A page file from an older release that is gone, or an empty module from a failed load. */
function isStaleChunk(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch dynamically|Unable to preload|is not a valid JavaScript MIME type/i.test(error.message)
    // The same empty module, as Chrome, Safari and Firefox word it.
    || /^Cannot read properties of undefined \(reading '[A-Z]\w*'\)$|^undefined is not an object \(evaluating '\w+\.[A-Z]\w*'\)$|^can't access property "[A-Z]\w*", \w+ is undefined$/.test(error.message);
}

/** Shown when a page fails to load or render: what happened, and a way out. */
function PageError({ error, reset }: { error: unknown; reset: () => void }) {
  const chunk = isStaleChunk(error);
  // A tab left open across a release asks for page files that no longer exist: reload once to
  // get the new release. The guard stops a loop if the reload does not help.
  useEffect(() => {
    if (!chunk) return;
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
      if (Date.now() - last < 30_000) return;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch { /* private mode: reload anyway, once per page view */ }
    window.location.reload();
  }, [chunk]);
  return (
    <div className="wrap" style={{ padding: "64px 0" }}>
      <h1>{chunk ? "This page was updated" : "This page could not be shown"}</h1>
      <p className="lead">{chunk ? "A newer version of Curveil was published while you were here. Reload to get it." : "Something went wrong while showing this page. Reloading usually fixes it."}</p>
      <p className="small muted mono">{error instanceof Error ? error.message : String(error)}</p>
      <div className="hero-actions">
        <button type="button" className="btn btn-primary" onClick={() => (chunk ? window.location.reload() : reset())}>{chunk ? "Reload" : "Try again"}</button>
      </div>
    </div>
  );
}

export const router = createRouter({ routeTree, defaultPreload: "intent", scrollRestoration: true, defaultErrorComponent: PageError });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
