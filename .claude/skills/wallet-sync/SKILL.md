---
name: wallet-sync
description: Sync this repository to the obsidion-wallet release that mainnet runs, verify the sync with a replica of the release CI, and cut a desktop release. Use for "do a sync", "sync to vX", "will this sync work", a review of a sync PR, or a desktop release.
---

# Wallet sync

This repository is the public export of the private wallet repository `obsidion-wallet` (`aztec-labs-eng/obsidion-wallet`). A sync applies the change between two exports to `main`. The sync keeps the public edits that `main` has.

## Rules

- Get approval from the user before each action that leaves this computer: a push, a PR, a change to a secret, a release asset, a tag, a gate approval, or a publish. One approval covers only the action that it names.
- Sync only to the commit that mainnet runs. Do not sync to the tip of `next`. A sync to `next` puts code in the desktop app that no website user runs.
- Do not put SSM parameter names, AWS or CloudFront hosts, internal IPs, private-repository URLs, ticket IDs, API keys or tokens in this repository.

## 1. Find the base and the target

| Item | Command |
| --- | --- |
| Base: the private commit of `main` | `jq -r .source EXPORT-MANIFEST.json` |
| Target: the commit that mainnet runs | `curl -fsS https://cdn.zk.money/profiles/v6/current.json \| jq -r '.versions[.current].gitSha'` |
| The release tag of the target | `git -C "$WALLET" tag --points-at <target>` |
| The Oxide pin | `git -C "$WALLET" ls-tree <commit> vendor/oxide` |

`$WALLET` is a clone of the private repository. If the base is not an ancestor of the target, stop and tell the user.

## 2. Make the two exports

Do these steps for the base and for the target. Use the exporter of the same commit.

```shell
git -C "$WALLET" worktree add --detach "$SCRATCH/wt-$SHA" "$SHA"
git --git-dir="$WALLET/.git/modules/vendor/oxide" worktree add --detach "$SCRATCH/wt-$SHA/vendor/oxide" "$OXIDE_PIN"
(cd "$SCRATCH/wt-$SHA" && node public-export/build.mjs "$SCRATCH/exp-$SHA")
```

The exporter stops if a checkout has tracked changes or if the Oxide checkout is not at the pin.

## 3. Apply the delta to main

1. Make a delta repository with two commits:
   ```shell
   git init -q -b export "$SCRATCH/delta" && cd "$SCRATCH/delta"
   rsync -a --delete --exclude .git "$SCRATCH/exp-$BASE/" ./ && git add -A && git commit -qm "export $BASE"
   rsync -a --delete --exclude .git "$SCRATCH/exp-$TARGET/" ./ && git add -A && git commit -qm "export $TARGET"
   ```
2. Apply the second commit to a branch from `origin/main`:
   ```shell
   git fetch "$SCRATCH/delta" export:tmp-delta
   git switch -c chore/sync-<tag> origin/main
   git cherry-pick --no-commit tmp-delta
   ```
3. Resolve the conflicts:
   - `pnpm-workspace.yaml`: keep the list from `main`. Add or remove only the packages that the delta adds or removes.
   - A file that `main` deleted: keep it deleted, unless the delta adds it as a new file.
   - `vendor/oxide/noir-projects/frozen_deposits_refund/`: keep it as `main` has it. The exporter writes `frozen_deposit_refund`.
4. Run `pnpm install --lockfile-only` with pnpm 9.14.4. Commit as `chore: sync the wallet to obsidion-wallet <tag>`.

## 4. Check the branch

1. Make sure that the public edits did not change. Only hunk offsets, and lines that the delta itself adds or removes, can be different:
   ```shell
   diff <(git diff tmp-delta~1 origin/main | grep -v '^index ') <(git diff tmp-delta HEAD | grep -v '^index ')
   ```
