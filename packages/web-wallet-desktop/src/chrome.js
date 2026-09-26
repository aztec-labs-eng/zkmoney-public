"use strict"

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync, spawn } = require("node:child_process")

const MAC_CHROME_CANDIDATES = Object.freeze([
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
])

const LINUX_CHROME_CANDIDATES = Object.freeze([
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-beta",
  "/usr/bin/google-chrome-unstable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
])

const WINDOWS_CHROME_RELATIVE_PATHS = Object.freeze([
  "Google\\Chrome\\Application\\chrome.exe",
  "Google\\Chrome Beta\\Application\\chrome.exe",
  "Google\\Chrome SxS\\Application\\chrome.exe",
  "Chromium\\Application\\chrome.exe",
])

const PATH_LOOKUP_NAMES = Object.freeze([
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "chrome",
])

function platformCandidates(platform = process.platform, homeDirectory = os.homedir()) {
  if (platform === "darwin") {
    const userCandidates = MAC_CHROME_CANDIDATES.map((candidate) =>
      path.join(homeDirectory, candidate.replace(/^\/Applications\//, "Applications/")),
    )
    return [...MAC_CHROME_CANDIDATES, ...userCandidates]
  }
  if (platform === "win32") {
    const roots = [
      process.env["PROGRAMFILES"],
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean)
    return roots.flatMap((root) => WINDOWS_CHROME_RELATIVE_PATHS.map((rel) => path.join(root, rel)))
  }
  return [...LINUX_CHROME_CANDIDATES]
}

// Chrome's installer registers its real location under App Paths — the one lookup that works
// when Chrome lives outside the standard ProgramFiles/LocalAppData roots. HKCU first: a
// per-user install shadows a machine-wide one for that user.
const WINDOWS_APP_PATHS_KEYS = Object.freeze([
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe",
])

// Keys off the REG_SZ type token, not the value name — "(Default)" is localized
// ("(Standard)" on German Windows, etc).
function parseRegQueryValue(output) {
  for (const line of String(output).split(/\r?\n/)) {
    const match = /\sREG_(?:EXPAND_)?SZ\s+(.+\S)\s*$/.exec(line)
    if (match) {
      return match[1]
    }
  }
  return undefined
}

// A REG_EXPAND_SZ value stores %VAR% tokens verbatim and reg.exe prints them unexpanded, so the
// path has to be resolved before it can be probed. Windows env names are case-insensitive; an
// unset token is left alone so the probe fails rather than collapsing to a shorter valid path.
function expandWindowsEnv(value, env = process.env) {
  return String(value).replace(/%([^%]+)%/g, (token, name) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key === undefined ? token : env[key]
  })
}

function appPathsLookup(platform = process.platform) {
  if (platform !== "win32") {
    return undefined
  }
  for (const key of WINDOWS_APP_PATHS_KEYS) {
    try {
      const output = execFileSync("reg", ["query", key, "/ve"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        windowsHide: true,
      })
      const raw = parseRegQueryValue(output)
      const value = raw && expandWindowsEnv(raw)
      if (value && fs.existsSync(value)) {
        return value
      }
    } catch {
      // key absent or reg.exe unavailable
    }
  }
  return undefined
}

function pathLookup(names = PATH_LOOKUP_NAMES, platform = process.platform) {
  const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean)
  const extensions = platform === "win32" ? [".exe"] : [""]
  for (const name of names) {
    for (const directory of directories) {
      for (const extension of extensions) {
        const candidate = path.join(directory, name + extension)
        if (fs.existsSync(candidate)) {
          return candidate
        }
      }
    }
  }
  return undefined
}

function chromeNotFoundMessage(platform = process.platform) {
  if (platform === "darwin") {
    return "Google Chrome, Chrome Beta, Chrome Canary, or Chromium was not found in /Applications or ~/Applications."
  }
  if (platform === "win32") {
    return "Google Chrome was not found under %ProgramFiles%, %ProgramFiles(x86)%, %LocalAppData% or the Windows registry. Install Chrome or set CHROME_PATH."
  }
  return "google-chrome / chromium was not found in the usual install locations or on PATH. Install Chrome or set CHROME_PATH."
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH
  }
  return (
    platformCandidates().find((candidate) => fs.existsSync(candidate)) ||
    appPathsLookup() ||
    pathLookup()
  )
}

function buildChromeArguments({
  hostname,
  localPort,
  spkiSha256,
  profilePath,
  startPath,
  windowMode = "app",
  includeTestTypeFlag = true,
}) {
  // localhost (sandbox dev mode) needs no resolver mapping — Chrome dials the loopback
  // server directly, and localhost is already a valid passkey RP. Real hostnames get
  // the MAP rule so the production origin resolves to the local server.
  const isLocalhost = hostname === "localhost"
  const targetUrl = isLocalhost
    ? `https://localhost:${localPort}${startPath}`
    : `https://${hostname}${startPath}`
  const argumentsList = [
    `--user-data-dir=${profilePath}`,
    ...(isLocalhost
      ? []
      : [`--host-resolver-rules=MAP ${hostname}:443 127.0.0.1:${localPort},EXCLUDE localhost`]),
    `--ignore-certificate-errors-spki-list=${spkiSha256}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
  ]

  if (includeTestTypeFlag) {
    argumentsList.push("--test-type")
  }

  if (windowMode === "app") {
    argumentsList.push(`--app=${targetUrl}`)
  } else {
    argumentsList.push(targetUrl)
  }

  return argumentsList
}

function launchChrome(chromePath, argumentsList) {
  return spawn(chromePath, argumentsList, {
    detached: false,
    stdio: "ignore",
  })
}

module.exports = {
  LINUX_CHROME_CANDIDATES,
  MAC_CHROME_CANDIDATES,
  PATH_LOOKUP_NAMES,
  WINDOWS_CHROME_RELATIVE_PATHS,
  appPathsLookup,
  buildChromeArguments,
  chromeNotFoundMessage,
  expandWindowsEnv,
  findChrome,
  launchChrome,
  parseRegQueryValue,
  pathLookup,
  platformCandidates,
}
