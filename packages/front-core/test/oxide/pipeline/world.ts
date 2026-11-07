/**
 * One account's SIPA pipeline over the fake chain: a real store on a memory database, the real
 * address derivation, and helpers that pay, sweep and announce the account's addresses.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { keccak256 } from "@aztec-labs/foundation/crypto/keccak"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import { computeSIPAAddress } from "@oxide/oxide-lib/sipa_address.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, Hex } from "viem"
import { openDatabase } from "../../../src/engine/database"
import { memoryBackend } from "../../../src/engine/memoryBackend"
import { loadRecords } from "../../../src/engine/persistentStore"
import {
  createSipaDeposits,
  sipaCursorKey,
  type SipaDeposit,
  type SipaDepositFields,
} from "../../../src/engine/sipaDeposits"
import { computeStealthRecipientHash } from "../../../src/core/services/deposits/sipa/stealth"
import { deriveStealthKey } from "../../../src/oxide/oxideAccountKeys"
import { claimSipaDeposits, type SipaClaimDeps } from "../../../src/oxide/sipaClaim"
import { scanSipaDeposits, type SipaScanDeps } from "../../../src/oxide/sipaScan"
import type { SipaRow } from "../../../src/oxide/sipaRows"
import { FakeL1 } from "./fakeL1"
import { FakeL2 } from "./fakeL2"

export const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f" as Address
export const SUSDS = "0xa3931d71877c0e7a3148cb7eb4463524fec27fbd" as Address
export const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address
export const PORTAL = "0x92308ce04e2416f20b03e941a14f9238c3603334" as Address
export const SAVINGS_PORTAL = "0x92308ce04e2416f20b03e941a14f9238c3603335" as Address
export const FACTORY = "0x239474855dff1eb58dca3ee877d599e3c6bd0bd2" as Address
export const TABLE = "0x00000000000000000000000000000000000000d1" as Address
export const DEPOSIT_IMPL = "0x39dd57b9f2b16e5c9e9e35e18b73c8a2a5d1f7c4" as Address
export const REGISTRATION_IMPL = "0x0000000000000000000000000000000000000c02" as Address
export const USER_OP_IMPL = "0x0000000000000000000000000000000000000c03" as Address
export const FUNDER = "0x00000000000000000000000000000000000000f1" as Address
export const L2_TOKEN = `0x0${"12".repeat(31)}2`
export const SAVINGS_L2_TOKEN = `0x0${"34".repeat(31)}4`
export const NETWORK = "0x00000000000000000000000000000000000000e1"
/** The deposit fee every row charges and the cap on one sweep, raw DAI. */
export const FEE = 10n ** 17n
export const CAP = 10n ** 24n
export const DEPOSIT = 1n
export const REGISTRATION = 2n
export const USER_OP = 3n

const MSK = new Fr(7n)
export const RECIPIENT = AztecAddress.fromBigIntUnsafe(0xbeefn)
export const RECOVERY_ACCOUNT = "0x00000000000000000000000000000000000000ac" as Address

export const TUPLE = {
  sipaFactory: FACTORY,
  portal: PORTAL,
  forwardingTable: TABLE,
  token: DAI,
  feeToken: DAI,
  l2Token: L2_TOKEN,
  rollupVersion: "4127419662",
  sipaRecoveryProtocol: "account",
  accountFactory: "0x00000000000000000000000000000000000000af",
} as unknown as OxideEnvTuple

const token = (address: Address, symbol: string, decimals = 18) => ({ address, symbol, decimals })
export const DAI_ROW: SipaRow = {
  portal: PORTAL,
  l2Token: L2_TOKEN,
  token: token(DAI, "DAI"),
  swapped: [token(USDC, "USDC", 6)],
  intents: ["deposit", "registration", "user-op"],
}
export const SAVINGS_ROW: SipaRow = {
  portal: SAVINGS_PORTAL,
  l2Token: SAVINGS_L2_TOKEN,
  token: token(SUSDS, "sUSDS"),
  swapped: [],
  intents: ["deposit"],
}

/** A salt as a test names it. */
export const salt = (n: number) => new Fr(BigInt(n) * 0x1000n + 0x7n)

