import {
  RequestStorage,
  SIPADepositStore,
  TransactionStorage,
  isUnfundedSipaDeposit,
  payerAddedToContacts,
  randomCodeRequestId,
  payerForPaidLink,
  useAssetContext,
  useAztecContext,
  useContactsDirectory,
  useContractServiceContext,
} from "@obsidion/front-core"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isDemoMode } from "../../dev/demoFlag"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { getSipaDepositGateway } from "../deposit/sipaGateway"
import { useDepositWatch } from "../onboarding/useDepositWatch"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { createAndStoreRequestLink, requestLinkOrigin } from "../requests/requestLinkCreation"
import {
  CODE_ADDRESS_MAX_AGE_MS,
  clearCode,
  codeIsStale,
  currentCode,
  nextCode,
  openCode,
  receiveCodeKey,
  setCodeAmount,
  type CodeDeps,
  type CodeForm,
  type ReceiveCode,
} from "./receiveCode"

/** How often a failed or address-less code is retried. */
const POLL_MS = 10_000

export interface CodePayment {
  amount: number
  via: "private" | "ethereum"
  /** Who paid; an Ethereum payment names nobody. */
  payer?: string
  /** The payer is now a full contact. */
  added?: boolean
  /** The paid code held an address, so the next one holds a new one. */
  hadAddress: boolean
}

/** What a claimed deposit to the code's address credited; the request's own amount without one. */
async function sweptAmount(code: ReceiveCode, requested: number): Promise<number> {
  if (!code.address) return requested
  const store = SIPADepositStore.get(webStorage)
  await store.load()
  const credited = Number(store.get(code.address)?.amount)
  return credited > 0 ? credited : requested
}

/**
 * Receive's code and what paid it. Watches the address on Ethereum and the request id on private
 * transfers; a payment moves the code to the next ready address.
 */
