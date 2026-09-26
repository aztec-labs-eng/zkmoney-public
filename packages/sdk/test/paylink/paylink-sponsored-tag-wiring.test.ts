/**
 * Tag-sender wiring guard for the ClaimFPC-sponsored paylink paths.
 *
 * The sponsored create keeps the creator as the tx-level tag sender, because that tx also emits the
 * creator's own notes — the funding change note and the refreshed ClaimFPC `SubscriptionNote` —
 * and those must stay discoverable after a reload, when the escrow is no longer one of the PXE's
 * accounts. (An escrow-tagged `SubscriptionNote` reads as "unsubscribed", and the wallet answers
 * that by replaying the one-per-account subscribe nullifier: every later sponsored tx then dies on
 * a nullifier collision.)
 *
 * What that costs is the escrow's own token note, which the oxide token also delivers under the
 * tx-level sender: a claimer's PXE scans `getSenders() ∪ keyStore.getAccounts()` and never holds
 * the creator, so it reads a zero escrow balance and the claim reverts inside the token with
 * "Balance too low". The create therefore returns `escrowTagSecret` — the ECDH point behind that
 * tag — for the link to carry, and every claim path registers it as an `arbitrary-secret` source.
 * `direct/escrow-tag-secret.sandbox.test.ts` proves that unlocks the note on a real token; this file pins
 * the wiring that produces and consumes it.
 *
 * Everything before dispatch (key derivation, authwit, the ClaimFPC batch and its TEE signing) is
 * stubbed — only the dispatch options and the tag-secret plumbing are under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Fr } from "@aztec/aztec.js/fields"
import { NO_FROM } from "@aztec/aztec.js/account"
import { EthAddress } from "@aztec/aztec.js/addresses"
import { getUserPayloadHash } from "@oxide/oxide-lib/content_hash.js"

const INSTANCE_ADDR = AztecAddress.fromBigIntUnsafe(33n)
const USER_ADDR = AztecAddress.fromBigIntUnsafe(11n)
const TOKEN_ADDR = AztecAddress.fromBigIntUnsafe(44n)
const FPC_ADDR = AztecAddress.fromBigIntUnsafe(55n)

const { depositSpy, claimSpy, claimToL1Spy, releaseSpy, syncNoteSpy, TAG_SECRET, FBPK, CLASS_ID } =
  vi.hoisted(() => ({
    depositSpy: vi.fn(() => ({ __fake: "depositInteraction" })),
    releaseSpy: vi.fn(() => ({ __fake: "releaseBroadcast" })),
    claimSpy: vi.fn(() => ({ __fake: "claimInteraction" })),
    claimToL1Spy: vi.fn(() => ({ __fake: "claimToL1Interaction" })),
    // A 3-token escrow note: `data` packs the amount in its top 16 bytes.
    syncNoteSpy: vi.fn(() => ({
      simulate: async () => ({
        result: {
          hash: 0n,
          sender_hash: 0n,
          data: 3_000_000_000_000_000_000n << 128n,
          refundable_until: 0n,
          oidc_key_registry: 0n,
          vkey_hash: 0n,
          token_address: 44n,
        },
      }),
    })),
    TAG_SECRET: { __fake: "escrowTagSecret" },
    FBPK: { __fake: "fallbackKeyHash" },
    CLASS_ID: { __fake: "classId", equals: (o: unknown) => o === CLASS_ID },
  }))

// The deployment's broadcaster: registration is a PXE write, and the release rides the smallest tier.
vi.mock("@obsidion/contracts", async (importActual) => ({
  ...(await importActual<typeof import("@obsidion/contracts")>()),
  ensureContractRegisteredInPXE: vi.fn(async () => undefined),
  BroadcasterContract: {
    at: vi.fn(() => ({ methods: { broadcast_l1_operation_2k: releaseSpy } })),
  },
}))

// The escrow contract handle: `deposit` on create, `claim` on claim.
vi.mock("@aztec/aztec.js/contracts", async (importActual) => {
  const actual = await importActual<typeof import("@aztec/aztec.js/contracts")>()
  return {
    ...actual,
    Contract: {
      ...(actual.Contract as object),
      at: vi.fn(() => ({
        address: INSTANCE_ADDR,
        methods: {
          deposit: depositSpy,
          claim: claimSpy,
          claim_to_l1: claimToL1Spy,
          sync_note: syncNoteSpy,
        },
      })),
    },
  }
})

// Counterfactual address derivation — a fake instance stands in for the real
// class-id/public-keys computation.
vi.mock("@aztec/stdlib/contract", async (importActual) => {
  const actual = await importActual<typeof import("@aztec/stdlib/contract")>()
  return {
    ...actual,
    getContractInstanceFromInstantiationParams: vi.fn(async () => ({
      address: INSTANCE_ADDR,
      initializationHash: Fr.ZERO,
      currentContractClassId: CLASS_ID,
      publicKeys: { __fake: "publicKeys" },
    })),
  }
})

vi.mock("../../src/services/paylink/paylinkKeys.js", () => ({
  registerPaylinkContractWithKeys: vi.fn(async () => undefined),
  derivePaylinkKeys: vi.fn(async () => paylinkKeyMaterial()),
  deriveDeterministicPaylinkKeys: vi.fn(async () => paylinkKeyMaterial()),
  computeEscrowTagSecret: vi.fn(async () => TAG_SECRET),
  registerEscrowTagSecret: vi.fn(async () => undefined),
}))

// The funding tx, located from the escrow's init nullifier; a claim anchors its spend on it.
vi.mock("../../src/services/paylink/paylinkRecovery.js", () => ({
  findEscrowDepositTx: vi.fn(async () => ({ txHash: { __fake: "depositTx" }, l2BlockNumber: 3 })),
}))

vi.mock("../../src/services/claimSponsor.js", () => ({
  chainInfoFields: vi.fn(async () => ({ chainId: new Fr(31337n), version: new Fr(1n) })),
  linkChainInfo: vi.fn(async () => ({ chainId: 31337, rollupVersion: 1 })),
  contractClassWitness: vi.fn(async () => ({ __fake: "classWitness" })),
  registerSponsorFpc: vi.fn(async () => ({ __fake: "fpcArtifact" })),
  authorizeSponsoredBatch: vi.fn(async () => ({
    accountCall: { __fake: "accountCall" },
    intentHashes: [],
    combinedAuthWitness: { __fake: "authWitness" },
  })),
}))

vi.mock("../../src/services/sponsoredTeeOperation.js", () => ({
  buildSponsoredTeeOperation: vi.fn(async () => ({
    payload: { __fake: "payload" },
    sendOpts: {
      additionalScopes: [INSTANCE_ADDR],
      finalize: { __fake: "finalize" },
      fee: { __fake: "fee" },
    },
  })),
}))

vi.mock("../../src/feePaymentMethod/sponsoredCall.js", () => ({
  computeIntentsOnlyAuthWitHash: vi.fn(async () => Fr.ZERO),
}))

vi.mock("@aztec/aztec.js/authorization", () => ({
  computeAuthWitMessageHash: vi.fn(async () => Fr.fromString("0xa11ce")),
}))

import { PaylinkService } from "../../src/services/PaylinkService.js"
import { ObsidionAccount } from "../../src/obsidion/alpha/account/ObsidionAccount.js"
import {
  computeEscrowTagSecret,
  registerEscrowTagSecret,
} from "../../src/services/paylink/paylinkKeys.js"
import { DEFAULT_CONTRACTS } from "@obsidion/contracts"
import { buildSponsoredTeeOperation } from "../../src/services/sponsoredTeeOperation.js"
import { plainUserPayload, type WithdrawalOptions } from "../../src/services/plainWithdrawal.js"

function paylinkKeyMaterial() {
  return {
    publicKeys: { __fake: "publicKeys" },
    secretKey: Fr.fromString("0x77"),
    fallbackSecret: Fr.fromString("0x88"),
    fallbackKeyHash: FBPK,
  }
}

/**
 * `asObsidionAccount()` gates the sponsored paths on a real `instanceof`, so the
 * stub is built on the prototype rather than as a plain object.
 */
