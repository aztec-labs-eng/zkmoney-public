// Compares the class IDs of the built contracts with the class IDs in the live config profile.
// Usage: node classids.mjs REPO_ROOT PROFILE_URL
// Run it after `pnpm build-contracts`. A profile contract without an entry in ARTIFACTS is reported as SKIP.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const [root, profileUrl] = process.argv.slice(2)
if (!root || !profileUrl) throw new Error("Usage: node classids.mjs REPO_ROOT PROFILE_URL")
const contracts = `${root}/packages/contracts`
const require = createRequire(`${contracts}/package.json`)
const load = (name) => import(pathToFileURL(require.resolve(name)).href)
const { loadContractArtifact } = await load("@aztec-labs/stdlib/abi")
const { getContractClassFromArtifact } = await load("@aztec-labs/stdlib/contract")

// Profile contract key : artifact path under packages/contracts/src/artifacts/target
const ARTIFACTS = {
  paylinkDirect: "paylink_direct/paylink_direct-PaylinkDirect.json",
  paylinkEmail: "paylink_email/paylink_email-PaylinkEmail.json",
  obsidionAccountAlpha: "alpha_account/obsidion_alpha_account-ObsidionAccountAlpha.json",
  linkLocator: "link_locator/link_locator-LinkLocator.json",
  sponsorFPC: "sponsor_fpc/sponsor_fpc-SponsorFPC.json",
  oidcKeyRegistry: "oidc_key_registry/oidc_key_registry-OidcKeyRegistry.json",
  claimFpc: "claim_fpc/claim_fpc-ClaimFPC.json",
  passwordFPC: "password_fpc/password_fpc-PasswordFPC.json",
}

const profile = await (await fetch(profileUrl)).json()
const pinned = profile.versions[profile.current].contracts
let mismatches = 0
for (const [key, { classId }] of Object.entries(pinned)) {
  if (!classId) continue
  const file = ARTIFACTS[key]
  if (!file) {
    console.log(`SKIP     ${key}: no artifact entry`)
    continue
  }
  const raw = JSON.parse(readFileSync(`${contracts}/src/artifacts/target/${file}`, "utf8"))
  const built = (await getContractClassFromArtifact(loadContractArtifact(raw))).id.toString()
  if (built !== classId) mismatches++
  console.log(`${built === classId ? "MATCH   " : "MISMATCH"} ${key} built=${built} profile=${classId}`)
}
process.exit(mismatches ? 1 : 0)
