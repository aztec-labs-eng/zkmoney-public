"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { app, dialog, Menu, Tray, nativeImage, shell } = require("electron")
const {
  chromeNotFoundMessage,
  findChrome,
  buildChromeArguments,
  launchChrome,
} = require("./chrome")
const { loadConfig, loadEndpoints, saveEndpoints } = require("./config")
const { createL1SubmitBridge } = require("./l1SubmitBridge")
const { renderL1SubmitPage, renderL1SubmitGonePage } = require("./l1SubmitPage")
const { createL1SubmitHttpServer, createLocalHttpsServer, listenOnLoopback } = require("./server")
const { renderSettingsPage } = require("./settingsPage")
const { loadOrCreateCertificate } = require("./tls")

const PROBE_TIMEOUT_MS = 5_000

let localServer = null
let l1SubmitServer = null
let chromeProcess = null
let quitting = false
let pendingRelaunch = false
// Module-scope so the tray isn't garbage-collected (a GC'd Tray vanishes from the bar).
let tray = null

function resourceRoot() {
  // app.getAppPath() resolves to the project root in development and app.asar when packaged.
  return app.getAppPath()
}

// Ships via electron-builder extraResources (on disk, outside asar) so the 94MB
// bundle streams with plain fs instead of asar's buffering shim.
function packagedResource(name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(app.getAppPath(), name)
}

async function showFatalError(title, error) {
  const message = error instanceof Error ? error.message : String(error)
  await dialog.showMessageBox({
    type: "error",
    title,
    message,
    detail: message,
  })
}

async function stopEverything() {
  if (quitting) {
    return
  }
  quitting = true

  if (chromeProcess && !chromeProcess.killed) {
    chromeProcess.kill("SIGTERM")
  }

  if (tray) {
    tray.destroy()
    tray = null
  }

  if (localServer) {
    await new Promise((resolve) => localServer.close(resolve))
  }

  if (l1SubmitServer) {
    await new Promise((resolve) => l1SubmitServer.close(resolve))
  }
}

function readBuildMeta() {
  try {
    return JSON.parse(fs.readFileSync(packagedResource("build-meta.json"), "utf8"))
  } catch {
    return null
  }
}

// True when the effective L1 RPC endpoint is REACHABLE. This is an outage
// detector, not a health check: any HTTP response counts (a 4xx/5xx proves the
// server is up), only network errors/timeouts fail — and one retry absorbs a
// cold network interface or a momentary hiccup at app start. A failed probe
// boots straight into /desktop-settings — the outage flow needs no user
// knowledge of the settings page's existence.
async function probeL1Rpc(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      return true
    } catch {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
      }
    }
  }
  return false
}

