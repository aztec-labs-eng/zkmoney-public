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
const {
  injectedEndpoints,
  loadConfig,
  loadEndpoints,
  saveEndpoints,
  settingsPageState,
} = require("./config")
const { createL1SubmitBridge } = require("./l1SubmitBridge")
const { renderL1SubmitPage, renderL1SubmitGonePage } = require("./l1SubmitPage")
const {
  L1_SUBMIT_PATH,
  SETTINGS_PATH,
  createL1SubmitHttpServer,
  createLocalHttpsServer,
  listenOnLoopback,
} = require("./server")
const { probeConfigProfile } = require("./probe")
const { loadOrCreateCertificate } = require("./tls")
const { createWalletSession } = require("./walletSession")

let localServer = null
let l1SubmitServer = null
let walletSession = null
let quitting = false
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

  walletSession?.stop()

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

function readJsonResource(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

// build-meta.json: when the bundle was built.
// web/build-target.json: the wallet build's own record of the profile it baked.
function readBuildMeta() {
  return readJsonResource(packagedResource("build-meta.json"))
}

function readBuildTarget() {
  return readJsonResource(path.join(packagedResource("web"), "build-target.json"))
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

  const buildMeta = readBuildMeta()
  const buildTarget = readBuildTarget()
  // Configuration overrides: env var > endpoints.json (user-data dir) > the build's own profile.
  // A profile URL must have the shape the wallet refuses at boot without, except on sandbox.
  const endpointsFilePath = path.join(userDataPath, "endpoints.json")
  const settingRules = { profileShape: buildTarget?.VITE_NETWORK !== "sandbox" }
  let endpointState = loadEndpoints(endpointsFilePath, settingRules)
  if (endpointState.problems.length) {
    await showFatalError(
      "Ignoring invalid configuration settings",
      endpointState.problems.map((problem) => problem.message).join("\n"),
    )
  }

  // The shipped-configuration switch wins over a profile URL: it boots without
  // fetching, so no URL is consulted. Resolved here once, for the injection, the
  // startup probe and the settings page alike.
  const profileState = () => {
    const override = endpointState.endpoints.bootFromBakedProfile
      ? null
      : endpointState.endpoints.configProfileUrl ?? null
    return {
      url: override ?? buildTarget?.VITE_CONFIG_PROFILE_URL ?? null,
      overridden: override !== null,
      baked: buildTarget?.bakedProfile ?? null,
    }
  }
  let profile = profileState()

  const tls = loadOrCreateCertificate({
    hostname: config.hostname,
    certificateDays: config.certificateDays,
    tlsDirectory,
  })

  const settingsToken = crypto.randomBytes(16).toString("hex")
  let localPort = null
  // { state, detail, overridden, bakedExpired } from the startup profile probe; null when no URL
  // is known.
  let profileProbe = null

  const walletOrigin = () =>
    config.hostname === "localhost"
      ? `https://localhost:${localPort}`
      : `https://${config.hostname}`

  const settings = {
    token: settingsToken,
    state: () =>
      settingsPageState({
        token: settingsToken,
        endpointState,
        builtAt: buildMeta?.builtAt,
        profile,
        profileProbe,
      }),
    save: async (body) => {
      saveEndpoints(endpointsFilePath, body, settingRules)
      endpointState = loadEndpoints(endpointsFilePath, settingRules)
      profile = profileState()
    },
    relaunch: () => walletSession.relaunch(),
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
    proxies: config.proxies,
    injectEndpoints: () => injectedEndpoints(endpointState.endpoints),
    // `recheck`: this launcher asks the wallet page to approve each send (see l1SubmitBridge.js).
    injectBridge: () => ({
      l1SubmitPath: L1_SUBMIT_PATH,
      settingsPath: SETTINGS_PATH,
      capabilities: ["recheck"],
    }),
    l1Submit: {
      create: (body) => l1Bridge.create(body),
      get: (id) => l1Bridge.get(id),
      resolveCheck: (id, body) => l1Bridge.resolveCheck(id, body),
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
    },
  })

  localPort = await listenOnLoopback(localServer, config.localPort)

  // Probes the configuration profile and picks where the wallet opens: the settings
  // page when the wallet would refuse to boot, else the normal start path. Runs at
  // every launch, a relaunch from the settings page included, so a saved value that
  // is still bad lands back on the page with the verdict, not on the wallet's boot
  // error. The outage flow needs no user knowledge of the page's existence.
  const chooseStartPath = async () => {
    const profileVerdict = profile.url ? await probeConfigProfile(profile.url) : null
    // The automatic fallback runs the shipped copy through the same expiry check as
    // a served document, so an expired copy is as good as none.
    const bakedExpired =
      typeof profile.baked?.expiresAt === "string" &&
      Date.parse(profile.baked.expiresAt) <= Date.now()
    profileProbe = profileVerdict
      ? { ...profileVerdict, overridden: profile.overridden, bakedExpired }
      : null
    // The wallet refuses a rejected document, and an unreachable one with no usable
    // baked copy to fall back on. With the shipped-configuration setting on it boots
    // regardless, so only the settings page (not the start path) shows the verdict.
    const profileBlocksBoot =
      profileProbe !== null &&
      !endpointState.endpoints.bootFromBakedProfile &&
      (profileProbe.state === "rejected" ||
        (profileProbe.state === "unreachable" && (profile.baked === null || bakedExpired)))
    return profileBlocksBoot ? SETTINGS_PATH : config.startPath
  }

  // Settings entry point per platform: Dock menu on macOS, a tray icon in the
  // notification area on Windows/Linux. Failure is tolerable — the probe and the
  // --settings flag still reach the page — so a headless or tray-less environment
  // must not kill the app.
  const useDock = process.platform === "darwin" && Boolean(app.dock)
  const renderSettingsMenu = (enabled) => {
    try {
      const settingsMenu = Menu.buildFromTemplate([
        { label: "Endpoint Settings…", enabled, click: () => walletSession.openSettings() },
      ])
      if (useDock) {
        app.dock.setMenu(settingsMenu)
      } else if (tray) {
        tray.setContextMenu(settingsMenu)
      }
    } catch (error) {
      console.warn("settings entry point unavailable:", error.message)
    }
  }

  walletSession = createWalletSession({
    spawnWallet: (startPath) =>
      launchChrome(
        chromePath,
        buildChromeArguments({
          hostname: config.hostname,
          localPort,
          spkiSha256: tls.spkiSha256,
          profilePath,
          startPath,
          windowMode: config.windowMode,
          includeTestTypeFlag: config.includeTestTypeFlag,
          devtoolsPipe: true,
        }),
      ),
    // Spawning Chrome again with the same profile hands the URL to the already-running
    // instance and exits, so the settings window is an extra window of the wallet's Chrome,
    // and closing it doesn't quit the app. Safe alongside the wallet — the settings page
    // never touches the PXE's OPFS lock.
    spawnSettingsWindow: () =>
      launchChrome(
        chromePath,
        buildChromeArguments({
          hostname: config.hostname,
          localPort,
          spkiSha256: tls.spkiSha256,
          profilePath,
          startPath: SETTINGS_PATH,
          windowMode: "app",
          includeTestTypeFlag: config.includeTestTypeFlag,
        }),
      ),
    chooseStartPath,
    onMenuChange: renderSettingsMenu,
    onSpawnError: async (error) => {
      await showFatalError("Unable to launch Chrome", error)
      await stopEverything()
      app.quit()
    },
    onClosed: async () => {
      await stopEverything()
      app.quit()
    },
    isQuitting: () => quitting,
  })

  try {
    if (!useDock) {
      tray = new Tray(nativeImage.createFromPath(path.join(root, "assets", "tray-icon.png")))
      tray.setToolTip("zk.money Desktop")
      // Windows convention: single-click on the tray icon opens the app's UI.
      tray.on("click", () => walletSession.openSettings())
    }
  } catch (error) {
    console.warn("settings entry point unavailable:", error.message)
  }
  renderSettingsMenu(false)

  // An invalid setting opens the page too, on a cold start only: it names the value that was
  // ignored, and a bad saved file is repaired by saving the page. A relaunch goes by the probe
  // alone, so an environment value the page cannot fix does not trap the user there.
  const startPath = await chooseStartPath()
  const startAtSettings = endpointState.problems.length > 0 || process.argv.includes("--settings")
  walletSession.launch(startAtSettings ? SETTINGS_PATH : startPath)
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
