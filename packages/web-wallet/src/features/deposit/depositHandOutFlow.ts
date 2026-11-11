/** The deposit screen's address: every caller joins the hand-out in flight or takes the held one. */
import {
  broadcastJobs,
  memoryStore,
  SELF_SLOTS,
  type ReadonlyStore,
  type SipaDeposit,
} from "@obsidion/front-core"
import { showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { RegistrationPendingError } from "../registration/registrationRail"
import type { ShownAddress } from "../sipa/depositTarget"
import { AddressesPublishingError, addressesPublishing } from "./addressesPublishing"
import { unpublishedSlots } from "./sipaAddresses"
import type { DepositStage, SipaAddresses } from "./sipaAddresses"

/** Shown, unfunded addresses still publishing above which the screen waits instead of deriving. */
export const PUBLISHING_LIMIT = 2

interface HandOut {
  address?: ShownAddress
  /** The hand-out in flight, and the most it may derive: limit 0 reads the pool only. */
  running?: { limit: number; run: Promise<boolean> }
  /** Refused while too many shown addresses still publish. */
  capped: boolean
  failed: boolean
}

export interface HandOutInputs {
  handle?: string
  account?: string
  /** Unset while no hand-out may run. */
  addresses?: Pick<SipaAddresses, "depositAddress">
  sheetOpen: boolean
}

/**
 * One deposit screen's address. A derivation waits for the account's keys until the screen goes. A
 * refused one waits for a counted address in `records` to land or be funded.
 */
export function openDepositHandOutFlow(
  latest: () => HandOutInputs,
  records: ReadonlyStore<{ records: readonly SipaDeposit[] }>,
  friendlyError: (e: unknown) => string,
) {
  const state = memoryStore<HandOut>({ capped: false, failed: false })
  const set = (patch: Partial<HandOut>) => state.set({ ...state.get(), ...patch })
  let screen: AbortSignal | undefined
  /** Uncaps once the limit frees, and hands out at once when the sheet waits for it. */
  const release = () => {
    const all = records.get().records
    const held =
      addressesPublishing(broadcastJobs(all)) >= PUBLISHING_LIMIT ||
      unpublishedSlots(all, latest().account ?? "", Date.now()) >= SELF_SLOTS.lookahead
    if (!state.get().capped || held) return
    set({ capped: false })
    if (latest().sheetOpen) void handOut()
  }

  const run = async (derive: () => ReturnType<SipaAddresses["depositAddress"]>, limit: number) => {
    // The open's pool read fails quietly and stays out of the derive funnel; the coin row reports.
    const quiet = limit === 0
    const elapsed = lapTimer()
    const signal = screen
    if (!quiet) fireEvent("address_resolve_started", { fresh: false })
    try {
      const next = await derive()
      if (!quiet)
        fireEvent("address_resolve_succeeded", {
          duration_ms: elapsed(),
          cached: next.source !== "derived",
          fresh: false,
        })
      const { address, name, publish, source } = next
      set({ address: { address, name, source, publishing: !!publish } })
      const publishLap = lapTimer()
      // The ledger keeps it owed whatever this reports; the status row shows where it stands.
      void publish?.().then(
        () => {
          if (!quiet) fireEvent("address_published", { duration_ms: publishLap() })
          const held = state.get().address
          if (held?.address === address) set({ address: { ...held, publishing: false } })
        },
        (e) =>
          e instanceof RegistrationPendingError
            ? fireEvent("address_publish_deferred", { reason: e.state.pending })
            : fireEvent("address_publish_failed", {
                duration_ms: publishLap(),
                code: failureCode(e),
              }),
      )
      return true
    } catch (e) {
      if (signal?.aborted) return false
      if (e instanceof AddressesPublishingError) {
        set({ capped: !quiet })
        // The limit may have freed since the refusal: check once this run has settled.
        queueMicrotask(release)
      } else if (!quiet) {
        fireEvent("address_resolve_failed", { duration_ms: elapsed(), code: failureCode(e) })
        showReportableError(e, "deposit:resolve", { message: friendlyError(e) })
        set({ failed: true })
      }
      return false
    } finally {
      set({ running: undefined })
    }
  }

  /** The held address, else one from the pool, else, past limit 0, a fresh one. */
  const handOut = (limit = PUBLISHING_LIMIT): Promise<boolean> => {
    const { address, running } = state.get()
    if (address) return Promise.resolve(true)
    if (running)
      return running.limit >= limit ? running.run : running.run.then((ok) => ok || handOut(limit))
    const { handle, addresses } = latest()
    if (!handle || !addresses || screen?.aborted) return Promise.resolve(false)
    const stageLap = lapTimer()
    const onStage = (stage: DepositStage) =>
      fireEvent("deposit_resolve_stage", { stage, prev_stage_ms: stageLap() })
    const signal = screen
    const next = run(
      () => addresses.depositAddress(handle, { onStage, publishingLimit: limit, signal }),
      limit,
    )
    set({ running: { limit, run: next }, capped: false, failed: false })
    return next
  }

  return {
    state: state.readonly,
    handOut,
    /** A demo page's fixture address. */
    show: (address: ShownAddress) => set({ address }),
    /** The held address was spent or may be: the next hand-out takes a fresh one. */
    drop: () => set({ address: undefined }),
    start(signal: AbortSignal) {
      screen = signal
      signal.addEventListener("abort", records.subscribe(release))
    },
  }
}
