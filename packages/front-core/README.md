# @obsidion/front-core

## What belongs here

The wallet engine: the `Database` and its persistent **Stores**, the **Services**, **Queries**
and **Tasks** with the **Runtime** that runs them, non-contract business logic, HTTP services
(relayer, gateway, ENS/CCIP-Read clients), pure data transforms, and the React hooks and contexts
over the engine, such as `useStore`. Anything you'd want to share between wallet fronts belongs here. The engine
follows the [wallet architecture and coding guidelines](../../docs/conventions/wallet-architecture.md).

Concrete examples already in this package:

- `createBalanceStore` — the account's last balance reads on the `Database`.
- `createContacts` — the account's contact book on the `Database`.
- `createSipaDeposits` — the session's SIPA deposit records on the `Database`.
- `selectFeed` — the activity feed as a pure selector over the stores.
- `openAccount`, `openToken`, `openTeeSigner` — **Services** over the wallet, built with
  `service` (`engine/service.ts`).
- `queries` — builds each **Query**, a remote value cached by its arguments (`engine/query.ts`).
- `startRuntime` — runs a **Session**'s **Tasks** (`engine/runtime.ts`).

What does NOT belong here:

- `contract.methods.X()` calls or on-chain-typed payloads →
  `@obsidion/sdk`.
- Noir source or contract codegen → `@obsidion/contracts`.
- Browser-only runtime adapters (the OPFS `DatabaseBackend`, the OPFS
  PXE store, WebAuthn glue) → `web-wallet/src/`.

This package depends on `@obsidion/sdk` for shared types (account /
wallet / address / network shapes) and for a small number of utility
helpers and service entry points that the asset and account flows
compose against at runtime.
What it does NOT do is originate contract method calls of its own —
no `contract.methods.X()` lives in this package. If a future PR adds
one, that code belongs in `@obsidion/sdk`, not here.

See the root `CLAUDE.md` "Package Layering" section for the full rule
set, decision tree, and gotchas.
