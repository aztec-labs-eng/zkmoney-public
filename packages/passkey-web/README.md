# @obsidion/passkey-web

The browser passkey policy for the web fronts: which device may answer a ceremony, which PRF slot becomes the master key, the backup and provider gates, the typed refusals and their copy, and the WebAuthn ceremony wrapper that produces the evidence those rules read. The web wallet and the launch campaign both compose it. A front that composes it carries no rule of its own, so fronts cannot drift from one another.

## Why it sits beside the layering chain, not in it

The chain is `core → contracts → sdk → front-core → web-wallet`. This package sits directly on `core` (the salt, the provider ids, the field modulus, the `PrfSlot` type) plus `@noble/curves` for P-256 public-key recovery, and nothing in the chain imports it. The campaign cannot take `sdk`: sdk compiles the contract artifacts into whatever builds it. `front-core` sits on sdk. So the shared rules live in a leaf that carries no Aztec, no React, no `viem`, and no `Buffer`; SHA-256 comes from WebCrypto.

**May import it:** the web wallet, the launch campaign, and any later web front. **Must not import it:** `sdk` and `front-core`. sdk keeps its own `Fr`-typed derivation; the shared fixture in `test/fixtures/mskPrfParity.json` pins the two derivations to the same vectors.

## Layers

| Folder | What it holds |
| --- | --- |
| `src/policy/` | No DOM. Device posture, the user-agent parser, the phone-reach probe, the provider allowlist and its display names, the refusal errors, the refusal / phone-steps / iOS-floor copy, the environment record, the slot and route rules, the authenticator-class rule, the evidence gates, the two ceremony drivers, and the Aztec-free MSK derivation. |
| `src/ceremony/` | The DOM. `BrowserPasskeyCeremony` over `navigator.credentials` (both salts, attachment and hints, the tab slot), authenticator-data parsing, public-key recovery, byte helpers. Nothing runs at module load, so the root export is safe to import from a node process. |

A change under `src/policy/` that relaxes a refusal, a gate or the provider allowlist reaches every front that composes it, the funded wallet among them. Judge such a change against every consumer's risk, not only for parity.

Three rules are worth knowing before reading the code.

**Only measured providers may create a wallet.** The check runs on the id the provider reports, per authenticator class, so a manager id on a hardware key and a key's id on a phone passkey are both refused. An absent or all-zero id passes, because iCloud reports zeros on iOS and Chromium zeros every roaming key's — so on a browser that withholds the id this is steering, not a gate, and the backup, PRF and route gates are what defend the account. `extraProviders` on the creation driver admits ids beyond that set for a consumer's browser tests, whose virtual authenticator reports a fixed id; production passes none.

**The backup gate applies to phone passkeys only.** At creation the response's transports tell a security key, which holds the only copy of its credential by design, from a phone answering over QR; anything the browser describes less certainly counts as a phone and meets the gate. An assertion carries no transports, so at sign-in the gate exempts any answer from another device and the consumer's anchors decide what it opens. That answer shape still says "key": `impliedKeyTransports` names USB, NFC and smart card (never `ble`, which Chrome reads as the phone route) for another device's answer that cannot be backed up, so a consumer can remember where a key lives on a browser that never created it and send those transports with later requests (`isPhysicalOnly` tells a recorded key list from a synced passkey's).

**A laptop Safari from 18.6 up to 26 mislabels a cross-device answer as its own.** The drivers correct the label under narrow conditions when a consumer says the browser is inside that window; "Route rules" in `docs/account/secret-key.md` states them and what the correction never touches.

**A laptop refuses its own passkey by default; a sign-in may opt in.** The route rule sends a laptop to another device — a phone over QR or a security key — and refuses a `platform` answer, because at creation an unmeasured local route could bind a value no other device reproduces. `runPasskeyAssertion`'s `localAllowed` lets a consumer admit the device's own answer at sign-in: the sheet opens on this computer, no transport restriction is sent (a record naming only `hybrid` must not hide the local copy), and a `platform` answer passes the route check. Its anchors then decide whether that answer opens the account, exactly as for a cross-device one. Creation never takes the opt-in.

## Commands

```shell
pnpm build            # builds @obsidion/core first, then tsc -b
pnpm test             # vitest; test/isolation.test.ts reads dist/, so build first
pnpm typecheck:test   # typecheck the suite
```

The consumers' own scripts build this package before they typecheck, test or bundle.

`test/support/fakePasskeyCeremony.ts` is the one fake authenticator both web fronts' suites drive (real P-256 signatures, a manager × route PRF table). It is test support, not part of the package's exports: a consumer's test support imports it by relative path, the way `packages/web-wallet/test/support/fakePasskeyCeremony.ts` does.
