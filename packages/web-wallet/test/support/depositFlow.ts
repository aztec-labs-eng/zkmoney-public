import { act } from "react"

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`)

const press = (id: string) =>
  act(async () => {
    const el = byTestId(id)
    if (!el) throw new Error(`no [data-testid='${id}']`)
    el.click()
  })

/** A button inside the deposit flow's dialog, not on the landing under it. */
const flowButtons = () => [
  ...document.querySelectorAll<HTMLButtonElement>(".ww-deposit-sheet button"),
]

const flowOpen = () => !!document.querySelector(".ww-deposit-sheet")

/** The network and coin picker, the flow's first step. */
const coinPicker = () => document.querySelector<HTMLElement>("[data-testid^='deposit-chain-']")

/** The deposit flow's method row that leads to the address. */
const addressMethod = () =>
  flowButtons().find((b) => b.querySelector("b")?.textContent === "Show deposit address")

/** The method step's row that sends from a wallet. */
export const walletMethod = () =>
  flowButtons().find((b) => b.querySelector("b")?.textContent === "Connect wallet")

/** Closes the deposit flow, step by step, back to the landing. */
export async function closeFlow() {
  for (let i = 0; i < 6 && flowOpen(); i++) {
    const close = [
      ...document.querySelectorAll<HTMLElement>(".ww-deposit-sheet [aria-label='Close']"),
    ].at(-1)
    if (!close) break
    await act(async () => close.click())
  }
}

/** Back from a later step, such as the address sheet, to the method step; its wallet row. */
export async function backToMethod() {
  for (let i = 0; i < 4 && !walletMethod(); i++) {
    const back = [...document.querySelectorAll<HTMLElement>("[aria-label='Back']")].at(-1)
    if (!back) break
    await act(async () => back.click())
  }
  return walletMethod()
}

/** In the picker: the L1, listed first, then `symbol` or its first coin. */
export async function pickL1Coin(symbol?: string) {
  const l1 = coinPicker()
  if (!l1) throw new Error("no network picker")
  await act(async () => l1.click())
  const coin = symbol
    ? byTestId(`picker-${symbol}`)
    : document.querySelector<HTMLElement>(".ww-deposit-sheet [data-testid^='picker-']")
  if (!coin) throw new Error(`no coin ${symbol ?? ""} on the L1`)
  await act(async () => coin.click())
}

/**
 * From the landing to the address flow's picker, or to the coin step over Home past its privacy
 * step. A step already passed is skipped.
 */
export async function toDepositCoinStep() {
  if (byTestId("deposit-show-address") && !flowOpen()) return press("deposit-show-address")
  if (!byTestId("deposit-coin-select") && byTestId("deposit-privacy-continue"))
    await press("deposit-privacy-continue")
}

/** Walks the deposit flow from wherever it stands to the address sheet for `symbol`. */
export async function openDepositSheet(symbol: string) {
  // From the method step the coin is already picked.
  const method = addressMethod()
  if (method) {
    await act(async () => method.click())
    return press("deposit-privacy-continue")
  }
  if (byTestId("deposit-privacy-continue")) return press("deposit-privacy-continue")
  if (!flowOpen()) await press("deposit-show-address")
  await pickL1Coin(symbol)
  // A ready address moves on to privacy; else the method step.
  const row = addressMethod()
  if (row) await act(async () => row.click())
  await press("deposit-privacy-continue")
}

const ADDRESS_TITLE = /^(Creating your address\.\.\.|Send \S+ to this address|Waiting for your \S+)/

/** The address sheet: its own dialog over Home, or the deposit flow's current step on the page. */
export function depositAddressSheet(): HTMLElement | null {
  const own = document.querySelector<HTMLElement>("dialog[aria-label='Deposit address']")
  if (own) return own
  const steps = document.querySelectorAll<HTMLElement>(
    ".ww-modal.ww-deposit-sheet:not(.ww-bridge-sheet)",
  )
  return (
    [...steps].find(
      (card) =>
        !!card.querySelector("[data-testid='deposit-spotted']") ||
        ADDRESS_TITLE.test(card.querySelector(".ww-deposit-sheet__head")?.textContent ?? ""),
    ) ?? null
  )
}
