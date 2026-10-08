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

```shell
cd packages/web-wallet-desktop
npm install

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
npm run dist:mac|dist:win|dist:linux          # installers (preflight + signing: see below)
```

`scripts/build-web.sh` builds the wallet, validates its page hostname and RP, writes both to `build-meta.json`, and composes `config/generated.json` from that metadata and the committed `config/default.json`. Each build reads the committed defaults; local proxy customizations belong in that file. Hosted builds replace the sandbox proxies with `/svc/predicate` pointing to the matching public wallet CDN. Production releases also take the environment's Predicate configuration, as the hosted wallet does. The default environment and hostname are local; a hosted build sets both explicitly. It compiles the Noir contracts first when the artifact set is incomplete or was built from other sources: complete means every artifact `packages/contracts/src/artifacts/lazy/*.ts` imports is on disk, which a bare glob cannot tell (a set carrying another `vendor/oxide` pin's contract names passes one and fails the `@obsidion/contracts` typecheck); current means `target/.noir-store-key`, stamped by a complete `build-contracts`, still matches the sources' content key. An unstamped set rebuilds once.

`web/`, `build-meta.json` and `config/generated.json` are gitignored build outputs, so a fresh clone or a partial copy packages an app that installs and then fails on first launch. `scripts/preflight-package.js` runs as electron-builder's `beforePack` hook — guarding a direct `npx electron-builder`, which is what CI runs, and not only `npm run dist:*` — and refuses to pack unless all three are present, `build-meta.json` carries a usable `pageHostname`/`passkeyRpId` pair matching `config/generated.json` (the pairing the launcher checks at startup), the bundle beside it actually contains the `bakedNodeUrl` that metadata claims, and `web/build-target.json` records `VITE_DESKTOP_BUILD` as exactly `"true"` (a web build lacks the settings page). Regenerate rather than hand-write: a hand-written `build-meta.json` next to a stale `web/` is the one mismatch a hostname comparison alone would miss.

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

Runtime env overrides: `OBSIDION_LOCAL_START_PATH`, `OBSIDION_LOCAL_TEST_TYPE=0`, `OBSIDION_ENCLAVE_TARGET` (the sandbox `/svc/enclave` proxy target), `OBSIDION_CONFIG_PROFILE_URL`, `OBSIDION_BOOT_FROM_BAKED_PROFILE=1`, `CHROME_PATH`. Set the page hostname with `DESKTOP_PAGE_HOSTNAME` at build time; startup rejects a hostname that differs from the bundle metadata.

