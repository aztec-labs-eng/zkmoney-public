/** One config and one set of reads per page: every session reads what ContractService was built from. */
import { expect, it, vi } from "vitest"
import { valueOf, type BridgeInProvider } from "@obsidion/front-core"
import { createPace } from "@obsidion/core/cadence"
import { openPage, pageSessionDeps } from "../../src/app/sessionDeps"
import { namespaceOf } from "../../src/session/session"
import { sandboxBoot } from "../support/seedBootConfig"

it("hands every session its page, over the boot's config", async () => {
  const boot = await sandboxBoot()
  const page = openPage(boot)
  const visitor = pageSessionDeps(page)(namespaceOf(null))
  const account = pageSessionDeps(page)(namespaceOf("a1"))

  expect(page.config).toBe(boot.config)
  expect(boot.contractServiceOptions.oxideEnvProfile).toBe(boot.config.oxideProfile)
  for (const deps of [visitor, account]) expect(deps.page).toBe(page)
})

it("polls on the pace the boot hands it", async () => {
  const pace = createPace()
  expect(openPage(await sandboxBoot(), { pace }).pace).toBe(pace)
})

it("counts its tab as active from the page's start until the gate says when", async () => {
  const page = openPage(await sandboxBoot())
  expect(page.activeSince.get()).toBe(performance.timeOrigin)
})

it("boots the wallet once wanted after the tab opens its store, never on a want before", async () => {
  const page = openPage(await sandboxBoot())
  const create = vi.fn(() => new Promise<never>(() => {}))
  page.wantWallet()
  page.openWallet({} as never, {} as never, create)
  await Promise.resolve()
  expect(create).not.toHaveBeenCalled()
  expect(page.walletWanted.get()).toBe(false)
  page.wantWallet()
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
  expect(page.walletWanted.get()).toBe(true)
})

it("boots the wallet for a flow that waits on it, once the store opens", async () => {
  const page = openPage(await sandboxBoot())
  const create = vi.fn(() => new Promise<never>(() => {}))
  page.openWallet({} as never, {} as never, create)
  void page.wallet.ready()
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
  expect(page.walletWanted.get()).toBe(true)
})

it("stops the PXE of a wallet it lets go", async () => {
  const page = openPage(await sandboxBoot())
  const stopped = vi.fn(async () => {})
  page.openWallet(
    {} as never,
    { bootStartedAt: 0 } as never,
    async () => ({ pxe: { stop: stopped } } as never),
  )
  page.wantWallet()
  await page.wallet.ready()
  page.wallet.close()
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce())
})

it("bridges in through a demo's bridge in place of the profile's, and none without a bridge", async () => {
  const boot = await sandboxBoot()
  const across = { apiUrl: "https://across.example/api", chains: [], oxide: {} }
  const fake: BridgeInProvider = { quote: vi.fn(), status: vi.fn() }
  const demo = openPage(
    { ...boot, config: { ...boot.config, features: { across } } },
    { bridgeInProvider: fake },
  )
  expect(valueOf(demo.bridgeInProvider)).toBe(fake)
  expect(valueOf(demo.bridgeInDeposits)).toBeNull()
  const none = openPage({ ...boot, config: { ...boot.config, features: {} } })
  expect(valueOf(none.bridgeInProvider)).toBeNull()
})
