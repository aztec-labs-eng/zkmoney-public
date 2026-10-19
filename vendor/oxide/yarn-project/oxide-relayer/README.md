# Oxide relayer image

The `@oxide/oxide-relayer` workspace builds the long-running L1 operation relayer. Its default mode is `l1-operations`. It reads a public list of deployments, pins one of them, and runs one worker for every listed deployment on the pinned deployment's L2 that its policy selects. Each worker discovers that deployment's L2 Broadcaster operations and keeps a SQLite database for its Portal. Submission uses a separate funded L1 signer. `DISABLE_SUBMISSION=true` runs fisherman checks and records fake sends as executed.

## Build

Use Node 24, Aztec 5.2.0, Docker Buildx, and the Foundry toolchain. From the repository root:

```sh
deployer/bash/relayer/prepare-relayer-image.sh
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load \
  -f yarn-project/oxide-relayer/Dockerfile -t oxide-relayer:local .
```

The preparation command builds production L1 ABI modules and the L2 and refund artifacts used by the image. The Dockerfile installs the locked Yarn workspace, builds the relayer dependency chain, and keeps production dependencies. Publish an immutable image digest for a persistent deployment.

## Public releases

The [release workflow](../../.github/workflows/release.yml) publishes this repository's image to a separate GHCR package when a `relayer/vX.Y.Z` or `relayer/vX.Y.Z-rc.N` tag is pushed. Its `IMAGE` value is a dummy placeholder until the final package name is chosen. This image is separate from upstream's Docker Hub `azteclabs/oxide-relayer` image. The workflow requires the tagged commit to be on `main`, prepares the same image inputs as the local build above, verifies `--version`, pushes the versioned image, checks that it is anonymously pullable, and creates a GitHub release containing its digest. Stable releases also move the applicable `X.Y`, `X`, and `latest` tags when they are the newest version in each line. Release candidates only get their full version tag. The private ECR image built by the [deployment workflow](../../.github/workflows/relayer-deploy.yml) remains a separate deployment artifact.

Before the first tag, replace `ghcr.io/REPLACE_ME/oxide-relayer` in the workflow with a package under this repository's GHCR organization, and protect creation of `relayer/v*` tags with a repository ruleset. The GitHub `release` environment already permits only `relayer/v*` tags. The workflow uses this repository's `GITHUB_TOKEN` with `packages: write`, so no registry password is needed. Tag a reviewed commit on `main` and push the tag, for example `git tag relayer/v1.2.3 && git push origin relayer/v1.2.3`. GitHub makes a new GHCR package private by default. After the first image push, change that package's visibility to **Public** in the organization's package settings, then rerun the workflow. It checks anonymous pull access before moving floating tags or creating the GitHub release. Push one relayer release tag at a time; the workflow serializes releases and GitHub keeps only one pending run in a concurrency group.

## Runtime inputs

Set `OXIDE_DEPLOYMENT_ENV_MANIFEST_URL`, `OXIDE_PORTAL`, `READ_L1_RPC_URL`, and `AZTEC_NODE_URL`. The CLI accepts equivalent `run` options; use `docker run --rm oxide-relayer:local run --help` to inspect them.

`OXIDE_DEPLOYMENT_ENV_MANIFEST_URL` (`--deployment-env-manifest`) names the releases list, `v<major>/<env>/releases.json`, a schema v4 deployment env manifest that lists every published deployment with a channel. It can be an `https://` URL, a `file://` URL, or a path. Each entry supplies the Portal, L2 token, rollup version, advertised payout token, enclave URL, Broadcaster, OperationExecutor, plain withdrawal executor, subsidies, and FPC funder. The relayer rejects a list with two entries for one Portal or one label. If the list cannot be read at startup, startup fails.

`OXIDE_PORTAL` (`--portal`) pins one entry of that list, which must be present; otherwise startup fails and the error names the available deployments. The pinned entry's rollup version selects the L2 the process serves: at startup the relayer compares it with the rollup version the Aztec node reports and refuses to start on a mismatch, so a wrong node URL cannot make a process serve another L2. `fpc-funding` and `epoch-proofs`, when enabled, run for the pinned entry only, and its label is the telemetry `service.version`.

With `l1-operations`, the relayer runs a worker for every entry in the list that has `withdrawalProtocol: l1-operation` and the pinned entry's rollup version, subject to the policy below. The pinned entry's worker starts first and a failure there stops the process; every other worker starts in the background with bounded retries and never stops the process. Each worker logs `deployment worker started label=<label> portal=<portal>` when it is running. The relayer rereads the list every five minutes and adds workers for new entries; it never stops a worker, and a read that fails or that changes the pinned entry's rollup version is logged and ignored. The state path must contain `{portal}` when more than one worker may run. When two served entries share a Broadcaster, the relayer logs a `shared broadcaster` warning naming their Portals and keeps running; both workers then record every operation on it.

One relayer ID has one signer, host and state volume. Multiple IDs may pin entries on the same L2 and serve the same Portal, but they may race to submit the same operation. A separate ID is needed for another L2 because one process uses one Aztec node. The deployment workflow takes the major version and pinned Portal, builds the manifest URL from the environment domain, and resolves the node for that entry's rollup version. Its verified receipt records the policy and the Portals seen at verification. App-entry composition uses that receipt and the current releases list to decide whether to run a funded-deposit smoke; an entry without a serving relayer can still publish with that step marked skipped.

The policy decides which of those entries get a worker and is applied on every read:

- `OXIDE_RELAYER_EXCLUDE_PORTALS` (`--exclude-portals`), optional: a comma-separated list of Portals that get no worker. A skipped entry is logged with reason `excluded`.
- `OXIDE_RELAYER_L1_OPERATIONS_PAYOUT_TOKENS` (`--l1-operations-payout-tokens`), optional: a comma-separated list of 18-decimal USD tokens. When it is set, every worker accepts the listed tokens as L1-operation payout, and an entry whose advertised token is not listed gets no worker, logged with reason `payout-token`. When it is unset, each worker accepts only its own entry's advertised token. Each operation's own payout token is still checked against the worker's list.

The pinned entry follows the same policy: it can be excluded or skipped on its token, in which case the relayer logs that it gets no worker while `fpc-funding` and `epoch-proofs` still run for it. The watched deposit tokens come from each entry's advertised token: DAI, USDC, and USDT on mainnet and that token on other chains.

Mount durable storage at `/data` for the default `oxide-relayer-{portal}.sqlite3` files. Supply either a keystore and password file under the mount or an L1 private key through the configured secret environment. Fund the L1 signer with ETH. The read RPC must support `eth_simulateV1` with validation; the Aztec node and each served entry's enclave must be reachable. The configured Chainlink feed and sanctions-list endpoint must be reachable.

For a reader coming from upstream oxide: the inputs and flag names are upstream's. The two differences are the startup check of the pinned entry's rollup version against the node, and the policy, that is the exclude list and the token admission rule, which upstream does not have.

Start the relayer before clients broadcast operations and check that its L2 cursor advances. Observe one transaction through discovery, simulation, screening, L1 execution, and receipt. Back up the SQLite state and monitor discovery lag, deferred operations, signer ETH, and the sanctions-list refresh. The L2 transaction payload is available only for a short window; an operation broadcast before discovery cannot be recovered after its payload is pruned.
