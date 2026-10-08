"use strict"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const https = require("node:https")
const { once } = require("node:events")
const { composeLauncherConfig, writeLauncherConfig } = require("./compose-config")
const { loadConfig } = require("../src/config")
const { createLocalHttpsServer, listenOnLoopback } = require("../src/server")
const { loadOrCreateCertificate } = require("../src/tls")
const defaults = require("../config/default.json")

for (const [pageHostname, passkeyRpId] of [
  ["wallet.zk.money", "auth.zk.money"],
  ["wallet.staging.zk.money", "staging.zk.money"],
  ["localhost", "localhost"],
]) {
  test(`page ${pageHostname} uses RP ${passkeyRpId}`, () => {
    const config = composeLauncherConfig(defaults, { pageHostname, passkeyRpId })
    assert.equal(config.hostname, pageHostname)
    assert.equal(config.passkeyRpId, passkeyRpId)
    assert.equal(config.localPort, pageHostname === "localhost" ? 5173 : 0)
  })
}
test("refuses metadata without a page hostname", () => {
  assert.throws(
    () => composeLauncherConfig(defaults, { passkeyRpId: "auth.zk.money" }),
    /Invalid hostname/,
  )
})

test("packaged metadata is checked outside the app archive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-rp-"))
  try {
    const appRoot = path.join(root, "app.asar")
    fs.mkdirSync(path.join(appRoot, "config"), { recursive: true })
    const metadata = { pageHostname: "wallet.zk.money", passkeyRpId: "auth.zk.money" }
    fs.writeFileSync(
      path.join(appRoot, "config/generated.json"),
      JSON.stringify(composeLauncherConfig(defaults, metadata)),
    )
    fs.writeFileSync(path.join(appRoot, "config/default.json"), JSON.stringify(defaults))
    const metaPath = path.join(root, "build-meta.json")
    fs.writeFileSync(metaPath, JSON.stringify(metadata))
    assert.equal(loadConfig(appRoot, metaPath).hostname, "wallet.zk.money")
    fs.writeFileSync(metaPath, JSON.stringify({ ...metadata, passkeyRpId: "staging.zk.money" }))
    assert.throws(() => loadConfig(appRoot, metaPath), /differs from the bundled wallet/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("OBSIDION_ENCLAVE_TARGET retargets only a build that proxies the enclave", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-enclave-"))
  const previous = process.env.OBSIDION_ENCLAVE_TARGET
  try {
    fs.mkdirSync(path.join(root, "config"))
    fs.writeFileSync(path.join(root, "config/default.json"), JSON.stringify(defaults))
    process.env.OBSIDION_ENCLAVE_TARGET = " http://127.0.0.1:9999 "
    const sandbox = loadConfig(root)
    assert.equal(sandbox.proxies["/svc/enclave"], "http://127.0.0.1:9999")
    assert.equal(sandbox.proxies["/svc/account"], defaults.proxies["/svc/account"])
    for (const invalid of ["not a url", "ftp://127.0.0.1:9999"]) {
      process.env.OBSIDION_ENCLAVE_TARGET = invalid
      assert.throws(() => loadConfig(root), /OBSIDION_ENCLAVE_TARGET/)
    }

    const metadata = { pageHostname: "wallet.zk.money", passkeyRpId: "auth.zk.money" }
    fs.writeFileSync(
      path.join(root, "config/generated.json"),
      JSON.stringify(composeLauncherConfig(defaults, metadata)),
    )
    process.env.OBSIDION_ENCLAVE_TARGET = "http://127.0.0.1:9999"
    assert.equal(loadConfig(root).proxies["/svc/enclave"], undefined)
    process.env.OBSIDION_ENCLAVE_TARGET = "not a url"
    assert.throws(() => loadConfig(root), /OBSIDION_ENCLAVE_TARGET/)
  } finally {
    if (previous === undefined) delete process.env.OBSIDION_ENCLAVE_TARGET
    else process.env.OBSIDION_ENCLAVE_TARGET = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

for (const [pageHostname, passkeyRpId] of [
  ["wallet.zk.money", "auth.zk.money"],
  ["wallet.staging.zk.money", "staging.zk.money"],
]) {
  test(`rebuilding ${pageHostname} for localhost preserves defaults and forwards local services`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-rebuild-"))
    const received = []
    const upstream = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      received.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
    })
    let server
    try {
      upstream.listen(0, "127.0.0.1")
      await once(upstream, "listening")
      const target = `http://127.0.0.1:${upstream.address().port}`
      const localDefaults = {
        ...defaults,
        proxies: { "/svc/account": target, "/svc/enclave": target },
      }
      const defaultsText = JSON.stringify(localDefaults)
      fs.mkdirSync(path.join(root, "config"))
      fs.writeFileSync(path.join(root, "config/default.json"), defaultsText)
      const metaPath = path.join(root, "build-meta.json")
      fs.writeFileSync(metaPath, JSON.stringify({ pageHostname, passkeyRpId }))
      writeLauncherConfig(root)
      const hosted = loadConfig(root)
      assert.equal(hosted.hostname, pageHostname)
      assert.deepEqual(hosted.proxies, {
        "/svc/predicate": `https://${pageHostname}/svc/predicate`,
      })

      fs.writeFileSync(
        metaPath,
        JSON.stringify({ pageHostname: "localhost", passkeyRpId: "localhost" }),
      )
      writeLauncherConfig(root)
      const local = loadConfig(root)
      assert.equal(local.hostname, "localhost")
      assert.equal(local.passkeyRpId, "localhost")
      assert.deepEqual(local.proxies, localDefaults.proxies)
      assert.equal(fs.readFileSync(path.join(root, "config/default.json"), "utf8"), defaultsText)

      const tls = loadOrCreateCertificate({
        hostname: "localhost",
        certificateDays: 1,
        tlsDirectory: root,
      })
      server = createLocalHttpsServer({
        ...local,
        webRoot: root,
        certPem: tls.certPem,
        keyPem: tls.keyPem,
      })
      const port = await listenOnLoopback(server, 0)
      for (const prefix of ["/svc/account", "/svc/enclave"]) {
        const response = await new Promise((resolve, reject) => {
          const req = https.request(
            {
              hostname: "127.0.0.1",
              port,
              path: `${prefix}/rpc`,
              method: "POST",
              headers: { Host: "localhost" },
              rejectUnauthorized: false,
            },
            (res) => {
              const chunks = []
              res.on("data", (chunk) => chunks.push(chunk))
              res.on("end", () =>
                resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }),
              )
            },
          )
          req.on("error", reject)
          req.end("test-payload")
        })
        assert.equal(response.status, 200)
        assert.deepEqual(JSON.parse(response.body), { ok: true })
      }
      assert.deepEqual(received, [
        { method: "POST", url: "/rpc", body: "test-payload" },
        { method: "POST", url: "/rpc", body: "test-payload" },
      ])
    } finally {
      for (const instance of [server, upstream]) {
        if (!instance) continue
        instance.closeAllConnections()
        await new Promise((resolve) => instance.close(resolve))
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}
