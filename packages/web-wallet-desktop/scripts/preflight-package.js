"use strict"

// Runs before electron-builder packs. The three inputs build-web.sh produces —
// web/, build-meta.json, config/generated.json — are all gitignored, so a fresh
// clone, a partial copy or a `git archive` leaves an app that packs, signs and
// installs, then fails in a dialog on first launch. Every check here is one the
// launcher already makes at startup; making them at pack time is the difference
// between a build error and a user-facing popup.
//
// Wired as electron-builder's `beforePack` hook rather than an npm pretask so it
// also guards CI, which invokes `npx electron-builder` directly.

const fs = require("node:fs")
const path = require("node:path")
const { validateHostname } = require("../src/config")

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

// The baked node URL must appear in the bundle beside it, or build-meta.json is
// describing some other build — the shape a hand-written metadata file next to a
// stale web/ takes, which no hostname comparison would catch.
function bundleContains(webDir, needle) {
  const assetsDir = path.join(webDir, "assets")
  if (!fs.existsSync(assetsDir)) return false
  for (const entry of fs.readdirSync(assetsDir)) {
    if (!entry.endsWith(".js")) continue
    if (fs.readFileSync(path.join(assetsDir, entry), "utf8").includes(needle)) return true
  }
  return false
}

// Only a desktop build carries the settings screen and honors the launcher's configuration.
// Anything but exactly "true" is refused. Returns the problem, or null.
function desktopBuildProblem(buildTargetPath) {
  let buildTarget
  try {
    buildTarget = readJson(buildTargetPath)
  } catch (error) {
    return `build-target.json is unreadable: ${error.message}`
  }
  const flag = buildTarget?.VITE_DESKTOP_BUILD
  return flag === "true"
    ? null
    : `build-target.json does not mark a desktop build (VITE_DESKTOP_BUILD is ` +
        `${JSON.stringify(flag) ?? "missing"}, not "true") — rebuild with scripts/build-web.sh`
}

function assertPackagingInputs(root) {
  const problems = []
  const webDir = path.join(root, "web")
  const metadataPath = path.join(root, "build-meta.json")
  const generatedPath = path.join(root, "config", "generated.json")

  for (const rel of ["index.html", "build-target.json"]) {
    if (!fs.existsSync(path.join(webDir, rel))) {
      problems.push(`web/${rel} is missing — run scripts/build-web.sh`)
    }
  }

  const buildTargetPath = path.join(webDir, "build-target.json")
  if (fs.existsSync(buildTargetPath)) {
    const problem = desktopBuildProblem(buildTargetPath)
    if (problem) problems.push(`web/${problem}`)
  }

  let metadata = null
  if (!fs.existsSync(metadataPath)) {
    problems.push("build-meta.json is missing — run scripts/build-web.sh")
  } else {
    try {
      metadata = readJson(metadataPath)
    } catch (error) {
      problems.push(`build-meta.json is unreadable: ${error.message}`)
    }
  }

  let generated = null
  if (!fs.existsSync(generatedPath)) {
    problems.push(
      "config/generated.json is missing — run scripts/compose-config.js (config/default.json " +
        "would be packaged instead, and its localhost defaults cannot match a hosted build)",
    )
  } else {
    try {
      generated = readJson(generatedPath)
    } catch (error) {
      problems.push(`config/generated.json is unreadable: ${error.message}`)
    }
  }

  if (metadata) {
    for (const key of ["pageHostname", "passkeyRpId"]) {
      try {
        validateHostname(metadata[key])
      } catch {
        problems.push(
          `build-meta.json has no usable ${key} (${String(metadata[key])}) — it predates the ` +
            "current scripts/write-build-meta.mjs; rebuild the bundle",
        )
      }
    }
  }

  if (metadata && generated) {
    for (const [metaKey, configKey] of [
      ["pageHostname", "hostname"],
      ["passkeyRpId", "passkeyRpId"],
    ]) {
      if (metadata[metaKey] !== generated[configKey]) {
        problems.push(
          `build-meta.json ${metaKey} (${String(metadata[metaKey])}) differs from ` +
            `config/generated.json ${configKey} (${String(generated[configKey])}) — the launcher ` +
            "refuses this pairing at startup; re-run scripts/compose-config.js",
        )
      }
    }
  }

  if (
    metadata?.bakedNodeUrl &&
    !problems.length &&
    !bundleContains(webDir, metadata.bakedNodeUrl)
  ) {
    problems.push(
      `build-meta.json bakedNodeUrl (${metadata.bakedNodeUrl}) does not appear in web/ — the ` +
        "metadata and the bundle come from different builds; re-run scripts/build-web.sh",
    )
  }

  if (problems.length) {
    throw new Error(
      `Refusing to package — the wallet bundle and launcher config are incomplete:\n` +
        problems.map((line) => `  - ${line}`).join("\n"),
    )
  }

  return { pageHostname: metadata.pageHostname, passkeyRpId: metadata.passkeyRpId }
}

// __dirname, not electron-builder's context: the package root is known here and
// does not depend on the hook's argument shape.
module.exports = () => {
  const { pageHostname, passkeyRpId } = assertPackagingInputs(path.resolve(__dirname, ".."))
  console.log(`preflight: packaging ${pageHostname} (RP ${passkeyRpId})`)
}
module.exports.assertPackagingInputs = assertPackagingInputs
module.exports.desktopBuildProblem = desktopBuildProblem
