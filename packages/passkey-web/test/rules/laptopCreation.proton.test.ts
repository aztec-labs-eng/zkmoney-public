// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  type Withdrawn,
  laptopCreationFor,
  withoutManager,
} from "../../src/rules/laptopCreation.js"
import { parseUserAgent } from "../../src/browser/userAgentInfo.js"
import {
  ANDROID_FIREFOX_UA,
  FIREFOX_ADMITTED,
  LINUX_FIREFOX_UA,
  WINDOWS_FIREFOX_UA,
  brave,
  chrome,
  edge,
  firefox,
  linux,
  mac,
  macEdgeBrave,
  macFirefox,
  macSafari,
  phone,
  safari,
  windows,
  withdrawing,
} from "../support/laptopRows.js"

describe("laptopCreationFor", () => {
  it("lists Proton Pass last on every laptop row once nothing is withdrawn, and not on the phone result", () => {
    const nothingWithdrawn: Withdrawn = { ...FIREFOX_ADMITTED, macFirefox: [] }
    const rows = [
      mac("26.4.1"),
      mac("26.4.1", edge),
      safari(),
      firefox("155.0"),
      windows(),
      windows(chrome, "10.0.0"),
      windows(edge),
      parseUserAgent({ userAgent: WINDOWS_FIREFOX_UA }),
      linux(),
      linux(brave),
      parseUserAgent({ userAgent: LINUX_FIREFOX_UA }),
    ]
    for (const ua of rows) {
      const creation = laptopCreationFor(ua, nothingWithdrawn)
      expect(creation.local).toBe(true)
      if (creation.local) expect(creation.managers.at(-1)).toBe("proton")
    }
    expect(laptopCreationFor(parseUserAgent({ userAgent: ANDROID_FIREFOX_UA }))).toEqual(phone)
  })

  describe("withdrawal", () => {
    it("keeps the Chrome tip on a row left with one extension alone", () => {
      expect(
        laptopCreationFor(
          windows(edge, "10.0.0"),
          withdrawing({ windowsEdgeBrave: ["1password"] }),
        ),
      ).toEqual({
        local: true,
        os: "windows",
        row: "windowsEdgeBrave",
        managers: ["proton"],
        withdrawn: ["1password"],
        chromeTip: "gpm",
      })
      expect(
        laptopCreationFor(mac("14.6", edge), withdrawing({ macEdgeBrave: ["proton"] })),
      ).toEqual(macEdgeBrave(["1password"], ["proton"], "gpm"))
    })

    it("ships with Proton Pass withdrawn from Firefox on a Mac alone, where the lock keeps no wrapper", () => {
      expect(laptopCreationFor(firefox("155.0"))).toEqual(macFirefox())
      expect(laptopCreationFor(safari())).toEqual(macSafari())
      for (const ua of [mac("26.4.1"), mac("26.4.1", edge), windows(), windows(edge), linux()]) {
        expect(laptopCreationFor(ua)).toMatchObject({ withdrawn: [] })
      }
    })
  })
})

describe("withoutManager", () => {
  it("keeps the Chrome tip on a row left with one extension", () => {
    expect(withoutManager(macEdgeBrave(["1password", "proton"], [], "gpm"), "1password")).toEqual(
      macEdgeBrave(["proton"], [], "gpm"),
    )
  })
})
