import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { WEB_PASSKEY_PRODUCTION_ORIGINS } from "@obsidion/core/constants"
import { assertWebPasskeyBuild, selectWebPasskeyRpId } from "../src/policy/relyingParty.js"

describe("deployment RP selection", () => {
  it.each([
    ["production", "auth.zk.money"],
    ["dev", "dev.zk.money"],
    ["staging", "staging.zk.money"],
    ["preview", "staging.zk.money"],
    ["prod-preview", "preview.zk.money"],
    ["local", "localhost"],
    [undefined, "localhost"],
  ])("selects %s independently of the chain", (environment, rpId) => {
    expect(selectWebPasskeyRpId({ VITE_PASSKEY_ENVIRONMENT: environment })).toBe(rpId)
    expect(selectWebPasskeyRpId({ VITE_PASSKEY_ENVIRONMENT: environment, VITE_PASSKEY_RP_ID: rpId })).toBe(rpId)
  })

  it.each(["wallet.zk.money", "staging.zk.money", "localhost"])("refuses production override %s", (rpId) => {
    expect(() => selectWebPasskeyRpId({ VITE_PASSKEY_ENVIRONMENT: "production", VITE_PASSKEY_RP_ID: rpId })).toThrow(
      /conflicts/,
    )
  })

  it("refuses a hosted override without a deployment environment", () => {
    expect(() => selectWebPasskeyRpId({ VITE_PASSKEY_RP_ID: "auth.zk.money" })).toThrow(/conflicts/)
    expect(() => selectWebPasskeyRpId({ VITE_PASSKEY_ENVIRONMENT: "prod" })).toThrow(/Unknown/)
  })

  it.each(["staging", "preview"])("accepts paired %s origins through the suffix rule", (environment) => {
    for (const [wallet, campaign] of [
      ["wallet.staging.zk.money", "launch.staging.zk.money"],
      ["wallet-pr-123.staging.zk.money", "pr-123.launch.staging.zk.money"],
    ]) {
      expect(
        assertWebPasskeyBuild({
          VITE_PASSKEY_ENVIRONMENT: environment,
          VITE_WALLET_URL: `https://${wallet}`,
          VITE_SITE_ORIGIN: `https://${campaign}`,
          VITE_CAMPAIGN_URL: `https://${campaign}`,
        }),
      ).toBe("staging.zk.money")
    }
  })

  it("accepts a prod-backed preview pair whose site origin is production's", () => {
    expect(
      assertWebPasskeyBuild({
        VITE_PASSKEY_ENVIRONMENT: "prod-preview",
        VITE_WALLET_URL: "https://wallet-pr-123.preview.zk.money",
        VITE_CAMPAIGN_URL: "https://launch-pr-123.preview.zk.money",
        VITE_SITE_ORIGIN: "https://launch.zk.money",
      }),
    ).toBe("preview.zk.money")
    // Only the site origin may be production's; the handoff pair must stay under the preview RP.
    expect(() =>
      assertWebPasskeyBuild({ VITE_PASSKEY_ENVIRONMENT: "prod-preview", VITE_CAMPAIGN_URL: "https://launch.zk.money" }),
    ).toThrow(/cannot use/)
  })

  it("accepts the dev wallet and campaign hosts", () => {
    expect(
      assertWebPasskeyBuild({
        VITE_PASSKEY_ENVIRONMENT: "dev",
        VITE_SITE_ORIGIN: "https://launch-aws.dev.zk.money",
        VITE_WALLET_URL: "https://wallet.dev.zk.money",
        VITE_CAMPAIGN_URL: "https://launch-aws.dev.zk.money",
      }),
    ).toBe("dev.zk.money")
  })

  it("accepts the production wallet/campaign pair", () => {
    expect(
      assertWebPasskeyBuild({
        VITE_PASSKEY_ENVIRONMENT: "production",
        VITE_WALLET_URL: "https://wallet.zk.money",
        VITE_SITE_ORIGIN: "https://launch.zk.money",
      }),
    ).toBe("auth.zk.money")
  })

  it.each([
    ["production", "https://wallet.staging.zk.money"],
    ["production", "https://launch.staging.zk.money"],
    ["staging", "https://wallet.zk.money"],
    ["preview", "https://launch.zk.money"],
    ["preview", "https://launch-pr-123.preview.zk.money"],
    ["prod-preview", "https://wallet.zk.money"],
    ["prod-preview", "https://wallet-pr-123.staging.zk.money"],
    ["staging", "https://evil-staging.zk.money"],
    ["staging", "https://staging.zk.money.evil.test"],
    ["production", "http://wallet.zk.money"],
    [undefined, "https://wallet.zk.money"],
  ])("rejects %s with incompatible origin %s", (environment, origin) => {
    expect(() => assertWebPasskeyBuild({ VITE_PASSKEY_ENVIRONMENT: environment, VITE_WALLET_URL: origin })).toThrow(
      /cannot use/,
    )
  })

  it("allows different localhost ports", () => {
    expect(
      assertWebPasskeyBuild({
        VITE_PASSKEY_ENVIRONMENT: "local",
        VITE_WALLET_URL: "http://localhost:5173",
        VITE_SITE_ORIGIN: "http://localhost:3000",
      }),
    ).toBe("localhost")
  })

  it("publishes exactly the approved production related origins with a JSON content type", () => {
    const document = JSON.parse(
      readFileSync(new URL("../../auth-web/public/.well-known/webauthn", import.meta.url), "utf8"),
    )
    expect(document).toEqual({ origins: [...WEB_PASSKEY_PRODUCTION_ORIGINS] })
    const hosting = JSON.parse(readFileSync(new URL("../../auth-web/vercel.json", import.meta.url), "utf8"))
    expect(hosting.headers).toContainEqual({
      source: "/.well-known/webauthn",
      headers: [{ key: "Content-Type", value: "application/json" }],
    })
  })
})
