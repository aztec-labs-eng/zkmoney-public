// Checks a bundle: each file against the manifest, the manifest's sha256 against pin.json, and its
// protocol against the boundary's. Run as a script, it checks dist/ and fails when it holds none.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export const dist = path.join(pkg, "dist")

/** The boundary to a source generation. The bundle compiles against a copy of it. */
export const boundaryFile = path.resolve(pkg, "../core/src/types/sourceGeneration.ts")

/** The `SOURCE_GENERATION_PROTOCOL` that this checkout's boundary declares. */
export const protocol = (() => {
  const value = Number(
    /SOURCE_GENERATION_PROTOCOL = (\d+)/.exec(readFileSync(boundaryFile, "utf8"))?.[1],
  )
  if (!value) throw new Error(`No SOURCE_GENERATION_PROTOCOL in ${boundaryFile}`)
  return value
})()

const { walletCommit: pinnedCommit } = JSON.parse(
  readFileSync(path.join(pkg, "source.json"), "utf8"),
)

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")

const filesIn = (dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = path.join(dir, name)
      return statSync(full).isDirectory() ? filesIn(full) : [full]
    })

/**
 * The files of this checkout that `build.mjs` puts into the bundle, other than the pinned wallet
 * commit: the adapter, the boundary, the pin and the build script.
 */
export const bundleInputs = [
  ...filesIn(path.join(pkg, "adapter")),
  boundaryFile,
  path.join(pkg, "source.json"),
  path.join(pkg, "scripts/build.mjs"),
]

/**
 * The first 12 hex digits of a sha256 over the path and content of each bundle input. A change to
 * the adapter changes the bundle, also when the protocol stays the same, so it changes this value.
 */
export const inputsHash = (() => {
  const hash = createHash("sha256")
  const root = path.resolve(pkg, "../..")
  for (const file of bundleInputs) hash.update(`${path.relative(root, file)}\0${sha256(file)}\0`)
  return hash.digest("hex").slice(0, 12)
})()

/**
 * The name of the published bundle of the pinned wallet commit. The adapter can change the bundle
 * at one wallet commit, so the name also holds the protocol and the hash of the bundle inputs.
 */
export const assetName = `generation-v5-${pinnedCommit}-protocol-${protocol}-${inputsHash}.tar.zst`

/** The manifest sha256 that pin.json names. */
export const pinnedManifest = () =>
  JSON.parse(readFileSync(path.join(pkg, "pin.json"), "utf8")).manifestSha256

/**
 * The bundle at `dir`: its files by served path, its manifest digest, its wallet commit, its
 * protocol, and the hash of the inputs it was built from. Undefined when `dir` holds no bundle. Throws on a file that does
 * not match the manifest.
 */
export function readBundle(dir = dist) {
  const manifestFile = path.join(dir, "manifest.json")
  if (!existsSync(manifestFile)) return undefined
  const { files, walletCommit, protocol, inputs } = JSON.parse(readFileSync(manifestFile, "utf8"))
  const out = new Map([["manifest.json", manifestFile]])
  for (const [name, digest] of Object.entries(files)) {
    const file = path.join(dir, name)
    if (sha256(file) !== digest)
      throw new Error(`${file} does not match its bundle manifest; rebuild the generation`)
    out.set(name, file)
  }
  return { files: out, manifestSha256: sha256(manifestFile), walletCommit, protocol, inputs }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = readBundle()
  if (!bundle) throw new Error(`No bundle at ${dist}`)
  if (bundle.protocol !== protocol)
    throw new Error(
      `The bundle at ${dist} speaks protocol ${bundle.protocol}, not ${protocol}; rebuild the generation`,
    )
  if (bundle.walletCommit !== pinnedCommit)
    throw new Error(
      `The bundle at ${dist} is built from ${bundle.walletCommit}, not the pinned ${pinnedCommit}`,
    )
  if (bundle.inputs !== inputsHash)
    throw new Error(
      `The bundle at ${dist} is built from inputs ${bundle.inputs}, not ${inputsHash}; rebuild the generation`,
    )
  if (bundle.manifestSha256 !== pinnedManifest())
    throw new Error(
      `The bundle's manifest is ${bundle.manifestSha256}, but pin.json names ${pinnedManifest()}. ` +
        "Set pin.json to the new digest if the change is intended.",
    )
  console.error(`The bundle at ${dist} matches its pin`)
}
