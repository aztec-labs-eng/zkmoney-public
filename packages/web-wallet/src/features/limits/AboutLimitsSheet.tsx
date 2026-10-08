import { useEffect, useState, type ReactNode } from "react"
import type { Address } from "viem"
import { Modal } from "../../ui/Modal"
import { getConfig } from "../../config/env"
import { getOxideTuple } from "../../config/oxideTuple"
import { useSponsoredAllowance } from "../allowance/useSponsoredAllowance"
import { depositValuation } from "../deposit/depositValuation"
import { depositTokensFor } from "../deposit/loadDepositFacts"
import type { SipaCapacityKey } from "@obsidion/front-core"
import { sipaProcessingObserver } from "../deposit/sipaProcessing"
import { AboutLimitsContent, type LimitsDetails } from "./AboutLimitsContent"
import { sourceFromSipaKey } from "./capacitySources"
import { useAboutLimitsCapacity, type CapacitySource } from "./useAboutLimitsCapacity"
import { productLimitFacts, sponsorshipFacts } from "./aboutLimitsFacts"
import type {
  AboutLimitsFacts,
  AboutLimitsFormat,
  LimitsTopic,
  SponsorshipFacts,
} from "./aboutLimitsView"
import { InfoButton } from "./InfoButton"

/** The About limits sheet, drawn from the facts it is given. */
export function AboutLimitsSheet({
  facts,
  topic,
  details,
  onClose,
  onRetryCapacity,
  onRetrySponsorship,
  format,
}: {
  facts: AboutLimitsFacts
  /** The section to open first; without one, every section is expanded. */
  topic?: LimitsTopic
  /** The calling surface's own lines, by section. */
  details?: LimitsDetails
  onClose: () => void
  onRetryCapacity?: () => void
  onRetrySponsorship?: () => void
  format?: AboutLimitsFormat
}) {
  return (
    <Modal title="About limits" onClose={onClose}>
      <div data-testid="about-limits-sheet">
        <AboutLimitsContent
          facts={facts}
          topic={topic}
          details={details}
          onRetryCapacity={onRetryCapacity}
          onRetrySponsorship={onRetrySponsorship}
          format={format}
        />
      </div>
    </Modal>
  )
}

interface WalletSheetProps {
  onClose: () => void
  topic?: LimitsTopic
  details?: LimitsDetails
  capacity?: CapacitySource
  /** The token the bucket is metered in; defaults to the deployment's settlement token. */
  settlementSymbol?: string
}

/** The product policy, the token valuation matched by address and the bucket `capacity` names. */
function PolicyAndCapacitySheet({
  onClose,
  topic,
  details,
  capacity = { kind: "active" },
  settlementSymbol,
  sponsorship,
  onRetrySponsorship,
}: WalletSheetProps & { sponsorship: SponsorshipFacts; onRetrySponsorship?: () => void }) {
  const config = getConfig()
  const tokens = depositTokensFor(config.network)
  const [manifestToken, setManifestToken] = useState<Address>()
  const shared = useAboutLimitsCapacity(capacity, settlementSymbol ?? tokens[0].symbol)

  useEffect(() => {
    let live = true
    // A profile that cannot name its manifest throws here; the sheet then shows no valuation.
    Promise.resolve()
      .then(() => getOxideTuple(config))
      .then(
        (tuple) => {
          if (live && tuple.token) setManifestToken(tuple.token as Address)
        },
        (error: unknown) => console.warn("[limits] deposit token read failed:", error),
      )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per opening
  }, [])

  const facts: AboutLimitsFacts = {
    product: productLimitFacts({
      tokens,
      valuationOf: manifestToken
        ? (token) => depositValuation(token, manifestToken, config.l1ChainId)
        : undefined,
    }),
    capacity: shared.facts,
    sponsorship,
  }
  return (
    <AboutLimitsSheet
      facts={facts}
      topic={topic}
      details={details}
      onClose={onClose}
      onRetryCapacity={shared.retry}
      onRetrySponsorship={onRetrySponsorship}
    />
  )
}

/** Adds the signed-in account's allowance, which needs the account context. */
function AccountAboutLimitsSheet(props: WalletSheetProps) {
  const { snapshot, refresh } = useSponsoredAllowance()
  useEffect(() => {
    // Uses change with every sponsored batch, so opening the sheet reads again.
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per opening
  }, [])
  return (
    <PolicyAndCapacitySheet
      {...props}
      sponsorship={sponsorshipFacts(snapshot)}
      onRetrySponsorship={refresh}
    />
  )
}

/**
 * The About limits sheet for a wallet surface. `account` is false where no account context exists,
 * such as the request page a visitor pays from; the allowance section then says it needs an account.
 */
export function WalletAboutLimitsSheet({
  account = true,
  ...props
}: WalletSheetProps & { account?: boolean }) {
  return account ? (
    <AccountAboutLimitsSheet {...props} />
  ) : (
    <PolicyAndCapacitySheet {...props} sponsorship={{ state: "no-account" }} />
  )
}

/** The info button beside a recorded deposit's processing reason, on that deposit's own bucket. */
export function PendingLimitsLink({
  sipaAddress,
  capacityKey,
  settlementSymbol,
  detail,
}: {
  sipaAddress: string
  capacityKey: SipaCapacityKey | undefined
  settlementSymbol?: string
  detail?: ReactNode
}) {
  const capacity = sourceFromSipaKey(
    capacityKey,
    () => void sipaProcessingObserver()?.retry(sipaAddress),
  )
  return (
    <LimitsInfoButton
      topic="capacity"
      label="About this wait"
      capacity={capacity}
      settlementSymbol={settlementSymbol}
      details={{ capacity: detail }}
    />
  )
}

/** An info button beside a limit or reason; opens the sheet on `topic` for this context's bucket. */
export function LimitsInfoButton({
  topic,
  label,
  details,
  capacity,
  settlementSymbol,
  account,
}: {
  topic: LimitsTopic
  /** The button's accessible name. */
  label: string
  details?: LimitsDetails
  capacity: CapacitySource
  settlementSymbol?: string
  account?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <InfoButton label={label} onClick={() => setOpen(true)} />
      {open && (
        <WalletAboutLimitsSheet
          topic={topic}
          details={details}
          capacity={capacity}
          settlementSymbol={settlementSymbol}
          account={account}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
