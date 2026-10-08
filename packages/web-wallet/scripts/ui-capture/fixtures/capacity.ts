import * as actual from "../../../src/features/deposit/capacityStore"
import {
  createPortalCapacityStore,
  portalCapacityKey,
  type PortalCapacityKey,
  type PortalCapacityStore,
} from "@obsidion/front-core"
import type { PortalCapacitySnapshot } from "@obsidion/sdk"
import { getConfig } from "../../../src/config/env"
import { isDemoMode } from "../../../src/dev/demoFlag"
import { DEMO_OXIDE_TUPLE } from "../../../src/dev/demoFixtures"
import { ORIGIN_PORTAL } from "./processing-origin"

const STATES = ["fits", "low", "short", "empty", "unavailable", "clock-ahead", "clears"] as const
type CapacityState = (typeof STATES)[number]
const KEY = "ui-capture.capacity-state"
const DAI = 10n ** 18n

/** `?capacityFixture=<state>` picks what the fake portal reports; a demo without it reads `fits`. */
function capacityState(): CapacityState {
  const requested = new URLSearchParams(location.search).get("capacityFixture")
  const value = requested ?? sessionStorage.getItem(KEY) ?? "fits"
  if (!STATES.includes(value as CapacityState))
    throw new Error(`Unknown capacity fixture: ${value}`)
  sessionStorage.setItem(KEY, value)
  return value as CapacityState
}

const AVAILABLE: Record<Exclude<CapacityState, "unavailable" | "clears">, bigint> = {
  "fits": 48_250n * DAI,
  "low": 1_200n * DAI,
  "short": 500n * DAI,
  "empty": 0n,
  "clock-ahead": 48_250n * DAI,
}

const CHECK_AGAIN = [
  '[data-testid="deposit-pending-reason"] > button',
  '[data-testid="about-limits-capacity-retry"]',
  '[data-testid="funding-capacity-retry"]',
].join(", ")
// `clears` reports an empty bucket until the user presses a capacity Check again, then `fits`.
let checkedAgain = false
document.addEventListener(
  "click",
  (event) => {
    if ((event.target as Element | null)?.closest?.(CHECK_AGAIN)) checkedAgain = true
  },
  true,
)

/** `?originCapacity=empty|short`: the original portal's amount, below a registration's 4.9 DAI credit; otherwise 700 DAI. */
function originAvailable(): bigint {
  const value = new URLSearchParams(location.search).get("originCapacity")
  if (value === null) return 700n * DAI
  if (value === "empty") return 0n
  if (value === "short") return 4n * DAI
  throw new Error(`Unknown origin capacity fixture: ${value}`)
}

function read(key: PortalCapacityKey): Promise<PortalCapacitySnapshot> {
  const state = capacityState()
  if (state === "unavailable") return Promise.reject(new Error("capture: capacity read failed"))
  // A device clock two hours ahead makes every block look two hours old.
  const skew = state === "clock-ahead" ? 2 * 3600 : 0
  return Promise.resolve({
    chainId: key.chainId,
    portal: key.portal,
    token: key.token,
    decimals: 18,
    blockNumber: BigInt(Math.floor(Date.now() / 12_000)),
    blockTimestamp: BigInt(Math.floor(Date.now() / 1000) - skew),
    rateAtomicPerSecond: (50_000n * DAI) / 86_400n,
    globalLimitAtomic: 50_000n * DAI,
    // A deposit's original portal (`?originFixture=`) reports its own amount, so it never looks like the active one.
    availableAtomic:
      key.portal.toLowerCase() === ORIGIN_PORTAL
        ? originAvailable()
        : state === "clears"
        ? checkedAgain
          ? AVAILABLE.fits
          : 0n
        : AVAILABLE[state],
  })
}

/**
 * The capture clock is frozen, and a read clears a confirmed blocker only when it is newer than the one that set it.
 * After a Check again, `clears` reads one second later; every other state reads the page clock unchanged.
 */
const storeNow = () => Date.now() + (checkedAgain && capacityState() === "clears" ? 1_000 : 0)

const stores = new Map<string, PortalCapacityStore>()

export const depositCapacityStore: typeof actual.depositCapacityStore = (key) => {
  if (!isDemoMode()) return actual.depositCapacityStore(key)
  const id = `${key.chainId}|${key.portal.toLowerCase()}|${key.token.toLowerCase()}`
  let store = stores.get(id)
  if (!store) {
    store = createPortalCapacityStore(key, { read, now: storeNow })
    stores.set(id, store)
  }
  return store
}

/** The demo tuple has no chain id; the demo's configured L1 chain stands in. */
export const activeCapacityKey: typeof actual.activeCapacityKey = async () => {
  if (!isDemoMode()) return actual.activeCapacityKey()
  return portalCapacityKey({
    chainId: getConfig().l1ChainId,
    portal: DEMO_OXIDE_TUPLE.portal,
    token: DEMO_OXIDE_TUPLE.token,
  })
}
