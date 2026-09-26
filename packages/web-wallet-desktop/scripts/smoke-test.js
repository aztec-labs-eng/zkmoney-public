"use strict"

const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const os = require("node:os")
const path = require("node:path")
const {
  appPathsLookup,
  buildChromeArguments,
  expandWindowsEnv,
  findChrome,
  parseRegQueryValue,
} = require("../src/chrome")
const {
  loadConfig,
  loadEndpoints,
  saveEndpoints,
  validateHostname,
  validateProxies,
} = require("../src/config")
const { upstreamPathFor } = require("../src/proxy")
const { createL1SubmitBridge } = require("../src/l1SubmitBridge")
const { renderL1SubmitPage, renderL1SubmitGonePage } = require("../src/l1SubmitPage")
const {
  createL1SubmitHttpServer,
  createLocalHttpsServer,
  listenOnLoopback,
  resolveRequestPath,
} = require("../src/server")
const { renderSettingsPage } = require("../src/settingsPage")
const { loadOrCreateCertificate, certificateMatchesHostname } = require("../src/tls")

function request(port, servername, pathname, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const clientRequest = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        servername,
        rejectUnauthorized: false,
        headers: body ? { "Content-Type": "application/json" } : {},
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
    "<!doctype html><html><head><title>fixture wallet</title></head><body></body></html>",
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

    // endpoints: save/load round-trip, validation, env precedence, reset-to-empty
    const endpointsFile = path.join(temporaryDirectory, "endpoints.json")
    assert.deepEqual(loadEndpoints(endpointsFile).endpoints, {})
    saveEndpoints(endpointsFile, {
      l1RpcUrl: " https://rpc.example/v1 ",
      nodeUrl: "https://node.example",
      enclaveUrl: "http://enclave.example",
      unknownKey: "x",
    })
    assert.deepEqual(loadEndpoints(endpointsFile).endpoints, {
      l1RpcUrl: "https://rpc.example/v1",
      nodeUrl: "https://node.example",
      enclaveUrl: "http://enclave.example",
    })
    assert.equal(loadEndpoints(endpointsFile).sources.nodeUrl, "file")
    assert.throws(() => saveEndpoints(endpointsFile, { l1RpcUrl: "not a url" }))
    assert.throws(() => saveEndpoints(endpointsFile, { nodeUrl: "ftp://rpc.example" }))
    process.env.OBSIDION_L1_RPC_URL = "https://env.example/rpc"
    const withEnv = loadEndpoints(endpointsFile)
    assert.equal(withEnv.endpoints.l1RpcUrl, "https://env.example/rpc")
    assert.equal(withEnv.sources.l1RpcUrl, "env")
    assert.equal(withEnv.sources.nodeUrl, "file")
    delete process.env.OBSIDION_L1_RPC_URL
    // reset = save with everything empty → all overrides cleared
    saveEndpoints(endpointsFile, { l1RpcUrl: "", nodeUrl: "", enclaveUrl: "" })
    assert.deepEqual(loadEndpoints(endpointsFile).endpoints, {})

    // settings page rendering: all three fields, defaults as placeholders,
    // env-override warning, reset button, escaping
    const page = renderSettingsPage({
      token: "tok",
      endpoints: { l1RpcUrl: "https://user.example/<script>" },
      sources: { l1RpcUrl: "file" },
      build: { builtAt: "2026-08-10T00:00:00.000Z" },
      defaults: {
        l1RpcUrl: "https://baked.example/rpc",
        nodeUrl: "https://node.example",
        enclaveUrl: "http://enclave.example",
      },
    })
    for (const fieldId of ["l1RpcUrl", "nodeUrl", "enclaveUrl"]) {
      assert.match(page, new RegExp(`<input type="url" id="${fieldId}"`))
    }
    assert.match(page, /https:\/\/baked\.example\/rpc \(default\)/)
    assert.match(page, /https:\/\/node\.example \(default\)/)
    assert.match(page, /http:\/\/enclave\.example \(default\)/)
    assert.match(page, /Reset all to defaults/)
    assert.match(page, /<td>Bundle built<\/td><td>Aug 10, 2026<\/td>/)
    assert.doesNotMatch(page, /user\.example\/<script>/)
    assert.doesNotMatch(page, /environment variable is set and overrides/)
    const pageEnv = renderSettingsPage({
      token: "tok",
      endpoints: { l1RpcUrl: "https://env.example/rpc", enclaveUrl: "http://e.example" },
      sources: { l1RpcUrl: "env", enclaveUrl: "env" },
    })
    assert.match(pageEnv, /OBSIDION_L1_RPC_URL<\/code> environment variable is set and overrides/)
    assert.match(pageEnv, /OBSIDION_ENCLAVE_TARGET<\/code> environment variable is set/)
    assert.match(pageEnv, /empty = default/)
    const pageProbeFailed = renderSettingsPage({
      token: "tok",
      endpoints: {},
      sources: { l1RpcUrl: "file" },
      probeFailure: { url: "https://dead.example/rpc", source: "your saved override" },
    })
    assert.match(
      pageProbeFailed,
      /your saved override — <code>https:\/\/dead\.example\/rpc<\/code> — did not respond/,
    )
    assert.doesNotMatch(page, /did not respond/)
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
    const savedEndpoints = []
    let relaunchCount = 0
    const settings = {
      token: "test-token",
      renderPage: () => "<html><body>SETTINGS PAGE FIXTURE</body></html>",
      save: async (body) => savedEndpoints.push(body),
      relaunch: () => relaunchCount++,
    }
    const faviconPath = path.join(temporaryDirectory, "favicon.svg")
    fs.writeFileSync(faviconPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const fontPath = path.join(temporaryDirectory, "sen.ttf")
    fs.writeFileSync(fontPath, Buffer.from("fake-font-bytes"))
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
      injectEndpoints: () => ({ l1RpcUrl: "https://override.example/rpc" }),
      injectBridge: () => ({ l1SubmitPath: "/desktop/l1-submit" }),
      settings,
      l1Submit: {
        create: (body) => l1Bridge.create(body),
        get: (id) => l1Bridge.get(id),
        submitUrl: (id) => `http://127.0.0.1:9999/submit/${id}`,
        openSubmitPage: async (id) => openedSubmitPages.push(id),
      },
      launcherAssets: {
        "/favicon.ico": { filePath: faviconPath, contentType: "image/svg+xml; charset=utf-8" },
        "/favicon.svg": { filePath: faviconPath, contentType: "image/svg+xml; charset=utf-8" },
        "/desktop-assets/Sen-VariableFont.ttf": { filePath: fontPath, contentType: "font/ttf" },
      },
    })
    const port = await listenOnLoopback(server)

    // index: 200 + crossOriginIsolated header pair, no CSP by default, endpoint
    // injection present ahead of the content with an accurate Content-Length
    const index = await request(port, hostname, "/")
    assert.equal(index.statusCode, 200)
    assert.match(index.body, /fixture wallet/)
    assert.match(index.body, /__ZKMONEY_ENDPOINTS__/)
    assert.match(index.body, /__ZKMONEY_DESKTOP_BRIDGE__/)
    assert.match(index.body, /\/desktop\/l1-submit/)
    assert.match(index.body, /https:\/\/override\.example\/rpc/)
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

    // settings page: served before the SPA fallback, mutations token-gated
    const settingsPage = await request(port, hostname, "/desktop-settings")
    assert.equal(settingsPage.statusCode, 200)
    assert.match(settingsPage.body, /SETTINGS PAGE FIXTURE/)
    const badToken = await request(port, hostname, "/desktop-settings/save", {
      method: "POST",
      body: JSON.stringify({ token: "wrong", l1RpcUrl: "https://x.example" }),
    })
    assert.equal(badToken.statusCode, 403)
    assert.equal(savedEndpoints.length, 0)
    const goodSave = await request(port, hostname, "/desktop-settings/save", {
      method: "POST",
      body: JSON.stringify({ token: "test-token", l1RpcUrl: "https://x.example" }),
    })
    assert.equal(goodSave.statusCode, 200)
    assert.equal(savedEndpoints[0].l1RpcUrl, "https://x.example")
    const relaunch = await request(port, hostname, "/desktop-settings/relaunch", {
      method: "POST",
      body: JSON.stringify({ token: "test-token" }),
    })
    assert.equal(relaunch.statusCode, 200)
    assert.equal(relaunchCount, 1)
    const settingsGetOnly = await request(port, hostname, "/desktop-settings/save")
    assert.equal(settingsGetOnly.statusCode, 405)


    const nested = await request(port, hostname, "/contacts/someone/send")
    assert.equal(nested.statusCode, 200)
    assert.match(nested.body, /fixture wallet/)

    // launcher assets: favicon on both conventional paths, Sen font for the settings page
    for (const faviconRoute of ["/favicon.ico", "/favicon.svg"]) {
      const icon = await request(port, hostname, faviconRoute)
      assert.equal(icon.statusCode, 200)
      assert.match(icon.headers["content-type"], /image\/svg\+xml/)
      assert.match(icon.body, /<svg/)
    }
    const font = await request(port, hostname, "/desktop-assets/Sen-VariableFont.ttf")
    assert.equal(font.statusCode, 200)
    assert.equal(font.headers["content-type"], "font/ttf")
    assert.equal(font.body, "fake-font-bytes")

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
