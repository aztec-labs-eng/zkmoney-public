# web-wallet-desktop — run the web wallet locally

An Electron launcher that lets a user run the zk.money web wallet entirely on their own machine,
with the passkeys they registered on the hosted wallet still working.

This README is for developers building and releasing the app. The user guide is at
https://download.zk.money/docs/desktop and the explanation of the local origin is at
https://download.zk.money/docs/how-it-works.

## How it works

Electron here is a packager and process manager only — there is no BrowserWindow. On launch the app:

1. Generates a per-install self-signed TLS certificate for the configured hostname (in-process via
   `selfsigned`, stored under the app's user-data dir) and computes its SPKI SHA-256 fingerprint.
2. Serves the bundled wallet build (`web/`) from an HTTPS server bound to `127.0.0.1` on a random
   port, with the same headers/rewrites the Vercel deployment applies: COOP+COEP on every response
   (`crossOriginIsolated` → SharedArrayBuffer → threaded bb.js proving), the `/svc/enclave` reverse
   proxy (the oxide TEE origin is bare-IP `http://`, which an HTTPS page can't fetch directly), and
   the SPA fallback — with `/assets/*` and extensioned paths excluded, because index.html served
   where `sqlite3.wasm` was expected hangs the PXE boot.
3. Launches the user's installed Chrome in a dedicated profile with
   `--host-resolver-rules=MAP <hostname>:443 127.0.0.1:<port>` and
   `--ignore-certificate-errors-spki-list=<fingerprint>`, so Chrome renders the local bundle at the
   real production origin.
4. Shuts the server down when Chrome exits.

The page hostname is independent of the passkey RP. Production serves `https://wallet.zk.money` locally and requests `auth.zk.money` credentials using the public related-origins document. Staging serves `https://wallet.staging.zk.money` and uses the `staging.zk.money` suffix; local development uses `localhost` for both. Real Chrome
is required — Electron's own Chromium has no iCloud Keychain / Google Password Manager passkey
integration. The X-OAuth onboarding callback also works unchanged: account-service's registered
redirect URI is `<origin>/auth/x/callback`, and that origin resolves to the local server inside the
launched profile.

## Build & run

Not a pnpm workspace member (own npm lockfile — keeps the Electron download out of root `pnpm i`).
The repo root declares npm workspaces over `packages/*`, so plain `npm install` here would climb to
the root and choke on `workspace:*` deps — use the flag (or `npm run setup`):

```shell
cd packages/web-wallet-desktop
npm install --workspaces=false

# Bundle the wallet (full monorepo chain: contracts → front-core → vite build).
# The committed config targets the LOCAL SANDBOX (web-wallet's own env.ts defaults),
# so this works as-is against `aztec start --local-network` + the local services.
# The build fetches and bakes the profile VITE_CONFIG_PROFILE_URL names, so the
# committed sandbox target needs the local config-service (8083, `pnpm sandbox:up`
# in web-wallet) running at build time:
npm run build:web
# SKIP_MONOREPO_BUILD=1 npm run build:web     # fast path when front-core is already built

# For a real tier, override the target via shell env (shell wins over desktop.env),
# e.g. testnet — the same values deploy-web-wallet.yml bakes (account-service is optional); the two RPC URLs
# are keyed-provider secrets:
VITE_NETWORK=testnet VITE_NODE_URL=https://… VITE_L1_RPC_URL=https://… \
  VITE_CONFIG_PROFILE_URL=https://cdn.staging.zk.money/profiles/v5/current.json \
  VITE_CONFIG_EXPECTED_PROFILE_ID=staging-v5 \
  VITE_ACCOUNT_SERVICE_URL=https://account.staging.zk.money \
  VITE_PASSKEY_ENVIRONMENT=staging \
  DESKTOP_PAGE_HOSTNAME=wallet.staging.zk.money \
  npm run build:web

npm start                                     # dev run (electron .)
npm test                                      # headless smoke test (server/proxy/tls/chrome args)
npm run dist:mac|dist:win|dist:linux          # installers (signing: see Security notes)
```

`scripts/build-web.sh` builds the wallet, validates its page hostname and RP, writes both to `build-meta.json`, and composes `config/generated.json` from that metadata and the committed `config/default.json`. Each build reads the committed defaults; local proxy customizations belong in that file. Hosted builds replace the sandbox proxies with `/svc/predicate` pointing to the matching public wallet CDN. Production releases also take the environment's Predicate configuration, as the hosted wallet does. The default environment and hostname are local; a hosted build sets both explicitly.

## Configuration

The launcher loads `config/generated.json` when present, otherwise `config/default.json`. The generated file is included in installers and ignored by Git. Rebuild after changing the committed defaults. Configuration fields: `hostname` (the page host; changing it regenerates the TLS certificate), `passkeyRpId` (the RP recorded by the bundle), `startPath`, `windowMode` (`app` = chromeless window), `proxies` (path prefix → target origin), `spaFallback`, `contentSecurityPolicy` (default `null`; a strict policy can prevent WASM proving), `includeTestTypeFlag`, `certificateDays`.

The committed defaults are the local-sandbox pairing of web-wallet's dev setup:
`hostname: "localhost"`, `localPort: 5173` and the same proxy targets as `vite.config.ts`'s
`backendProxies` (`/svc/account` → `localhost:5060`, `/svc/enclave` → `localhost:5071`). `localhost`
is a special hostname: Chrome opens `https://localhost:<port>` directly with no
`--host-resolver-rules` mapping (localhost is already a valid passkey RP). The port must then be
stable — it's part of the origin, so it partitions storage and anchors the local X-OAuth redirect
(`localhost:5173`, same as `vite preview`); don't run the desktop app and a vite server at once —
the loser gets a fatal "listen EADDRINUSE: address already in use 127.0.0.1:5173" at startup, and
the app must not silently move ports, since in localhost mode the port is part of the origin and a
different one would present an empty wallet. Shipped tier builds are immune: their composed config
sets `localPort: 0` (any free port), which is why this failure is absent from the user guide. Any
real hostname gets the MAP rule so the production origin resolves to the local server (the port
disappears behind `:443`, so `localPort: 0` = any free port is fine); on testnet the enclave proxy
target is the oxide TEE ELB — the same literal as web-wallet's `vercel.json` rewrite.

Runtime env overrides: `OBSIDION_LOCAL_START_PATH`, `OBSIDION_LOCAL_TEST_TYPE=0`, `OBSIDION_ENCLAVE_TARGET`, `OBSIDION_L1_RPC_URL`, `OBSIDION_NODE_URL`, `CHROME_PATH`. Set the page hostname with `DESKTOP_PAGE_HOSTNAME` at build time; startup rejects a hostname that differs from the bundle metadata.

Branding: `build/icon.png` (the wallet logo, from front-core's `obsidionLogos`) is the
electron-builder app-icon source — auto-converted to icns/ico/png per platform at package time.
`assets/favicon.svg` (same logo) is served by the local server at `/favicon.ico` + `/favicon.svg`
for both the wallet window and the settings page — the wallet bundle ships no favicon of its own; if
it ever does, the web-root file wins. `assets/Sen-VariableFont.ttf` (copied from
`design-system/fonts/`) is served at `/desktop-assets/Sen-VariableFont.ttf` so the settings page
renders in the design system's Sen face; its styles mirror the `@obsidion/web-ds` tokens (kept in
sync by hand — the page is standalone HTML).

## Outage resilience (endpoint overrides)

The app is meant to keep working when zk.money's hosting is down, so the endpoints it depends on
degrade in two ways:

- **L1 RPC, Aztec node, and enclave URLs — user-overridable at runtime.** Precedence per key: env
  var (`OBSIDION_L1_RPC_URL` / `OBSIDION_NODE_URL` / `OBSIDION_ENCLAVE_TARGET`) > `endpoints.json`
  in the app's user-data dir > the baked/config default. The L1 and node values are injected into
  the served `index.html` as `window.__ZKMONEY_ENDPOINTS__`, which web-wallet's `env.ts` reads ahead
  of the baked env — so a packaged app retargets with no rebuild. The enclave value takes whichever
  transport the build uses: it rewrites the `/svc/enclave` proxy target live where one is configured
  (sandbox), and otherwise rides `__ZKMONEY_ENDPOINTS__` as a direct dial. Either way it is
  transport only — the TEE must still pass attestation. Only non-trust-anchor endpoints are exposed:
  the config-profile and oxide-manifest URLs stay non-editable — the profile is the wallet's address
  authority, and an editable pointer would swap that authority rather than retarget a transport. A
  "Reset all to defaults" button clears every override. Users edit them on the **settings page** at
  `/desktop-settings`: served by the local server (part of this package, not the wallet bundle, so
  it works even when the wallet can't boot). Reachable four ways — the app opens it automatically
  when the startup probe finds the effective L1 RPC unresponsive, via the platform entry point
  ("Endpoint Settings…" on the macOS Dock menu; a tray icon in the Windows/Linux notification area —
  either opens a second Chrome window, safe alongside the wallet since the page never touches the
  PXE lock), via the `--settings` CLI flag (`open -a "zk.money Desktop" --args --settings`), or by
  navigating there. Mutations are gated by a per-boot token so wallet-origin scripts can't rewrite
  endpoints. Endpoints are read at wallet launch, so "Save & relaunch wallet" restarts the Chrome
  window to apply them; "Reset all to defaults" only clears the form fields — nothing changes until
  Save & relaunch.
- **Config profile — fetched every launch, with the build's own copy as the fallback.** The wallet
  resolves its contract addresses from the config profile named by the baked
  `VITE_CONFIG_PROFILE_URL` on every launch. The bundle also carries the document as it was served
  when the release was built (`build-web.sh` runs `vite build`, which fetches and bakes it), and
  boots from that copy only when the config service cannot be reached at all — network failure,
  timeout, or a 5xx — showing a persistent notice that the configuration may be outdated. A document
  the server *answers* with but the wallet cannot accept — a 404, an expired document, the wrong
  profile or network — is still a fatal, retryable boot error: serving a stale copy there would boot
  the wallet against addresses the deployment has deliberately moved off. So the app survives a
  zk.money hosting outage and a config-CDN outage, on the configuration of its release.
  `web/build-target.json` records what was baked; `build-meta.json` records when the bundle was
  built and which endpoints it baked, and the settings page displays it.

Account-service has deliberately no override: it only gates onboarding (X sign-in, sponsored
claims), which is single-origin by design — when zk.money is down, existing accounts keep working
and new registrations don't.

## L1 transactions (the submit helper)

The dedicated Chrome profile has no wallet extensions, so anything needing an L1 signature (e.g.
funding a SIPA deposit) runs through the **L1 submit bridge**: the wallet prepares the full
transaction and POSTs it to its own origin (`/desktop/l1-submit`, injected as
`window.__ZKMONEY_DESKTOP_BRIDGE__`); the launcher stores it under an unguessable 128-bit id and
opens `http://127.0.0.1:<port>/submit/<id>` in the user's **default** browser — where their real
MetaMask lives — via a second, plain-HTTP loopback listener (plain HTTP because the main server's
certificate names the impersonated hostname; `http://127.0.0.1` is a secure context and injected
wallets work there). The helper page shows the prepared summary and hands the transaction to the
injected wallet, whose own confirmation UI is the review step; on success it reports the tx hash
back, and the wallet (polling same-origin) resumes with receipt-watching over its own RPC. One
pending submission at a time (a new one supersedes the old), 30-minute TTL, page-side failures are
retryable, and a wallet-side poll timeout strands nothing — a late-approved transfer is still an
ordinary send to the deposit address, which SIPA discovery credits on a later sync. The same
mechanism is the intended channel for future self-submitted flows (e.g. rollup-exit refunds).

To change deployment tier, set `VITE_PASSKEY_ENVIRONMENT` and `DESKTOP_PAGE_HOSTNAME`, supply that tier's endpoints and rerun `pnpm build:web`. Startup checks the launcher against the bundle metadata. Production page hostname `wallet.zk.money` and RP `auth.zk.money` are deliberately different.

## Security notes

User-facing caveats (single window, per-profile state, per-platform passkey availability) are in the
user guide. The developer-relevant ones:

- **The local bundle executes under the production origin.** Treat packaging, signing, and
  distribution of this app as security-critical: whoever can modify the bundle can act as the wallet
  origin. `--host-resolver-rules` / `--ignore-certificate-errors-spki-list` / `--test-type` are
  Chrome testing mechanisms; this needs a dedicated security review before consumer distribution.
- **The basic-auth gate does not apply locally** — it's Vercel edge middleware, intentionally absent
  from the static bundle.
- **Signing**: unsigned builds need right-click → Open past Gatekeeper (macOS) or a SmartScreen
  click-through (Windows). Release builds sign + notarize macOS automatically when the signing
  secrets are configured — see Releasing below. A local `dist:mac` signs only if the keychain holds
  a Developer ID identity (set `CSC_IDENTITY_AUTO_DISCOVERY=false` to force unsigned). Windows
  signing is pending a cloud-signing service (post-2023, code-signing certs must live in HSMs;
  electron-builder supports Azure Trusted Signing natively when we procure it). Linux has no
  OS-level signing; releases ship a `SHA256SUMS` file.

## Releasing

The root [README](../../README.md#desktop-releases) describes the release workflow, `.github/workflows/release-desktop.yml`. The comment at the top of the workflow lists the signing secrets.
