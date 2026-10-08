"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")
const {
  appPathsLookup,
  buildChromeArguments,
  expandWindowsEnv,
  findChrome,
  parseRegQueryValue,
} = require("../src/chrome")
const {
  injectedEndpoints,
  loadConfig,
  loadEndpoints,
  saveEndpoints,
  settingsPageState,
  validateHostname,
  validateProxies,
} = require("../src/config")
const probeModule = require("../src/probe")
const { probeConfigProfile } = probeModule
const { upstreamPathFor } = require("../src/proxy")
const { createL1SubmitBridge, SUBMISSION_TTL_MS } = require("../src/l1SubmitBridge")
const { renderL1SubmitPage, renderL1SubmitGonePage } = require("../src/l1SubmitPage")
const {
  createL1SubmitHttpServer,
  createLocalHttpsServer,
  listenOnLoopback,
  resolveRequestPath,
} = require("../src/server")
const { loadOrCreateCertificate, certificateMatchesHostname } = require("../src/tls")

function request(port, servername, pathname, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const clientRequest = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        servername,
        rejectUnauthorized: false,
        headers: {
          Host: servername,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = []
        response.on("data", (chunk) => chunks.push(chunk))
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        })
      },
    )
    clientRequest.on("error", reject)
    if (body) {
      clientRequest.write(body)
    }
    clientRequest.end()
  })
}

function startFakeUpstream() {
  return new Promise((resolve) => {
    const seen = []
    const upstream = http.createServer((req, res) => {
      const chunks = []
      req.on("data", (chunk) => chunks.push(chunk))
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          host: req.headers.host,
          body: Buffer.concat(chunks).toString("utf8"),
        })
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      })
    })
    upstream.listen(0, "127.0.0.1", () => {
      resolve({ upstream, port: upstream.address().port, seen })
    })
  })
}

function makeFixtureWebRoot(baseDirectory) {
  const webRoot = path.join(baseDirectory, "web")
  fs.mkdirSync(path.join(webRoot, "assets"), { recursive: true })
  fs.writeFileSync(
    path.join(webRoot, "index.html"),
    '<!doctype html><html><head><title>fixture wallet</title><script type="module" ' +
      'src="/assets/app.js"></script></head><body></body></html>',
  )
  fs.writeFileSync(path.join(webRoot, "assets", "app.js"), "console.log('fixture')")
  fs.writeFileSync(
    path.join(webRoot, "assets", "sqlite3.wasm"),
    Buffer.from([0x00, 0x61, 0x73, 0x6d]),
  )
  return webRoot
}

