import {
  loadRecords,
  receivesForRequest,
  isUnfundedSipaDeposit,
  payerAddedToContacts,
  randomCodeRequestId,
  payerForPaidLink,
  type ContactRow,
  type ReceiveCode,
  useStore,
  NO_SERVICE,
  serviceStatus,
} from "@obsidion/front-core"
import { useContactDirectory } from "../../session/contacts"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { isDemoMode } from "../../dev/demoFlag"
import { useSession, type Session } from "../../session/session"
import { useDepositWatch } from "../sipa/useDepositWatch"
import { createAndStoreRequestLink, requestLinkOrigin } from "../requests/requestLinkCreation"
import {
  CODE_ADDRESS_MAX_AGE_MS,
  clearCode,
  codeIsStale,
  currentCode,
  nextCode,
  openCode,
  receiveCodeId,
  setCodeAmount,
  type CodeDeps,
  type CodeForm,
} from "./receiveCode"

/** How often a failed or address-less code is retried. */
const POLL_MS = 10_000

export interface CodePayment {
  amount: number
  via: "private" | "ethereum"
  /** Who paid; an Ethereum payment names nobody. */
  payer?: string
  /** The payer is a full contact. */
  added?: boolean
  /** The paid code held an address, so the next one holds a new one. */
  hadAddress: boolean
}

/** A payment as saved: `added` is read from the payer's contact as it changes. */
type PaidCode = Omit<CodePayment, "added"> & { payerId?: string }

/**
 * Calls `onPaid` once, when the code's request reads paid: by a receive carrying its id, else by a
 * deposit to its address. A failed read leaves it to the next update. Returns the stop.
 */
export function watchRequestPayment(
  code: ReceiveCode,
  deps: {
    session: Pick<Session, "requests" | "transfers" | "sipaDeposits">
    contacts: () => readonly ContactRow[]
    onPaid: (found: Omit<PaidCode, "hadAddress">) => void
  },
): () => void {
  const { requests, transfers, sipaDeposits } = deps.session
  /** What a claimed deposit to the code's address credited; the request's own amount without one. */
  const sweptAmount = async (requested: number) => {
    if (!code.address) return requested
    const credited = Number((await sipaDeposits.get(code.address))?.amount)
    return credited > 0 ? credited : requested
  }
  let done = false
  // One read at a time; a failed one lets the next update try again.
  let reading = false
  const check = async () => {
    const row = requests.view.get().find((r) => r.id === code.requestId)
    if (done || reading || row?.status !== "fulfilled") return
    reading = true
    try {
      const hash = row.fulfillmentTxHash?.toLowerCase()
      const paying = await loadRecords(transfers.where("request", code.requestId.toLowerCase()))
      const receives = receivesForRequest(paying, code.requestId)
      const tx = receives.find((r) => r.txHash?.toLowerCase() === hash)
      if (!tx) {
        const amount = await sweptAmount(row.amount)
        if (done) return
        done = true
        return deps.onPaid({ via: "ethereum", amount })
      }
      if (done) return
      done = true
      const payer = payerForPaidLink(row, receives, deps.contacts())
      deps.onPaid({
        via: "private",
        amount: tx.token.amount * (tx.token.price || 1),
        payer: payer?.displayName,
        payerId: payer?.contact?.id,
      })
    } finally {
      reading = false
    }
  }
  const onChange = () =>
    void check().catch((err) => console.warn("[receive] payment read failed:", err))
  onChange()
  const unsubscribe = requests.view.subscribe(onChange)
  return () => {
    done = true
    unsubscribe()
  }
}

/**
 * Receive's code and what paid it. Watches the address on Ethereum and the request id on private
 * transfers; a payment moves the code to the next ready address.
 */
