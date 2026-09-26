#!/usr/bin/env node
import { parseArgs } from "node:util"
import { readFile, mkdtemp } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { startCaptureServer, walletDir } from "./server.mjs"
import { loadChromium, localBaseUrl, urlAtOrigin, installCaptureGuard, verificationErrors } from "./capture-support.mjs"
import { selectedViewports, FIXTURE_TIME, locatorFor, runStep, settle } from "./plan.mjs"
import { installCameraFixture } from "./camera.mjs"
import { startVideo, requireVideoTools } from "./video.mjs"
import { externalOutputDir, outputDirectory, writeOutputFile } from "./output.mjs"

const scenarioNames = Object.keys(JSON.parse(await readFile(new URL("../../src/dev/demoScenarios.json", import.meta.url), "utf8")))

const HELP = `Capture the web wallet with local demo fixtures (no sandbox or personal skills).

From packages/web-wallet:
  pnpm ui:capture --path / --scenario activity --preset 390x844
  pnpm ui:capture --plan scripts/ui-capture/plans/registration.json --preset all --record

Options:
  --path PATH            Direct route after fixture bootstrap
  --scenario NAME        ${scenarioNames.join(", ")} (default: activity)
  --plan FILE            JSON interaction plan; CLI values override plan values
  --preset SIZE|all      390x844 (default), 402x879, 390x667, or all three
  --viewport WIDTHxHEIGHT  Custom CSS viewport (e.g. 1280x832); excludes --preset
  --record               Exact-size WebM recording; requires ffmpeg and ffprobe
  --full-page            Supplemental full-page screenshots (default: viewport only)
  --output-dir DIR       Output outside the repository; default: a unique /tmp directory
  --port NUMBER          Dedicated loopback Vite port; default 5499, fails if occupied
  --ready SELECTOR       Visible selector required before capturing a direct route
  --safe-area T,R,B,L    Override inset tokens in CSS pixels (e.g. 20,12,34,12)
  --color-scheme VALUE   dark (default) or light browser preference
  --fixture-time ISO     Fixed browser Date; default ${FIXTURE_TIME}
  --headed              Show Chromium
  --browser-cache DIR   Use an existing Playwright browser cache
  --help                Show this help

Reports include interaction states, computed sheet geometry, and attempted requests.
Unexpected service calls, console/page errors, and failed steps exit nonzero.
See scripts/ui-capture/README.md for plans, dependencies, and verification limits.
`

function safeArea(value) {
  if (value === undefined) return null
  const values = String(value).split(",").map(Number)
  if (values.length !== 4 || values.some((n) => !Number.isFinite(n) || n < 0 || n > 200)) {
    throw new Error("--safe-area requires four pixel values between 0 and 200: top,right,bottom,left")
  }
  return Object.fromEntries(["top", "right", "bottom", "left"].map((edge, i) => [edge, values[i]]))
}

