// Puts the bundle of this checkout in dist/: the pinned wallet commit, this checkout's protocol and
// the hash of this checkout's bundle inputs (`assetName` in check.mjs). It keeps dist/ when dist/
// already holds that bundle, else it downloads it through the GitHub REST API from the
// source-generations release, or from the release whose tag is the asset name without `.tar.zst`.
// A repository with immutable releases cannot add an asset to a published release, so it publishes
// each bundle in its own release. Exits 2 only when neither release has the asset. Any other
// failure (no token, auth, network) exits 1.
//
// Env: GH_TOKEN or GITHUB_TOKEN. GH_REPO or GITHUB_REPOSITORY names the repository, else the
// origin remote of the checkout does.
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { assetName, dist, inputsHash, protocol, readBundle } from "./check.mjs"

const RELEASE = "source-generations"
const BUNDLE_RELEASE = assetName.replace(/\.tar\.zst$/, "")
const API = "https://api.github.com"
const pin = JSON.parse(
  readFileSync(new URL("../source.json", import.meta.url), "utf8"),
).walletCommit

const holds = (bundle) =>
  bundle?.walletCommit === pin && bundle.protocol === protocol && bundle.inputs === inputsHash

const held = () => {
  try {
    return holds(readBundle())
  } catch {
    return false
  }
}

if (held()) {
  console.error(`dist/ already holds ${assetName}`)
  process.exit(0)
}

const absent = (message) => {
  console.error(message)
  process.exit(2)
}

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN to read the source-generations release")

const repo = (() => {
  const named = process.env.GH_REPO || process.env.GITHUB_REPOSITORY
  if (named) return named
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim()
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)
  if (!match) throw new Error(`Set GH_REPO: the origin remote ${remote} is not a GitHub repository`)
  return match[1]
})()

const request = async (url, accept = "application/vnd.github+json") => {
  const response = await fetch(url, {
    headers: {
      "Accept": accept,
      "Authorization": `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (response.status !== 404 && !response.ok)
    throw new Error(`GET ${url}: ${response.status} ${await response.text()}`)
  return response
}

const asset = assetName

// The asset in the release with this tag, or undefined when the release or the asset is absent.
const releaseAsset = async (tag) => {
  const release = await request(`${API}/repos/${repo}/releases/tags/${tag}`)
  if (release.status === 404) return undefined
  const { id } = await release.json()
  for (let page = 1; ; page++) {
    const response = await request(
      `${API}/repos/${repo}/releases/${id}/assets?per_page=100&page=${page}`,
    )
    if (response.status === 404) throw new Error(`The ${tag} release vanished while it was read`)
    const assets = await response.json()
    if (assets.length === 0) return undefined
    const match = assets.find((entry) => entry.name === asset)
    if (match) return match
  }
}

const found = (await releaseAsset(RELEASE)) ?? (await releaseAsset(BUNDLE_RELEASE))
if (!found) {
  // A token without access to the repository also gets 404, which is not an absent release.
  if ((await request(`${API}/repos/${repo}`)).status === 404)
    throw new Error(`${repo} is not readable with the given token`)
  absent(`${repo} has ${asset} in neither the ${RELEASE} release nor the ${BUNDLE_RELEASE} release`)
}

const download = await request(found.url, "application/octet-stream")
if (download.status === 404) throw new Error(`${asset} vanished while it was downloaded`)

const work = mkdtempSync(path.join(tmpdir(), "generation-v5-"))
try {
  writeFileSync(path.join(work, asset), Buffer.from(await download.arrayBuffer()))
  const unpacked = path.join(work, "dist")
  mkdirSync(unpacked)
  execFileSync("tar", ["--zstd", "-xf", path.join(work, asset), "-C", unpacked])
  if (!holds(readBundle(unpacked)))
    throw new Error(
      `${asset} does not hold the bundle of wallet commit ${pin}, protocol ${protocol} and inputs ${inputsHash}`,
    )
  rmSync(dist, { recursive: true, force: true })
  cpSync(unpacked, dist, { recursive: true })
  console.error(`Fetched ${asset}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
