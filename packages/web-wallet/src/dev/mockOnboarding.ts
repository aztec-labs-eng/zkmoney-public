import { parseUnits } from "viem"

/**
 * Dev-only `?mock=create|creating|claim|claiming|carousel|deposit|deposit-free|deposit-wrong-chain|deposit-expired|funded&handle=<tag>`
 * on /claim: opens the onboarding modals directly (the -ing forms hold the spinner) and fakes every
 * backend op (passkey, claim) so the UI can be iterated without services. `deposit`/`deposit-free`/
 * `funded` render the campaign deposit panel (registration-fee.md Campaign) over a synthetic record
 * and claim, never the real store; `deposit-wrong-chain` is that record started on another L1 chain
 * and `deposit-expired` one whose reservation deadline has passed with no deposit — see OnboardingScreen's `mockRecord`/`freshClaim` seeding;
 * `&min=<tokens>&fee=<tokens>` set the schedule the previews quote, its minimum and its fee
 * (18 decimals, with a default per kind below);
 * `&cut=<tokens>` sets the portal's funding cut;
 * `&token=DAI|USDC|USDT` picks the deposit token and
 * `&received=<tokens>` seeds a deposit already at the address.
 * `import.meta.env.DEV` is a build-time literal — production drops this.
 */
const MOCKS = {
  "create": { step: "create", busy: false },
  "creating": { step: "create", busy: true },
  "claim": { step: "claim", busy: false },
  "claiming": { step: "claim", busy: true },
  "carousel": { step: "carousel", busy: false },
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
  step: "create" | "claim" | "carousel" | "pending"
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
  /** The portal's funding cut, in base units: what the opening balance loses on arrival. */
  cut: bigint
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
  return {
    ...mock,
    handle: q.get("handle") ?? "honktheg00se",
    min: parseUnits(q.get("min") ?? (earned ? "4.4" : "9.5"), 18),
    fee: parseUnits(q.get("fee") ?? (earned ? "0.5" : "4.9"), 18),
    cut: parseUnits(q.get("cut") ?? "0.1", 18),
    tokenSymbol: (TOKENS as readonly string[]).includes(token) ? token : "DAI",
    received: received === null ? undefined : parseUnits(received, 18),
  }
}
