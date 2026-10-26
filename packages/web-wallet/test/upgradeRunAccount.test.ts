import { describe, expect, it, vi } from "vitest"

vi.mock("../src/config/env", () => ({
  getConfig: () => ({ oxideProfile: { portal: "0xMainPortal" } }),
}))

const { upgradeRunAccount } = await import("../src/features/migration/upgradeRunAccount")

describe("upgradeRunAccount", () => {
  it("names the account a run's destination portal pays into", () => {
    expect(upgradeRunAccount("metadata-migration/0xmainportal/0xv5portal/0xacct")).toBe("main")
    expect(upgradeRunAccount("metadata-migration/0xsavings/0xv5portal/0xacct")).toBe("savings")
  })

  it("names an upgrade another device inferred from its deposits the same way", () => {
    expect(upgradeRunAccount("chain-upgrade/0xmainportal")).toBe("main")
    expect(upgradeRunAccount("chain-upgrade/0xsavings")).toBe("savings")
  })
})