function makeAccount() {
  const account = Object.create(ObsidionAccount.prototype) as ObsidionAccount
  return Object.assign(account, {
    getAddress: () => USER_ADDR,
    getAuthProvider: () => ({ createAuthWit: vi.fn(async () => ({ __fake: "authwit" })) }),
    makeSpendMetadataResolver: vi.fn(async () => async () => ({} as never)),
    makeDepositSpendMetadataResolver: vi.fn(async () => async () => ({} as never)),
  })
}

function makeService() {
  const sendTx = vi.fn(async (_payload: unknown, _opts: unknown) => ({
    receipt: { txHash: { toString: () => "0xabc" }, blockNumber: 7 },
  }))
  const wallet: any = { node: {}, sendTx, registerSender: vi.fn(async () => undefined) }
  const tokenService: any = {
    tokenAddress: TOKEN_ADDR,
    getTokenContract: vi.fn(async () => ({
      address: TOKEN_ADDR,
      methods: { transfer: vi.fn(() => ({ __fake: "transferInteraction" })) },
    })),
  }
  const service = new PaylinkService(
    wallet,
    makeAccount(),
    tokenService,
    {
      getArtifactForContract: vi.fn(async () => ({ __fake: "artifact" })),
      getArtifactForInstance: vi.fn(async () => ({ __fake: "broadcasterArtifact" })),
      getConfiguredClassId: vi.fn(() => undefined),
    } as any,
    undefined,
    { __fake: "teeSigner" } as any,
  )
  // Nonce-slot scan is a node read; the key material it lands on is what matters here.
  ;(service as any).deriveDepositKeys = vi.fn(async () => paylinkKeyMaterial())
  // The payout meta read is a PXE event query; the claim wiring is what is under test.
  ;(service as any).payoutMeta = vi.fn(async () => [])
  return { service, sendTx }
}