async function main() {
  const { values: args } = parseArgs({ options: Object.fromEntries([
    ...["path", "scenario", "plan", "preset", "viewport", "output-dir", "port", "ready", "safe-area", "color-scheme", "fixture-time", "browser-cache"].map((key) => [key, { type: "string" }]),
    ...["record", "full-page", "headed", "help"].map((key) => [key, { type: "boolean" }]),
  ]) })
  if (args.help) { process.stdout.write(HELP); return }
  const planFile = args.plan ? path.resolve(args.plan) : null
  const plan = planFile ? JSON.parse(await readFile(planFile, "utf8")) : {}
  const scenario = args.scenario ?? plan.scenario ?? "activity"
  if (!scenarioNames.includes(scenario)) throw new Error(`Unknown scenario: ${scenario}`)
  const viewports = selectedViewports(args.preset ?? (args.viewport ? undefined : plan.preset), args.viewport ?? (args.preset ? undefined : plan.viewport))
  const insets = safeArea(args["safe-area"] ?? plan.safeArea)
  const colorScheme = args["color-scheme"] ?? plan.colorScheme ?? "dark"
  if (!["light", "dark"].includes(colorScheme)) throw new Error("color-scheme must be light or dark")
  const fixtureTime = args["fixture-time"] ?? plan.fixtureTime ?? FIXTURE_TIME
  if (!Number.isFinite(Date.parse(fixtureTime))) throw new Error("Invalid fixture time")
  const record = args.record ?? plan.record ?? false
  const recordHoldMs = plan.recordHoldMs ?? 1500
  if (!Number.isInteger(recordHoldMs) || recordHoldMs < 0 || recordHoldMs > 10_000) throw new Error("recordHoldMs must be an integer from 0 to 10000")
  if (record) await requireVideoTools()
  const port = Number(args.port ?? 5499)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be an integer from 1024 to 65535")
  const steps = plan.steps ?? []
  if (!Array.isArray(steps)) throw new Error("Plan steps must be an array")
  const repo = path.resolve(walletDir, "../..")
  const outputDir = await externalOutputDir(args["output-dir"] ?? await mkdtemp(path.join(tmpdir(), "web-wallet-ui-")), repo)
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
  const cssHash = createHash("sha256").update(await readFile(path.join(walletDir, "src/ui/shell.css"))).digest("hex")
  const require = createRequire(path.join(walletDir, "package.json"))
  for (const dependency of ["@obsidion/core/constants", "@obsidion/sdk", "@obsidion/front-core", "@obsidion/config-client", "@obsidion/proving-progress"]) {
    try { require.resolve(dependency) }
    catch { throw new Error(`Missing build output for ${dependency}. Build the workspace dependencies before running ui:capture (see scripts/ui-capture/README.md).`) }
  }
  const chromium = loadChromium(repo, args["browser-cache"])
  const { server, origin } = await startCaptureServer(port)
  const base = localBaseUrl(origin)
  const reports = []
  let browser
  try {
    browser = await chromium.launch({ headless: !args.headed, args: ["--disable-dev-shm-usage"] })
    for (const viewport of viewports) {
      const preset = `${viewport.width}x${viewport.height}`
      const runDir = await outputDirectory(outputDir, preset)
      const report = {
        ok: false, evidence: "demo rendering and navigation", commit, cssHash,
        browser: browser.version(), scenario, plan: planFile, viewport, colorScheme, fixtureTime,
        camera: plan.camera ?? null, safeArea: insets, recordHoldMs: record ? recordHoldMs : null, screenshots: [], steps: [], videos: [],
      }
      reports.push(report)
      let context
      let video
      let page
      const started = performance.now()
      try {
        context = await browser.newContext({
          viewport, deviceScaleFactor: 1, colorScheme, reducedMotion: "reduce",
          locale: "en-US", timezoneId: "UTC", serviceWorkers: "block",
        })
        await context.grantPermissions(["local-network-access"], { origin: base.origin })
        await installCaptureGuard(context, base, report, plan.blockedProxyPrefixes ?? [])
        if (plan.camera) await installCameraFixture(context, plan.camera)
        if (insets) await context.addInitScript((edges) => {
          const apply = () => {
            if (!document.documentElement) return false
            for (const [edge, value] of Object.entries(edges)) {
              document.documentElement.style.setProperty(`--ww-safe-area-${edge}`, `${value}px`, "important")
            }
            return true
          }
          if (!apply()) {
            const observer = new MutationObserver(() => { if (apply()) observer.disconnect() })
            observer.observe(document, { childList: true })
          }
        }, insets)
        if (plan.rejectingExtension) await context.addInitScript(() => {
          Object.defineProperty(window, "ethereum", {
            value: { request: () => Promise.reject(new Error("Capture must not use the extension provider")) },
            configurable: false,
          })
        })
        page = await context.newPage()
        if (record) video = await startVideo(page, viewport)
        const network = await context.newCDPSession(page)
        await network.send("Network.enable")
        if (insets) await network.send("Emulation.setSafeAreaInsetsOverride", { insets })
        report.serviceInitiators = []
        network.on("Network.requestWillBeSent", ({ request, initiator }) => {
          const url = new URL(request.url)
          if (["http:", "https:"].includes(url.protocol) && (url.origin !== base.origin || url.pathname.startsWith("/svc/"))) {
            report.serviceInitiators.push({ url: request.url, initiator })
          }
        })
        await page.clock.setFixedTime(new Date(fixtureTime))
        const timeout = plan.timeout ?? 30_000
        page.setDefaultTimeout(timeout)
        const bootstrap = plan.bootstrap ?? (scenario === "onboarding"
          ? "/claim?demo=onboarding&mock=create&handle=demo"
          : `/?demo=${scenario}`)
        report.bootstrap = bootstrap
        await page.goto(urlAtOrigin(base, bootstrap), { waitUntil: "domcontentloaded", timeout })
        await page.locator(scenario === "onboarding" ? ".ww-invite" : ".ww-shell").waitFor({ state: "visible" })
        const target = args.path ?? plan.path
        if (target && page.url() !== urlAtOrigin(base, target)) {
          await page.goto(urlAtOrigin(base, target), { waitUntil: "domcontentloaded", timeout })
        }
        const ready = args.ready ? { selector: args.ready } : plan.ready ?? { selector: scenario === "onboarding" ? '[role="dialog"]' : ".ww-shell" }
        await locatorFor(page, ready).waitFor({ state: "visible" })
        const shot = async (file, state, fullPage = args["full-page"] ?? plan.fullPage ?? false) => {
          await settle(page)
          const extension = path.extname(file).toLowerCase()
          if (![".png", ".jpg", ".jpeg"].includes(extension)) throw new Error("Screenshot files must use .png, .jpg or .jpeg")
          const pixels = await page.screenshot({ type: extension === ".png" ? "png" : "jpeg", fullPage, animations: "disabled", caret: "hide" })
          const target = await writeOutputFile(runDir, file, pixels)
          const geometry = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
            sheets: [...document.querySelectorAll(".ww-modal, .ww-reg-sheet__card")].map((element) => {
              const css = getComputedStyle(element)
              const rect = element.getBoundingClientRect()
              return {
                classes: element.className, top: rect.top, bottom: rect.bottom, height: rect.height,
                padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft],
                maxHeight: css.maxHeight, overflowY: css.overflowY,
                clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
              }
            }),
          }))
          report.screenshots.push({ file: target, state, url: page.url(), viewport, fullPage, geometry, at: (performance.now() - started) / 1000 })
          // Keep settled states visible in recordings before the next route starts loading.
          if (record) await page.waitForTimeout(recordHoldMs)
        }
        for (const [index, step] of steps.entries()) {
          const entry = { index, ...step, at: (performance.now() - started) / 1000, ok: false }
          report.steps.push(entry)
          await runStep(page, step, { base, timeout, shot })
          entry.ok = true
        }
        if (plan.finalScreenshot !== false) await shot("final.png", plan.state ?? target ?? bootstrap)
        report.finalUrl = page.url()
        report.ok = verificationErrors(report).length === 0
      } catch (error) {
        report.flowError = error.stack ?? String(error)
        if (page) await page.screenshot().then((pixels) => writeOutputFile(runDir, "failure.png", pixels)).catch(() => {})
      } finally {
        if (video) {
          try {
            report.videos.push({ ...await video.finish(runDir), at: (video.startedAt - started) / 1000 })
          } catch (error) {
            report.videoError = String(error)
            report.ok = false
          }
        }
        await context?.close()
        report.verificationErrors = verificationErrors(report)
        if (report.verificationErrors.length) report.ok = false
        await writeOutputFile(runDir, "report.json", `${JSON.stringify(report, null, 2)}\n`)
        process.stdout.write(`${preset}: ${report.ok ? "OK" : "FAILED"} ${path.join(runDir, "report.json")}\n`)
        if (!report.ok) process.exitCode = 1
      }
    }
  } finally {
    await browser?.close()
    await server.close()
    await writeOutputFile(outputDir, "report.json", `${JSON.stringify({ ok: reports.length === viewports.length && reports.every((r) => r.ok), reports }, null, 2)}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
