// @vitest-environment node
/** A request's short link goes out as one sponsored announce, which the bell lists. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { WalletError } from "@obsidion/core/errors"
import { TxInFlightError } from "@obsidion/front-core"
import {
  bundledLinkLocator,
  bytesToBase64Url,
  claimFpcSponsoredFee,
  getHardcodedArtifact,
  LinkKind,
  linkAnnounceInteraction,
  loadClaimFpcPolicy,
  MAX_LINK_PAYLOAD_BYTES,
  randomLinkKey,
} from "@obsidion/sdk"
import type { OperationHandle } from "../../../src/features/operations/operations"
import type { ClaimSponsorDeps } from "../../../src/features/registration/claimSponsorship"
import { RAIL_REGISTERED } from "../../../src/features/registration/rails"
import {
  announceCode,
  codePayload,
  publishCode,
} from "../../../src/features/requests/shortRequestLink"
import { closeSession, type Session } from "../../../src/session/session"
import { requestAmountLabel } from "../../../src/ui/format"
import { operationEntry, operationRecord } from "../../support/operations"
import { openTestSession } from "../../support/session"
import { checksHolding } from "../../support/sponsors"
import { sendLikeTheWallet, type WalletSendOptions } from "../../support/submitBoundary"

const FPC = AztecAddress.fromStringUnsafe(`0x${"0a".repeat(32)}`)
const USER = AztecAddress.fromStringUnsafe(`0x${"0b".repeat(32)}`)
const TX = `0x${"0c".repeat(32)}`
const REQUEST = "0x0a1b"
const BY_ANY_ROOT = "0x132c3179e1b98a786a84be2824a607a50271804d108870905f64b3e80fb5e141"
const ZERO = `0x${"00".repeat(32)}`

/** The deployment's ClaimFPC with one open rail, gated by a NameClaim, and the bundled locator. */
const contractService = {
  ...bundledLinkLocator,
  getConfiguredClassId: () => undefined,
  getContractRecord: async () => ({
    address: FPC,
    meta: {
      policyManifest: {
        version: 2,
        depth: 6,
        rails: [
          {
            name: RAIL_REGISTERED,
            gate: "nameClaim",
            policy: {
              root: BY_ANY_ROOT,
              entries: [{ kind: 4, target: ZERO, selector: ZERO, maxFee: "20160000000000000000" }],
            },
          },
        ],
      },
    },
  }),
  getArtifactForContract: () => getHardcodedArtifact(DEFAULT_CONTRACTS.claimFpc),
}

const authProvider = { getPubkeys: async () => [Buffer.alloc(32, 1), Buffer.alloc(32, 2)] }
const auth = {
  accountRecord: async () => undefined,
  sessionKeys: async () => ({ secretKey: new Fr(123n), authProvider }),
}
const account = { getAddress: () => USER, getAuthProvider: () => authProvider }

/** A wallet whose PXE holds every contract; `send` stands for its `sendTx`. */
function fakeWallet(send: (options: WalletSendOptions) => Promise<void> = async () => {}) {
  const sent: { payload: { calls: { name: string }[] }; options: Record<string, unknown> }[] = []
  const wallet = {
    pxe: {
      getContractArtifact: async () => ({}),
      getContractInstance: async () => ({ originalContractClassId: Fr.ONE }),
    },
    node: { getTxReceipt: async () => Promise.reject(new Error("no receipt")) },
    registerSender: async () => {},
    sendTx: async (payload: never, options: WalletSendOptions & Record<string, unknown>) => {
      sent.push({ payload, options })
      await send(options)
    },
  }
  return { wallet, sent }
}

/** What the wallet asks of a send that lands; `land` stands for the node accepting it. */
const landing =
  (land: () => void = () => {}) =>
  (options: WalletSendOptions) =>
    sendLikeTheWallet(options, TX, land)

const subscriptionKey = `${USER.toString()}|${FPC.toString()}|0`
const bytes = Uint8Array.from([1, 2, 3])

let session: Session
const depsOver = (wallet: unknown) =>
  ({ session, wallet, account, contractService } as unknown as ClaimSponsorDeps)

const handle = (operationId = "op-1"): OperationHandle => ({
  operationId,
  describe: vi.fn(),
  transfer: vi.fn(async () => {}),
  sent: vi.fn(async () => {}),
  leaveToChain: vi.fn(),
})

/** The pinned tuple the request link's ENS name comes from. */
const primed = { tuple: { rollupVersion: "1", ensDomain: "zk.money" } as never }
afterEach(closeSession)

describe("codePayload", () => {
  const code = (fragment: string) => ({
    requestId: REQUEST,
    url: `https://x/pay#${fragment}`,
    amount: 0,
  })

  it("returns the fragment's bytes when they fit a link payload", () => {
    expect(codePayload(code(bytesToBase64Url(bytes)))).toEqual(bytes)
  })

  it("returns nothing for an empty fragment", () => {
    expect(codePayload(code(""))).toBeUndefined()
  })

  it("returns nothing for a fragment longer than a link payload", () => {
    const long = new Uint8Array(MAX_LINK_PAYLOAD_BYTES + 1)
    expect(codePayload(code(bytesToBase64Url(long)))).toBeUndefined()
  })
})

