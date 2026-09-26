"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const https = require("node:https")
const path = require("node:path")
const { pipeline } = require("node:stream")
const { matchProxy, proxyRequest } = require("./proxy")

const SETTINGS_PATH = "/desktop-settings"
const L1_SUBMIT_PATH = "/desktop/l1-submit"
const SETTINGS_BODY_LIMIT = 10_240
const L1_SUBMIT_BODY_LIMIT = 256_000

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
})

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function resolveRequestPath(webRoot, pathname) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "")
  const resolved = path.resolve(webRoot, relativePath)
  return isWithinRoot(path.resolve(webRoot), resolved) ? resolved : null
}

// crossOriginIsolated (COOP+COEP) is required: SharedArrayBuffer → threaded bb.js proving.
// Same pair the deployment serves via vercel.json.
function baseHeaders(filePath, contentSecurityPolicy) {
  const headers = {
    "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  }
  if (contentSecurityPolicy) {
    headers["Content-Security-Policy"] = contentSecurityPolicy
  }
  return headers
}

// `<` escaped so an injected value can never terminate the script element.
function globalsScriptTag(globals) {
  const statements = Object.entries(globals)
    .filter(([, value]) => value && Object.keys(value).length > 0)
    .map(
      ([name, value]) =>
        `window.${name} = Object.freeze(${JSON.stringify(value).replaceAll("<", "\\u003c")})`,
    )
  return statements.length ? `<script>${statements.join(";")}</script>` : ""
}

// index.html is the one file served buffered instead of streamed: the runtime
// endpoint overrides + desktop-bridge marker ride in as an inline script ahead
// of the module scripts (which are deferred, so the globals are set before the
// wallet's config loads).
function sendIndexHtml(
  request,
  response,
  filePath,
  contentSecurityPolicy,
  injectEndpoints,
  injectBridge,
) {
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      })
      response.end(error.code === "ENOENT" ? "Not found" : "Internal error")
      return
    }
    let body = contents
    const scriptTag = globalsScriptTag({
      __ZKMONEY_ENDPOINTS__: injectEndpoints ? injectEndpoints() : null,
      __ZKMONEY_DESKTOP_BRIDGE__: injectBridge ? injectBridge() : null,
    })
    if (scriptTag) {
      const html = contents.toString("utf8")
      const headIndex = html.indexOf("<head>")
      if (headIndex !== -1) {
        const insertAt = headIndex + "<head>".length
        body = Buffer.from(html.slice(0, insertAt) + scriptTag + html.slice(insertAt), "utf8")
      }
    }
    const headers = baseHeaders(filePath, contentSecurityPolicy)
    headers["Content-Length"] = body.length
    response.writeHead(200, headers)
    response.end(request.method === "HEAD" ? undefined : body)
  })
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  })
  response.end(body)
}

function readJsonBody(request, limit = SETTINGS_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("Body too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
      } catch {
        reject(new Error("Body is not valid JSON"))
      }
    })
    request.on("error", reject)
  })
}

function tokenMatches(expected, provided) {
  if (typeof provided !== "string" || typeof expected !== "string") return false
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  )
}

// Wallet-origin side of the L1 submit bridge: the wallet page creates a prepared
// transaction here (which also opens the helper page in the user's default
// browser) and polls its status. Same-origin for the wallet — no CORS, no token:
// only the wallet bundle runs on this origin, and the actual approval happens in
// the user's own EVM wallet.
function handleL1SubmitRoute(request, response, pathname, l1Submit) {
  if (pathname === L1_SUBMIT_PATH && request.method === "POST") {
    void (async () => {
      try {
        const body = await readJsonBody(request, L1_SUBMIT_BODY_LIMIT)
        const { id } = l1Submit.create(body)
        // The URL is returned so the wallet can show it to the user — the
        // recovery path when opening the default browser silently failed.
        const submitUrl = l1Submit.submitUrl ? l1Submit.submitUrl(id) : undefined
        await l1Submit.openSubmitPage(id)
        sendJson(response, 200, { id, submitUrl })
      } catch (error) {
        sendJson(response, 400, { error: error.message })
      }
    })()
    return true
  }
  const match = new RegExp(`^${L1_SUBMIT_PATH}/([a-f0-9]{32})$`).exec(pathname)
  if (match && request.method === "GET") {
    const status = l1Submit.get(match[1])
    if (status) {
      sendJson(response, 200, status)
    } else {
      sendJson(response, 404, { error: "Unknown or expired submission" })
    }
    return true
  }
  return false
}

