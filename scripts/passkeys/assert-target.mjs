import { WEB_PASSKEY_PRODUCTION_ORIGINS } from "../../packages/core/dist/constants/index.js"
import { readFileSync } from "node:fs"
import { selectWebPasskeyRpId } from "../../packages/passkey-web/dist/index.js"

const [directory, environment] = process.argv.slice(2)
if (!directory || !environment) throw new Error("Usage: assert-target.mjs <dist> <environment>")
const rpId = selectWebPasskeyRpId({ VITE_PASSKEY_ENVIRONMENT: environment })
const target = JSON.parse(readFileSync(`${directory}/passkey-target.json`, "utf8"))
if (target.environment !== environment || target.rpId !== rpId) {
  throw new Error(`Bundle targets ${JSON.stringify(target)}; expected ${environment} / ${rpId}`)
}
console.log(`Passkey target verified: ${environment} / ${rpId}`)

if (process.argv.includes("--live") && environment === "production") {
  const response = await fetch(`https://${rpId}/.well-known/webauthn`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new Error("Production RP must serve HTTP 200 with Content-Type: application/json")
  }
  const document = await response.json()
  const expected = [...WEB_PASSKEY_PRODUCTION_ORIGINS].sort()
  if (!Array.isArray(document.origins) || JSON.stringify([...document.origins].sort()) !== JSON.stringify(expected)) {
    throw new Error(
      "Publish the approved production related origins at auth.zk.money before deploying this bundle",
    )
  }
  console.log("Live production related origins verified")
}