Branding: `build/icon.png` (the wallet logo, from front-core's `obsidionLogos`) is the
electron-builder app-icon source — auto-converted to icns/ico/png per platform at package time.
`assets/favicon.svg` (same logo) is served by the local server at `/favicon.ico` + `/favicon.svg`
for both the wallet window and the settings page — the wallet bundle ships no favicon of its own; if
it ever does, the web-root file wins.

## Outage resilience (endpoints and configuration)

The app is meant to keep working when zk.money's hosting is down, so the endpoints it depends on
degrade in these ways:

- **Ethereum RPC, Aztec node (plus its API key), and enclave URLs — the wallet's own endpoint editor.**
  The wallet keeps them in this Chrome profile's storage, exactly as on the web, and every place the web wallet offers its editor works
  here too: Settings, the pill and card link before sign-in, and "Change endpoints" on a boot error.
  The launcher neither stores nor injects them; endpoint keys an earlier release saved in
  `endpoints.json` are ignored and dropped on the next save, so users re-enter them once. None of
  these define a trust anchor. The one launcher-side endpoint knob is `OBSIDION_ENCLAVE_TARGET`, a
  developer override that retargets the sandbox `/svc/enclave` proxy: the sandbox mock TEE sends no
  CORS headers, so an enclave typed into the editor on a sandbox build is dialled directly and
  fails, and the variable is the way to point that build at another mock.
- **The settings page.** `/desktop-settings` is a screen of the wallet bundle itself, compiled only
  into desktop builds: `build-web.sh` bakes `VITE_DESKTOP_BUILD=true`, `build-target.json` records
  it, and both `build-web.sh` and the packaging preflight refuse a bundle without it (a web build
  fails if the screen leaks into it). It loads in its own chunk, like `/reset`, so it opens when the
  wallet cannot boot, and it never takes the PXE lock. It shows the wallet's endpoint editor above
  the configuration setting described below. The launcher serves `index.html` there with
  `window.__ZKMONEY_DESKTOP_SETTINGS__` added: a per-boot token, the two configuration values and
  their sources, startup problems, the build date, the shipped profile's stamp and the startup
  profile verdict — no endpoint and no other build detail. Reachable three ways: the app opens it
  automatically when the startup profile check says the wallet would not boot; "Endpoint Settings…"
  on the macOS Dock menu or the Windows/Linux tray icon opens it in a second window of the wallet's
  Chrome (the entry turns on only once that Chrome has answered a `Browser.getVersion` on its pipe,
  which a launch that handed off to another Chrome never does, and is off during a relaunch and
  while quitting; a relaunch or a quit also ends any settings window still being handed over, and
  the replacement starts only once it has exited, so a pipe-less Chrome can never own the profile);
  or the `--settings` CLI flag
  (`open -a "zk.money Desktop" --args --settings`). An invalid configuration value, from the
  environment or a hand-edited `endpoints.json`, is reported in a startup dialog and on the page,
  and saving the page rewrites the file.
- **Save & relaunch.** The page posts the configuration (with the per-boot token), writes the
  endpoint record, then asks the launcher to relaunch; each step that
  succeeds is not repeated when the user presses the button again. The launcher starts the wallet's
  Chrome with `--remote-debugging-pipe` (fds 3 and 4, held by the launcher alone, no TCP listener)
  and relaunches by sending the DevTools `Browser.close` command, never a kill: Chrome then quits
  cleanly and flushes the just-written record on every platform, where Node's `kill` would end it
  abruptly on Windows. `Browser.close` ignores `beforeunload`, so a relaunch ends a transaction in
  progress, as any relaunch does. If Chrome never closes (remote debugging disabled by policy), the
  relaunch stays pending and the page tells the user to restart the app; quitting still works. The
  pipe makes Chrome report `navigator.webdriver` as true to every page of the wallet's profile.
  `npm run test:chrome` runs the relaunch against this machine's Chrome and checks that a value
  stored just before it survives; run it on each platform before a release.
- **Config profile — fetched every launch, with the build's own copy as the fallback.** The wallet
  resolves its contract addresses from the config profile named by the baked
  `VITE_CONFIG_PROFILE_URL` on every launch. The bundle also carries the document as it was served
  when the release was built (`build-web.sh` runs `vite build`, which fetches and bakes it), and
  boots from that copy only when the config service cannot be reached at all — network failure,
  timeout, or a 5xx — showing a persistent notice that the configuration may be outdated. A document
  the server *answers* with but the wallet cannot accept — a 404, an expired document, the wrong
  profile or network — is a fatal, retryable boot error: serving a stale copy there would boot the
  wallet against addresses the deployment has deliberately moved off. So the app survives a
  zk.money hosting outage and a config-CDN outage, on the configuration of its release.
  `web/build-target.json` records what was baked (URL, version, publish and expiry dates), and the
  settings page shows it with the build date.
- **Shipped configuration — the user's way past a profile nobody serves anymore.** A torn-down
  profile (4xx) or one past its `expiresAt` — which the baked copy reaches too, eventually — leaves
  the fallback above with nothing acceptable to boot from. (No published profile sets `expiresAt`
  today, so in practice the trigger is a torn-down profile: zk.money moved on and this app is out
  of date, or zk.money is gone.) The settings page's **Shipped configuration** switch
  (`bootFromBakedProfile` in `endpoints.json`, or `OBSIDION_BOOT_FROM_BAKED_PROFILE=1`, where `=0`
  forces it off over a saved on) rides `__ZKMONEY_ENDPOINTS__` into the wallet, which then boots
  from the baked copy without fetching and past its expiry; identity, network and version checks
  still run, and the wallet shows a persistent notice naming the setting and the publish date. It
  needs no address from anyone, so it is the answer to reach for first, and it is what the settings
  page and the user guide point at. The switch is disabled on a build that baked no profile.
- **Config-profile URL — editable, and the one setting that can cost a user their funds.** The
  settings page's **Configuration URL** field (`configProfileUrl` in `endpoints.json`, or
  `OBSIDION_CONFIG_PROFILE_URL`) rides `__ZKMONEY_ENDPOINTS__` into the wallet and replaces
  `VITE_CONFIG_PROFILE_URL`. This deliberately breaks the rule the endpoints keep: the profile IS
  the wallet's address authority, documents carry no signature, and the checks that survive an
  override — profile id, network, schema, expiry, `assertProfilePolicy` — are format checks any
  author can satisfy. A hostile document therefore routes funds to hostile contracts. It is exposed
  anyway because a user whose profile nobody serves has no other way to name a replacement, and
  because refusing it does not stop a determined user (the bundle is on their disk). What
  containment there is, is by design and must stay: the wallet honors the injected value only in a
  desktop build with the launcher's bridge present, so the hosted bundle ignores it; outside sandbox
  the URL must have the `/profiles/<generation>/<current|x.y.z>.json` shape artifact addresses
  derive from (the page refuses another before saving, the wallet before fetching); the expected
  profile id is **not** overridable alongside the URL, so an overridden URL must still serve *this
  build's* profile for *this build's* network; the shipped-configuration switch wins over it (the
  launcher does not inject the URL while that switch is on); a `file:` or other non-http(s) URL is
  refused; and the wallet shows a persistent pink notice naming the address for as long as it runs
  on it (`CustomProfileNotice`). The settings page carries the fund-loss warning next to the field,
  and points at the switch above it as the safe alternative. When the URL is set but unreachable,
  the wallet falls back to the baked copy as usual — so that case shows the baked notice, not the
  custom one.
