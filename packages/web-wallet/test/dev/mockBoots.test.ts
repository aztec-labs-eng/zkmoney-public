/**
 * A demo boot under `/dev/mock/`: a move onto another mock builds a new boot and marks the page it
 * leaves; any other move keeps the page.
 */
import { afterEach, describe, expect, it } from "vitest"
import { memoryStore } from "@obsidion/front-core"
import type { PageBoot } from "../../src/app/sessionDeps"
import { mockBoots, opensMock } from "../../src/dev/mockBoots"
import { answered, testQuery } from "../support/query"

afterEach(() => history.replaceState(null, "", "/"))

describe("opensMock", () => {
  it.each([
    ["/dev/mock/deposit", "/dev/mock/deposit/address", true],
    ["/dev/mock/deposit/address", "/dev/mock/deposit/address", false],
    ["/dev/mock/deposit/address", "/dev/mock/deposit", false],
  ])("%s → %s: %s", (from, to, opens) => expect(opensMock(from, to)).toBe(opens))
})

describe("mockBoots", () => {
  /** A ready boot over a page that only carries `leaving`. */
  const booted = async () => {
    const leaving = memoryStore(false)
    const boot = answered({ page: { leaving } } as unknown as PageBoot)
    await boot.read()
    return { boot, leaving }
  }

  it("builds the next boot on a move to another mock and marks the page it leaves", async () => {
    history.replaceState(null, "", "/dev/mock/deposit")
    const { boot, leaving } = await booted()
    const next = answered({} as PageBoot)
    const boots = mockBoots(boot, () => next)
    history.pushState(null, "", "/dev/mock/deposit/address")
    boots.follow()
    expect(boots.current.get().boot).toBe(next)
    expect(leaving.get()).toBe(true)
  })

  it("lets the next boot seed only once a loading one lands, and marks the page it built", async () => {
    history.replaceState(null, "", "/dev/mock/withdraw/withdraw-journey")
    const leaving = memoryStore(false)
    let land = (_: PageBoot) => {}
    const loading = testQuery()<[], PageBoot>("loading", {
      load: () => new Promise<PageBoot>((resolve) => (land = resolve)),
    })()
    void loading.read()
    let after = Promise.resolve()
    const boots = mockBoots(loading, (settled) => {
      after = settled
      return answered({} as PageBoot)
    })
    history.pushState(null, "", "/dev/mock/withdraw/landing")
    boots.follow()
    let settled = false
    void after.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    land({ page: { leaving } } as unknown as PageBoot)
    await after
    expect(leaving.get()).toBe(true)
  })

  it("keeps the page on a move that opens no other mock", async () => {
    history.replaceState(null, "", "/dev/mock/deposit/address")
    const { boot, leaving } = await booted()
    const boots = mockBoots(boot, () => answered({} as PageBoot))
    history.pushState(null, "", "/dev/mock/deposit/address?network=base")
    boots.follow()
    history.pushState(null, "", "/activity")
    boots.follow()
    expect(boots.current.get().boot).toBe(boot)
    expect(leaving.get()).toBe(false)
  })

  it("follows back and forward only while read", async () => {
    history.replaceState(null, "", "/dev/mock/deposit/address")
    const { boot } = await booted()
    const next = answered({} as PageBoot)
    const boots = mockBoots(boot, () => next)
    history.replaceState(null, "", "/dev/mock/deposit/privacy")
    dispatchEvent(new PopStateEvent("popstate"))
    expect(boots.current.get().boot).toBe(boot)
    const off = boots.current.subscribe(() => {})
    dispatchEvent(new PopStateEvent("popstate"))
    off()
    expect(boots.current.get().boot).toBe(next)
  })
})
