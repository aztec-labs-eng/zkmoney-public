import * as actual from "../../../src/features/paylink/sponsoredPaylink"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { decodePaylinkInline, encodePaylinkInline } from "@obsidion/sdk"
import { linkIdFor, linkedActivity, operationRows, valueOf, type PaylinkTransaction } from "@obsidion/front-core"
import { ROLLUP, TOKEN_INFO, field } from "./data"
import { formatUnits, parseUnits } from "viem"
import { demoClaimFragments, demoEscrowAmount, demoFundingTxHash } from "../../../src/dev/demoFixtures"
import type { OperationHandle } from "../../../src/features/operations/operations"
import { captureSession, fixtureState, inOperation, operation, pause } from "./control"

/** The deps' payer: its override, else the session's account. */
const signerOf = (deps: actual.SponsoredPaylinkDeps) => (deps.account ?? valueOf(deps.session.account!))!
export * from "../../../src/features/paylink/sponsoredPaylink"

let fixtureSequence = 0

/** Distinct synthetic identities even after a retry, fixed clock, or page reload. */
async function fixtureIdentity(kind: "paylink-create" | "paylink-claim", fundingHash?: string) {
  const { transfers, operations } = captureSession()
  const rows = [...(await transfers.all()), ...operations.view.get().records]
  const base = kind === "paylink-create" ? 0x78410000n : 0x78420000n
  for (;;) {
    const sequence = ++fixtureSequence
    const id = `capture-${kind}-${sequence}`
    const txHash = `0x${(base + BigInt(sequence)).toString(16).padStart(64, "0")}`
    if (txHash === fundingHash || rows.some((row) => row.operationId === id || row.txHash === txHash)) continue
    return { id, txHash }
  }
}

/** Read-only browser assertions over rows written by this capture adapter. */
export async function capturePaylinkRows() {
  if (!fixtureState()) throw new Error("Capture paylink inspection requires an active flow fixture")
  const { transfers, paylinks, operations } = captureSession()
  const rows = [...(await linkedActivity(transfers, paylinks, operations)), ...operationRows(operations.view.get()).records]
  return rows.filter((row) => row.operationId?.startsWith("capture-")).map((tx) => {
    const row = tx as PaylinkTransaction
    return { operationId: row.operationId, kind: row.kind, status: row.status, txHash: row.txHash, amount: row.token?.amount, paylink: row.paylink, secret: row.payToEmailSecret }
  })
}

export const voucherAvailable: typeof actual.voucherAvailable = async (deps) => {
  if (!fixtureState()) return actual.voucherAvailable(deps)
  await pause(300)
  return fixtureState() !== "no-voucher"
}
export const createSponsoredLink: typeof actual.createSponsoredLink = (...args) =>
  fixtureState()
    ? inOperation(
        args[0].session,
        "paylink-create",
        `$${args[1]} paylink`,
        (op) => fakeCreate(op, ...args),
        (link) => link.txHash,
      )
    : actual.createSponsoredLink(...args)
