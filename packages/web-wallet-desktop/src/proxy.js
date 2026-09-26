"use strict"

const http = require("node:http")
const https = require("node:https")

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
])

const UPSTREAM_TIMEOUT_MS = 120_000

// Mirrors the vite/vercel rewrite: strip the prefix, keep the remainder — an empty
// remainder must become "/" (the enclave RPC lives at the target's root).
function upstreamPathFor(requestUrl, prefix, targetUrl) {
  const suffix = requestUrl.slice(prefix.length) || "/"
  return targetUrl.pathname.replace(/\/$/, "") + suffix
}

function filterHeaders(headers) {
  const filtered = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}

// A network error or timeout answers 502; an upstream 5xx is relayed as-is.
function proxyRequest(request, response, { prefix, target }) {
  const targetUrl = new URL(target)
  const headers = filterHeaders(request.headers)
  headers.host = targetUrl.host

  const failOver = () => {
    if (!response.headersSent) {
      response.writeHead(502, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      })
    }
    response.end("Bad gateway")
  }

  const transport = targetUrl.protocol === "https:" ? https : http
  const upstream = transport.request(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: upstreamPathFor(request.url, prefix, targetUrl),
      method: request.method,
      headers,
    },
    (upstreamResponse) => {
      const outHeaders = filterHeaders(upstreamResponse.headers)
      outHeaders["cache-control"] = "no-store"
      response.writeHead(upstreamResponse.statusCode || 502, outHeaders)
      upstreamResponse.pipe(response)
    },
  )

  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timeout")))
  upstream.on("error", failOver)
  request.pipe(upstream)
}

// Longest matching prefix wins; a prefix matches exactly or at a "/" boundary.
function matchProxy(pathname, proxies) {
  let match
  for (const [prefix, target] of Object.entries(proxies || {})) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      if (!match || prefix.length > match.prefix.length) {
        match = { prefix, target }
      }
    }
  }
  return match
}

module.exports = {
  matchProxy,
  proxyRequest,
  upstreamPathFor,
}