/**
 * The helper listener: plain HTTP on loopback, opened in the user's DEFAULT
 * browser (where their wallet extension lives). Plain HTTP because the main
 * server's certificate names the impersonated wallet hostname and would be
 * rejected outside the launched profile; http://127.0.0.1 is a secure context
 * and injected wallets work there. Ids are unguessable 128-bit tokens.
 */
function createL1SubmitHttpServer({ bridge, renderPage, renderGonePage }) {
  return require("node:http").createServer((request, response) => {
    const match = /^\/submit\/([a-f0-9]{32})(\/status)?$/.exec(request.url?.split("?")[0] ?? "")
    if (match && !match[2] && ["GET", "HEAD"].includes(request.method)) {
      const record = bridge.getPayload(match[1])
      const body = Buffer.from(
        record && record.state === "pending" ? renderPage(match[1], record) : renderGonePage(),
        "utf8",
      )
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": body.length,
      })
      response.end(request.method === "HEAD" ? undefined : body)
      return
    }
    if (match && match[2] && request.method === "POST") {
      void (async () => {
        try {
          const body = await readJsonBody(request)
          sendJson(response, 200, bridge.report(match[1], body))
        } catch (error) {
          sendJson(response, 400, { error: error.message })
        }
      })()
      return
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    response.end("Not found")
  })
}

function handleSettingsRoute(request, response, pathname, settings, contentSecurityPolicy) {
  if (pathname === SETTINGS_PATH && ["GET", "HEAD"].includes(request.method || "GET")) {
    const body = Buffer.from(settings.renderPage(), "utf8")
    const headers = baseHeaders("settings.html", contentSecurityPolicy)
    headers["Content-Length"] = body.length
    response.writeHead(200, headers)
    response.end(request.method === "HEAD" ? undefined : body)
    return true
  }

  const action = { [`${SETTINGS_PATH}/save`]: "save", [`${SETTINGS_PATH}/relaunch`]: "relaunch" }[
    pathname
  ]
  if (!action) return false
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" })
    response.end()
    return true
  }
  void (async () => {
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { error: error.message })
      return
    }
    if (!tokenMatches(settings.token, body.token)) {
      sendJson(response, 403, { error: "Invalid settings token — reopen the settings page" })
      return
    }
    try {
      if (action === "save") {
        await settings.save(body)
      } else {
        settings.relaunch()
      }
      sendJson(response, 200, { ok: true })
    } catch (error) {
      sendJson(response, 400, { error: error.message })
    }
  })()
  return true
}

function sendFile(request, response, filePath, contentSecurityPolicy) {
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.writeHead(statError && statError.code !== "ENOENT" ? 500 : 404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      })
      response.end(statError && statError.code !== "ENOENT" ? "Internal error" : "Not found")
      return
    }

    const headers = baseHeaders(filePath, contentSecurityPolicy)
    headers["Content-Length"] = stats.size
    response.writeHead(200, headers)

    if (request.method === "HEAD") {
      response.end()
      return
    }

    // Streamed, not buffered — the bundle carries multi-MB wasm files.
    pipeline(fs.createReadStream(filePath), response, () => {})
  })
}

