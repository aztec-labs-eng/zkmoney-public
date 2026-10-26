import { useEffect, useState, type ReactNode } from "react"
import { Modal } from "../../ui/Modal"
import { getConfig } from "../../config/env"
import { useSponsoredAllowance } from "../allowance/useSponsoredAllowance"
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
import { SHEET_TITLE } from "./limitsCopy"

/** The About limits sheet, drawn from the facts it is given. */
export function AboutLimitsSheet({
  facts,
  topic,
  details,
  onClose,
  onRetryCapacity,
  onRetrySponsorship,
  format,
  showCapacity,
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
  showCapacity?: boolean
}) {
  return (
    <Modal title={SHEET_TITLE} onClose={onClose}>
      <div data-testid="about-limits-sheet">
        <AboutLimitsContent
          facts={facts}
          topic={topic}
          details={details}
          onRetryCapacity={onRetryCapacity}
          onRetrySponsorship={onRetrySponsorship}
          format={format}
          showCapacity={showCapacity}
        />
      </div>
    </Modal>
  )
}

interface WalletSheetProps {
  onClose: () => void
  topic?: LimitsTopic
  details?: LimitsDetails
  /** `false` leaves the capacity section out, for Settings, where no deposit is in view. */
  capacity?: CapacitySource | false
  /** The token the bucket is metered in; defaults to the deployment's settlement token. */
  settlementSymbol?: string
}

/** The product policy and the bucket `capacity` names. */
function PolicyAndCapacitySheet({
  onClose,
  topic,
  details,
  capacity = { kind: "active" },
  settlementSymbol,
  sponsorship,
  onRetrySponsorship,
}: WalletSheetProps & { sponsorship: SponsorshipFacts; onRetrySponsorship?: () => void }) {
  const symbol = settlementSymbol ?? depositTokensFor(getConfig().network)[0].symbol
  // An unresolved source reads no store.
  const shared = useAboutLimitsCapacity(capacity || { kind: "unresolved" }, symbol)
  const facts: AboutLimitsFacts = {
    product: productLimitFacts(),
    capacity: capacity ? shared.facts : undefined,
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
      showCapacity={capacity !== false}
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
