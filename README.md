# zk.money wallet

Source of the zk.money web wallet and the zk.money Desktop app. This tree builds the release that runs on mainnet today: config profile `prod-v5`, Oxide label v6 (Oxide commit `edf0c71d5`), Aztec `5.2.0`.

## Layout

| Path | Contents |
| --- | --- |
| `packages/web-wallet` | The browser wallet (React + Vite). The PXE runs in the browser. |
| `packages/web-wallet-desktop` | The Electron launcher that serves the built web wallet locally. |
| `packages/core`, `contracts`, `sdk`, `front-core` | The wallet stack: shared types, Noir contracts, contract calls, and app logic. |
| `packages/config-client`, `passkey-web`, `design-system`, `proving-progress`, `metrics-policy` | Libraries that the wallet imports. |
| `packages/oxide-build` | Builds the vendored Oxide packages. |
| `vendor/oxide` | The subset of Oxide that the wallet needs, at commit `edf0c71d5`. |

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 20.10 or later |
| pnpm | 9.14.4 (`corepack enable`) |
| Yarn | 4 (`corepack` supplies it for `vendor/oxide/l1-contracts`) |
| Foundry (`forge`) | 1.4 or later |
| Aztec toolchain | 5.2.0 (`aztec`, `aztec-nargo`) |
| rsync, bash | any; macOS and Linux have them |
| Google Chrome | any; the desktop app opens the installed Chrome (or set `CHROME_PATH`) |

The contract build fetches Noir dependencies from github.com.

## Build

```shell
git clone --recursive <this repo>
cd zkmoney-public
pnpm install --frozen-lockfile
pnpm build-contracts        # Noir contracts, Oxide build, then the contracts package
pnpm build:web-deps
```

You must supply three values yourself: an Aztec mainnet node URL (`VITE_NODE_URL`), its API key if the node needs one (`VITE_NODE_API_KEY`), and an Ethereum mainnet RPC URL (`VITE_L1_RPC_URL`). The example files hold all other mainnet values.

### Web wallet

```shell
cp packages/web-wallet/.env.mainnet.example packages/web-wallet/.env.production
# Fill VITE_NODE_URL, VITE_NODE_API_KEY and VITE_L1_RPC_URL.
pnpm --filter @obsidion/web-wallet build
```

The build fetches the `prod-v5` config profile and bakes it into the bundle. The build fails if the profile, the network, or the Oxide pointer does not agree. The output is in `packages/web-wallet/dist`.

### Desktop app

```shell
cd packages/web-wallet-desktop
cp config/mainnet.env.example config/mainnet.env
# Fill VITE_NODE_URL, VITE_NODE_API_KEY and VITE_L1_RPC_URL.
npm ci
ENV_FILE=config/mainnet.env SKIP_MONOREPO_BUILD=1 pnpm build:web
pnpm start                  # run from source
pnpm dist:mac               # or dist:linux, dist:win
```

The installers are in `packages/web-wallet-desktop/dist`. They are not signed. macOS shows a Gatekeeper warning for an unsigned app.

See [packages/web-wallet-desktop/README.md](packages/web-wallet-desktop/README.md) for how the launcher serves the wallet under `wallet.zk.money`.

## Desktop releases

`.github/workflows/release-desktop.yml` builds the macOS, Windows and Linux installers and attaches them to a draft GitHub release.

1. In the repository settings, create the environment `production`. Add the secrets `WEB_WALLET_NODE_URL`, `WEB_WALLET_L1_RPC_URL` and, if the node needs one, `WEB_WALLET_NODE_API_KEY`.
2. Optional: add the signing secrets. The comment at the top of the workflow lists them. Without them, the installers are unsigned.
3. Push a tag: `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`. A tag with a hyphen, such as `desktop-v0.1.0-rc1`, makes a pre-release.
4. Review the draft release and publish it. The download links `releases/latest/download/zkmoney-desktop-mac-arm64.dmg` and the other installer names then resolve to it.

**Caution:** the node URL, the node API key and the L1 RPC URL go into every installer in plain text. Use endpoints that you can make public.

## Tests

Each package runs its unit tests with `pnpm test`. The tests need no sandbox and no network.

The desktop smoke test (`packages/web-wallet-desktop`, `pnpm test`) expects a time zone at UTC or east of UTC. In a time zone west of UTC, run it with `TZ=UTC pnpm test`.

## License

MIT. See [LICENSE](LICENSE).
