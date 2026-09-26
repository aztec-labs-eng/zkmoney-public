import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import path from "node:path"

export function viewportFrom(value) {
  const match = /^(\d+)x(\d+)$/.exec(String(value))
  if (!match) throw new Error(`Invalid viewport: ${value}; expected WIDTHxHEIGHT`)
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 240 || height < 240 || width > 8192 || height > 8192) {
    throw new Error("Viewport dimensions must be between 240px and 8192px")
  }
  return { width, height }
}

export function localBaseUrl(value) {
  const base = new URL(value)
  if (!["http:", "https:"].includes(base.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("The preview URL must be a loopback HTTP(S) origin without credentials, path, query or fragment")
  }
  return base
}

export function urlAtOrigin(base, value) {
  const result = new URL(value, base)
  if (result.origin !== base.origin) throw new Error(`Page URL must stay on ${base.origin}`)
  return result.href
}

export function loadChromium(repo, browserCache) {
  if (browserCache) process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(browserCache)
  const require = createRequire(path.join(repo, "packages/web-wallet/package.json"))
  const { chromium } = require("@playwright/test")
  // Launch still validates the headless-shell build; this path helps diagnose a stale cache.
  const executable = chromium.executablePath()
  if (!existsSync(executable)) {
    throw new Error(`Expected Chromium at ${executable}. Check PLAYWRIGHT_BROWSERS_PATH and the existing browser cache; use --browser-cache to select it.`)
  }
  return chromium
}

export async function installCaptureGuard(context, base, report, extraPrefixes = []) {
  for (const key of ["externalRequests", "proxyRequests", "blockedWebSockets", "blockedRedirects", "requestErrors", "pageErrors", "consoleErrors"]) {
    report[key] ??= []
  }
  const prefixes = ["/svc", ...extraPrefixes].map((prefix) => {
    if (typeof prefix !== "string" || !prefix.startsWith("/")) throw new Error("Blocked proxy prefixes must begin with /")
    return prefix.replace(/\/+$/, "") || "/"
  })
  const proxyPath = (pathname) => {
    let decoded = pathname
    try { decoded = decodeURIComponent(pathname) } catch { /* Retain malformed input for the prefix check. */ }
    return prefixes.some((prefix) => prefix === "/" || decoded === prefix || decoded.startsWith(`${prefix}/`))
  }
  context.on("page", (page) => {
    page.on("pageerror", (error) => report.pageErrors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text())
    })
  })
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (!["http:", "https:"].includes(url.protocol)) return route.continue()
    if (url.origin !== base.origin) {
      report.externalRequests.push(url.href)
      return route.abort("blockedbyclient")
    }
    if (proxyPath(url.pathname)) {
      report.proxyRequests.push(url.href)
      return route.abort("blockedbyclient")
    }
    // Playwright does not route each hop of a continued redirect. Fetch only this
    // vetted local URL and reject redirects before the browser can follow them.
    let response
    try {
      // Vite may close an idle keepalive socket between navigations. Retry only reset GET/HEAD
      // transports; HTTP failures and redirects still fail, and service requests never get here.
      response = await route.fetch({
        maxRedirects: 0,
        maxRetries: ["GET", "HEAD"].includes(route.request().method()) ? 2 : 0,
      })
      const location = response.headers().location
      if (response.status() >= 300 && response.status() < 400 && location) {
        const target = new URL(location, url)
        report.blockedRedirects.push({ from: url.href, to: target.href, status: response.status() })
        if (target.origin !== base.origin) report.externalRequests.push(target.href)
        else if (proxyPath(target.pathname)) report.proxyRequests.push(target.href)
        await route.abort("blockedbyclient")
      } else {
        await route.fulfill({ response })
      }
    } catch (error) {
      report.requestErrors.push({ url: url.href, error: String(error) })
      await route.abort("failed").catch(() => {})
    } finally {
      // Browser teardown may finish while a routed response releases its buffer.
      await response?.dispose().catch((error) => {
        if (!String(error).includes("Target page, context or browser has been closed")) throw error
      })
    }
  })
  if (typeof context.routeWebSocket !== "function") {
    throw new Error("This capture requires Playwright BrowserContext.routeWebSocket support")
  }
  await context.routeWebSocket(/.*/, async (socket) => {
    const url = new URL(socket.url())
    const httpOrigin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`
    if (httpOrigin !== base.origin || proxyPath(url.pathname)) {
      report.blockedWebSockets.push(url.href)
      await socket.close({ code: 1008, reason: "Local preview network guard" })
      return
    }
    // Same-origin, non-proxy sockets let Vite HMR function without a backend connection.
    socket.connectToServer()
  })
}

export function verificationErrors(report, { failOnConsoleError = true } = {}) {
  const errors = []
  for (const key of ["externalRequests", "proxyRequests", "blockedWebSockets", "blockedRedirects", "requestErrors", "pageErrors", ...(failOnConsoleError ? ["consoleErrors"] : [])]) {
    if (report[key]?.length) errors.push(`${key}: ${report[key].length}`)
  }
  return errors
}
