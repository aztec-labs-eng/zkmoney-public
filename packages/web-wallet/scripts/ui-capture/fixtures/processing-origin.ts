import type { SipaOrigin } from "@obsidion/front-core"
import type { SipaPortalTerms } from "@obsidion/sdk"
import type { Address } from "viem"
import { DEMO_L1_TOKEN, DEMO_OXIDE_TUPLE } from "../../../src/dev/demoFixtures"
import { DEMO_DEPOSIT_FEE, DEMO_FPC_FUNDING_CUT } from "../../../src/dev/fakeL1Rpc"

/** The origin capture deposits derive from; the observer fixture maps its implementation to the demo portal. */
export const DEMO_ORIGIN: SipaOrigin = {
  sipaFactory: "0xfac7fac7fac7fac7fac7fac7fac7fac7fac7fac7",
  implementation: "0x1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e",
  intentHash: "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
  rollupVersion: "1821665230",
  resweepable: false,
  protocol: "legacy-eoa",
  recoveryAddress: "0xfd9df8ea9d7350063da52e60e7e1b6d78449786a",
}

/** With `?originFixture=other` or `failing`, the portal capture deposits were made to; not the active one. */
export const ORIGIN_PORTAL = "0x0707070707070707070707070707070707070707"

/**
 * `?originFixture=`: `other` names ORIGIN_PORTAL for every recorded deposit; `failing` fails that
 * lookup until a retry control is clicked, then names ORIGIN_PORTAL. Absent: the demo portal.
 */
export function originFixture(): "other" | "failing" | null {
  const value = new URLSearchParams(location.search).get("originFixture")
  if (value === null) return null
  if (value !== "other" && value !== "failing") throw new Error(`Unknown origin fixture: ${value}`)
  return value
}

const RETRY_CONTROLS = [
  '[data-testid="about-limits-capacity-retry"]',
  '[data-testid="deposit-pending-reason"] button',
  '[data-testid="funding-capacity-retry"]',
].join(", ")
// `originFixture=failing` recovers only after a user retry: dev StrictMode remounts start extra lookups.
let retried = false
document.addEventListener(
  "click",
  (event) => {
    if ((event.target as Element | null)?.closest?.(RETRY_CONTROLS)) retried = true
  },
  true,
)

/** A recorded SIPA's portal terms in captures; the processing observer and the registration funding panel both read them. */
export async function captureSipaPortalTerms(): Promise<SipaPortalTerms> {
  const origin = originFixture()
  if (origin === "failing" && !retried) throw new Error("capture: portal lookup failed")
  return {
    portal: (origin ? ORIGIN_PORTAL : DEMO_OXIDE_TUPLE.portal) as Address,
    token: DEMO_L1_TOKEN,
    depositFee: DEMO_DEPOSIT_FEE,
    fpcFundingCut: DEMO_FPC_FUNDING_CUT,
  }
}
