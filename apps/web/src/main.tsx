import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { RouterProvider } from "@tanstack/react-router";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/global.css";
import "./styles/forms.css";
// Shared by the token, pool, liquidity, perps and profile pages: load it with the base styles so it always wins over them.
import "./styles/token.css";
import { wagmiConfig } from "./lib/wagmi";
import { router } from "./router";

// A page's stylesheet that fails to preload (a blocked or flaky request) should not stop the page
// from rendering. A script that fails must still throw: swallowing it hands the router an empty
// module ("Cannot read properties of undefined"). The route's error screen then reloads the page,
// which is what a tab left open across a new release needs.
window.addEventListener("vite:preloadError", (e) => {
  const msg = (e as Event & { payload?: unknown }).payload;
  if (msg instanceof Error && /preload CSS/i.test(msg.message)) e.preventDefault();
});

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true } } });

function TitleSync() {
  useEffect(
    () =>
      router.subscribe("onResolved", () => {
        const match = router.state.matches.at(-1);
        const title = (match?.meta?.find((m) => m && "title" in m) as { title?: string } | undefined)?.title;
        if (title) document.title = title;
      }),
    [],
  );
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <TitleSync />
        <RouterProvider router={router} />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