export async function pipelineWorld(rows: readonly SipaRow[] = [DAI_ROW]) {
  const l1 = new FakeL1({ factory: FACTORY, table: TABLE, portals: [PORTAL, SAVINGS_PORTAL] })
  const l2 = new FakeL2()
  for (const t of [DAI_ROW.token, SAVINGS_ROW.token, ...DAI_ROW.swapped])
    l1.token(t.address, t.symbol, t.decimals)
  l1.implementations.set(1, DEPOSIT_IMPL)
  l1.implementations.set(2, REGISTRATION_IMPL)
  l1.bless(3, USER_OP_IMPL, 1n)
  for (const row of rows) {
    l1.caps.set(row.portal.toLowerCase(), CAP)
    for (const t of [row.token, ...row.swapped])
      for (const intent of [1, 2, 3])
        l1.row(t.address, intent, { portal: row.portal, sweepTip: FEE })
  }
  const db = openDatabase(memoryBackend())
  const store = createSipaDeposits({ db, account: true })
  const stealth = deriveStealthKey(MSK)

  /** The address an event announces, derived as discovery derives it. */
  const derive = async (
    s: Fr,
    opts: {
      intentHash?: Hex
      implementation?: Address
      resweepable?: boolean
      recipient?: AztecAddress
    } = {},
  ) => {
    const recipient = opts.recipient ?? RECIPIENT
    const commitment = await computeStealthRecipientHash(s, recipient)
    const intentHash =
      opts.intentHash ?? (`0x${keccak256(commitment.toBuffer()).toString("hex")}` as Hex)
    const address = computeSIPAAddress({
      sipaFactory: EthAddress.fromString(FACTORY),
      implementation: EthAddress.fromString(opts.implementation ?? DEPOSIT_IMPL),
      intentHash: Buffer.from(intentHash.slice(2), "hex"),
      rollupVersion: BigInt(TUPLE.rollupVersion),
      resweepable: opts.resweepable ?? true,
      recoveryCommitment: deriveRecoveryCommitment(s, EthAddress.fromString(RECOVERY_ACCOUNT)),
      forwardingTable: EthAddress.fromString(TABLE),
    } as never)
    return {
      salt: s,
      recipient,
      address: address.toString() as Address,
      commitment: commitment.toString() as Hex,
      intentHash,
    }
  }

  return {
    l1,
    l2,
    db,
    store,
    stealth,
    derive,
    /** A deposit address the account's PXE learned of from its `SIPA` event. */
    async announced(n: number, opts: Parameters<typeof derive>[1] & { l2Token?: string } = {}) {
      const sipa = await derive(salt(n), opts)
      l2.emit(opts.l2Token ?? L2_TOKEN, sipa.recipient, {
        salt: sipa.salt,
        resweepable: opts.resweepable,
        intentHash: sipa.intentHash,
      })
      return sipa
    },
    /** `amount` of `t` reaches `sipa` from the funder at `block`. */
    pay(sipa: Address, amount: bigint, t: Address = DAI, block = l1.head - 50n) {
      l1.setBalance(FUNDER, t, l1.balanceOf(FUNDER, t) + amount)
      return l1.transfer(t, FUNDER, sipa, amount, block)
    },
    /** The relayer sweeps what `sipa` holds of `t` through `row`, `credit` reaching L2. */
    sweep(
      sipa: { address: Address; commitment: Hex },
      index: bigint,
      opts: { t?: Address; row?: SipaRow; block?: bigint; credit?: bigint } = {},
    ) {
      const t = opts.t ?? DAI
      const gross = l1.balanceOf(sipa.address, t)
      return l1.sweep({
        sipa: sipa.address,
        token: t,
        gross,
        credit: opts.credit ?? gross - FEE,
        index,
        commitment: sipa.commitment,
        portal: (opts.row ?? DAI_ROW).portal,
        block: opts.block ?? l1.head - 40n,
      })
    },
    /** A record this device saved before any event, as a hand-out or a seed writes it. */
    async saved(
      sipa: { address: Address; salt: Fr; commitment: Hex; recipient?: AztecAddress },
      over: Partial<SipaDeposit> = {},
    ) {
      const fields: SipaDepositFields = {
        sipaAddress: sipa.address,
        phase: "resolved",
        recipientL2Address: (sipa.recipient ?? RECIPIENT).toString(),
        messageSecret: sipa.salt.toString(),
        recipientHash: sipa.commitment,
        recoveryAddress: "",
        l1ChainId: 1,
        networkId: NETWORK,
        amount: "0",
        tokenSymbol: "DAI",
        tokenAddress: DAI,
        startTime: Date.now(),
        ...over,
      }
      await store.apply(sipa.address, { type: "derived", fields })
    },
    scan: (over: Partial<SipaScanDeps> = {}) =>
      scanSipaDeposits({
        publicClient: l1.client,
        wallet: l2.wallet as never,
        node: l2.node as never,
        // The spent lookup is answered per message hash, so no key is read.
        masterNullifierHidingKey: undefined as never,
        readConsumed: (l2Token, keys) => l2.readConsumed(l2Token, keys),
        discover: true,
        store,
        db,
        tuple: TUPLE,
        recipient: RECIPIENT,
        stealthPublicKey: stealth.publicKey,
        recoveryAccount: RECOVERY_ACCOUNT,
        rows,
        l1ChainId: 1,
        networkId: NETWORK,
        historyStartBlock: async () => l1.head - 100_000n,
        txAmountCap: (row) =>
          l1.client.readContract({
            address: row.portal,
            abi: OxidePortalAbi,
            functionName: "TX_AMOUNT_CAP",
          }),
        ...over,
      }),
    claim: (over: Partial<SipaClaimDeps> = {}) =>
      claimSipaDeposits({
        store,
        node: l2.node as never,
        recipient: RECIPIENT,
        tuple: TUPLE,
        rows,
        tokenServiceFor: async (l2Token) => l2.tokenService(l2Token),
        ...over,
      }),
    /** Scan, settle every message seen, then claim: one full pass. */
    async pass(over: { scan?: Partial<SipaScanDeps>; claim?: Partial<SipaClaimDeps> } = {}) {
      const scanned = await this.scan(over.scan)
      for (const r of await loadRecords(store.view))
        for (const s of r.pendingSweeps ?? []) l2.settle(s.messageKey)
      const claimed = await this.claim(over.claim)
      return { scanned, claimed }
    },
    get: (address: string) => store.get(address),
    records: () => loadRecords(store.view),
    cursor: async (portal: Address = PORTAL, recipient = RECIPIENT) => {
      const raw = await db.get(sipaCursorKey(portal, recipient.toString()))
      return raw === undefined ? undefined : BigInt(raw)
    },
  }
}

export type PipelineWorld = Awaited<ReturnType<typeof pipelineWorld>>