2. Run `node "$WALLET/public-export/check-public-only.mjs" . "$SCRATCH/exp-$TARGET"`. Each file that it flags must be a file that the private repository deleted, or a public edit that step 1 shows. The check also flags the files of this skill, until the private exporter has them in `public-export/overlay/`.
3. Scan the added lines for the items in [Rules](#rules): `git diff origin/main -U0 | grep '^+'`.
4. Make sure that `EXPORT-MANIFEST.json` names the target as `source`.
5. Make sure that `packages/generation-v5/scripts/fetch.mjs` has `BUNDLE_RELEASE`. Without it, `fetch:bundle` reads only `source-generations`, and a new bundle cannot reach this repository. `BUNDLE_RELEASE` is a public edit that the private repository does not have. If the sync has a conflict in `fetch.mjs`, keep it.

## 5. Verify the build

Run the verify script on the local branch. With a warm pnpm store, it takes approximately 15 minutes.

```shell
AZTEC_DIR=~/.aztec/versions/6.0.0 SOURCE_GENERATIONS_REPO=aztec-labs-eng/obsidion-wallet \
  .claude/skills/wallet-sync/verify.sh chore/sync-<tag> "$SCRATCH/verify-<tag>"
```

The script clones the branch. It then runs the `bundle` job and the Linux row of the `installers` job of `release-desktop.yml`. It also does these checks, which CI does not do:

| Check | Pass condition |
| --- | --- |
| `archive-node` | The bundle contains the v5 archive node URL. |
| `classids` | Each built class ID is the same as the live profile. |
| `circuits` | The 3 refund circuits match their L1 verifiers. |
| `relayer`, `relayer-help` | The relayer builds and starts. |
| `typecheck-*`, `test-*` | The typecheck and the tests of each package pass. |
| Clean tree | `git status --porcelain` is empty after the build. |

Use `SOURCE_GENERATIONS_REPO=aztec-labs-eng/obsidion-wallet` until this repository has the bundle of the target (see [6](#6-the-v5-bundle)).

Read `logs/summary.log` in the work directory. If a test fails, run the same test on the private target commit. A failure is acceptable only if it also occurs there.

Write the results in the PR test plan. Mark each check that did not run as not run.

## 6. The v5 bundle

The wallet reads v5 accounts through a prebuilt v5 wallet bundle. The name of the release asset depends on `packages/generation-v5/source.json` and on a hash of the bundle inputs. To get the name, run this command in `packages/generation-v5`:

```shell
node -e 'import("./scripts/check.mjs").then((m) => console.log(m.assetName))'
```

`fetch:bundle` reads the asset from the `source-generations` release, else from the release whose tag is the asset name without `.tar.zst`. The releases of this repository are immutable: nobody can add an asset to a published release, and nobody can use the tag of a deleted release again. So each new bundle gets its own release. Before a desktop release, this repository must have the asset. To add it:

1. Download the asset from the private `source-generations` release into a new, empty directory.
2. Scan its contents for the items in [Rules](#rules).
3. With approval, create the release with the asset in one command. `gh release create` uploads the asset before it publishes the release:
   ```shell
   gh release create "$TAG" "$DIR/$TAG.tar.zst" --target main --prerelease --latest=false \
     --title "v5 bundle <inputs hash>" --notes "<wallet commit, protocol and inputs hash>"
   ```
   `$TAG` is the asset name without `.tar.zst`.
4. Run `fetch:bundle` and `check:bundle` against this repository.

## 7. Release

1. Make sure that the `production` environment has these secrets: `WEB_WALLET_NODE_URL`, `WEB_WALLET_NODE_API_KEY`, `WEB_WALLET_L1_RPC_URL` and `WEB_WALLET_V5_ARCHIVE_NODE_URL`. Use `gh secret list --env production`.
2. With approval, push an annotated tag `desktop-vX.Y.Z` at the merge commit on `main`.
3. With approval, approve the two `production` gates of the run: the `bundle` job and the `installers` job.
   ```shell
   gh api -X POST "repos/{owner}/{repo}/actions/runs/$RUN/pending_deployments" \
     -F "environment_ids[]=$ENV_ID" -f state=approved -f comment="<reason>"
   ```
4. When the run is complete, download one installer and `SHA256SUMS` from the draft. Make sure that the checksum is correct and that the app contains the v5 archive node URL.
5. The user publishes the draft, or approves its publication.

## Known facts

- An Aztec node keeps 64 checkpoints of world state (`WS_NUM_HISTORIC_CHECKPOINTS`). The v5 refund reads the state at the v5 freeze block, which is older than that. Thus the wallet needs `WEB_WALLET_V5_ARCHIVE_NODE_URL`. Without it, a refund fails with "world state history has been pruned".
- The archive node needs the `x-api-key` header. The build sends `WEB_WALLET_NODE_API_KEY` to it if `WEB_WALLET_V5_ARCHIVE_NODE_API_KEY` is not set. A node URL that a user sets in Settings gets no key.
- The `bundle` job uses Node.js 24, because the Aztec 6.0.0 installer needs 24.15 or later. The `installers` job uses Node.js 22.
- `pnpm build:oxide-circuits` does not check `resolver_circuit`. Its verifier is pinned to the circuit of the deployed Resolver module.
- Without the `DESKTOP_MAC_*` secrets, the macOS app is not signed and not notarized. Gatekeeper shows a warning when the app opens.
- `gh release delete` without `--cleanup-tag` keeps the tag. To delete only a draft, use `gh api -X DELETE repos/{owner}/{repo}/releases/<id>`.
- In zsh, an unquoted variable does not split into words. Run a loop that makes a list of arguments with `bash -c`.
