# @obsidion/generation-v5

The Aztec v5 source generation: wallet code built for Aztec 5.2.0 that the v6 web wallet loads to read and refund a frozen v5 deployment. See [metadata migration](../../docs/state-migration/metadata-migration.md#source-proof-systems).

## Build

1. Install the v5 toolchain: `aztec-up install 5.2.0`.
2. Run `pnpm --filter @obsidion/generation-v5 build:bundle`.

The build checks out the wallet commit in `source.json` at `.source/`, extracts the pinned Noir artifacts there, builds it with the v5 toolchain, and writes the bundle and its manifest to `dist/`. It compiles no Noir. Set `GENERATION_V5_SOURCE` to build in another checkout of that commit, and `AZTEC_V5_HOME` to use a toolchain outside `~/.aztec/versions/5.2.0`.

## Pins

The bundle's Noir artifacts come from two pins, and `scripts/pins.mjs` checks every file's sha256 before it extracts it:

- `pinned/v5-wallet-artifacts.tar.gz` holds the wallet commit's own contracts and circuits. `pinned/v5-wallet-artifacts.json` records the wallet commit, each file's sha256 and each contract's class id. The build fails when that commit is not `walletCommit`, or when the `oxidePin` commit does not descend from the wallet commit's vendored Oxide.
- Oxide's v5 token, broadcaster and refund circuits come from Oxide's pin, `noir-projects/pinned-noir-artifacts.tar.gz`, at the `oxidePin` commit in `source.json`, on Oxide's `v5-pinned` branch.

Each pinned file names its source paths from the bundle's fixed roots (`v5-wallet/`, `nargo/`), so a pinned build gives the same bundle as a build from source.

To move the wallet pin, change `walletCommit` to a v5 commit. In a checkout of that commit, put the v5 toolchain on `PATH` and run `pnpm install` and `pnpm build-contracts`. Then run `GENERATION_V5_SOURCE=<that checkout> node scripts/pins.mjs pin` with GNU tar on `PATH`, and commit `pinned/`. The adapter in `adapter/` compiles against that commit's packages, and the build typechecks it there.

## Check

The manifest holds the sha256 of every bundle file. `pnpm --filter @obsidion/generation-v5 check:bundle` checks `dist/` against it. It also checks that the manifest records the pinned wallet commit, this checkout's protocol and the hash of this checkout's bundle inputs. Nothing fixes the bundle's content in git.

## Publication

A push to `main` or `v6` that changes the bundle publishes it to the `source-generations` release as `generation-v5-<wallet commit>-protocol-<protocol>-<inputs hash>.tar.zst` (`assetName` in `scripts/check.mjs`). The inputs hash is the first 12 hex digits of a sha256 over the files that the build takes from this checkout: `adapter/`, the boundary in `packages/core/src/types/sourceGeneration.ts`, `source.json`, the wallet pin's manifest, `scripts/build.mjs` and `scripts/pins.mjs` (`bundleInputs` in `scripts/check.mjs`). An adapter change can change the bundle at one wallet commit and one protocol, so the hash gives it a new name. The manifest records the hash as `inputs`. The CI never replaces a published bundle. The deploys run `fetch:bundle` to download the bundle of this name, and build it only when the release has none. `fetch:bundle` reads the asset from the `source-generations` release, else from the release whose tag is the asset name without `.tar.zst`. A repository with immutable releases cannot add an asset to a published release, so it publishes each bundle in its own release. `fetch:bundle` keeps `dist/` only when its manifest records the same wallet commit, protocol and inputs hash.

`manifest.json` records `protocol`, the `SOURCE_GENERATION_PROTOCOL` that the bundle speaks. `check:bundle` and the web wallet refuse a bundle of another protocol. Change the constant in `packages/core/src/types/sourceGeneration.ts` on any boundary change that a built bundle cannot serve.

## Discover retired resolver senders

The host reads complete `ResolverOperatorUpdated` entries from the source metadata registry. It selects the source forwarding table and gateway, then applies the operator trust policy. It passes every distinct historical sender from that operator to the v5 bundle. The bundle registers those senders before it reads SIPA notifications. It does not read current operator storage or substitute the destination sender.

Recovery requires RPC access to the complete source deployment window.