const sponsor = {
  railId: 0,
  fpcAddress: FPC_ADDR,
  fpcArtifact: { __fake: "fpcArtifact" } as any,
  policy: { __fake: "policy" } as any,
}

const linkParams = {
  secret: Fr.fromString("0x77"),
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  classId: CLASS_ID as any,
  chainId: 31337,
  fallbackKeyHash: FBPK as any,
  rollupVersion: 1,
  escrowTagSecret: TAG_SECRET as any,
}

const EXECUTOR = EthAddress.fromString(`0x${"33".repeat(20)}`)
const withdrawal: WithdrawalOptions = {
  tuple: {
    portal: `0x${"11".repeat(20)}`,
    token: `0x${"22".repeat(20)}`,
    l2Token: TOKEN_ADDR.toString(),
    plainWithdrawalExecutor: EXECUTOR.toString(),
    l2Broadcaster: AztecAddress.fromBigIntUnsafe(66n).toString(),
  },
  portal: { fpcFundingCut: 0n, frozen: false },
}

describe("sponsored paylink dispatch — tag sender", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("createSponsoredPaylink tags from the creator and hands the escrow tag secret to the link", async () => {
    const { service, sendTx } = makeService()

    // The web wallet encodes this into a link before the tx lands, so it must already be complete.
    let prepared: Awaited<ReturnType<typeof service.createSponsoredPaylink>> | undefined
    const params = await service.createSponsoredPaylink(
      {
        amount: 3_000_000_000_000_000_000n,
        token: TOKEN_ADDR,
        window: {
          fromClaimable: 0n,
          untilClaimable: 86_400n,
          refundableUntil: 0n,
        },
        masterSecret: Fr.fromString("0x99"),
      },
      sponsor,
      {
        operationId: "op-123",
        onPrepared: (p) => {
          prepared = p as typeof prepared
        },
      },
    )

    expect(sendTx).toHaveBeenCalledTimes(1)
    const opts = sendTx.mock.calls[0]![1] as any
    expect(opts.sendMessagesAs).toBe(USER_ADDR)
    expect(opts.from).toBe(NO_FROM)
    expect(opts.additionalScopes).toEqual([USER_ADDR, INSTANCE_ADDR])
    expect(opts.kind).toBe("paylink-create")
    expect(opts.operationId).toBe("op-123")
    expect(depositSpy).toHaveBeenCalledTimes(1)

    // Without this the escrow note is findable in the creator's PXE and nowhere else.
    expect(computeEscrowTagSecret).toHaveBeenCalledWith(
      expect.objectContaining({ creator: USER_ADDR }),
    )
    expect(params.escrowTagSecret).toBe(TAG_SECRET)

    // The link is complete before the passkey: class, chain and tag point all known up front.
    expect(prepared?.classId).toBe(CLASS_ID)
    expect(prepared?.chainId).toBe(31337)
    expect(prepared?.fallbackKeyHash).toBe(FBPK)
    expect(params.classId).toBe(CLASS_ID)
    expect(params.chainId).toBe(31337)
    // The creator keeps the migration factor; the link gets its point only.
    expect(params.fallbackSecret).toEqual(Fr.fromString("0x88"))
  })

  it("claimSponsoredPaylink refuses a link made against another class or chain", async () => {
    const { service, sendTx } = makeService()
    await expect(
      service.claimSponsoredPaylink(
        { ...linkParams, classId: { __fake: "other" } as any },
        sponsor,
      ),
    ).rejects.toThrow(/another version/)
    await expect(
      service.claimSponsoredPaylink({ ...linkParams, chainId: 1 }, sponsor),
    ).rejects.toThrow(/different network/)
    expect(sendTx).not.toHaveBeenCalled()
  })

  it("claimSponsoredPaylink tags the payout from the claimer and registers the link's tag secret", async () => {
    const { service, sendTx } = makeService()

    await service.claimSponsoredPaylink(linkParams, sponsor)

    expect(sendTx).toHaveBeenCalledTimes(1)
    const opts = sendTx.mock.calls[0]![1] as any
    expect(opts.sendMessagesAs).toBe(USER_ADDR)
    expect(opts.additionalScopes).toEqual([USER_ADDR, INSTANCE_ADDR])
    expect(opts.kind).toBe("paylink-claim")
    expect(claimSpy).toHaveBeenCalledTimes(1)
    expect(registerEscrowTagSecret).toHaveBeenCalledWith({
      wallet: expect.anything(),
      escrow: INSTANCE_ADDR,
      secret: TAG_SECRET,
    })
  })

  it("claimSponsoredPaylinkToL1 burns the escrow to the L1 recipient through the same sponsored rail", async () => {
    const { service, sendTx } = makeService()
    const l1Recipient = EthAddress.fromString("0x1111111111111111111111111111111111111111")

    const result = await service.claimSponsoredPaylinkToL1(
      linkParams,
      l1Recipient,
      { proverTip: 5n, withdrawal },
      sponsor,
      { operationId: "op-l1" },
    )

    expect(result).toEqual({ txHash: "0xabc", blockNumber: 7 })
    expect(claimToL1Spy).toHaveBeenCalledWith(
      EXECUTOR,
      getUserPayloadHash(plainUserPayload(l1Recipient)),
      5n,
    )
    expect(claimSpy).not.toHaveBeenCalled()
    const args = vi.mocked(buildSponsoredTeeOperation).mock.calls[0]![1]
    expect(args.teeUnsignedInteractions).toEqual([{ __fake: "releaseBroadcast" }])
    const opts = sendTx.mock.calls[0]![1] as any
    expect(opts.sendMessagesAs).toBe(USER_ADDR)
    expect(opts.additionalScopes).toEqual([USER_ADDR, INSTANCE_ADDR])
    expect(opts.kind).toBe("paylink-claim")
    expect(opts.operationId).toBe("op-l1")
    expect(registerEscrowTagSecret).toHaveBeenCalledWith(
      expect.objectContaining({ escrow: INSTANCE_ADDR, secret: TAG_SECRET }),
    )
  })

  it("claimSponsoredPaylinkToL1 requires a proof for an email link", async () => {
    const { service, sendTx } = makeService()
    await expect(
      service.claimSponsoredPaylinkToL1(
        { ...linkParams, paylinkType: DEFAULT_CONTRACTS.paylinkEmail },
        EthAddress.fromString("0x1111111111111111111111111111111111111111"),
        { proverTip: 0n, withdrawal },
        sponsor,
      ),
    ).rejects.toThrow(/zkProof/)
    expect(sendTx).not.toHaveBeenCalled()
  })

  it("claimSponsoredPaylink registers nothing for a link with no tag secret", async () => {
    const { service } = makeService()

    await service.claimSponsoredPaylink({ ...linkParams, escrowTagSecret: undefined }, sponsor)

    expect(registerEscrowTagSecret).not.toHaveBeenCalled()
  })
})
