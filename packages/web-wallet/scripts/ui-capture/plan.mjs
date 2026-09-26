import { urlAtOrigin, viewportFrom } from "./capture-support.mjs"
import { cameraStep } from "./camera.mjs"

export const PHONE_PRESETS = ["390x844", "402x879", "390x667"]
export const FIXTURE_TIME = "2026-09-01T12:00:00.000Z"

export function selectedViewports(preset, viewport) {
  if (preset && viewport) throw new Error("Choose --preset or --viewport, not both")
  if (viewport) return [viewportFrom(viewport)]
  if (preset === "all") return PHONE_PRESETS.map(viewportFrom)
  const selected = preset ?? PHONE_PRESETS[0]
  if (!PHONE_PRESETS.includes(selected)) throw new Error(`Unknown phone preset: ${selected}`)
  return [viewportFrom(selected)]
}

export function locatorFor(page, step) {
  let locator
  if (step.selector) locator = page.locator(step.selector)
  else if (step.testId) locator = page.getByTestId(step.testId)
  else if (step.label) locator = page.getByLabel(step.label, { exact: step.exact ?? false })
  else if (step.role) locator = page.getByRole(step.role, { name: step.name, exact: step.exact ?? false })
  else if (step.text) locator = page.getByText(step.text, { exact: step.exact ?? false })
  else if (step.placeholder) locator = page.getByPlaceholder(step.placeholder, { exact: step.exact ?? false })
  else throw new Error(`${step.action ?? "readiness"} requires a locator`)
  if (step.nth !== undefined) return locator.nth(step.nth)
  return step.first ? locator.first() : locator
}

export async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((img) => img.decode().catch(() => {})))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

export async function runStep(page, step, context) {
  const timeout = context.timeout
  const locator = () => locatorFor(page, step)
  switch (step.action) {
    case "camera": await cameraStep(page, step); return
    case "goto":
      await page.goto(urlAtOrigin(context.base, step.path), { waitUntil: "domcontentloaded", timeout })
      return
    case "reload": await page.reload({ waitUntil: "domcontentloaded", timeout }); return
    case "back": await page.goBack({ waitUntil: "domcontentloaded", timeout }); return
    case "click": await locator().click({ timeout }); return
    case "fill": await locator().fill(String(step.value), { timeout }); return
    case "press": await locator().press(step.key, { timeout }); return
    case "hover": await locator().hover({ timeout }); return
    case "check": await locator().check({ timeout }); return
    case "uncheck": await locator().uncheck({ timeout }); return
    case "select": await locator().selectOption(step.value, { timeout }); return
    case "waitFor": await locator().waitFor({ state: step.state ?? "visible", timeout }); return
    case "waitForUrl": await page.waitForURL(step.url, { timeout }); return
    case "wait": await page.waitForTimeout(step.ms ?? 250); return
    case "scroll":
      await locator().evaluate((element, top) => { element.scrollTop = top === "end" ? element.scrollHeight : top }, step.top ?? "end")
      return
    case "reachable": {
      await locator().scrollIntoViewIfNeeded({ timeout })
      // Trial click verifies hit testing and clipping without triggering a transaction.
      await locator().click({ trial: true, timeout })
      return
    }
    case "screenshot": await context.shot(step.file, step.state ?? step.file, step.fullPage); return
    case "setViewport": throw new Error("Use a separate capture run per viewport so screenshots and recordings agree")
    default: throw new Error(`Unknown plan action: ${step.action}`)
  }
}