describe("announceCode", () => {
  beforeEach(() => {
    session = openTestSession({ auth, primed })
  })

  it("sends the announce on the rail's sponsor leg when the account holds a subscription", async () => {
    session.subscriptionChecks = checksHolding(true)
    const { wallet, sent } = fakeWallet()
    const op = handle()
    const key = randomLinkKey()
    await announceCode(depsOver(wallet), key, bytes, op)

    const { rail } = await loadClaimFpcPolicy(contractService as never, RAIL_REGISTERED)
    const announce = await linkAnnounceInteraction(
      wallet as never,
      contractService as never,
      LinkKind.Request,
      key,
      bytes,
    )
    const [{ payload, options }] = sent
    expect(payload.calls.map((call) => call.name)).toEqual(["sponsor"])
    expect(options).toEqual({
      from: NO_FROM,
      sendMessagesAs: USER,
      additionalScopes: [USER],
      fee: claimFpcSponsoredFee(rail.policy, (await announce.request()).calls),
      operationId: "op-1",
      onTxHash: op.sent,
    })
  })

  it("folds the subscribe into the tx when the account holds none, then reads it as held", async () => {
    session.subscriptionChecks = checksHolding(false)
    await session.nameClaims.put({
      address: USER.toString(),
      handle: "bo",
      nameHash: `0x${"0d".repeat(32)}`,
      signature: `0x${"0e".repeat(65)}`,
      nonce: "1",
      deadline: "2",
    })
    const { wallet, sent } = fakeWallet()
    await announceCode(depsOver(wallet), randomLinkKey(), bytes, handle())
    expect(sent.map(({ payload }) => payload.calls[0]!.name)).toEqual(["subscribe"])
    expect(
      await session.subscriptionChecks
        .held({ toString: () => subscriptionKey, read: async () => false })
        .read(),
    ).toBe(true)
  })

  it("throws TxInFlightError when a send that failed may still land", async () => {
    session.subscriptionChecks = checksHolding(true)
    const refused = new Error("node timeout")
    const { wallet } = fakeWallet(
      landing(() => {
        throw refused
      }),
    )
    const thrown = await announceCode(depsOver(wallet), randomLinkKey(), bytes, handle()).catch(
      (e: unknown) => e,
    )
    expect(thrown).toBeInstanceOf(TxInFlightError)
    expect(thrown).toMatchObject({ txHash: TX, cause: refused })
  })

  it("rethrows a send that failed before it went out", async () => {
    session.subscriptionChecks = checksHolding(true)
    const refused = new Error("rejected")
    const { wallet } = fakeWallet(() => Promise.reject(refused))
    await expect(announceCode(depsOver(wallet), randomLinkKey(), bytes, handle())).rejects.toBe(
      refused,
    )
  })
})

describe("publishCode", () => {
  beforeEach(() => {
    session = openTestSession({ auth, primed })
    session.subscriptionChecks = checksHolding(true)
  })

  const publishOf = (requestId: string) =>
    session.operations.view.get().records.find((r) => r.operationId.includes(`_${requestId}_`))!
  const latest = () => publishOf(REQUEST)

  it("runs one handed-off bell operation that opens the request once it lands", async () => {
    const { wallet, sent } = fakeWallet(landing())
    await publishCode(session, depsOver(wallet), REQUEST, randomLinkKey(), bytes, 0)
    expect(sent).toHaveLength(1)
    const record = latest()
    expect(record).toMatchObject({ state: "settled", txHash: TX })
    expect(record.handedOffAt).toBeDefined()
    expect(operationEntry(record)).toMatchObject({
      severity: "success",
      target: { type: "request.share", requestId: REQUEST },
    })
  })

  it("names the amount in the summary when the request has one", async () => {
    const publish = (requestId: string, amount: number) =>
      publishCode(
        session,
        depsOver(fakeWallet(landing()).wallet),
        requestId,
        randomLinkKey(),
        bytes,
        amount,
      )
    await publish("0x01", 0)
    await publish("0x02", 5)
    expect(publishOf("0x02").summary).toContain(requestAmountLabel(5))
    expect(publishOf("0x01").summary).not.toContain(requestAmountLabel(5))
  })

  it("rejects a failed publish, and the bell reports it on the request", async () => {
    const refused = new Error("rejected")
    const { wallet } = fakeWallet(() => Promise.reject(refused))
    await expect(
      publishCode(session, depsOver(wallet), REQUEST, randomLinkKey(), bytes, 0),
    ).rejects.toBe(refused)
    expect(operationEntry(latest())).toMatchObject({
      severity: "error",
      target: { type: "request.share", requestId: REQUEST },
    })
  })

  describe("a send that may still land", () => {
    const inFlight = async () => {
      const { wallet } = fakeWallet(
        landing(() => {
          throw new Error("node timeout")
        }),
      )
      const settled = vi.fn()
      const failed = vi.fn()
      const done = publishCode(session, depsOver(wallet), REQUEST, randomLinkKey(), bytes, 0).then(
        settled,
        failed,
      )
      await vi.waitFor(() => expect(latest().state).toBe("sent"))
      await Promise.resolve()
      return { done, settled, failed, id: latest().operationId }
    }

    it("resolves once the chain settles it", async () => {
      const { done, settled, failed, id } = await inFlight()
      expect(settled).not.toHaveBeenCalled()
      await session.operations.apply(id, { type: "settled", txHash: TX, at: Date.now() })
      await done
      expect(settled).toHaveBeenCalled()
      expect(failed).not.toHaveBeenCalled()
      expect(operationRecord(id)?.state).toBe("settled")
    })

    it("rejects once the chain fails it", async () => {
      const { done, settled, failed, id } = await inFlight()
      await session.operations.apply(id, { type: "failed", error: "reverted", at: Date.now() })
      await done
      expect(settled).not.toHaveBeenCalled()
      expect(failed).toHaveBeenCalledWith(new WalletError("tx.failed", "reverted"))
    })
  })
})
