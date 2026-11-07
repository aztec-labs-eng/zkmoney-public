import { parseUnits } from "viem"
import { REGISTRATION_SCHEDULE_DEFAULTS } from "@obsidion/core/constants"
import type { OnboardingMock } from "../features/onboarding/OnboardingScreen/signupFlow"

/**
 * Dev-only `?mock=create|creating|claim|claiming|deposit|deposit-free|deposit-expired|funded&handle=<tag>`
 * on /claim: opens the onboarding modals directly (the -ing forms hold the spinner) and fakes every
 * backend op (passkey, claim) so the UI can be iterated without services. `deposit`/`deposit-free`/
 * `funded` render the campaign deposit panel (registration-fee.md Campaign) over a synthetic record
 * and claim, never the real store; `deposit-expired` is that record past its reservation deadline with no deposit — see OnboardingScreen's `mockRecord`/`freshClaim` seeding;
 * `&min=<tokens>&fee=<tokens>` set the schedule the previews quote, its minimum and its fee
 * (18 decimals, with a default per kind below);
 * `&token=DAI|USDC|USDT` picks the deposit token and
 * `&received=<tokens>` seeds a deposit already at the address.
 * `import.meta.env.DEV` is a build-time literal — production drops this.
 */
const MOCKS = {
  "create": { step: "create", busy: false },
  "creating": { step: "create", busy: true },
  "claim": { step: "claim", busy: false },
  "claiming": { step: "claim", busy: true },
  "deposit": { step: "pending", busy: false, depositPhase: "awaiting_deposit", free: false },
  "deposit-free": { step: "pending", busy: false, depositPhase: "awaiting_deposit", free: true },
  "deposit-expired": {
    step: "pending",
    busy: false,
    depositPhase: "awaiting_deposit",
    free: false,
    expired: true,
  },
  "funded": { step: "pending", busy: false, depositPhase: "funded", free: false },
} as const

const TOKENS = ["DAI", "USDC", "USDT"] as const

export function mockOnboarding(): OnboardingMock | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null
  const q = new URLSearchParams(window.location.search)
  const mock = MOCKS[q.get("mock") as keyof typeof MOCKS]
  if (!mock) return null
  const token = (q.get("token") ?? "").toUpperCase()
  const received = q.get("received")
  const earned = "free" in mock && mock.free
  const schedule = REGISTRATION_SCHEDULE_DEFAULTS[earned ? "earned_tag" : "standard"]
  return {
    ...mock,
    handle: q.get("handle") ?? "honktheg00se",
    min: q.get("min") ? parseUnits(q.get("min")!, 18) : schedule.min,
    fee: q.get("fee") ? parseUnits(q.get("fee")!, 18) : schedule.fee,
    tokenSymbol: (TOKENS as readonly string[]).includes(token) ? token : "DAI",
    received: received === null ? undefined : parseUnits(received, 18),
  }
}
