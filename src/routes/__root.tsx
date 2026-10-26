import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportApplicationError } from "../lib/error-reporting";
// Page metadata for browser titles, favicons and social previews.
import appMetaJson from "../app-meta.json";

// Built-in defaults for any field that isn't set in app-meta.json.
const DEFAULT_TITLE = "TradeDuel | The Trading Arena";
const DEFAULT_DESCRIPTION = "A competitive Pump.fun trading arena in development. Head-to-head challenges, wallet-owned trades, and transparent scoring.";

type AppMeta = {
  og_title?: string | null;
  og_description?: string | null;
  og_image_url?: string | null;
  favicon_url?: string | null;
  og_video_url?: string | null;
};

const appMeta = appMetaJson as AppMeta;

// Build the document head (title / description / og: / twitter: / favicon) from
// app-meta.json, falling back to the defaults above for any unset field.
// og_title/og_description double as the browser <title> and meta description;
// og_image_url (when set) also drives the twitter card + image. Built from
// inline tag literals (conditional spreads for the optional image/favicon) so
// it matches the head() shape TanStack expects.
function toOwnAssetUrl(value: string | null | undefined): string | null {
  return value || null;
}
function buildHead(meta: AppMeta) {
  const title = meta.og_title ?? DEFAULT_TITLE;
  const description = meta.og_description ?? DEFAULT_DESCRIPTION;
  const ogImage = toOwnAssetUrl(meta.og_image_url);
  const favicon = toOwnAssetUrl(meta.favicon_url);
  const ogVideo = toOwnAssetUrl(meta.og_video_url);

  return {
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title },
      { name: "description", content: description },
      { name: "author", content: "TradeDuel" },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: ogImage ? "summary_large_image" : "summary" },
      
      ...(ogImage
        ? [
            { property: "og:image", content: ogImage },
            { name: "twitter:image", content: ogImage },
          ]
        : []),
      // Cover video (og:video) — the animated counterpart of og:image; the
      // social preview cards also play it on hover.
      ...(ogVideo ? [{ property: "og:video", content: ogVideo }] : []),
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      ...(favicon ? [{ rel: "icon", href: favicon }] : []),
    ],
  };
}

function NotFoundComponent() {
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "24px", background: "var(--td-bg)", color: "var(--td-text)", fontFamily: "Inter, Arial, sans-serif" }}>
      <section style={{ maxWidth: "420px", textAlign: "center" }}>
        <p style={{ fontSize: "56px", lineHeight: 1, fontWeight: 800, margin: "0 0 16px", color: "var(--td-accent)" }}>404</p>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 8px" }}>Page not found</h1>
        <p style={{ color: "var(--td-muted)", lineHeight: 1.6, margin: "0 0 24px" }}>The page you're looking for doesn't exist or has been moved.</p>
        <Link to="/" style={{ display: "inline-block", padding: "10px 16px", borderRadius: "8px", background: "var(--td-accent)", color: "var(--td-bg)", fontWeight: 700, textDecoration: "none" }}>Go home</Link>
      </section>
    </main>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportApplicationError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "24px", background: "var(--td-bg)", color: "var(--td-text)", fontFamily: "Inter, Arial, sans-serif" }}>
      <section style={{ maxWidth: "440px", textAlign: "center" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 700, margin: "0 0 8px" }}>This page didn't load</h1>
        <p style={{ color: "var(--td-muted)", lineHeight: 1.6, margin: "0 0 24px" }}>Something went wrong on our end. You can try again or head back home.</p>
        <div style={{ display: "flex", justifyContent: "center", gap: "10px", flexWrap: "wrap" }}>
          <button onClick={() => { router.invalidate(); reset(); }} style={{ border: 0, borderRadius: "8px", padding: "10px 16px", background: "var(--td-accent)", color: "var(--td-bg)", fontWeight: 700, cursor: "pointer" }}>Try again</button>
          <a href="/" style={{ border: "1px solid #353b45", borderRadius: "8px", padding: "10px 16px", color: "var(--td-text)", textDecoration: "none" }}>Go home</a>
        </div>
      </section>
    </main>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Read the committed page metadata at build time (no runtime fetch).
  head: () => buildHead(appMeta),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="default-dark" style={{ colorScheme: "dark" }}>
      {/* Marketplace apps are permanently dark: data-theme is pinned on <html>
          above. Do not add quanta's bootstrapScript/ThemeController, a theme
          toggle, or a light mode. */}
      <head>
        <HeadContent />
      </head>
      <body style={{ background: "var(--td-bg)", color: "var(--td-text)" }}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Temporary public maintenance mode. Set to false to restore the full site.
  const SITE_MAINTENANCE = false;

  if (SITE_MAINTENANCE) {
    return (
      <main style={{ minHeight: "100dvh", background: "var(--td-bg)", color: "var(--td-text)", display: "grid", placeItems: "center", padding: "32px", fontFamily: "Inter, Arial, sans-serif" }}>
        <section style={{ width: "100%", maxWidth: "680px", textAlign: "center" }}>
          <img src="/brand-mark-exact.png" alt="TradeDuel" width="92" height="92" style={{ objectFit: "contain", margin: "0 auto 28px" }} />
          <p style={{ color: "var(--td-accent)", fontSize: "12px", letterSpacing: "0.28em", textTransform: "uppercase", marginBottom: "18px" }}>TradeDuel · Maintenance</p>
          <h1 style={{ fontSize: "clamp(38px, 8vw, 72px)", lineHeight: 0.98, fontWeight: 850, letterSpacing: "-0.05em", margin: "0 0 24px" }}>THE ARENA IS<br /><span style={{ color: "var(--td-accent)" }}>UNDER CONSTRUCTION.</span></h1>
          <p style={{ color: "var(--td-muted)", fontSize: "17px", lineHeight: 1.7, maxWidth: "520px", margin: "0 auto" }}>We're making improvements behind the scenes. TradeDuel will be back when the next stage is ready.</p>
          <div style={{ height: "1px", background: "linear-gradient(90deg, transparent, var(--td-accent), transparent)", margin: "36px auto 20px", maxWidth: "360px" }} />
          <p style={{ color: "var(--td-subtle)", fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase" }}>Still building · More updates soon</p>
        </section>
      </main>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
    </QueryClientProvider>
  );
}
