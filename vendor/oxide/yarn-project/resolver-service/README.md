# @oxide/resolver-service

The SIPA resolver resolves an ENS name to a counterfactual **SIPA** (Segregated Incoming Payment Address). It is an EIP-3668 CCIP HTTP gateway (`node dest/main.js`). Per request it reads the user and resolver entry through the NameRegistry, allocates the next `(user, day)` nonce, derives `sharedSecretSalt`/`recipientCommitment`/`recoveryCommitment`, generates the resolver-circuit honk proof, and returns the `(proof, publicInputs)` blob that the SIPAResolver's `resolveWithProof` consumes to yield the SIPA.

The resolver does not watch, broadcast or announce SIPAs. The recipient wallet derives the same salt with its own private key and the operator public key, checks the SIPA of each nonce of a day for funds, and broadcasts the sweeps. Nonces of a `(user, day)` start at 0. A nonce can have no funded SIPA: an unpaid resolve or a failed request still uses it. Wallets must scan past empty nonces.

| `OXIDE_RESOLVER_MODE` | store | rate limiter |
| --------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `local` (default)     | LMDB at `_DATA_DIR` (Postgres when `_DB_URL` set) | Redis at `_REDIS_URL`, or `memory:` in-process  |
| `gateway`             | Postgres at `_DB_URL`                             | Redis at `_REDIS_URL`                           |

`local` runs one process, for dev and e2e. `gateway` is one instance of the Lambda fleet: the instances share one SQL store, so the gateway capacity is the instance count. The store holds only the nonce counters. Each process drops the counters of past days once a day.

The per-`(IP, name)` rate limiter is enforced strictly: while its store is unreachable every resolve is refused (503) rather than admitted unchecked.

The gateway refuses a name with 409 (outcome `undepositable_portal`) when the operator entry's forwarding table serves a rollup version other than the user record's, or when no deposit token has a table row whose portal is open on the canonical rollup. This stops payers from funding a SIPA on an old rollup.

The gateway answers 400 (outcome `invalid_request`) to a request whose `{data}` is not `resolve(bytes,bytes)` calldata that wraps `addr(bytes32)`, or whose POST body is not JSON `{sender, data}`. It does not log this answer at error level, so a scanner does not look like a gateway fault.

The gateway answers 404 (outcome `unknown_name`), with no error log, to a name with no owner in the NameRegistry or with no record in the current metadata registry. A CCIP client sends such a name only when the gateway's L1 node lags the client's node after a registration, or when `OXIDE_RESOLVER_NAME_REGISTRY_ADDRESS` names a NameRegistry other than the one that the Resolver module reads. In all other cases the on-chain resolver reverts before the gateway call.

Which address the limiter buckets by depends on `OXIDE_RESOLVER_PROXY_KIND`, and every value is load-bearing: pick the wrong hop and a client either forges its own bucket per request or every client collapses into a single bucket keyed by the proxy's address. The prod gateway sits behind CloudFront in front of API Gateway (`cloudfront`), reading `CloudFront-Viewer-Address` — set by CloudFront itself, unforgeable by the client.

## Configuration

| env var                                                 | required          | meaning                                                                                                                                                                                         |
| ------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OXIDE_RESOLVER_MODE` | no | `local` (default) / `gateway` |
| `OXIDE_RESOLVER_PRIVATE_KEY`                            | yes               | circuit `resolverPrivateKey` (32-byte hex); its public key must be the one registered on-chain                                                                                                  |
| `OXIDE_RESOLVER_NAME_REGISTRY_ADDRESS`                  | yes               | NameRegistry contract address — record reads go through it                                                                                                                                      |
| `OXIDE_RESOLVER_ADDRESS`                                | yes               | Resolver module this service answers for, and the only EIP-3668 sender the gateway accepts                                                                                                      |
| `OXIDE_RESOLVER_SIPA_FACTORY_ADDRESS`                   | yes               | SIPAFactory contract address (SIPA create2 prediction)                                                                                                                                          |
| `OXIDE_RESOLVER_L1_RPC_URL`                             | yes               | L1 RPC                                                                                                                                                                                          |
| `OXIDE_RESOLVER_DATA_DIR` | without `_DB_URL` | data directory of the LMDB store |
| `OXIDE_RESOLVER_DEPOSIT_TOKENS` | yes | comma-separated ERC20s a SIPA may be funded with. The gateway refuses a name when no portal of these tokens is open |
| `OXIDE_RESOLVER_DB_URL` | gateway | shared SQL store (`postgres://…`); absent in `local` mode → LMDB under the data dir |
| `OXIDE_RESOLVER_DB_CA_PATH`                             | no                | CA bundle the SQL store's TLS certificate is verified against; the image defaults it to a baked AWS bundle. Unset → no TLS (local Postgres)                                                     |
| `OXIDE_RESOLVER_REDIS_URL` | yes | shared rate-limiter store (`rediss://…`); `memory:` selects the in-process limiter in `local` mode |
| `OXIDE_RESOLVER_PROVER_THREADS`                         | no                | proving threads (default `min(16, cores)`)                                                                                                                                                      |
| `OXIDE_RESOLVER_NOIR_EXECUTE_BINARY_PATH`               | no                | `noir-execute` binary from a noir release that solves the circuit witness natively, faster than the wasm solver noir_js bundles and to the same witness; the image bakes one and points here. Unset → wasm |
| `OXIDE_RESOLVER_HTTP_HOST` / `OXIDE_RESOLVER_HTTP_PORT` | no                | listener bind address (default `127.0.0.1:8081`; `0` picks an ephemeral port)                                                                                                                   |
| `OXIDE_RESOLVER_RATE_REQUESTS_PER_HOUR`                 | no                | resolves allowed per `(IP, name)` per hour (default 100)                                                                                                                                        |
| `OXIDE_RESOLVER_PROXY_KIND`                             | no                | `none` \| `apigw` \| `cloudfront`: which ingress fronts the listener, and so where the client IP for rate-limit bucketing comes from. Defaults to `apigw` in gateway mode and `none` in local mode. |

`OXIDE_RESOLVER_{PRIVATE_KEY,DB_URL,REDIS_URL}_SECRET_ID` are accepted in place of the values themselves: each names an AWS Secrets Manager secret fetched at startup. That is how the Lambda-hosted gateway is configured — a value in Lambda env config would be readable via `GetFunctionConfiguration`.

## Tests

`yarn test` runs the LMDB leg of the store contract suite. The Postgres leg and the rate-limiter suite need live backing services, and skip themselves when not pointed at one:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine
docker run --rm -d -p 6379:6379 valkey/valkey:7-alpine
OXIDE_TEST_PG_URL=postgres://postgres@localhost:5432/postgres \
OXIDE_TEST_REDIS_URL=redis://localhost:6379 yarn test
```
