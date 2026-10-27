# TradeDuel Independent Hosting Audit

Date: 2026-10-25
Target: Cloudflare Workers + D1, with custom domain later
Baseline: `main` commit `1e13285806dbbe4087a4dfc92a2636031a76877e`
Working branch: `migration/cloudflare-audit`

## Executive summary

The repository is a TanStack Start / React 19 app configured for a Cloudflare Workers-style SSR bundle. It is not yet a clean independent deployment. The repository contains local workspace copies of four `@higgsfield/*` packages and comments/configuration tied to Higgsfield's generated deployment process. The app also includes an arena backend using Cloudflare D1 bindings and SQL migrations. A successful Git push is not evidence that the app builds or runs independently.

## Findings and priority

### P0 — Rights and package provenance
- `packages/fnf/package.json`, `packages/fnf-react/package.json`, `packages/quanta/package.json`, and `packages/app-landing/package.json` mark the packages private and/or `UNLICENSED`, and the snapshot metadata identifies a private Higgsfield source repository.
- Before redistributing, publishing these packages, or removing their names and provenance, confirm the user has rights to use and self-host this vendored code. Keep this repository private pending confirmation. Do not claim these packages are open source.

### P0 — Cloudflare deployment is not independently provisioned
- `wrangler.jsonc` explicitly says deploy CI generates authoritative config and replaces placeholder Worker name/binding IDs.
- `app.manifest.json` opts into D1 but contains only platform metadata; it does not create a D1 database by itself.
- D1 database and binding `DB`, database migrations, Worker name, assets directory and runtime compatibility need to be provisioned/configured in Cloudflare.

### P0 — Domain-bound wallet verification
- `src/lib/api/arena.functions.ts` sets the wallet challenge domain to `tradeduel.higgsfield.app`. This will be incorrect after moving to a custom domain and may cause wallet-signature verification to fail or verify the wrong origin.
- The domain should be derived from the incoming request origin, with an explicit production allowlist and localhost support only for local development. Signature verification must bind the signed message to the expected origin, wallet, nonce and expiry.

### P1 — Higgsfield-only packages / runtime coupling
- Root `package.json` depends on `@higgsfield/app-landing`, `@higgsfield/fnf`, `@higgsfield/fnf-react`, and `@higgsfield/quanta` via `workspace:*`.
- Quanta is used directly for UI components/styles; it is not safe to delete without replacing its components and tokens or confirming rights.
- FNF SDK and React bindings are generation/media services. Need a usage/import inventory before deciding whether to remove or replace; remove only after no active routes/components depend on them.
- The design inspector Vite plugin and error reporting contain Higgsfield-specific code. They should be disabled/removed from the production build if not required; retain local functionality until the build is verified.

### P1 — Environment variables and secrets
- `src/lib/config.server.ts` currently exposes only `NODE_ENV` and contains placeholder examples. Create an explicit env-variable inventory and use Cloudflare Worker secrets for provider/API credentials. Never commit secrets or `.env` values.
- Confirm public RPC / GeckoTerminal rate limits and any paid RPC requirements before launch.

### P1 — Database and state integrity
- The app expects D1 tables for wallet challenges/sessions, users, queue, matches, valuation, and transaction evidence. The repository has migrations `0001_init.sql` through `0014_*.sql`.
- Apply migrations to a new Cloudflare D1 database first, validate schema consistency and indexes, then run functional tests. Do not reuse or destructively modify production data.
- Audit matchmaking concurrency, session expiry, challenge replay prevention, settlement idempotency, and whether any endpoint can mark a match verified without sufficient chain evidence.

### P1 — Build and test validation
- The root build script is `bun run check:ui && tsr generate && tsc --noEmit && vite build`; tests are `bun test tests/*.test.ts`.
- No clean install/build/test has been executed in this audit session. Do not treat the code as deployment-ready until lockfile install, typecheck, build, tests, and a local Worker smoke test pass.

### P2 — Metadata and host assumptions
- `src/routes/__root.tsx` has logic to rewrite Higgsfield-hosted image URLs to root-relative paths, which is useful but should be verified against all metadata and assets.
- Check canonical URLs, sitemap, robots, callback origins, CORS, cookie/security settings, and any hardcoded `higgsfield.app` hosts before cutover.

## Safe migration plan

1. Keep `main` untouched; do all changes on `migration/cloudflare-audit`.
2. Confirm rights to use the vendored `UNLICENSED` packages for independent hosting.
3. Inventory every active import and runtime network call for Higgsfield APIs.
4. Replace host-bound wallet domain with request-origin verification plus an allowlist.
5. Establish standalone `wrangler.jsonc`, D1 database binding and a repeatable migration command.
6. Remove unused Higgsfield analytics/design-inspector integration; replace error reporting with console/Cloudflare observability.
7. Keep or replace UI packages based on the rights confirmation and build test results.
8. Run install, typecheck, build, tests and local Worker smoke tests; fix failures.
9. Deploy a preview Worker and validate wallet connect, challenge/signature verification, arena status, matchmaking, match routes, leaderboard, spectating and tracker.
10. Only after validation, attach the domain and switch traffic. Keep the existing Higgsfield site live until then.

## Scope / limits of this report

This is a source-level initial audit based on repository files. It is not a security certification and does not establish that all external integrations, runtime behavior, wallet flows or database migrations work. Findings must be validated with a clean build and runtime tests before launch.