async function start() {
  const root = resourceRoot()
  const config = loadConfig(root, packagedResource("build-meta.json"))
  const chromePath = findChrome()

  if (!chromePath) {
    throw new Error(chromeNotFoundMessage())
  }

  const servedRoot = packagedResource("web")
  if (!fs.existsSync(path.join(servedRoot, "index.html"))) {
    throw new Error(`No wallet bundle at ${servedRoot} — run scripts/build-web.sh first.`)
  }

  const userDataPath = app.getPath("userData")
  const tlsDirectory = path.join(userDataPath, "TLS")
  const profilePath = path.join(userDataPath, config.profileDirectoryName)
  fs.mkdirSync(profilePath, { recursive: true, mode: 0o700 })

  // User endpoint overrides: env var > endpoints.json (user-data dir) > baked value.
  const endpointsFilePath = path.join(userDataPath, "endpoints.json")
  let endpointState
  try {
    endpointState = loadEndpoints(endpointsFilePath)
  } catch (error) {
    await showFatalError("Ignoring invalid endpoint overrides", error)
    endpointState = { endpoints: {}, sources: {} }
  }

  // Two enclave transports, decided by whether this build proxies one at all.
  // Sandbox pairs with the CORS-free mock TEE, so it keeps the same-origin proxy and a
  // retarget rewrites that target — the server reads this object per request, so the
  // running wallet's next /svc/enclave call already goes to the new host, no restart.
  // A tier build has no enclave proxy: the wallet dials the manifest's enclaveUrl, and a
  // retarget reaches it through injectEndpoints below.
  const proxiesEnclave = Boolean(config.proxies["/svc/enclave"])
  const effectiveProxies = { ...config.proxies }
  const applyEndpointOverrides = () => {
    if (!proxiesEnclave) return
    effectiveProxies["/svc/enclave"] =
      endpointState.endpoints.enclaveUrl ?? config.proxies["/svc/enclave"]
  }
  applyEndpointOverrides()

  const buildMeta = readBuildMeta()

  const tls = loadOrCreateCertificate({
    hostname: config.hostname,
    certificateDays: config.certificateDays,
    tlsDirectory,
  })

  const settingsToken = crypto.randomBytes(16).toString("hex")
  let localPort = null
  // { url, source } when the startup probe failed; null otherwise.
  let probeFailure = null

  const walletOrigin = () =>
    config.hostname === "localhost"
      ? `https://localhost:${localPort}`
      : `https://${config.hostname}`

  const injectEndpoints = () => {
    const injected = {}
    const keys = proxiesEnclave ? ["l1RpcUrl", "nodeUrl"] : ["l1RpcUrl", "nodeUrl", "enclaveUrl"]
    for (const key of keys) {
      if (endpointState.endpoints[key]) {
        injected[key] = endpointState.endpoints[key]
      }
    }
    return injected
  }

  const settings = {
    token: settingsToken,
    renderPage: () =>
      renderSettingsPage({
        token: settingsToken,
        endpoints: endpointState.endpoints,
        sources: endpointState.sources,
        build: buildMeta,
        defaults: {
          l1RpcUrl: buildMeta?.bakedL1RpcUrl,
          nodeUrl: buildMeta?.bakedNodeUrl,
          enclaveUrl: config.proxies["/svc/enclave"],
        },
        probeFailure,
      }),
    save: async (body) => {
      saveEndpoints(endpointsFilePath, body)
      endpointState = loadEndpoints(endpointsFilePath)
      applyEndpointOverrides()
    },
    relaunch: () => {
      if (chromeProcess && !chromeProcess.killed) {
        pendingRelaunch = true
        probeFailure = null
        chromeProcess.kill("SIGTERM")
      }
    },
  }

  // L1 submit bridge: the wallet prepares an L1 transaction; the helper page —
  // opened in the user's DEFAULT browser, where their EVM wallet extension
  // lives — submits it. Plain-HTTP loopback listener (see server.js).
  const l1Bridge = createL1SubmitBridge()
  l1SubmitServer = createL1SubmitHttpServer({
    bridge: l1Bridge,
    renderPage: renderL1SubmitPage,
    renderGonePage: renderL1SubmitGonePage,
  })
  const l1SubmitPort = await listenOnLoopback(l1SubmitServer)

  localServer = createLocalHttpsServer({
    hostname: config.hostname,
    webRoot: servedRoot,
    certPem: tls.certPem,
    keyPem: tls.keyPem,
    contentSecurityPolicy: config.contentSecurityPolicy,
    spaFallback: config.spaFallback,
    proxies: effectiveProxies,
    injectEndpoints,
    injectBridge: () => ({ l1SubmitPath: "/desktop/l1-submit" }),
    l1Submit: {
      create: (body) => l1Bridge.create(body),
      get: (id) => l1Bridge.get(id),
      submitUrl: (id) => `http://127.0.0.1:${l1SubmitPort}/submit/${id}`,
      openSubmitPage: (id) => shell.openExternal(`http://127.0.0.1:${l1SubmitPort}/submit/${id}`),
    },
    settings,
    // Inside the asar when packaged; fs reads through Electron's asar shim.
    launcherAssets: {
      "/favicon.ico": {
        filePath: path.join(root, "assets", "favicon.svg"),
        contentType: "image/svg+xml; charset=utf-8",
      },
      "/favicon.svg": {
        filePath: path.join(root, "assets", "favicon.svg"),
        contentType: "image/svg+xml; charset=utf-8",
      },
      // The DS's Sen variable font, for the settings page (same file as
      // design-system/fonts/Sen-VariableFont.ttf).
      "/desktop-assets/Sen-VariableFont.ttf": {
        filePath: path.join(root, "assets", "Sen-VariableFont.ttf"),
        contentType: "font/ttf",
      },
    },
  })

  localPort = await listenOnLoopback(localServer, config.localPort)

  // The launcher can only probe an L1 endpoint it knows: a user override, or the
  // baked URL recorded in the build meta at bundle time. Neither known → skip.
  const probeUrl = endpointState.endpoints.l1RpcUrl ?? buildMeta?.bakedL1RpcUrl
  if (probeUrl && !(await probeL1Rpc(probeUrl))) {
    probeFailure = {
      url: probeUrl,
      source: endpointState.endpoints.l1RpcUrl
        ? endpointState.sources.l1RpcUrl === "env"
          ? "the OBSIDION_L1_RPC_URL environment variable"
          : "your saved override"
        : "the bundle default",
    }
  }

  const launchWallet = (startPath) => {
    const chromeArguments = buildChromeArguments({
      hostname: config.hostname,
      localPort,
      spkiSha256: tls.spkiSha256,
      profilePath,
      startPath,
      windowMode: config.windowMode,
      includeTestTypeFlag: config.includeTestTypeFlag,
    })

    chromeProcess = launchChrome(chromePath, chromeArguments)

    chromeProcess.once("error", async (error) => {
      await showFatalError("Unable to launch Chrome", error)
      await stopEverything()
      app.quit()
    })

    chromeProcess.once("exit", async () => {
      if (pendingRelaunch) {
        pendingRelaunch = false
        launchWallet(config.startPath)
        return
      }
      await stopEverything()
      app.quit()
    })
  }

  // Spawning Chrome again with the same profile hands the URL to the already-running
  // instance and exits immediately, so no lifecycle handlers are wired: the settings
  // window is an extra window of the wallet's Chrome, and closing it doesn't quit the
  // app. Safe alongside the wallet — the settings page never touches the PXE's OPFS lock.
  const openSettingsWindow = () => {
    launchChrome(
      chromePath,
      buildChromeArguments({
        hostname: config.hostname,
        localPort,
        spkiSha256: tls.spkiSha256,
        profilePath,
        startPath: "/desktop-settings",
        windowMode: "app",
        includeTestTypeFlag: config.includeTestTypeFlag,
      }),
    )
  }

  // Settings entry point per platform: Dock menu on macOS, a tray icon in the
  // notification area on Windows/Linux. Failure is tolerable — the probe and the
  // --settings flag still reach the page — so a headless or tray-less environment
  // must not kill the app.
  try {
    const settingsMenu = Menu.buildFromTemplate([
      { label: "Endpoint Settings…", click: openSettingsWindow },
    ])
    if (process.platform === "darwin" && app.dock) {
      app.dock.setMenu(settingsMenu)
    } else {
      tray = new Tray(nativeImage.createFromPath(path.join(root, "assets", "tray-icon.png")))
      tray.setToolTip("zk.money Desktop")
      tray.setContextMenu(settingsMenu)
      // Windows convention: single-click on the tray icon opens the app's UI.
      tray.on("click", openSettingsWindow)
    }
  } catch (error) {
    console.warn("settings entry point unavailable:", error.message)
  }

  const startAtSettings = probeFailure !== null || process.argv.includes("--settings")
  launchWallet(startAtSettings ? "/desktop-settings" : config.startPath)
}

// One instance only: the wallet's OPFS store takes an exclusive per-origin lock (one
// PXE page at a time), and two launchers would race on the TLS dir and Chrome profile.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("before-quit", () => {
    void stopEverything()
  })

  app.whenReady().then(async () => {
    try {
      await start()
    } catch (error) {
      await showFatalError("zk.money Desktop could not start", error)
      await stopEverything()
      app.quit()
    }
  })
}
