/**
 * A signup that came from a paylink spends the link's golden ticket before the NameClaim, so the
 * claim quotes the ticket schedule. Unavailable, below-threshold and uncovered leave the ticket
 * unspent; a prove or redeem failure surfaces to the caller instead of quoting a paid deposit.
 */
import type { Chain } from "../../session/session"
import { EthAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { Hex } from "viem"
import type { RegistrationSchedule } from "@obsidion/core/types"
import {
  type ContractService,
  assertGoldenTicketNoteSettled,
  decodePaylinkInline,
  finishGoldenTicketWitness,
  prepareGoldenTicketWitness,
  type ObsidionWallet,
  type PreparedGoldenTicketWitness,
} from "@obsidion/sdk"
import {
  AccountServiceError,
  bestEffort,
  deriveBootstrapKey,
  type AccountServiceClient,
} from "@obsidion/front-core"
import { proveGoldenTicketInBrowser, warmGoldenTicketProver } from "../paylink/goldenTicketProver"
import type { NoirWasm } from "../../platform/noirProver"
import { rememberTicketSpent } from "../paylink/ticketSpent"
import type { TicketDevice } from "../paylink/ticketSignupAccount"

export type GoldenTicketOutcome =
  | "created"
  | "repeat"
  | "unavailable"
  | "below_threshold"
  | "cannot_cover"

export interface GoldenTicketRedeemed {
  status: GoldenTicketOutcome
  /** The note's amount, base units; known once the witness read it. */
  amount?: bigint
}

/**
 * How far behind the head a prepared root may be before the redeem reads a fresh one: half the
 * account-service's default accepted window (`ACCOUNT_GOLDEN_TICKET_ROOT_WINDOW`, 200 blocks), so the
 * proof and the POST after it still land inside the window.
 */
export const PREPARED_ROOT_MAX_AGE_BLOCKS = 100

/**
 * The page's one prepared witness of a link, bar its owner, read once per wallet and link, and the
 * witness wasm its proof runs on.
 */
export function createPreparedTicket(wasm: NoirWasm) {
  let prepared:
    | { wallet: ObsidionWallet; fragment: string; witness: Promise<PreparedGoldenTicketWitness> }
    | undefined
  const holds = (wallet: ObsidionWallet, fragment: string) =>
    prepared?.wallet === wallet && prepared.fragment === fragment
  return {
    wasm,
    holds,
    /** A failed read is not kept. */
    read(chain: Chain, fragment: string): Promise<PreparedGoldenTicketWitness> {
      if (!prepared || !holds(chain.wallet, fragment)) {
        const witness = (async () =>
          prepareGoldenTicketWitness(chain, decodePaylinkInline(fragment)))()
        prepared = { wallet: chain.wallet, fragment, witness }
        witness.catch(() => {
          if (prepared?.witness === witness) prepared = undefined
        })
      }
      return prepared.witness
    },
    forget(wallet: ObsidionWallet, fragment: string): void {
      if (holds(wallet, fragment)) prepared = undefined
    },
  }
}

export type PreparedTicket = ReturnType<typeof createPreparedTicket>

/**
 * Starts what the ticket's proof needs before the passkey exists: the prover (wasm, backend and
 * reference string, the circuit) and the witness bar its owner, which is the one input the passkey
 * decides. The redeem picks both up; a failure here leaves the redeem its own attempt.
 */
export function prewarmGoldenTicket(
  prepared: PreparedTicket,
  chain: Chain,
  fragment: string,
): void {
  warmGoldenTicketProver(prepared.wasm).catch((err) =>
    console.warn("golden ticket prover warm-up failed", err),
  )
  prepared.read(chain, fragment).catch(() => {})
}

/**
 * The prepared witness while its root is recent enough to redeem, else a fresh read. A root above
 * the head was pruned or reorged away. `settled` rejects when a note read before this redeem was
 * claimed or cancelled since; a fresh read is its own check.
 */
async function redeemableWitness(
  prepared: PreparedTicket,
  chain: Chain,
  fragment: string,
  head: number,
): Promise<{ witness: PreparedGoldenTicketWitness; settled: Promise<void> }> {
  const early = prepared.holds(chain.wallet, fragment)
  const reuse = await prepared.read(chain, fragment).catch(() => undefined)
  const age = reuse ? head - reuse.blockNumber : -1
  if (reuse && age >= 0 && age <= PREPARED_ROOT_MAX_AGE_BLOCKS) {
    const settled = early
      ? assertGoldenTicketNoteSettled(chain, decodePaylinkInline(fragment), reuse)
      : Promise.resolve()
    settled.catch(() => {})
    return { witness: reuse, settled }
  }
  prepared.forget(chain.wallet, fragment)
  return { witness: await prepared.read(chain, fragment), settled: Promise.resolve() }
}

/**
 * A ticket is spent by the redeem POST and never refunded, so every check that can fail closed runs
 * before it: the network issues tickets, the note clears the threshold, and the note covers the
 * registration burn on the schedule the service advertises for a ticket right now (`covers`). An
 * advertised schedule that is missing cannot price a burn, so it does not cover. A network that paused tickets between the offer read and the
 * redeem reads as unavailable too: the route refuses before anything is spent.
 */
export async function redeemGoldenTicketForLink(args: {
  wallet: ObsidionWallet
  contractService: ContractService
  accountService: AccountServiceClient
  secretKey: Fr
  fragment: string
  /** Where a ticket the service refused as spent is remembered. */
  device: TicketDevice
  prepared: PreparedTicket
  covers?: (
    amount: bigint,
    advertised: RegistrationSchedule | undefined,
  ) => Promise<boolean> | boolean
  /** Called as the proof starts, once every check has passed. */
  onProving?: () => void
}): Promise<GoldenTicketRedeemed> {
  const [info, head] = await Promise.all([
    args.accountService.domainInfo(),
    args.wallet.node.getBlockNumber().then(Number),
  ])
  if (!info.goldenTicket) return { status: "unavailable" }
  const threshold = BigInt(info.goldenTicket.threshold)
  const advertised = info.goldenTicket.schedule
    ? {
        fee: BigInt(info.goldenTicket.schedule.fee),
        min: BigInt(info.goldenTicket.schedule.minDeposit),
      }
    : undefined
  // The passkey MSK determines the bootstrap EOA. The circuit and the redeem POST both name it.
  const ownerHex = deriveBootstrapKey(args.secretKey).address.toLowerCase() as Hex
  const { prepared, wallet, contractService, fragment } = args
  const { witness, settled } = await redeemableWitness(
    prepared,
    { wallet, contractService },
    fragment,
    head,
  )
  const ticket = finishGoldenTicketWitness(witness, {
    threshold,
    owner: EthAddress.fromString(ownerHex),
  })
  const amount = ticket.amount
  if (amount < threshold) return { status: "below_threshold", amount }
  if (args.covers && !(await args.covers(amount, advertised)))
    return { status: "cannot_cover", amount }
  args.onProving?.()
  try {
    const { proof } = await proveGoldenTicketInBrowser(ticket.inputs, prepared.wasm)
    await settled
    const { status } = await args.accountService.redeemGoldenTicket({
      proof: `0x${Buffer.from(proof).toString("hex")}`,
      root: ticket.publicInputs.root.toString() as Hex,
      blockNumber: ticket.publicInputs.blockNumber,
      nullifier: ticket.nullifier.toString() as Hex,
      owner: ownerHex,
      classIds: ticket.publicInputs.classIds.map(String) as [Hex, Hex],
    })
    return { status, amount }
  } catch (err) {
    // The service may have refused this root, so a retry reads the witness again.
    prepared.forget(wallet, fragment)
    if (ticketsPaused(err)) return { status: "unavailable", amount }
    if (err instanceof AccountServiceError && err.message.includes("ticket_spent"))
      void bestEffort("unknown", rememberTicketSpent(args.device, args.fragment))
    throw err
  }
}

const ticketsPaused = (err: unknown): boolean =>
  err instanceof AccountServiceError && err.status === 503 && err.message === "ticket_paused"