function createLocalHttpsServer({
  hostname,
  webRoot,
  certPem,
  keyPem,
  contentSecurityPolicy = null,
  spaFallback = true,
  proxies = {},
  // () => object | null — endpoint overrides injected into index.html per request.
  injectEndpoints = null,
  // () => object | null — the desktop-bridge marker injected alongside the endpoints.
  injectBridge = null,
  // { token, renderPage, save, relaunch } — enables the /desktop-settings routes.
  settings = null,
  // { create, get, openSubmitPage } — enables the /desktop/l1-submit routes.
  l1Submit = null,
  // Launcher-shipped static files (favicon, the Sen font for the settings page):
  // urlPath -> { filePath, contentType }. A same-path file in the web root wins.
  launcherAssets = {},
}) {
  const root = path.resolve(webRoot)
  const launcherAssetCache = new Map()
  const launcherAsset = (urlPath) => {
    if (!launcherAssetCache.has(urlPath)) {
      try {
        launcherAssetCache.set(urlPath, fs.readFileSync(launcherAssets[urlPath].filePath))
      } catch {
        launcherAssetCache.set(urlPath, null)
      }
    }
    return launcherAssetCache.get(urlPath)
  }

  const server = https.createServer({ cert: certPem, key: keyPem }, (request, response) => {
    if (!request.url) {
      response.writeHead(400)
      response.end("Bad request")
      return
    }

    let requestUrl
    try {
      requestUrl = new URL(request.url, `https://${hostname}`)
    } catch {
      response.writeHead(400)
      response.end("Bad request")
      return
    }

    if (
      settings &&
      handleSettingsRoute(request, response, requestUrl.pathname, settings, contentSecurityPolicy)
    ) {
      return
    }

    if (l1Submit && handleL1SubmitRoute(request, response, requestUrl.pathname, l1Submit)) {
      return
    }

    // Proxied prefixes accept any method and must win over the SPA fallback
    // (same ordering as the vercel.json rewrites).
    const proxyMatch = matchProxy(requestUrl.pathname, proxies)
    if (proxyMatch) {
      proxyRequest(request, response, proxyMatch)
      return
    }

    if (!["GET", "HEAD"].includes(request.method || "GET")) {
      response.writeHead(405, { Allow: "GET, HEAD" })
      response.end()
      return
    }

    const filePath = resolveRequestPath(root, requestUrl.pathname)
    if (!filePath) {
      response.writeHead(403)
      response.end("Forbidden")
      return
    }

    const indexPath = path.join(root, "index.html")

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      if (filePath === indexPath) {
        sendIndexHtml(
          request,
          response,
          filePath,
          contentSecurityPolicy,
          injectEndpoints,
          injectBridge,
        )
      } else {
        sendFile(request, response, filePath, contentSecurityPolicy)
      }
      return
    }

    if (launcherAssets[requestUrl.pathname]) {
      const body = launcherAsset(requestUrl.pathname)
      if (body) {
        response.writeHead(200, {
          "Content-Type": launcherAssets[requestUrl.pathname].contentType,
          "Cache-Control": "no-store",
          "Content-Length": body.length,
        })
        response.end(request.method === "HEAD" ? undefined : body)
        return
      }
    }

    // A missing asset (or any extensioned path) must 404, never fall back: index.html
    // served where sqlite3.wasm was expected hangs the PXE boot forever.
    const looksLikeFile =
      requestUrl.pathname.startsWith("/assets/") || path.extname(requestUrl.pathname) !== ""

    if (spaFallback && !looksLikeFile) {
      if (fs.existsSync(indexPath)) {
        sendIndexHtml(
          request,
          response,
          indexPath,
          contentSecurityPolicy,
          injectEndpoints,
          injectBridge,
        )
        return
      }
    }

    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    })
    response.end("Not found")
  })

  return server
}

function listenOnLoopback(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once("error", onError)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine loopback server port"))
        return
      }
      resolve(address.port)
    })
  })
}

module.exports = {
  createL1SubmitHttpServer,
  createLocalHttpsServer,
  isWithinRoot,
  listenOnLoopback,
  resolveRequestPath,
}
