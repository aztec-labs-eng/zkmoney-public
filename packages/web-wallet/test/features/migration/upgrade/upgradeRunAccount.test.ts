import { describe, expect, it } from "vitest"
import { upgradeRunAccount } from "../../../../src/features/migration/upgradeRunAccount"
import { sandboxConfig } from "../../../support/seedBootConfig"

describe("upgradeRunAccount", () => {
  it("names an upgrade another device inferred from its deposits the same way", async () => {
    const config = await sandboxConfig()
    const main = config.oxideProfile.portal.toLowerCase()
    expect(upgradeRunAccount(config, `chain-upgrade/${main}`)).toBe("main")
    expect(upgradeRunAccount(config, "chain-upgrade/0xsavings")).toBe("savings")
  })
})
