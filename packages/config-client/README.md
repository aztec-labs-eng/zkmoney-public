# @obsidion/config-client

The config-profile contract every consumer shares: the schema that defines a profile document, the client that fetches and resolves one, and the mapping from a profile into the snapshot `ContractService` consumes. It holds a vocabulary, not a service — zero runtime logic beyond those three jobs, and no workspace dependency but `@obsidion/core`.

The documents themselves, the dev server, and the publish tooling live in `packages/backend/config-service`, which imports this package like any other consumer. **That README is the normative reference for the document shape and the publishing contract**; this one covers the package.

## Why it sits beside the layering chain, not in it

The monorepo's chain is `core → contracts → sdk → front-core → web-wallet`, each layer free to import the ones below it. This package is **beside** that chain: it sits directly on `core` (plus zod), and nothing in the chain imports it.

That placement is load-bearing. `contracts` must stay ignorant of the profile vocabulary — `ContractService` takes a plain `ContractServiceConfig` snapshot that `@obsidion/core/types` declares, and `toContractServiceConfig` is the single place profile keys become that snapshot. The obvious home for a fetch client would be `front-core`, where every other HTTP client belongs, but `front-core` sits *above* `contracts`, so the contracts layer's own composition root could never reach it.

**Import rules:**

- **May import it:** composition roots (whatever owns `main()`) and backend services. They acquire config and hand the snapshot down.
- **Must never import it:** `contracts`, `sdk`, `front-core`. They receive a snapshot; they do not learn where it came from.

This is not precedent for putting HTTP clients outside `front-core`. It is the one exception, for the one reason above.

## Modules

| Module | What it is for |
| --- | --- |
| `schema.ts` | The normative document definition and `parseConfigProfile`. Strict for every shape it speaks — an unrecognized key is a schema bump, not a silent passenger — with one deliberate blind spot: a version entry whose own `schemaVersion` this build does not know is carried opaquely, validated no further than the marker's grammar. |
| `client.ts` | `fetchConfigProfile(url)` then `resolveVersion(profile)`. Every failure is typed and fatal — a client that cannot resolve its profile says so at boot rather than degrading to silently-stale config. One code is set apart: `UNREACHABLE` (the request failed, the deadline passed, the body stream ended, or the status was not a 4xx) is the only failure a consumer may cover with a document it baked in at build time, through `parseServedProfile` — the same parse-and-expiry rulebook the fetch path applies. A 4xx is an answer and never falls back: this store answers a missing key with 403, so treating it as silence would let a torn-down profile boot off a snapshot. The other tolerance is for keys zod reports as unrecognized (top-level, `shared`, version, `oxide`), which the fetch path prunes so a published field addition never bricks a shipped binary; a field added inside a contract entry parses through the L1/L2 union and stays fatal (entries extend through `meta`). A version entry whose own `schemaVersion` the build does not speak is likewise tolerated — opaque at parse, and typed-fatal (`UNSUPPORTED_VERSION_SCHEMA`, "app update required") only when `resolveVersion` lands on it, so a consumer pinned to an entry it does speak survives the entry shape moving on. Direct `parseConfigProfile` stays strict for the authoring gates. |
| `toContractServiceConfig.ts` | Profile → `ContractServiceConfig`. The one place the two vocabularies meet, so no consumer maps by hand and a key rename stays a one-file change. |
| `walletProfile.ts` | `resolveWalletProfile` — the whole wallet boot sequence in one call: obtain the document, `profileId` then `network` identity, rollup binding, live-version resolution, vkey-skew compare, snapshot. Both wallets share it so the checks cannot drift apart. Everything after "obtain the document" is `resolveWalletProfileDocument`, a pure function, so a caller-supplied `bakedProfile` — consulted only when the live fetch is `UNREACHABLE` — and a build-time check run exactly the checks a served document runs; the result says `bootedFromBakedProfile` and carries the live failure it stood in for. Identity failures are fatal; a network mismatch raises a distinct type, because it is the one case a root may answer by booting the registry path instead. |

## Network constants are pinned to core, not derived from it

`PROFILE_NETWORKS` and `NETWORK_L1_CHAIN_IDS` restate values `@obsidion/core/constants` also carries (`Network`, `L1_CHAIN_ID_BY_NETWORK`). Restating them is deliberate: these literals are a **wire contract**. They govern what a document already published to a bucket, and read by already-shipped binaries, is allowed to contain — so they should move by a deliberate schema change, never by silently following an app constant, which would retroactively invalidate documents that were valid when published.

Silent *divergence* is the real hazard, since it would leave the validator and the wallet disagreeing about the same network. `test/schema.test.ts` pins the two together, so drift is a failing test to resolve on purpose rather than a gap nobody sees.

## Commands

```shell
pnpm build            # builds @obsidion/core first, then tsc -b
pnpm test             # vitest
pnpm typecheck:test   # typecheck the suite
```