- **The startup profile check routes to the settings page.** The launcher fetches the effective
  profile URL — the user's override, else the one in `web/build-target.json` — and classifies the
  answer the way the wallet will: a 4xx, an expired document or a non-profile body is *rejected*;
  no answer, a 5xx or a cut-off body is *unreachable*. The app opens the settings page instead of
  the wallet when the wallet would refuse to boot — a rejected document, or an unreachable one on a
  build whose baked copy is missing or has itself expired — unless the shipped-configuration switch
  is already on. The check runs again on a relaunch from the settings page, so a saved value that is
  still bad lands back on the page with the verdict instead of on the wallet's boot error. A
  cut-short response body counts as unreachable, as the wallet counts it, never as a verdict on the
  document. The verdict is shown on the page in every case, including "the service answered
  normally" while the switch is on, so the user knows to turn it off. The wallet's configuration
  error screen links to the settings page too, via the `settingsPath` the launcher adds to
  `__ZKMONEY_DESKTOP_BRIDGE__`. The launcher does not check the Ethereum RPC: it cannot see the
  one saved in the wallet, and the wallet's boot error names an unreachable one and offers the
  editor.

Account-service has deliberately no override: it only gates onboarding (X sign-in, sponsored
claims), which is single-origin by design — when zk.money is down, existing accounts keep working
and new registrations don't.

## L1 transactions (the submit helper)

The dedicated Chrome profile starts with no wallet extensions, so anything needing an L1 signature
(e.g. funding a SIPA deposit) runs through the **L1 submit bridge**: the wallet prepares the full
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

A submission created with `recheck: true` also needs the wallet's approval for each send. When the
user clicks send, the helper page posts `/submit/<id>/check` and polls `/submit/<id>/state`; the
wallet page sees `checking` in its status poll, runs its own check and answers on
`/desktop/l1-submit/<id>/recheck`. Only the wallet origin serves that route, so the helper cannot
approve itself. The helper opens the injected wallet only after `authorized`. A refusal ends the
submission; no answer within 20 seconds (for example, the wallet stopped polling) sends nothing.
Each check is numbered, so an answer to an earlier check is refused. A wallet prompt opened under an
earlier approval can still send after a refusal or supersede, so its reported hash is still recorded. The launcher lists `recheck` in
`window.__ZKMONEY_DESKTOP_BRIDGE__.capabilities`, and the wallet refuses a checked send on a launcher
without it.

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