export function useReceiveCode(enabled: boolean) {
  const identity = loadWalletIdentity()
  const tag = identity?.handle
  const { rollupAddress, obsidionWallet } = useAztecContext()
  const { contractService } = useContractServiceContext()
  const { tokenService } = useAssetContext()
  const [code, setCode] = useState<ReceiveCode>()
  const [payment, setPayment] = useState<CodePayment>()
  const [failed, setFailed] = useState(false)
  const contacts = useContactsDirectory()
  const directory = useRef(contacts)
  directory.current = contacts

  const walletDeps = useMemo((): CodeDeps | null => {
    if (!enabled || !tag || !rollupAddress || !obsidionWallet || !contractService || !tokenService)
      return null
    return {
      key: receiveCodeKey(rollupAddress, tag),
      readyAddress: () =>
        getSipaDepositGateway()
          .readyAddress(obsidionWallet, contractService, tag, CODE_ADDRESS_MAX_AGE_MS)
          .catch((err) => {
            console.warn("[receive] no ready address:", err)
            return null
          }),
      mint: async (args) => {
        const token = await tokenService.fetchTokenInformation()
        return createAndStoreRequestLink(
          {
            requestId: randomCodeRequestId(),
            compact: true,
            requesterTag: tag,
            requesterAddress: identity?.address,
            tokenAddress: token.address,
            tokenDecimals: token.decimals,
            tokenSymbol: token.symbol,
            networkId: rollupAddress,
            baseUrl: requestLinkOrigin(),
            ...args,
          },
          RequestStorage.get(),
        )
      },
      cancel: (requestId) => RequestStorage.get().applyStatus(requestId, "cancelled"),
      paid: async (code) => {
        const row = await RequestStorage.get().findById(code.requestId)
        if (row?.status === "fulfilled") return true
        if (!code.address) return false
        const store = SIPADepositStore.get(webStorage)
        await store.load()
        const record = store.get(code.address)
        return !!record && !isUnfundedSipaDeposit(record)
      },
    }
  }, [
    enabled,
    tag,
    rollupAddress,
    obsidionWallet,
    contractService,
    tokenService,
    identity?.address,
  ])
  // Dev demo has no wallet; a production build drops this body and the import with it.
  const [demoDeps, setDemoDeps] = useState<CodeDeps>()
  useEffect(() => {
    if (!import.meta.env.DEV || !isDemoMode() || !enabled || !tag) return
    void import("../../dev/demoReceiveCode").then(({ demoCodeDeps, demoPayment }) => {
      setDemoDeps(demoCodeDeps(tag))
      setPayment(demoPayment(location.search))
    })
  }, [enabled, tag])
  const deps = demoDeps ?? walletDeps

  // One write at a time: two mints would show one code and leave the other's request behind.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const run = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(task, task)
    queue.current = next.catch(() => {})
    return next
  }, [])

  const load = useCallback(
    (read: (deps: CodeDeps) => Promise<ReceiveCode>) => {
      if (!deps) return
      void run(() => read(deps))
        .then((c) => {
          setFailed(false)
          setCode(c)
        })
        .catch((err) => {
          console.warn("[receive] code not minted:", err)
          setFailed(true)
        })
    },
    [deps, run],
  )
  const refresh = useCallback(() => load(currentCode), [load])

  // Each visit opens on a plain code, retried while it cannot be made.
  useEffect(() => load(openCode), [load])
  useEffect(() => {
    if (!failed || code) return
    const timer = setTimeout(() => load(openCode), POLL_MS)
    return () => clearTimeout(timer)
  }, [failed, code, load])

  // A paid code never shows again: it is dropped at once and its replacement retried until minted.
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(retry.current), [])
  const paid = useCallback(
    (paidCode: ReceiveCode, found: Omit<CodePayment, "hadAddress">) => {
      if (!deps) return
      setPayment({ ...found, hadAddress: !!paidCode.address })
      setCode(undefined)
      const replace = () =>
        void run(() => nextCode(deps, paidCode))
          .then(setCode)
          .catch((err) => {
            console.warn("[receive] next code not minted, retrying:", err)
            retry.current = setTimeout(replace, POLL_MS)
          })
      replace()
    },
    [deps, run],
  )

  // Ethereum: the rail's record of the address. A funded record is the payment.
  const demo = import.meta.env.DEV && isDemoMode()
  const watched = useDepositWatch(code?.address && !payment && !demo ? code.address : null)
  const { record } = watched
  useEffect(() => {
    if (code?.address && record && !isUnfundedSipaDeposit(record))
      paid(code, { via: "ethereum", amount: Number(record.amount) })
  }, [code, record, paid])

  // A code waiting for an address takes one when ready, and a stale one is replaced.
  useEffect(() => {
    if (!code || payment || demo) return
    const timer = setInterval(() => {
      if (!code.address || codeIsStale(code, Date.now())) refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [code, payment, demo, refresh])

  // Private: the fulfillment reconciler marks the code's request paid.
  useEffect(() => {
    if (!code || payment) return
    const store = RequestStorage.get()
    let done = false
    const check = async () => {
      const row = await store.findById(code.requestId)
      if (done || row?.status !== "fulfilled") return
      done = true
      const hash = row.fulfillmentTxHash?.toLowerCase()
      const receives = await TransactionStorage.get(webStorage).findReceivesByRequestId(
        code.requestId,
      )
      const tx = receives.find((r) => r.txHash?.toLowerCase() === hash)
      if (!tx) return paid(code, { via: "ethereum", amount: await sweptAmount(code, row.amount) })
      const payer = payerForPaidLink(row, receives, directory.current)
      paid(code, {
        via: "private",
        amount: tx.token.amount * (tx.token.price || 1),
        payer: payer?.displayName,
        added: payerAddedToContacts(payer),
      })
    }
    const onChange = () =>
      void check().catch((err) => console.warn("[receive] payment read failed:", err))
    onChange()
    const unsubscribe = store.subscribe(onChange)
    return () => {
      done = true
      unsubscribe()
    }
  }, [code, payment, paid])

  const setAmount = useCallback(
    async (form: CodeForm) => {
      if (!deps) throw new Error("wallet not ready")
      setCode(await run(() => setCodeAmount(deps, form)))
    },
    [deps, run],
  )
  const clearAmount = useCallback(async () => {
    if (!deps) return
    setCode(await run(() => clearCode(deps)))
  }, [deps, run])

  return {
    tag,
    code,
    payment,
    failed,
    ready: !!deps,
    setAmount,
    clearAmount,
    showCode: () => setPayment(undefined),
  }
}
