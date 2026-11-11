/**
 * The wallet's read of where a registration stands: front-core's `registrationStage` over the
 * wallet's own stores. Surfaces that decide whether to ask for the deposit, show progress or step
 * aside read it here, and combine it with the facts a stage does not cover.
 */
import {
  currentRegistration,
  depositOwed,
  derived,
  registrationStage,
  routeConfirmsTag,
  useStore,
  type FundingBurn,
  type Loaded,
  type PendingRegistrationRecord,
  type ReadonlyStore,
  type RecordSet,
  type RegistrationStage,
  type SipaDeposit,
} from "@obsidion/front-core"
import { useSession, type Session } from "../../session/session"
import {
  isTagPresentationPending,
  loadedRegistrations,
  registrationAddressPublished,
} from "./webRegistration"

/** What a stage reads: the session's deposits and withdrawals. */
type StageReads = Pick<Session, "sipaDeposits" | "withdrawals">

/** What the open registration reads. */
export type RegistrationReads = StageReads & Pick<Session, "registrations" | "identity">

/**
 * Undefined until the session's deposits load, and while its withdrawals load and the stage would
 * read `reserved`: a funding burn may be among them. A caller passing `burns` passes loaded ones,
 * and reads the deposits as they are.
 */
export function readRegistrationStage(
  own: StageReads,
  record: PendingRegistrationRecord,
): RegistrationStage | undefined
export function readRegistrationStage(
  own: StageReads,
  record: PendingRegistrationRecord,
  burns: readonly FundingBurn[],
): RegistrationStage
export function readRegistrationStage(
  own: StageReads,
  record: PendingRegistrationRecord,
  burns?: readonly FundingBurn[],
): RegistrationStage | undefined {
  const deposits = own.sipaDeposits.view.get()
  if (burns) return stageOf(record, deposits, { records: burns, hydrated: true })
  if (!deposits.loaded || deposits.failed) return undefined
  return stageOf(record, deposits, own.withdrawals.list.get())
}

function stageOf(
  record: PendingRegistrationRecord,
  deposits: RecordSet<SipaDeposit>,
  list: Loaded<FundingBurn>,
): RegistrationStage | undefined {
  const id = record.sipaAddress.toLowerCase()
  const stage = registrationStage(record, {
    deposit: deposits.records.find((d) => d.sipaAddress.toLowerCase() === id) ?? null,
    burns: list.records,
  })
  return stage === "reserved" && !list.hydrated ? undefined : stage
}

/** The open registration, or `failed` while the records cannot be read: never none. */
export type OpenRegistration =
  | {
      record: PendingRegistrationRecord
      /** Undefined until it is known (`readRegistrationStage`). */
      stage: RegistrationStage | undefined
      failed?: undefined
    }
  | { failed: true; record?: undefined; stage?: undefined }

/** The registration behind the tag the active wallet still presents as pending. */
export function openRegistration(
  own: RegistrationReads,
  burns?: readonly FundingBurn[],
): OpenRegistration | null {
  const identity = own.identity.get().value
  if (identity && own.registrations.view.get().failed) return { failed: true }
  const record = currentRegistration(loadedRegistrations(own.registrations))
  if (!identity || !isTagPresentationPending(own.registrations, identity) || !record) return null
  if (record.l2Address.toLowerCase() !== identity.address.toLowerCase()) return null
  return {
    record,
    stage: burns ? readRegistrationStage(own, record, burns) : readRegistrationStage(own, record),
  }
}

/** Re-renders on every store a stage reads, over the session the view runs in, and returns it. */
function useStageReads(): RegistrationReads {
  const session = useSession()
  useStore(session.registrations.view)
  useStore(session.sipaDeposits.view)
  useStore(session.withdrawals.list)
  useStore(session.identity)
  return session
}

/** Whether the active wallet owes its registration deposit: the gate that sends an action to the
 *  deposit screen instead. */
export function useRegistrationDepositOwed(): boolean {
  const open = openRegistration(useStageReads())
  return open?.stage !== undefined && depositOwed(open.stage)
}

/** Whether the active wallet's tag is not yet claimed on L1; balance and activity wait for it. */
export function useNameClaimPending(): boolean {
  const open = openRegistration(useStageReads())
  return (
    open !== null &&
    open.stage !== "crediting" &&
    open.stage !== "registered" &&
    open.stage !== "failed"
  )
}

/**
 * Whether a registration still has funds to move, from the address it shows until its deposit is
 * credited, over one session's records. Read off the record alone, so a signup reloaded before it
 * saved the wallet identity still has one. The deposit sync runs on signup for that long.
 */
export function registrationCustody(
  registrations: ReadonlyStore<RecordSet<PendingRegistrationRecord>>,
  deposits: ReadonlyStore<RecordSet<SipaDeposit>>,
  withdrawals: ReadonlyStore<Loaded<FundingBurn>>,
): ReadonlyStore<boolean> {
  return derived([registrations, deposits, withdrawals], (records, view, list) => {
    // Records that cannot be read may hold funds in flight.
    if (records.failed) return true
    const record = currentRegistration(records.records)
    if (!record) return false
    const stage = view.loaded && !view.failed ? stageOf(record, view, list) : undefined
    return stage !== "registered" && stage !== "failed"
  })
}

/** `readRegistrationStage` for one record, kept current. Null without a record. */
export function useRegistrationStage(
  record: PendingRegistrationRecord,
): RegistrationStage | undefined
export function useRegistrationStage(
  record: PendingRegistrationRecord | null,
): RegistrationStage | undefined | null
export function useRegistrationStage(
  record: PendingRegistrationRecord | null,
): RegistrationStage | undefined | null {
  const own = useStageReads()
  return record ? readRegistrationStage(own, record) : null
}

/** `openRegistration`, kept current. */
export function useOpenRegistration(): OpenRegistration | null {
  return openRegistration(useStageReads())
}

// ── Tag confirmation ────────────────────────────────────────────────────────────

/**
 * Whether the user settled on this registration's tag. The ClaimFPC's broadcast rail sponsors one
 * broadcast per L1 account, ever, so an address is broadcast only once its tag is final, and from
 * then on the tag cannot change.
 */
export function registrationTagConfirmed(
  own: StageReads,
  record: PendingRegistrationRecord,
  burns?: readonly FundingBurn[],
): boolean {
  if (registrationAddressPublished(record)) return true
  const stage = burns
    ? readRegistrationStage(own, record, burns)
    : readRegistrationStage(own, record)
  if (stage !== undefined && !depositOwed(stage)) return true
  // Random and paid tags wait on the user: keep or swap, and register or verify as a past user.
  return record.tagConfirmed === true || routeConfirmsTag(record.route)
}

/** `registrationTagConfirmed`, kept current. True without a record: nothing is left to choose. */
export function useRegistrationTagConfirmed(record: PendingRegistrationRecord | null): boolean {
  const own = useStageReads()
  return record ? registrationTagConfirmed(own, record) : true
}

/** Whether the active wallet may still change its tag: the deposit is owed and the tag not final. */
export function useRegistrationTagChangeable(): boolean {
  const own = useStageReads()
  const open = openRegistration(own)
  return (
    open?.stage !== undefined &&
    depositOwed(open.stage) &&
    !registrationTagConfirmed(own, open.record)
  )
}