const fakeCreate = async (
  op: OperationHandle,
  ...args: Parameters<typeof actual.createSponsoredLink>
) => {
  const [deps, amount, onStage, opts] = args
  onStage?.("building")
  const fragments = demoClaimFragments()
  const fragment = opts?.email ? fragments.email : fragments.direct
  const params = decodePaylinkInline(fragment)
  const { txHash } = await fixtureIdentity("paylink-create", demoFundingTxHash(fragment))
  // Synthetic fields for rendering; no escrow or funding transaction is created.
  const prepared = { ...params, secret: Fr.fromString(txHash) }
  const link = {
    ...actual.decodeLink(deps.session.page.config, encodePaylinkInline(prepared)),
    amount,
    email: opts?.email,
    memo: opts?.memo,
  }
  const now = Math.floor(Date.now() / 1000)
  const untilClaimable = now + (opts?.expiryDays ?? 30) * 86_400
  const draft = {
    timestamp: Date.now(), operationId: op.operationId, networkId: ROLLUP, flavor: link.flavor, kind: "paylink-create" as const,
    to: opts?.email, token: { ...TOKEN_INFO, amount: Number(amount), price: 1, logo: "" },
    amountAtomic: parseUnits(amount, TOKEN_INFO.decimals),
    obsidionAccountAddress: signerOf(deps).getAddress().toString(), tokenAddress: TOKEN_INFO.address,
    memo: opts?.memo,
  }
  await operation("paylink-create", onStage, true, {
    operationId: op.operationId,
    txHash,
    onPrepared: async () => {
      await actual.savePreparedLink(deps.session, draft, {
        payToEmailSecret: prepared.secret.toString(),
        paylink: link.url, fallbackSecret: field("1d"), fromClaimable: now + 300,
        untilClaimable, refundableUntil: untilClaimable,
      })
      opts?.onLink?.(link)
    },
    onTxHash: actual.saveLinkTxHash(deps.session, op.operationId),
  })
  const settledLink = { ...link, txHash }
  await actual.fundLink(deps.session, op.operationId, settledLink.url)
  return settledLink
}
export const claimSponsoredLink: typeof actual.claimSponsoredLink = (...args) =>
  fixtureState()
    ? inOperation(
        args[0].session,
        "paylink-claim",
        "Paylink",
        (op) => fakeClaim(op, ...args),
        (txHash) => txHash,
      )
    : actual.claimSponsoredLink(...args)
async function fakeClaim(op: OperationHandle, ...args: Parameters<typeof actual.claimSponsoredLink>) {
  const [deps, fragment, onStage, zkProof] = args
  onStage?.("building")
  const params = decodePaylinkInline(fragment)
  const link = actual.decodeLink(deps.session.page.config, fragment)
  if (link.flavor === "email" && !zkProof)
    throw new Error("This link is locked to an email — sign in first to prove ownership")
  const { txHash } = await fixtureIdentity("paylink-claim", demoFundingTxHash(fragment))
  // Capture has no PXE note; this fragment is ours, so its amount is the demo escrow.
  const amount = demoEscrowAmount(fragment)
  await op.transfer({ kind: "paylink-claim", payload: {
    networkId: ROLLUP, flavor: link.flavor, linkId: linkIdFor(params), amountAtomic: amount.toString(),
    token: { ...TOKEN_INFO, amount: Number(formatUnits(amount, TOKEN_INFO.decimals)), price: 1, logo: "" },
  } })
  await operation("paylink-claim", onStage, true, { operationId: op.operationId, txHash, onTxHash: op.sent })
  await actual.markLinkClaimed(deps.session, params, signerOf(deps).getAddress().toString())
  return txHash
}
export const recoverSponsoredLink: typeof actual.recoverSponsoredLink = (...args) =>
  fixtureState()
    ? inOperation(
        args[0].session,
        "paylink-reclaim",
        "Paylink",
        () => fakeRecover(...args),
        (txHash) => txHash,
      )
    : actual.recoverSponsoredLink(...args)
const fakeRecover: typeof actual.recoverSponsoredLink = async (...args) => {
  const [, , onStage] = args
  onStage?.("building")
  const refundHash = field("5c")
  await operation("paylink-recover", onStage, true, { txHash: refundHash })
  const params = decodePaylinkInline(args[1])
  await actual.markLinkRefunded(args[0].session, params, signerOf(args[0]).getAddress().toString(), refundHash, "cancel")
  return refundHash
}
export const viewLink: typeof actual.viewLink = async (...args) => {
  if (!fixtureState()) return actual.viewLink(...args)
  if (fixtureState() === "loading") await new Promise<void>(() => {})
  await pause()
  const [deps, fragment] = args
  return {
    ...actual.decodeLink(deps.session.page.config, fragment),
    amount: formatUnits(demoEscrowAmount(fragment), TOKEN_INFO.decimals),
    status: fixtureState() === "claimed" ? "claimed" : "unclaimed",
    memo: "Dinner and groceries for the weekend, including the train tickets home.",
  }
}
