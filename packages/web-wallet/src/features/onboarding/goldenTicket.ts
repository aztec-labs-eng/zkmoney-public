/**
 * A signup that came from a paylink spends the link's golden ticket before the NameClaim, so the
 * claim quotes the ticket schedule. Unavailable, below-threshold and uncovered leave the ticket
 * unspent; a prove or redeem failure surfaces to the caller instead of quoting a paid deposit.
 */
import { EthAddress } from "@aztec/aztec.js/addresses"
import type { Fr } from "@aztec/aztec.js/fields"
import type { Hex } from "viem"
import type { RegistrationSchedule } from "@obsidion/core/types"
import {
  buildGoldenTicketWitness,
  ContractService,
  decodePaylinkInline,
  type ObsidionWallet,
} from "@obsidion/sdk"
import {
  AccountServiceError,
  deriveBootstrapKey,
  type AccountServiceClient,
} from "@obsidion/front-core"
import { proveGoldenTicketInBrowser } from "../paylink/goldenTicketProver"

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
 * A ticket is spent by the redeem POST and never refunded, so every check that can fail closed runs
 * before it: the network issues tickets, the note clears the threshold, and the note covers the
 * registration burn on the schedule the service advertises for a ticket right now (`covers`,
 * which the caller prices against the live cuts). An advertised schedule that is missing cannot
 * price a burn, so it does not cover. A network that paused tickets between the offer read and the
 * redeem reads as unavailable too: the route refuses before anything is spent.
 */
export async function redeemGoldenTicketForLink(args: {
  wallet: ObsidionWallet
  accountService: AccountServiceClient
  secretKey: Fr
  fragment: string
  covers?: (
    amount: bigint,
    advertised: RegistrationSchedule | undefined,
  ) => Promise<boolean> | boolean
}): Promise<GoldenTicketRedeemed> {
  const info = await args.accountService.domainInfo()
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
  const ticket = await buildGoldenTicketWitness(
    { wallet: args.wallet, contractService: ContractService.getInstance() },
    decodePaylinkInline(args.fragment),
    { threshold, owner: EthAddress.fromString(ownerHex) },
  )
  const amount = ticket.amount
  if (amount < threshold) return { status: "below_threshold", amount }
  if (args.covers && !(await args.covers(amount, advertised)))
    return { status: "cannot_cover", amount }
  const { proof } = await proveGoldenTicketInBrowser(ticket.inputs)
  try {
    const { status } = await args.accountService.redeemGoldenTicket({
      proof: `0x${Buffer.from(proof).toString("hex")}`,
      root: ticket.publicInputs.root.toString() as Hex,
      blockNumber: ticket.publicInputs.blockNumber,
      nullifier: ticket.nullifier.toString() as Hex,
      owner: ownerHex,
    })
    return { status, amount }
  } catch (err) {
    if (ticketsPaused(err)) return { status: "unavailable", amount }
    throw err
  }
}

const ticketsPaused = (err: unknown): boolean =>
  err instanceof AccountServiceError && err.status === 503 && err.message === "ticket_paused"