async function main() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "web-wallet-desktop-smoke-"))
  const hostname = "zkmoney-web-wallet.vercel.app"

  try {
    // config
    assert.equal(validateHostname(hostname), hostname)
    assert.equal(validateHostname("LOCALHOST"), "localhost")
    assert.throws(() => validateHostname("not a hostname"))

    // the committed default config is the coherent sandbox pairing
    const configFixture = path.join(temporaryDirectory, "defaults")
    fs.mkdirSync(path.join(configFixture, "config"), { recursive: true })
    fs.copyFileSync(
      path.resolve(__dirname, "../config/default.json"),
      path.join(configFixture, "config/default.json"),
    )
    const committed = loadConfig(configFixture)
    assert.equal(committed.hostname, "localhost")
    assert.equal(committed.localPort, 5173)
    assert.ok(committed.proxies["/svc/enclave"])
    assert.ok(committed.proxies["/svc/account"])

    // configuration settings: save/load round-trip, validation, env precedence, reset-to-empty
    const endpointsFile = path.join(temporaryDirectory, "endpoints.json")
    const profileUrl = "https://config.example/profiles/v5/current.json"
    assert.deepEqual(loadEndpoints(endpointsFile).endpoints, {})
    // endpoint keys an earlier release saved are ignored without a problem
    fs.writeFileSync(
      endpointsFile,
      JSON.stringify({
        l1RpcUrl: "https://rpc.example/v1",
        nodeUrl: "https://node.example",
        nodeApiKey: "key-1",
        enclaveUrl: "http://enclave.example",
        configProfileUrl: profileUrl,
      }),
    )
    const legacy = loadEndpoints(endpointsFile)
    assert.deepEqual(legacy.endpoints, { configProfileUrl: profileUrl })
    assert.deepEqual(legacy.sources, { configProfileUrl: "file", bootFromBakedProfile: null })
    assert.deepEqual(legacy.problems, [])
    // a save writes the two configuration keys and nothing else
    saveEndpoints(endpointsFile, {
      token: "tok",
      configProfileUrl: ` ${profileUrl} `,
      bootFromBakedProfile: true,
      nodeUrl: "https://node.example",
      unknownKey: "x",
    })
    assert.deepEqual(JSON.parse(fs.readFileSync(endpointsFile, "utf8")), {
      configProfileUrl: profileUrl,
      bootFromBakedProfile: true,
    })
    assert.throws(() => saveEndpoints(endpointsFile, { configProfileUrl: "file:///etc/p.json" }))
    assert.throws(() => saveEndpoints(endpointsFile, { configProfileUrl: "not a url" }))
    // outside sandbox builds the profile URL must have the shape the wallet requires
    const shaped = { profileShape: true }
    for (const bad of [
      "http://config.example/profiles/v5/current.json",
      "https://config.example/p.json",
      "https://config.example/profiles/v5/current.json?x=1",
      "https://config.example/profiles/v5/current.json#x",
      "https://user:pw@config.example/profiles/v5/current.json",
      "https://config.example/profiles/v5/1.2.json",
    ]) {
      assert.throws(
        () => saveEndpoints(endpointsFile, { configProfileUrl: bad }, shaped),
        /must be https:\/\/<host>\/profiles\//,
        bad,
      )
    }
    for (const good of [profileUrl, "https://config.example/profiles/v5/1.2.3.json"]) {
      saveEndpoints(endpointsFile, { configProfileUrl: good }, shaped)
      assert.equal(loadEndpoints(endpointsFile, shaped).endpoints.configProfileUrl, good)
    }
    fs.writeFileSync(
      endpointsFile,
      JSON.stringify({ configProfileUrl: "https://x.example/p.json" }),
    )
    assert.equal(loadEndpoints(endpointsFile).problems.length, 0)
    assert.deepEqual(
      loadEndpoints(endpointsFile, shaped).problems.map((p) => [p.key, p.source]),
      [["configProfileUrl", "file"]],
    )
    saveEndpoints(endpointsFile, { configProfileUrl: profileUrl, bootFromBakedProfile: true })
    // the environment wins, and can force the switch off over a saved on
    process.env.OBSIDION_CONFIG_PROFILE_URL = "https://env.example/p.json"
    process.env.OBSIDION_BOOT_FROM_BAKED_PROFILE = "0"
    const withEnv = loadEndpoints(endpointsFile)
    assert.deepEqual(withEnv.endpoints, { configProfileUrl: "https://env.example/p.json" })
    assert.deepEqual(withEnv.sources, { configProfileUrl: "env", bootFromBakedProfile: "env" })
    // nonsense is reported and skipped, and the saved values still apply
    process.env.OBSIDION_CONFIG_PROFILE_URL = "not a url"
    process.env.OBSIDION_BOOT_FROM_BAKED_PROFILE = "maybe"
    const flawed = loadEndpoints(endpointsFile)
    assert.deepEqual(
      flawed.problems.map((p) => [p.key, p.source]),
      [
        ["configProfileUrl", "env"],
        ["bootFromBakedProfile", "env"],
      ],
    )
    assert.match(flawed.problems[0].message, /not a valid URL/)
    assert.match(flawed.problems[1].message, /must be one of/)
    assert.deepEqual(flawed.endpoints, { configProfileUrl: profileUrl, bootFromBakedProfile: true })
    assert.equal(flawed.sources.configProfileUrl, "file")
    delete process.env.OBSIDION_CONFIG_PROFILE_URL
    delete process.env.OBSIDION_BOOT_FROM_BAKED_PROFILE
    // the endpoint variables are not read
    process.env.OBSIDION_NODE_URL = "not a url"
    process.env.OBSIDION_L1_RPC_URL = "not a url"
    assert.deepEqual(loadEndpoints(endpointsFile).problems, [])
    delete process.env.OBSIDION_NODE_URL
    delete process.env.OBSIDION_L1_RPC_URL
    // an invalid saved value is one problem, and the other setting survives it
    fs.writeFileSync(
      endpointsFile,
      JSON.stringify({ configProfileUrl: "ftp://x.example/p.json", bootFromBakedProfile: true }),
    )
    const badSaved = loadEndpoints(endpointsFile)
    assert.deepEqual(
      badSaved.problems.map((p) => [p.key, p.source]),
      [["configProfileUrl", "file"]],
    )
    assert.deepEqual(badSaved.endpoints, { bootFromBakedProfile: true })
    // an unreadable file is one problem, not a crash
    fs.writeFileSync(endpointsFile, "{ not json")
    const unreadable = loadEndpoints(endpointsFile)
    assert.deepEqual(unreadable.endpoints, {})
    assert.equal(unreadable.problems.length, 1)
    assert.equal(unreadable.problems[0].key, null)
    assert.match(unreadable.problems[0].message, /Unreadable settings file/)
    // off is the absence of the key, never a stored false
    saveEndpoints(endpointsFile, { bootFromBakedProfile: false })
    assert.deepEqual(loadEndpoints(endpointsFile).endpoints, {})
    assert.doesNotMatch(fs.readFileSync(endpointsFile, "utf8"), /false/)
    process.env.OBSIDION_BOOT_FROM_BAKED_PROFILE = "1"
    assert.equal(loadEndpoints(endpointsFile).endpoints.bootFromBakedProfile, true)
    assert.equal(loadEndpoints(endpointsFile).sources.bootFromBakedProfile, "env")
    delete process.env.OBSIDION_BOOT_FROM_BAKED_PROFILE
    // reset = save with everything empty → all overrides cleared
    saveEndpoints(endpointsFile, { configProfileUrl: "", bootFromBakedProfile: false })
    assert.deepEqual(loadEndpoints(endpointsFile).endpoints, {})

    // the wallet's __ZKMONEY_ENDPOINTS__: the configuration key alone, the switch winning
    assert.deepEqual(injectedEndpoints({}), {})
    assert.deepEqual(injectedEndpoints({ configProfileUrl: profileUrl }), {
      configProfileUrl: profileUrl,
    })
    assert.deepEqual(
      injectedEndpoints({ configProfileUrl: profileUrl, bootFromBakedProfile: true }),
      { bootFromBakedProfile: true },
    )

    // startup profile probe: mirrors the wallet's own verdict on the document
    const reply = (status, body) => async () =>
      new Response(body === undefined ? null : JSON.stringify(body), { status })
    const probeNow = () => new Date("2026-09-01T00:00:00Z")
    const probe = (fetchImpl) =>
      probeConfigProfile("https://config.example/p.json", { fetchImpl, now: probeNow })
    assert.equal((await probe(reply(200, { profileId: "x", expiresAt: "2099-01-01T00:00:00Z" }))).state, "ok")
    assert.equal((await probe(reply(200, { profileId: "x" }))).state, "ok")
    assert.deepEqual(await probe(reply(200, { profileId: "x", expiresAt: "2026-08-01T00:00:00Z" })), {
      state: "rejected",
      detail: "the document expired at 2026-08-01T00:00:00Z",
    })
    assert.deepEqual(await probe(reply(403)), { state: "rejected", detail: "the server answered 403" })
    assert.equal((await probe(reply(404))).state, "rejected")
    assert.equal((await probe(reply(200, "not a profile"))).state, "rejected")
    assert.equal((await probe(reply(200))).state, "rejected")
    assert.equal((await probe(reply(503))).state, "unreachable")
    // a body cut short by the network is silence, not a verdict: the wallet falls back on it
    const cutShort = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new TypeError("terminated")
      },
    })
    assert.deepEqual(await probe(cutShort), {
      state: "unreachable",
      detail: "the response was cut short: terminated",
    })
    assert.equal(
      (
        await probe(async () => {
          throw new TypeError("fetch failed")
        })
      ).state,
      "unreachable",
    )
    // the launcher probes no endpoint of its own
    assert.equal(probeModule.probeL1Rpc, undefined)
    assert.throws(() => validateProxies({ "svc/enclave": "http://127.0.0.1" }))
    assert.throws(() => validateProxies({ "/svc/enclave/": "http://127.0.0.1" }))
    assert.throws(() => validateProxies({ "/svc/enclave": "ftp://127.0.0.1" }))
    assert.deepEqual(validateProxies({ "/svc/enclave": "http://127.0.0.1:1234" }), {
      "/svc/enclave": "http://127.0.0.1:1234",
    })

    // proxy path rewrite parity with vite's `path.replace(prefix, "") || "/"`
    const target = new URL("http://upstream.example")
    assert.equal(upstreamPathFor("/svc/enclave/rpc", "/svc/enclave", target), "/rpc")
    assert.equal(upstreamPathFor("/svc/enclave", "/svc/enclave", target), "/")
    assert.equal(
      upstreamPathFor("/svc/enclave/rpc", "/svc/enclave", new URL("http://upstream.example/base/")),
      "/base/rpc",
    )

    // static path resolution
    const webRoot = makeFixtureWebRoot(temporaryDirectory)
    assert.equal(resolveRequestPath(webRoot, "/index.html"), path.join(webRoot, "index.html"))
    assert.equal(resolveRequestPath(webRoot, "/../../etc/passwd"), null)

    // tls: generation, SPKI, hostname-mismatch regeneration
    const tlsDirectory = path.join(temporaryDirectory, "tls")
    const tls = loadOrCreateCertificate({ hostname, certificateDays: 2, tlsDirectory })
    assert.ok(tls.spkiSha256.length > 30)
    assert.ok(certificateMatchesHostname(tls.certPem, hostname))
    assert.ok(!certificateMatchesHostname(tls.certPem, "other.example"))
    const regenerated = loadOrCreateCertificate({
      hostname: "wallet.zk.money",
      certificateDays: 2,
      tlsDirectory,
    })
    assert.ok(certificateMatchesHostname(regenerated.certPem, "wallet.zk.money"))

    // server
    const fake = await startFakeUpstream()
    const l1Bridge = createL1SubmitBridge()
    const openedSubmitPages = []
    // A settings file an earlier release wrote: its endpoint keys reach neither global.
    const settingsFile = path.join(temporaryDirectory, "served-endpoints.json")
    const savedProfileUrl = "https://config.example/profiles/v5/current.json"
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        l1RpcUrl: "https://rpc.example/v1",
        nodeUrl: "https://node.example",
        nodeApiKey: "key-1",
        enclaveUrl: "http://enclave.example",
        configProfileUrl: savedProfileUrl,
        bootFromBakedProfile: "maybe",
      }),
    )
    const servedProfile = { url: savedProfileUrl, overridden: true, baked: null }
    const servedProbe = {
      state: "rejected",
      detail: "</script><script>alert(1)</script>",
      overridden: true,
      bakedExpired: false,
    }
    const relaunchAnswers = ["accepted", "already-relaunching", new Error("write EPIPE")]
    const settings = {
      token: "test-token",
      state: () =>
        settingsPageState({
          token: "test-token",
          endpointState: loadEndpoints(settingsFile),
          builtAt: "2026-08-10T00:00:00.000Z",
          profile: servedProfile,
          profileProbe: servedProbe,
        }),
      save: async (body) => {
        saveEndpoints(settingsFile, body)
      },
      relaunch: async () => {
        const answer = relaunchAnswers.shift()
        if (answer instanceof Error) throw answer
        return answer
      },
    }
    const faviconPath = path.join(temporaryDirectory, "favicon.svg")
    fs.writeFileSync(faviconPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const server = createLocalHttpsServer({
      hostname,
      webRoot,
      certPem: tls.certPem,
      keyPem: tls.keyPem,
      contentSecurityPolicy: null,
      spaFallback: true,
      proxies: {
        "/svc/enclave": `http://127.0.0.1:${fake.port}`,
      },
      injectEndpoints: () => injectedEndpoints(loadEndpoints(settingsFile).endpoints),
      injectBridge: () => ({ l1SubmitPath: "/desktop/l1-submit", settingsPath: "/desktop-settings" }),
      settings,
      l1Submit: {
        create: (body) => l1Bridge.create(body),
        get: (id) => l1Bridge.get(id),
        resolveCheck: (id, body) => l1Bridge.resolveCheck(id, body),
        submitUrl: (id) => `http://127.0.0.1:9999/submit/${id}`,
        openSubmitPage: async (id) => openedSubmitPages.push(id),
      },
      launcherAssets: {
        "/favicon.ico": { filePath: faviconPath, contentType: "image/svg+xml; charset=utf-8" },
        "/favicon.svg": { filePath: faviconPath, contentType: "image/svg+xml; charset=utf-8" },
      },
    })
    const port = await listenOnLoopback(server)
    const endpointUrls = /rpc\.example|node\.example|enclave\.example|key-1/

    // index: 200 + crossOriginIsolated header pair, no CSP by default, the configuration
    // override and the bridge injected ahead of the content with an accurate Content-Length
    const index = await request(port, hostname, "/")
    assert.equal(index.statusCode, 200)
    assert.match(index.body, /fixture wallet/)
    assert.match(
      index.body,
      /__ZKMONEY_ENDPOINTS__ = Object\.freeze\(\{"configProfileUrl":"https:\/\/config\.example\/profiles\/v5\/current\.json"\}\)/,
    )
    assert.match(index.body, /__ZKMONEY_DESKTOP_BRIDGE__/)
    assert.match(index.body, /\/desktop\/l1-submit/)
    assert.match(index.body, /"settingsPath":"\/desktop-settings"/)
    assert.doesNotMatch(index.body, endpointUrls)
    assert.doesNotMatch(index.body, /__ZKMONEY_DESKTOP_SETTINGS__/)
    assert.equal(Number(index.headers["content-length"]), Buffer.byteLength(index.body))
    assert.equal(index.headers["cross-origin-opener-policy"], "same-origin")
    assert.equal(index.headers["cross-origin-embedder-policy"], "require-corp")
    assert.equal(index.headers["content-security-policy"], undefined)

    // injection only touches index.html, never assets
    const asset = await request(port, hostname, "/assets/app.js")
    assert.doesNotMatch(asset.body, /__ZKMONEY_ENDPOINTS__/)

    // wasm MIME + HEAD/GET header parity
    const wasm = await request(port, hostname, "/assets/sqlite3.wasm")
    assert.equal(wasm.statusCode, 200)
    assert.equal(wasm.headers["content-type"], "application/wasm")
    const wasmHead = await request(port, hostname, "/assets/sqlite3.wasm", { method: "HEAD" })
    assert.equal(wasmHead.statusCode, 200)
    for (const header of [
      "content-type",
      "content-length",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
    ]) {
      assert.equal(wasmHead.headers[header], wasm.headers[header], `HEAD/GET mismatch on ${header}`)
    }

    // missing asset: hard 404, never index.html
    const missingAsset = await request(port, hostname, "/assets/does-not-exist.wasm")
    assert.equal(missingAsset.statusCode, 404)
    assert.doesNotMatch(missingAsset.body, /fixture wallet/)
    const missingExtensioned = await request(port, hostname, "/deep/route/file.wasm")
    assert.equal(missingExtensioned.statusCode, 404)

    // SPA fallback for client-side routes (incl. the X OAuth callback) — injected too
    const callback = await request(port, hostname, "/auth/x/callback?code=abc")
    assert.equal(callback.statusCode, 200)
    assert.match(callback.body, /fixture wallet/)
    assert.match(callback.body, /__ZKMONEY_ENDPOINTS__/)
    assert.doesNotMatch(callback.body, /__ZKMONEY_DESKTOP_SETTINGS__/)

    // settings page: the wallet's index.html with its state, served before the SPA fallback
    const settingsPage = await request(port, hostname, "/desktop-settings")
    assert.equal(settingsPage.statusCode, 200)
    assert.match(settingsPage.body, /fixture wallet/)
    assert.equal(
      Number(settingsPage.headers["content-length"]),
      Buffer.byteLength(settingsPage.body),
    )
    const stateAt = settingsPage.body.indexOf("window.__ZKMONEY_DESKTOP_SETTINGS__")
    assert.ok(stateAt > settingsPage.body.indexOf("<head>"))
    assert.ok(stateAt < settingsPage.body.indexOf('<script type="module"'))
    assert.doesNotMatch(settingsPage.body, /<\/script><script>alert/)
    assert.doesNotMatch(settingsPage.body, endpointUrls)
    const servedState = JSON.parse(
      /window\.__ZKMONEY_DESKTOP_SETTINGS__ = Object\.freeze\((.*?)\)<\/script>/.exec(
        settingsPage.body,
      )[1],
    )
    assert.equal(servedState.problems[0].key, "bootFromBakedProfile")
    assert.match(servedState.problems[0].message, /must be one of/)
    assert.deepEqual(servedState, {
      token: "test-token",
      values: { configProfileUrl: savedProfileUrl },
      sources: { configProfileUrl: "file", bootFromBakedProfile: null },
      problems: [
        {
          key: "bootFromBakedProfile",
          source: "file",
          message: servedState.problems[0].message,
        },
      ],
      builtAt: "2026-08-10T00:00:00.000Z",
      profile: servedProfile,
      profileProbe: servedProbe,
    })
    const settingsHead = await request(port, hostname, "/desktop-settings", { method: "HEAD" })
    assert.equal(settingsHead.statusCode, 200)
    assert.equal(settingsHead.body, "")
    for (const header of [
      "content-type",
      "content-length",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
    ]) {
      assert.equal(settingsHead.headers[header], settingsPage.headers[header], header)
    }

    // settings mutations: token-gated; a save keeps only the configuration keys
    const postJson = (pathname, body) =>
      request(port, hostname, pathname, { method: "POST", body: JSON.stringify(body) })
    const savedBefore = fs.readFileSync(settingsFile, "utf8")
    const badToken = await postJson("/desktop-settings/save", {
      token: "wrong",
      configProfileUrl: "https://x.example/profiles/v5/current.json",
    })
    assert.equal(badToken.statusCode, 403)
    assert.equal(fs.readFileSync(settingsFile, "utf8"), savedBefore)
    const goodSave = await postJson("/desktop-settings/save", {
      token: "test-token",
      configProfileUrl: "https://x.example/profiles/v5/current.json",
      bootFromBakedProfile: false,
      nodeUrl: "https://node.example",
      l1RpcUrl: "https://rpc.example/v1",
    })
    assert.equal(goodSave.statusCode, 200)
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), {
      configProfileUrl: "https://x.example/profiles/v5/current.json",
    })
    const badSave = await postJson("/desktop-settings/save", {
      token: "test-token",
      configProfileUrl: "ftp://x.example/p.json",
    })
    assert.equal(badSave.statusCode, 400)
    assert.match(JSON.parse(badSave.body).error, /must be http\(s\)/)
    const slashless = await postJson("/desktop-settings/save", {
      token: "test-token",
      configProfileUrl: "https:x.example/profiles/v5/current.json",
    })
    assert.equal(slashless.statusCode, 400)
    assert.match(JSON.parse(slashless.body).error, /must start with http:\/\/ or https:\/\//)
    // a body that is not an object is refused before the token is looked at
    const nullBody = await request(port, hostname, "/desktop-settings/save", {
      method: "POST",
      body: "null",
    })
    assert.equal(nullBody.statusCode, 400)
    assert.match(JSON.parse(nullBody.body).error, /JSON object/)
    // a page on another site cannot save, relaunch or submit; a same-origin page can
    const savedAfterGood = fs.readFileSync(settingsFile, "utf8")
    const mutatingRoutes = [
      "/desktop-settings/save",
      "/desktop-settings/relaunch",
      "/desktop/l1-submit",
      `/desktop/l1-submit/${"0".repeat(32)}/recheck`,
    ]
    for (const route of mutatingRoutes) {
      const refused = await request(port, hostname, route, {
        method: "POST",
        body: JSON.stringify({ token: "test-token" }),
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
      assert.equal(refused.statusCode, 403, route)
      assert.match(JSON.parse(refused.body).error, /Only the wallet/)
    }
    assert.equal(fs.readFileSync(settingsFile, "utf8"), savedAfterGood)
    const sameOrigin = await request(port, hostname, "/desktop-settings/save", {
      method: "POST",
      body: JSON.stringify({ token: "test-token", configProfileUrl: "" }),
      headers: { "Sec-Fetch-Site": "same-origin" },
    })
    assert.equal(sameOrigin.statusCode, 200)
    // a request for any other hostname is not this server's to answer
    const misdirected = await request(port, hostname, "/", { headers: { Host: "evil.example" } })
    assert.equal(misdirected.statusCode, 421)
    const withPort = await request(port, hostname, "/", {
      headers: { Host: `${hostname}:${port}` },
    })
    assert.equal(withPort.statusCode, 200)

    // relaunch: the session's answer, or a 500 when the close command was not written
    assert.equal((await postJson("/desktop-settings/relaunch", { token: "wrong" })).statusCode, 403)
    const accepted = await postJson("/desktop-settings/relaunch", { token: "test-token" })
    assert.equal(accepted.statusCode, 200)
    assert.deepEqual(JSON.parse(accepted.body), { ok: true, status: "accepted" })
    const again = await postJson("/desktop-settings/relaunch", { token: "test-token" })
    assert.deepEqual(JSON.parse(again.body), { ok: true, status: "already-relaunching" })
    const failed = await postJson("/desktop-settings/relaunch", { token: "test-token" })
    assert.equal(failed.statusCode, 500)
    assert.deepEqual(JSON.parse(failed.body), { error: "write EPIPE" })
    const settingsGetOnly = await request(port, hostname, "/desktop-settings/save")
    assert.equal(settingsGetOnly.statusCode, 405)

    const nested = await request(port, hostname, "/contacts/someone/send")
    assert.equal(nested.statusCode, 200)
    assert.match(nested.body, /fixture wallet/)
    assert.doesNotMatch(nested.body, /__ZKMONEY_DESKTOP_SETTINGS__/)

    // launcher assets: favicon on both conventional paths
    for (const faviconRoute of ["/favicon.ico", "/favicon.svg"]) {
      const icon = await request(port, hostname, faviconRoute)
      assert.equal(icon.statusCode, 200)
      assert.match(icon.headers["content-type"], /image\/svg\+xml/)
      assert.match(icon.body, /<svg/)
    }

    // non-proxied POST is refused
    const post = await request(port, hostname, "/", { method: "POST", body: "{}" })
    assert.equal(post.statusCode, 405)

    // proxy: prefix strip, root preservation, host rewrite, POST body round-trip
    const rpc = await request(port, hostname, "/svc/enclave/rpc", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    })
    assert.equal(rpc.statusCode, 200)
    assert.equal(JSON.parse(rpc.body).ok, true)
    const bare = await request(port, hostname, "/svc/enclave", { method: "POST", body: "{}" })
    assert.equal(bare.statusCode, 200)
    assert.deepEqual(
      fake.seen.map((r) => r.url),
      ["/rpc", "/"],
    )
    assert.equal(fake.seen[0].method, "POST")
    assert.equal(fake.seen[0].host, `127.0.0.1:${fake.port}`)
    assert.equal(JSON.parse(fake.seen[0].body).method, "ping")

    // L1 submit bridge: validation, lifecycle, wallet-origin routes, helper listener
    const validTx = {
      to: "0x" + "ab".repeat(20),
      data: "0xa9059cbb" + "00".repeat(64),
      chainId: 11155111,
    }
    const validDisplay = {
      title: "Fund your zk.money deposit",
      lines: [
        ["Amount", "5 DAI"],
        ["Deposit address", "0x" + "cd".repeat(20)],
      ],
    }
    assert.throws(() => l1Bridge.create({ tx: { ...validTx, to: "nope" }, display: validDisplay }))
    assert.throws(() => l1Bridge.create({ tx: { ...validTx, chainId: 0 }, display: validDisplay }))
    assert.throws(() => l1Bridge.create({ tx: validTx, display: { title: "x", lines: [["one"]] } }))

    const createResponse = await request(port, hostname, "/desktop/l1-submit", {
      method: "POST",
      body: JSON.stringify({ tx: validTx, display: validDisplay }),
    })
    assert.equal(createResponse.statusCode, 200)
    const created = JSON.parse(createResponse.body)
    const submissionId = created.id
    assert.match(submissionId, /^[a-f0-9]{32}$/)
    assert.equal(created.submitUrl, `http://127.0.0.1:9999/submit/${submissionId}`)
    assert.deepEqual(openedSubmitPages, [submissionId])
    const pendingStatus = await request(port, hostname, `/desktop/l1-submit/${submissionId}`)
    assert.equal(JSON.parse(pendingStatus.body).state, "pending")
    const unknownStatus = await request(port, hostname, `/desktop/l1-submit/${"0".repeat(32)}`)
    assert.equal(unknownStatus.statusCode, 404)
    const badCreate = await request(port, hostname, "/desktop/l1-submit", {
      method: "POST",
      body: JSON.stringify({ tx: {}, display: {} }),
    })
    assert.equal(badCreate.statusCode, 400)

    // helper listener: page render, invalid report refused, submitted reported, terminal → gone
    const submitServer = createL1SubmitHttpServer({
      bridge: l1Bridge,
      renderPage: renderL1SubmitPage,
      renderGonePage: renderL1SubmitGonePage,
    })
    const submitPort = await listenOnLoopback(submitServer)
    const submitBase = `http://127.0.0.1:${submitPort}/submit/${submissionId}`
    const helperPage = await fetch(submitBase)
    const helperHtml = await helperPage.text()
    assert.equal(helperPage.status, 200)
    assert.match(helperHtml, /Fund your zk.money deposit/)
    assert.match(helperHtml, /5 DAI/)
    assert.match(helperHtml, /eth_sendTransaction/)
    assert.match(helperHtml, /eth_estimateGas/)
    assert.match(helperHtml, /page-origin/)
    const reportBad = await fetch(`${submitBase}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "submitted", txHash: "nope" }),
    })
    assert.equal(reportBad.status, 400)
    const txHash = "0x" + "12".repeat(32)
    const reportOk = await fetch(`${submitBase}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "submitted", txHash }),
    })
    assert.equal(reportOk.status, 200)
    const submittedStatus = await request(port, hostname, `/desktop/l1-submit/${submissionId}`)
    assert.deepEqual(JSON.parse(submittedStatus.body), { state: "submitted", txHash })
    assert.match(await (await fetch(submitBase)).text(), /expired/)
    const reportAgain = await fetch(`${submitBase}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "submitted", txHash }),
    })
    assert.equal(reportAgain.status, 400)
    await new Promise((resolve) => submitServer.close(resolve))

    // recheck submissions: the helper asks before each send and only the wallet origin answers
    assert.throws(() => l1Bridge.create({ tx: validTx, display: validDisplay, recheck: "yes" }))
    const plain = l1Bridge.create({ tx: validTx, display: validDisplay })
    assert.throws(() => l1Bridge.requestCheck(plain.id), /does not take a check/)
    assert.equal(l1Bridge.get(plain.id).check, undefined)

    const recheckServer = createL1SubmitHttpServer({
      bridge: l1Bridge,
      renderPage: renderL1SubmitPage,
      renderGonePage: renderL1SubmitGonePage,
    })
    const recheckPort = await listenOnLoopback(recheckServer)
    const helper = (id, suffix = "", init) =>
      fetch(`http://127.0.0.1:${recheckPort}/submit/${id}${suffix}`, init)
    const jsonPost = (body) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const appStatus = async (id) =>
      JSON.parse((await request(port, hostname, `/desktop/l1-submit/${id}`)).body)
    const reportSent = async (id, attempt) =>
      (await helper(id, "/status", jsonPost({ state: "submitted", txHash, attempt }))).status
    const TAB_A = "a1".repeat(16)
    const TAB_B = "b2".repeat(16)
    const check = (id, attempt) => helper(id, "/check", jsonPost({ attempt }))
    const claim = async (id, attempt, n) =>
      (await helper(id, "/claim", jsonPost({ attempt, check: n }))).status
    const release = async (id, attempt) =>
      (await helper(id, "/release", jsonPost({ attempt }))).status
    const answer = (id, body) =>
      request(port, hostname, `/desktop/l1-submit/${id}/recheck`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    const createRecheck = async () => {
      const response = await request(port, hostname, "/desktop/l1-submit", {
        method: "POST",
        body: JSON.stringify({ tx: validTx, display: validDisplay, recheck: true }),
      })
      assert.equal(response.statusCode, 200)
      return JSON.parse(response.body).id
    }

    const checked = await createRecheck()
    assert.equal(l1Bridge.get(plain.id).state, "superseded")
    assert.deepEqual(await appStatus(checked), {
      state: "pending",
      check: 0,
    })
    const checkedHtml = await (await helper(checked)).text()
    assert.match(checkedHtml, /checks this transfer again/)
    assert.match(checkedHtml, /const recheck = true/)
    assert.match(checkedHtml, /post\("check"/)
    // the page's script parses; the plain page keeps recheck off
    new vm.Script(/<script>([\s\S]*)<\/script>/.exec(checkedHtml)[1])
    assert.match(helperHtml, /const recheck = false/)

    // no send report before an approval and a claim; the helper listener has no approval route
    assert.equal(await reportSent(checked, TAB_A), 400)
    assert.equal((await helper(checked, "/recheck", jsonPost({ check: 1, ok: true }))).status, 404)
    // a check names its attempt
    assert.equal((await helper(checked, "/check", { method: "POST" })).status, 400)

    assert.deepEqual(await (await check(checked, TAB_A)).json(), { state: "checking", check: 1 })
    assert.deepEqual(await appStatus(checked), { state: "checking", check: 1 })
    assert.equal((await answer(checked, { check: 0, ok: true })).statusCode, 400)
    assert.equal((await answer(checked, { check: 1 })).statusCode, 400)
    assert.equal((await answer(checked, { check: 1, ok: false })).statusCode, 400)
    assert.equal((await answer(checked, { check: 1, ok: true })).statusCode, 200)
    assert.equal((await (await helper(checked, "/state")).json()).state, "authorized")
    assert.equal((await answer(checked, { check: 1, ok: true })).statusCode, 400)

    // only the attempt that asked for the current check can claim its approval
    assert.equal(await claim(checked, TAB_B, 1), 400)
    assert.equal(await claim(checked, TAB_A, 0), 400)
    assert.equal(await claim(checked, TAB_A, 1), 200)
    assert.equal((await appStatus(checked)).state, "sending")
    assert.match(await (await helper(checked)).text(), /Open wallet/)

    // while that wallet prompt is open, another tab can neither start a check nor claim nor report
    const blocked = await check(checked, TAB_B)
    assert.equal(blocked.status, 400)
    assert.match((await blocked.json()).error, /already open in a wallet/)
    assert.equal(await claim(checked, TAB_B, 1), 400)
    assert.equal(await reportSent(checked, TAB_B), 400)

    // the prompt was declined: only its attempt releases it, and then it can no longer report
    assert.equal(await release(checked, TAB_B), 400)
    assert.equal(await release(checked, TAB_A), 200)
    assert.equal((await appStatus(checked)).state, "pending")
    assert.equal(await reportSent(checked, TAB_A), 400)

    // a new attempt needs a new approval; the old one is void; a refusal ends the submission
    assert.equal((await (await check(checked, TAB_B)).json()).check, 2)
    assert.equal((await answer(checked, { check: 1, ok: true })).statusCode, 400)
    const reason = "Network capacity changed."
    assert.equal((await answer(checked, { check: 2, ok: false, message: reason })).statusCode, 200)
    assert.deepEqual(await (await helper(checked, "/state")).json(), {
      state: "refused",
      check: 2,
      message: reason,
    })
    assert.equal((await appStatus(checked)).message, reason)
    for (const [message, sentence] of [
      ["Check failed", "stopped this transfer: Check failed. Go back"],
      ["Is capacity back?", "stopped this transfer: Is capacity back? Go back"],
    ]) {
      const page = renderL1SubmitGonePage({ state: "refused", message })
      assert.ok(page.includes(sentence), message)
    }
    const stoppedHtml = await (await helper(checked)).text()
    assert.match(stoppedHtml, /This transfer was stopped/)
    assert.match(stoppedHtml, /stopped this transfer: Network capacity changed\. Go back/)
    assert.equal((await check(checked, TAB_A)).status, 400)
    assert.equal(await reportSent(checked, TAB_B), 400)

    // the claimed send reports its hash
    const approved = await createRecheck()
    await check(approved, TAB_A)
    await answer(approved, { check: 1, ok: true })
    assert.equal(await claim(approved, TAB_A, 1), 200)
    assert.equal(await reportSent(approved, TAB_A), 200)
    assert.deepEqual(await appStatus(approved), { state: "submitted", txHash, check: 1 })

    // an approval nobody claimed holds nothing: another tab may take over, and the old one is void
    const unclaimed = await createRecheck()
    await check(unclaimed, TAB_A)
    await answer(unclaimed, { check: 1, ok: true })
    assert.equal((await (await check(unclaimed, TAB_B)).json()).check, 2)
    assert.equal(await claim(unclaimed, TAB_A, 1), 400)
    await answer(unclaimed, { check: 2, ok: true })
    assert.equal(await claim(unclaimed, TAB_B, 2), 200)
    assert.equal(await reportSent(unclaimed, TAB_B), 200)

    // a submission never approved cannot report a send
    const neverApproved = await createRecheck()
    await check(neverApproved, TAB_A)
    await answer(neverApproved, { check: 1, ok: false, message: reason })
    assert.equal(await reportSent(neverApproved, TAB_A), 400)

    // a new create supersedes a submission that is waiting on a check
    const waiting = await createRecheck()
    await check(waiting, TAB_A)
    await createRecheck()
    assert.equal(l1Bridge.get(waiting).state, "superseded")
    assert.equal((await answer(waiting, { check: 1, ok: true })).statusCode, 400)
    assert.equal(await reportSent(waiting, TAB_A), 400)

    // a claimed send outlives later creates: no checked submission starts beside it, a plain one
    // leaves it alone, an error report does not end it, and it still reports its hash
    const claimedFirst = await createRecheck()
    await check(claimedFirst, TAB_A)
    await answer(claimedFirst, { check: 1, ok: true })
    assert.equal(await claim(claimedFirst, TAB_A, 1), 200)
    const create = (body) =>
      request(port, hostname, "/desktop/l1-submit", { method: "POST", body: JSON.stringify(body) })
    const beside = await create({ tx: validTx, display: validDisplay, recheck: true })
    assert.equal(beside.statusCode, 409)
    assert.match(JSON.parse(beside.body).error, /already open in a wallet/)
    assert.equal((await create({ tx: validTx, display: validDisplay })).statusCode, 200)
    assert.equal(l1Bridge.get(claimedFirst).state, "sending")
    const uncertain = { state: "error", message: "Internal JSON-RPC error.", attempt: TAB_A }
    assert.equal((await helper(claimedFirst, "/status", jsonPost(uncertain))).status, 400)
    assert.equal(l1Bridge.get(claimedFirst).state, "sending")
    assert.equal(await reportSent(claimedFirst, TAB_B), 400)
    assert.equal(await reportSent(claimedFirst, TAB_A), 200)
    // a declined prompt releases the send, and then a new create replaces it
    const declinedFirst = await createRecheck()
    await check(declinedFirst, TAB_A)
    await answer(declinedFirst, { check: 1, ok: true })
    assert.equal(await claim(declinedFirst, TAB_A, 1), 200)
    assert.equal(await release(declinedFirst, TAB_A), 200)
    await createRecheck()
    assert.equal(l1Bridge.get(declinedFirst).state, "superseded")
    assert.equal((await helper(`${"0".repeat(32)}`, "/state")).status, 404)
    await new Promise((resolve) => recheckServer.close(resolve))

    // expiry: an approval nobody claimed blocks nothing; a claimed send outlives the TTL
    {
      let clock = 0
      const bridge = createL1SubmitBridge({ now: () => clock })
      const approve = (id) => {
        bridge.requestCheck(id, { attempt: TAB_A })
        bridge.resolveCheck(id, { check: 1, ok: true })
      }
      const make = () => bridge.create({ tx: validTx, display: validDisplay, recheck: true }).id
      const abandoned = make()
      approve(abandoned)
      const next = make()
      assert.equal(bridge.get(abandoned).state, "superseded")
      approve(next)
      bridge.claimSend(next, { attempt: TAB_A, check: 1 })
      clock += SUBMISSION_TTL_MS + 1
      assert.equal(bridge.get(abandoned), null)
      assert.equal(bridge.get(next).state, "sending")
      assert.throws(make, /already open in a wallet/)
      bridge.report(next, { state: "submitted", txHash, attempt: TAB_A })
      make()
    }

    // the helper page's send gate, run against the real bridge on a virtual clock
    /** One helper tab: renders the page, clicks send, and resolves `done` when the click settles. */
    const openTab = (
      id,
      { onTick = () => {}, send = async () => txHash, unreachable = new Set() } = {},
    ) => {
      const payload = l1Bridge.getPayload(id)
      const html = renderL1SubmitPage(id, payload)
      let clock = 0
      const walletCalls = []
      const elements = {}
      const document = {
        body: { innerHTML: "" },
        getElementById: (name) =>
          (elements[name] ??= {
            textContent: "",
            className: "",
            hidden: true,
            disabled: false,
            addEventListener(type, listener) {
              this[type] = listener
            },
          }),
      }
      const respond = (read) => {
        try {
          const body = read()
          if (body === null) return { ok: false, status: 404, json: async () => ({}) }
          return { ok: true, status: 200, json: async () => body }
        } catch (error) {
          return { ok: false, status: 400, json: async () => ({ error: error.message }) }
        }
      }
      const body = (init) => JSON.parse(init.body)
      const routes = {
        check: (init) => l1Bridge.requestCheck(id, body(init)),
        claim: (init) => l1Bridge.claimSend(id, body(init)),
        release: (init) => l1Bridge.releaseSend(id, body(init)),
        state: () => l1Bridge.getState(id),
        status: (init) => l1Bridge.report(id, body(init)),
      }
      const ethereum = {
        request: async ({ method }) => {
          if (method === "eth_sendTransaction") {
            walletCalls.push(`send@${l1Bridge.get(id).state}`)
            return send()
          }
          walletCalls.push(method)
          return {
            eth_requestAccounts: ["0x" + "ee".repeat(20)],
            eth_chainId: "0x" + payload.tx.chainId.toString(16),
            eth_estimateGas: "0x5208",
          }[method]
        },
      }
      const context = vm.createContext({
        document,
        location: { host: "127.0.0.1:1" },
        window: { ethereum },
        crypto,
        fetch: async (url, init) => {
          const route = url.split("/").pop()
          if (unreachable.has(route)) throw new TypeError("Failed to fetch")
          return respond(() => routes[route](init))
        },
        Date: { now: () => clock },
        setTimeout: (callback, ms) => {
          clock += ms
          onTick(clock)
          setImmediate(callback)
        },
      })
      vm.runInContext(/<script>([\s\S]*)<\/script>/.exec(html)[1], context)
      const tab = {
        walletCalls,
        button: elements.send,
        document,
        click: () => elements.send.click(),
      }
      tab.done = elements.send.click().then(() => tab)
      Object.defineProperty(tab, "status", { get: () => elements.status.textContent })
      return tab
    }
    const clickSend = (id, onTick) => openTab(id, { onTick }).done
    /** Resolves once `tab` has asked its wallet to send. */
    const untilSending = async (tab) => {
      while (!tab.walletCalls.some((call) => call.startsWith("send@"))) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    const answerAt = (id, at, body) => (clock) => {
      if (clock === at) l1Bridge.resolveCheck(id, { check: l1Bridge.get(id).check, ...body })
    }
    const answerChecks = (id) => () => {
      const record = l1Bridge.get(id)
      if (record.state === "checking") l1Bridge.resolveCheck(id, { check: record.check, ok: true })
    }
    const recheckRecord = () =>
      l1Bridge.create({ tx: validTx, display: validDisplay, recheck: true }).id
    const prompts = ["eth_requestAccounts", "eth_chainId", "eth_estimateGas"]

    // approval: the wallet is asked to send only after this page claimed its approved check
    const approvedId = recheckRecord()
    const approvedClick = await clickSend(approvedId, answerAt(approvedId, 3000, { ok: true }))
    assert.deepEqual(approvedClick.walletCalls, [...prompts, "send@sending"])
    assert.match(approvedClick.document.body.innerHTML, /Sent/)
    assert.doesNotMatch(approvedClick.document.body.innerHTML, /arrive/)
    assert.equal(l1Bridge.get(approvedId).state, "submitted")

    // refusal: no send, the button stays disabled, the reason is shown as one sentence
    const refusedId = recheckRecord()
    const refusedClick = await clickSend(
      refusedId,
      answerAt(refusedId, 2000, { ok: false, message: "Network capacity changed." }),
    )
    assert.deepEqual(refusedClick.walletCalls, prompts)
    assert.equal(refusedClick.button.disabled, true)
    assert.equal(
      refusedClick.status,
      "zk.money Desktop stopped this transfer: Network capacity changed. Go back to zk.money Desktop to review it.",
    )

    // no answer within 20 s: no send, retry allowed; a late approval of that check never sends
    const silentId = recheckRecord()
    const silentClick = await clickSend(silentId)
    assert.deepEqual(silentClick.walletCalls, prompts)
    assert.equal(silentClick.button.disabled, false)
    assert.match(silentClick.status, /didn't confirm this transfer/)
    l1Bridge.resolveCheck(silentId, { check: 1, ok: true })
    const retryClick = await clickSend(silentId)
    assert.deepEqual(retryClick.walletCalls, prompts)
    assert.equal(l1Bridge.get(silentId).check, 2)

    // another tab starts a newer check before this one claims: this page does not send
    const raceId = recheckRecord()
    const raceClick = await clickSend(raceId, (clock) => {
      if (clock === 2000) l1Bridge.requestCheck(raceId, { attempt: TAB_B })
      if (clock === 3000) l1Bridge.resolveCheck(raceId, { check: 2, ok: true })
    })
    assert.deepEqual(raceClick.walletCalls, prompts)
    assert.match(raceClick.status, /Another check started/)
    assert.equal(raceClick.button.disabled, false)

    // two tabs: while the first tab's wallet prompt is open, the second cannot open another
    const overlapId = recheckRecord()
    let approveFirst
    const firstTab = openTab(overlapId, {
      onTick: answerAt(overlapId, 1000, { ok: true }),
      send: () => new Promise((resolve) => (approveFirst = () => resolve(txHash))),
    })
    await untilSending(firstTab)
    const secondTab = await openTab(overlapId, { onTick: answerAt(overlapId, 1000, { ok: true }) })
      .done
    assert.deepEqual(secondTab.walletCalls, prompts)
    assert.match(secondTab.status, /already open in a wallet/)
    assert.equal(secondTab.button.disabled, false)
    approveFirst()
    await firstTab.done
    assert.deepEqual(firstTab.walletCalls, [...prompts, "send@sending"])
    assert.equal(l1Bridge.get(overlapId).state, "submitted")
    assert.equal(l1Bridge.get(overlapId).txHash, txHash)

    // the first tab's prompt is declined: its claim is released and a second tab may send
    const declinedId = recheckRecord()
    const declinedTab = await openTab(declinedId, {
      onTick: answerAt(declinedId, 1000, { ok: true }),
      send: async () => {
        throw Object.assign(new Error("User rejected the request."), { code: 4001 })
      },
    }).done
    assert.equal(declinedTab.status, "Cancelled in wallet")
    assert.equal(declinedTab.button.disabled, false)
    assert.equal(l1Bridge.get(declinedId).state, "pending")
    const takeoverTab = await openTab(declinedId, {
      onTick: answerAt(declinedId, 1000, { ok: true }),
    }).done
    assert.deepEqual(takeoverTab.walletCalls, [...prompts, "send@sending"])
    assert.equal(l1Bridge.get(declinedId).state, "submitted")

    // a decline whose release never reached the bridge keeps the send held until a later click delivers it
    const unreleasedId = recheckRecord()
    const unreachable = new Set(["release"])
    let decline = true
    const unreleasedTab = openTab(unreleasedId, {
      onTick: answerChecks(unreleasedId),
      unreachable,
      send: async () => {
        if (decline) throw Object.assign(new Error("User rejected the request."), { code: 4001 })
        return txHash
      },
    })
    await unreleasedTab.done
    assert.equal(unreleasedTab.status, "Cancelled in wallet")
    assert.equal(l1Bridge.get(unreleasedId).state, "sending")
    await unreleasedTab.click()
    assert.match(unreleasedTab.status, /already open in a wallet/)
    assert.equal(l1Bridge.get(unreleasedId).state, "sending")
    unreachable.clear()
    decline = false
    await unreleasedTab.click()
    assert.deepEqual(unreleasedTab.walletCalls, [
      ...prompts,
      "send@sending",
      ...prompts,
      ...prompts,
      "send@sending",
    ])
    assert.equal(l1Bridge.get(unreleasedId).state, "submitted")

    // any other wallet error after the claim cannot prove nothing was sent: the claim stays held
    const erroredId = recheckRecord()
    const erroredTab = await openTab(erroredId, {
      onTick: answerAt(erroredId, 1000, { ok: true }),
      send: async () => {
        throw Object.assign(new Error("Internal JSON-RPC error."), { code: -32603 })
      },
    }).done
    assert.match(erroredTab.status, /may or may not have been sent/)
    assert.equal(erroredTab.button.disabled, true)
    assert.equal(l1Bridge.get(erroredId).state, "sending")
    const afterErrorTab = await openTab(erroredId, {
      onTick: answerAt(erroredId, 1000, { ok: true }),
    }).done
    assert.deepEqual(afterErrorTab.walletCalls, prompts)
    assert.match(afterErrorTab.status, /already open in a wallet/)

    // a plain submission sends without asking
    const plainId = l1Bridge.create({ tx: validTx, display: validDisplay }).id
    const plainClick = await clickSend(plainId)
    assert.deepEqual(plainClick.walletCalls, [...prompts, "send@pending"])
    assert.equal(l1Bridge.get(plainId).state, "submitted")

    // a new create supersedes the previous pending one
    const first = l1Bridge.create({ tx: validTx, display: validDisplay })
    const second = l1Bridge.create({ tx: validTx, display: validDisplay })
    assert.equal(l1Bridge.get(first.id).state, "superseded")
    assert.equal(l1Bridge.get(second.id).state, "pending")

    // display strings are escaped in the helper page
    const evil = l1Bridge.create({
      tx: validTx,
      display: { title: "<script>alert(1)</script>", lines: [["a", "<img src=x>"]] },
    })
    const evilHtml = renderL1SubmitPage(evil.id, l1Bridge.getPayload(evil.id))
    assert.doesNotMatch(evilHtml, /<script>alert/)
    assert.doesNotMatch(evilHtml, /<img src=x>/)

    // chrome
    const args = buildChromeArguments({
      hostname,
      localPort: port,
      spkiSha256: tls.spkiSha256,
      profilePath: "/tmp/profile path",
      startPath: "/",
      windowMode: "app",
      includeTestTypeFlag: true,
    })
    assert.ok(args.some((value) => value.includes(`MAP ${hostname}:443 127.0.0.1:${port}`)))
    assert.ok(args.some((value) => value.startsWith("--ignore-certificate-errors-spki-list=")))
    assert.ok(args.includes("--test-type"))
    assert.ok(args.includes(`--app=https://${hostname}/`))

    // windows App-Paths registry lookup: type-token parsing (the value name is localized),
    // REG_EXPAND_SZ accepted, garbage rejected, and the lookup is a no-op off win32
    const regOut =
      "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe\r\n" +
      "    (Default)    REG_SZ    C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n\r\n"
    assert.equal(
      parseRegQueryValue(regOut),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    )
    assert.equal(
      parseRegQueryValue("    (Standard)    REG_EXPAND_SZ    C:\\Custom Dir\\chrome.exe"),
      "C:\\Custom Dir\\chrome.exe",
    )
    assert.equal(
      parseRegQueryValue("ERROR: The system was unable to find the specified key."),
      undefined,
    )
    assert.equal(parseRegQueryValue(""), undefined)
    if (process.platform !== "win32") {
      assert.equal(appPathsLookup(), undefined)
    }

    // a real REG_EXPAND_SZ value keeps its %VAR% tokens; the path is unprobeable until expanded
    const expandOut =
      "    (Default)    REG_EXPAND_SZ    %ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"
    const expandEnv = { ProgramFiles: "C:\\Program Files" }
    assert.equal(
      expandWindowsEnv(parseRegQueryValue(expandOut), expandEnv),
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    )
    // env names are case-insensitive on Windows, and an unset token stays put so the probe misses
    assert.equal(expandWindowsEnv("%PROGRAMFILES%\\x", expandEnv), "C:\\Program Files\\x")
    assert.equal(expandWindowsEnv("%NoSuchVar%\\x", expandEnv), "%NoSuchVar%\\x")
    assert.equal(
      expandWindowsEnv("C:\\No Tokens\\chrome.exe", expandEnv),
      "C:\\No Tokens\\chrome.exe",
    )

    // localhost (sandbox dev) mode: no resolver mapping, explicit port in the URL,
    // and cert generation accepts the single-label name
    const localArgs = buildChromeArguments({
      hostname: "localhost",
      localPort: port,
      spkiSha256: tls.spkiSha256,
      profilePath: "/tmp/profile path",
      startPath: "/",
      windowMode: "app",
      includeTestTypeFlag: true,
    })
    assert.ok(!localArgs.some((value) => value.startsWith("--host-resolver-rules=")))
    assert.ok(localArgs.includes(`--app=https://localhost:${port}/`))

    // a fixed localPort is honored (localhost mode: the port is part of the origin)
    const fixedServer = createLocalHttpsServer({
      hostname: "localhost",
      webRoot,
      certPem: tls.certPem,
      keyPem: tls.keyPem,
    })
    const fixedPort = await listenOnLoopback(fixedServer, port + 1)
    assert.equal(fixedPort, port + 1)
    await new Promise((resolve) => fixedServer.close(resolve))
    const localTls = loadOrCreateCertificate({
      hostname: "localhost",
      certificateDays: 2,
      tlsDirectory: path.join(temporaryDirectory, "tls-localhost"),
    })
    assert.ok(certificateMatchesHostname(localTls.certPem, "localhost"))

    const found = findChrome()
    assert.ok(found === undefined || typeof found === "string")

    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => fake.upstream.close(resolve))
    console.log("Smoke test passed.")
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
