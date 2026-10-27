import { parseUnits } from "viem"
import { REGISTRATION_SCHEDULE_DEFAULTS } from "@obsidion/core/constants"

/**
 * Dev-only `?mock=create|creating|claim|claiming|deposit|deposit-free|deposit-wrong-chain|deposit-expired|funded&handle=<tag>`
 * on /claim: opens the onboarding modals directly (the -ing forms hold the spinner) and fakes every
 * backend op (passkey, claim) so the UI can be iterated without services. `deposit`/`deposit-free`/
 * `funded` render the campaign deposit panel (registration-fee.md Campaign) over a synthetic record
 * and claim, never the real store; `deposit-wrong-chain` is that record started on another L1 chain
 * and `deposit-expired` one whose reservation deadline has passed with no deposit — see OnboardingScreen's `mockRecord`/`freshClaim` seeding;
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
  "deposit-wrong-chain": {
    step: "pending",
    busy: false,
    depositPhase: "awaiting_deposit",
    free: false,
    wrongChain: true,
  },
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

export function mockOnboarding(): {
  step: "create" | "claim" | "pending"
  busy: boolean
  handle: string
  /** Set only for the deposit-panel previews; seeds a synthetic record instead of hitting the chain. */
  depositPhase?: "awaiting_deposit" | "funded"
  free?: boolean
  /** The synthetic record's chain differs from the wallet's, so the pending step shows the wrong-network state. */
  wrongChain?: boolean
  /** The synthetic claim's deadline is already past, so the pending step shows the lapsed reservation. */
  expired?: boolean
  /** The schedule the previews quote: its minimum and its fee, in base units. */
  min: bigint
  fee: bigint
  /** The deposit token. A token other than the settlement one adds the panel's note about the
   *  opening balance. */
  tokenSymbol: string
  /** A deposit already seen at the address, in base units; absent means nothing sent yet. */
  received?: bigint
} | null {
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