export function useReceiveCode(enabled: boolean) {
  const identity = useStore(useSession().identity).value
  const tag = identity?.handle
  const session = useSession()
  const rollupAddress = useStore(session.page.networkId)
  const { requests, sipaDeposits, sipaAddresses, receiveCodes, token } = session
  const contracts = useStore(session.contractService, serviceStatus)
  const tokenStatus = useStore(token ?? NO_SERVICE, serviceStatus)
  const built = contracts === "ready" && tokenStatus === "ready"
  /** The code this visit resolved, as committed; a saved code shows only once it is resolved. */
  const [code, setCode] = useState<ReceiveCode>()
  const [paidWith, setPayment] = useState<PaidCode>()
  const [failed, setFailed] = useState(false)
  const contacts = useContactDirectory()
  const directory = useRef(contacts)
  directory.current = contacts

  // Approval can land after the receipt shows, so `added` follows the contacts.
  const payerContact = contacts.contacts.find((c) => c.id === paidWith?.payerId)
  const payment = useMemo((): CodePayment | undefined => {
    if (!paidWith) return undefined
    const { payerId: _, ...shown } = paidWith
    return { ...shown, added: payerAddedToContacts(payerContact) }
  }, [paidWith, payerContact])

  const walletDeps = useMemo((): CodeDeps | null => {
    if (!enabled || !tag || !rollupAddress || !built || !token || !sipaAddresses || !receiveCodes)
      return null
    return {
      codes: receiveCodes,
      id: receiveCodeId(rollupAddress, tag),
      requester: identity?.address,
      readyAddress: () =>
        sipaAddresses.readyAddress(CODE_ADDRESS_MAX_AGE_MS).catch((err) => {
          console.warn("[receive] no ready address:", err)
          return null
        }),
      mint: async (args) => {
        const info = await (await token.ready()).fetchTokenInformation()
        return createAndStoreRequestLink(
          {
            requestId: randomCodeRequestId(),
            compact: true,
            requesterTag: tag,
            requesterAddress: identity?.address,
            tokenAddress: info.address,
            tokenDecimals: info.decimals,
            tokenSymbol: info.symbol,
            networkId: rollupAddress,
            baseUrl: requestLinkOrigin(session.network),
            ...args,
          },
          requests,
          async (sipa) => (await sipaDeposits.get(sipa))?.origin,
        )
      },
      cancel: (requestId) => requests.cancel(requestId),
      paid: async (code) => {
        const saved = (await requests.all()).find((r) => r.id === code.requestId)
        if (saved?.status === "fulfilled") return true
        if (!code.address) return false
        const record = await sipaDeposits.get(code.address)
        return !!record && !isUnfundedSipaDeposit(record)
      },
    }
  }, [
    enabled,
    tag,
    rollupAddress,
    built,
    token,
    identity?.address,
    requests,
    sipaDeposits,
    sipaAddresses,
    receiveCodes,
  ])
  // Dev demo has no wallet; a production build drops this body and the import with it.
  const [demoDeps, setDemoDeps] = useState<CodeDeps>()
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!import.meta.env.DEV || !isDemoMode() || !enabled || !tag || !receiveCodes) return
    void import("../../dev/demoReceiveCode").then(({ demoCodeDeps, demoPayment }) => {
      setDemoDeps(demoCodeDeps(tag, receiveCodes))
      setPayment(demoPayment(location.search))
    })
  }, [enabled, tag, receiveCodes])
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
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => load(openCode), [load])
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!failed || code) return
    // eslint-disable-next-line local/timer-in-view -- debt
    const timer = setTimeout(() => load(openCode), POLL_MS)
    return () => clearTimeout(timer)
  }, [failed, code, load])

  // A paid code never shows again: it is dropped at once and its replacement retried until minted.
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => () => clearTimeout(retry.current), [])
  const paid = useCallback(
    (paidCode: ReceiveCode, found: Omit<PaidCode, "hadAddress">) => {
      if (!deps) return
      setPayment({ ...found, hadAddress: !!paidCode.address })
      setCode(undefined)
      const replace = () =>
        void run(() => nextCode(deps, paidCode))
          .then(setCode)
          .catch((err) => {
            console.warn("[receive] next code not minted, retrying:", err)
            // eslint-disable-next-line local/timer-in-view -- debt
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
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (code?.address && record && !isUnfundedSipaDeposit(record))
      paid(code, { via: "ethereum", amount: Number(record.amount) })
  }, [code, record, paid])

  // A code waiting for an address takes one when ready, and a stale one is replaced.
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!code || payment || demo) return
    const replaceStale = () => {
      if (!code.address || codeIsStale(code, Date.now(), deps?.requester)) refresh()
    }
    // eslint-disable-next-line local/timer-in-view -- debt
    return session.page.pace.every(POLL_MS, replaceStale)
  }, [code, payment, demo, refresh, deps?.requester, session.page.pace])

  // Private: a receive carrying the code's request id pays it.
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!code || payment) return
    return watchRequestPayment(code, {
      session,
      contacts: () => directory.current.contacts,
      onPaid: (found) => paid(code, found),
    })
  }, [code, payment, paid, session])

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
