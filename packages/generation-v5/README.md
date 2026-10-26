# @obsidion/generation-v5

The Aztec v5 source generation: wallet code built for Aztec 5.2.0 that the v6 web wallet loads to read and refund a frozen v5 deployment. See [metadata migration](../../docs/state-migration/metadata-migration.md#source-proof-systems).

## Build

1. Install the v5 toolchain: `aztec-up install 5.2.0`.
2. Run `pnpm --filter @obsidion/generation-v5 build:bundle`.

The build checks out the wallet commit in `source.json` at `.source/`, builds it with the v5 toolchain, and writes the bundle and its manifest to `dist/`. Set `GENERATION_V5_SOURCE` to build in another checkout of that commit, and `AZTEC_V5_HOME` to use a toolchain outside `~/.aztec/versions/5.2.0`.

To move the pin, change `walletCommit` to a v5 commit and rebuild. The adapter in `adapter/` compiles against that commit's packages, and the build typechecks it there.

## Pin

`pin.json` names the sha256 of the bundle's `manifest.json`. The manifest holds the sha256 of every bundle file, so the pin fixes the whole bundle in git. The build prints the digest.

- After a change to an input of the bundle, rebuild and set `manifestSha256` to the printed digest. The bundle CI fails until the pin matches its build.
- `pnpm --filter @obsidion/generation-v5 check:bundle` checks `dist/` against the pin. It also checks that the manifest records the pinned wallet commit, this checkout's protocol and the hash of this checkout's bundle inputs.
- The web wallet build serves only a pinned bundle when `REQUIRE_SOURCE_GENERATIONS=true`. A local build serves an unpinned bundle with a warning.

## Publication

A push to `next` or `v6` that changes the bundle publishes it to the `source-generations` release as `generation-v5-<wallet commit>-protocol-<protocol>-<inputs hash>.tar.zst` (`assetName` in `scripts/check.mjs`). The inputs hash is the first 12 hex digits of a sha256 over the files that the build takes from this checkout: `adapter/`, the boundary in `packages/core/src/types/sourceGeneration.ts`, `source.json` and `scripts/build.mjs` (`bundleInputs` in `scripts/check.mjs`). An adapter change can change the bundle at one wallet commit and one protocol, so the hash gives it a new name. The manifest records the hash as `inputs`. The CI never replaces a published bundle. The deploys run `fetch:bundle` to download the bundle of this name, and build it only when the release has none. `fetch:bundle` keeps or downloads a bundle only when its manifest matches the pin and records the same wallet commit, protocol and inputs hash. `pin.json` is not a bundle input, so a commit that only moves the pin keeps the asset name and the CI cache.

`manifest.json` records `protocol`, the `SOURCE_GENERATION_PROTOCOL` that the bundle speaks. `check:bundle` and the web wallet refuse a bundle of another protocol. Change the constant in `packages/core/src/types/sourceGeneration.ts` on any boundary change that a built bundle cannot serve.

## Discover retired resolver senders

The host reads complete `ResolverOperatorUpdated` entries from the source metadata registry. It selects the source forwarding table and gateway, then applies the operator trust policy. It passes every distinct historical sender from that operator to the v5 bundle. The bundle registers those senders before it reads SIPA notifications. It does not read current operator storage or substitute the destination sender.

Recovery requires RPC access to the complete source deployment window.
