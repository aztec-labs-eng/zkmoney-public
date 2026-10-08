import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { formatUnits } from "viem"
import {
  isUnfundedSipaDeposit,
  maximumCreditAtomic,
  maximumSendAtomic,
  maximumSendForCapacity,
  SIPADepositStore,
  type AddressRoute,
  type SIPADepositRecord,
  useAztecContext,
  useCachedRecords,
  useContractServiceContext,
} from "@obsidion/front-core"
import { quotedDepositFee } from "@obsidion/core/constants"
import { GradientText, Icon } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { useUserFlowActive } from "../provingGate"
import { showReportableError } from "../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { useCopy } from "../../ui/hooks"
import { shortAddr, usdFigure } from "../../ui/format"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useRegistrationEscalated, useTagPresentationPending } from "../onboarding/webRegistration"
import { RegistrationPendingError } from "../onboarding/registrationRail"
import { buildErc20TransferUriWithoutAmount } from "../requests/eip681"
import { DepositFromWalletModal, type SentDeposit } from "./DepositFromWalletModal"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { isDemoMode } from "../../dev/demoFlag"
import { DepositDetailModal } from "../../ui/screens/DepositDetailModal"
import {
  depositTokensFor,
  loadDepositDisplayFacts,
  type DepositDisplayFacts,
  type DepositTokenOption,
} from "./loadDepositFacts"
import { sentDepositRecord } from "./sentDepositRecord"
import { AddressLimitsDetail } from "./AddressLimits"
import { ADDRESS_RECHECK_NOTE } from "./AddressCapacity"
import { WalletAboutLimitsSheet } from "../limits/AboutLimitsSheet"
import { InfoButton } from "../limits/InfoButton"
import { formatPublicLimit, usdFigureGrouped } from "../limits/publicLimit"
import { sourceFromTarget } from "../limits/capacitySources"
import type { LimitsTopic } from "../limits/aboutLimitsView"
import { targetEligibility, useTargetCapacity } from "./targetCapacity"
import { fundingCapacityView } from "./fundingCapacity"
import { useL1Wallet } from "./l1Wallet"
import { readL1TokenBalance } from "./l1DepositTokenBalance"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { OneTimeAddressPoints, type OneTimeAddressPoint } from "./OneTimeAddressWarning"
import {
  DepositPrivacyDisclaimer,
  isDepositPrivacyDisclaimerHidden,
} from "./DepositPrivacyDisclaimer"
import {
  CoinIcon,
  DepositAddressSheet,
  LimitsRow,
  type DepositSheetPhase,
  type DepositSpottedProblem,
} from "./DepositAddressSheet"
import { CheckAgainPill } from "./WaitingBlock"
import { getSipaDepositGateway, type DepositAddress, type DepositStage } from "./sipaGateway"
import { AddressesPublishingError, addressesPublishing } from "./addressesPublishing"
import { getBroadcastLedger } from "../broadcasts/broadcasts"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import {
  clearUnresolvedSend,
  holdUnresolvedSend,
  readUnresolvedSend,
  UnresolvedSendHeldError,
  type UnresolvedSendState,
} from "./unresolvedSend"
import { depositValuation } from "./depositValuation"
import { useDepositArrivalMinutes } from "./depositArrival"

/** Shown, unfunded addresses still publishing above which the screen waits instead of deriving. */
const PUBLISHING_LIMIT = 2

/** How often the address on screen is checked for a transfer nobody told us about. */
const FUNDING_POLL_MS = 10_000

/** How long the sheet says "Address copied!" before it waits for the funds. */
const COPIED_MS = 2_000

/** The smallest deposit the relayer sweeps, as the limits drawer states it. */
const MINIMUM_DEPOSIT = "$1"

/** The coin list's order; any other token the network offers follows. */
const COIN_ORDER = ["USDC", "USDT", "DAI"]

/** The coin row's subtitle. */
const COIN_NAMES: Record<string, string> = { USDT: "Tether" }

const DEPOSIT_INFO_POINTS: OneTimeAddressPoint[] = [
  {
    id: "loss",
    icon: "coins",
    title: "Risk of loss",
    body: "Only send available tokens on Ethereum. Anything else is not credited, and getting it back requires manual recovery.",
  },
  {
    id: "rotates",
    icon: "shield-check",
    title: "Each deposit gets a new address",
    body: "Addresses you already shared keep working. Use each one only once for the best privacy.",
  },
]

/**
 * The address this screen holds. `publishing`: its broadcast has not landed. It shows, copies and
 * funds all the same: the broadcast ledger publishes it, and funds wait at the address until then.
 */
type ShownAddress = DepositAddress & { publishing?: boolean }

/** Map raw errors to something a user can act on (esp. the stale-identity resolve revert). */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/UserNotFound|User not found/i.test(msg)) {
    return "This @tag isn't registered on the current network — your saved login is likely from a previous deployment. Clear site data and claim again."
  }
  return msg
}

/** The Fee row while the quote is still being read. */
export const QUOTE_PENDING = "Checking…"

/** What to do when the fee read failed and the funding controls are held. */
export const FEE_UNAVAILABLE_NOTE = "Use Retry to load the fee and continue."

function coinOrder(tokens: DepositTokenOption[]): DepositTokenOption[] {
  const rank = (t: DepositTokenOption) => {
    const i = COIN_ORDER.indexOf(t.symbol)
    return i === -1 ? COIN_ORDER.length : i
  }
  return [...tokens].sort((a, b) => rank(a) - rank(b))
}

/**
 * Deposit: pick a coin, then a sheet hands out a single-use SIPA address for THIS wallet's
 * `<tag>.<ensDomain>` to copy or scan, or funds it from a connected wallet. Anything sent there is
 * discovered and credited automatically by the SIPA sync loop mounted in WalletGate; the screen
 * watches the address itself so the sheet can say when funds are spotted.
 */
export function DepositScreen() {
  const navigate = useNavigate()
  const handle = loadWalletIdentity()?.handle
  // The gate is effectful, not cosmetic: while the registration is unconfirmed, deriving and
  // publishing a deposit address for a name that may be lost must not happen at all.
  const claiming = useTagPresentationPending()
  const escalated = useRegistrationEscalated()
  const { obsidionWallet } = useAztecContext()
  const { contractService } = useContractServiceContext()
  const gateway = getSipaDepositGateway()
  const config = getConfig()
  const { l1Chain, l1ChainId, l1RpcUrl, network, oxideProfile } = config
  const manifestUrl = oxideProfile.manifestUrl
  const chainName = l1ChainId === 1 ? "Ethereum Mainnet" : l1Chain.name

  const [deposit, setDeposit] = useState<ShownAddress>()
  const [generating, setGenerating] = useState(false)
  const [resolveFailed, setResolveFailed] = useState(false)
  const [capped, setCapped] = useState(false)
  const busy = useUserFlowActive()
  const l1 = useL1Wallet({ expectedChainId: l1ChainId, rpcUrl: l1RpcUrl })
  // Desktop launcher: no wallet extension, the transfer is approved in the default browser.
  const bridgeMode = isDesktopL1SubmitActive()
  const canFund = bridgeMode || !!l1.account
  const [sheetOpen, setSheetOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(true)
  // Copying hands the address over; the sheet then waits for the funds.
  const [step, setStep] = useState<"address" | "awaiting">("address")
  // The balance seen at the shown address; set once, no new address appears after it.
  const [funded, setFunded] = useState<bigint>()
  const [balance, setBalance] = useState(0n)
  const [lastReadAt, setLastReadAt] = useState<number>()
  const [readError, setReadError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [fundOpen, setFundOpen] = useState(false)
  const [aboutLimits, setAboutLimits] = useState<LimitsTopic>()
  // A funding click made while disconnected, waiting on the wallet the picker is asking for.
  const [fundOnConnect, setFundOnConnect] = useState(false)
  // A desktop send may have been approved without a known hash: that address may still be funded, so
  // new funding waits until funds reach it or the user starts again.
  const unresolvedScope = loadWalletIdentity()?.address ?? "unknown"
  const [hold, setHold] = useState<UnresolvedSendState>(() =>
    readUnresolvedSend(network, unresolvedScope),
  )
  const unresolved = hold.status === "held" ? hold.send : undefined
  const [holdError, setHoldError] = useState(false)
  const [discovered, setDiscovered] = useState<SIPADepositRecord>()
  // After the wallet broadcasts a deposit the detail sheet tracks it: a client-side `funding` view
  // until event discovery creates the store record, then that record as it advances.
  const [sent, setSent] = useState<SentDeposit>()
  const depositStore = useMemo(() => SIPADepositStore.get(webStorage), [])
  const { records } = useCachedRecords(depositStore)
  const stored = sent
    ? records.find((r) => r.sipaAddress.toLowerCase() === sent.address.toLowerCase())
    : undefined
  // The user's explicit choice; the hold stays until the saved marker is really gone.
  const startNewDeposit = useCallback(() => {
    clearUnresolvedSend(network, unresolvedScope).then(
      () => {
        setHoldError(false)
        setHold({ status: "none" })
      },
      () => setHoldError(true),
    )
  }, [network, unresolvedScope])
  // Funds reached the address the unresolved send was going to: show that deposit. A published
  // address already has an unfunded record from discovery, which proves nothing.
  useEffect(() => {
    if (!unresolved) return
    const record = records.find(
      (r) =>
        r.sipaAddress.toLowerCase() === unresolved.address.toLowerCase() &&
        !isUnfundedSipaDeposit(r),
    )
    if (!record) return
    // The funded record ends the hold; a marker left behind ends the same way on the next mount.
    clearUnresolvedSend(network, unresolvedScope).catch((err: unknown) =>
      console.warn("[deposit] could not remove the unresolved send", err),
    )
    setHold({ status: "none" })
    setDiscovered(record)
  }, [unresolved, records, network, unresolvedScope])
  const tokens = depositTokensFor(network)
  // The first entry is the token the portal settles in.
  const settlement = tokens[0]
  const coins = coinOrder(tokens)
  const [token, setToken] = useState<DepositTokenOption>(settlement)
  const [disclaimer, setDisclaimer] = useState(() => !isDepositPrivacyDisclaimerHidden())
  const [facts, setFacts] = useState<DepositDisplayFacts>()
  const [factsFailed, setFactsFailed] = useState(false)
  const [factsAttempt, setFactsAttempt] = useState(0)
  const fee = facts?.fee
  const manifestToken = facts?.token
  const sentRecord = sent ? sentDepositRecord(sent, stored, l1ChainId, facts) : undefined
  const { copied, copy } = useCopy()
  // Without the fee nothing may be funded: the wallet path would charge amount + 0 while the sweep
  // still takes the real fee. Copy/Deposit stay disabled until it loads.
  const quoteFailed = fee == null && factsFailed
  const quoteLoading = fee == null && !factsFailed
  const reloadFacts = () => setFactsAttempt((n) => n + 1)

  useEffect(() => {
    fireEvent("deposit_sheet_opened")
  }, [])

  // Both halves of the quote are per-deployment immutables, so the read is redone only on Retry
  // and when the deployment behind it changes.
  useEffect(() => {
    let stale = false
    setFactsFailed(false)
    void loadDepositDisplayFacts()
      .then((next) => {
        if (!stale) setFacts(next)
      })
      .catch((e) => {
        if (stale) return
        console.warn("[deposit] fee quote failed:", e)
        fireEvent("action_failed", { action: "deposit:facts", code: failureCode(e) })
        setFactsFailed(true)
      })
    return () => {
      stale = true
    }
  }, [factsAttempt, l1RpcUrl, l1ChainId, manifestUrl])

  // Dev demo: the fixture address stands in for a derived one. `import.meta.env.DEV` is a
  // build-time literal, so a production build drops this body and the dynamic import with it.
  useEffect(() => {
    if (!import.meta.env.DEV || !isDemoMode() || claiming || deposit || !handle) return
    let stale = false
    void import("../../dev/demoDeposit")
      .then(({ demoDepositAddress }) => {
        if (!stale) setDeposit(demoDepositAddress(handle))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [claiming, deposit, handle])

  // One resolve at a time: a second would derive, and owe a proof for, an address nobody sees. The
  // open reads the pool only (limit 0); the coin row may derive, after a pool read still in flight.
  const resolving = useRef<{ limit: number; run: Promise<boolean> } | null>(null)
  const resolveAddress = useCallback(
    (limit: number = PUBLISHING_LIMIT): Promise<boolean> => {
      if (!handle || !obsidionWallet || !contractService || claiming) return Promise.resolve(false)
      if (resolving.current) {
        const current = resolving.current
        if (current.limit >= limit) return current.run
        return current.run.then((ok) => (ok ? true : resolveAddress(limit)))
      }
      // The pool read on open fails quietly; the coin row's derive reports.
      const quiet = limit === 0
      setGenerating(true)
      setResolveFailed(false)
      setCapped(false)
      const elapsed = lapTimer()
      const stageLap = lapTimer()
      let sawResolving = false
      fireEvent("address_resolve_started", { fresh: false })
      const onStage = (next: DepositStage) => {
        if (next === "resolving") sawResolving = true
        fireEvent("deposit_resolve_stage", { stage: next, prev_stage_ms: stageLap() })
      }
      const run = (async () => {
        const next = await gateway.depositAddress(obsidionWallet, contractService, handle, {
          onStage,
          publishingLimit: limit,
        })
        fireEvent("address_resolve_succeeded", {
          duration_ms: elapsed(),
          cached: !sawResolving,
          fresh: false,
        })
        const { publish, owe } = next
        setDeposit({ address: next.address, name: next.name, owe, publishing: !!publish })
        fireEvent("deposit_address_shown", { pooled: !publish })
        if (publish) {
          const publishLap = lapTimer()
          // The ledger keeps it owed whatever this reports; the status row shows where it stands.
          void publish().then(
            () => {
              fireEvent("address_published", { duration_ms: publishLap() })
              setDeposit((d) => (d?.address === next.address ? { ...d, publishing: false } : d))
            },
            (e) => {
              if (e instanceof RegistrationPendingError) {
                fireEvent("address_publish_deferred", { reason: e.state.pending })
              } else {
                fireEvent("address_publish_failed", {
                  duration_ms: publishLap(),
                  code: failureCode(e),
                })
              }
            },
          )
        }
        return true
      })()
        .catch((e) => {
          if (e instanceof AddressesPublishingError) {
            if (!quiet) setCapped(true)
            return false
          }
          fireEvent("address_resolve_failed", { duration_ms: elapsed(), code: failureCode(e) })
          if (!quiet) {
            showReportableError(e, "deposit:resolve", { message: friendlyError(e) })
            setResolveFailed(true)
          }
          return false
        })
        .finally(() => {
          resolving.current = null
          setGenerating(false)
        })
      resolving.current = { limit, run }
      return run
    },
    [gateway, handle, obsidionWallet, contractService, claiming],
  )

  // The address appears on open: one nobody was shown from the pool, else a fresh derivation. While
  // a sent deposit's detail is open, the next address waits for the user to come back to the sheet.
  useEffect(() => {
    if (claiming || deposit || capped || resolveFailed || busy || sent) return
    if (hold.status !== "none" || !handle || !obsidionWallet || !contractService) return
    void resolveAddress(0)
  }, [
    claiming,
    deposit,
    capped,
    resolveFailed,
    busy,
    sent,
    hold.status,
    handle,
    obsidionWallet,
    contractService,
    resolveAddress,
  ])

  // Held by the limit until one of the counted addresses lands or is funded.
  useEffect(() => {
    if (!capped) return
    const ledger = getBroadcastLedger()
    return ledger.onListChanged((jobs) => {
      if (addressesPublishing(jobs, getActiveStorageId()) >= PUBLISHING_LIMIT) return
      setCapped(false)
      // The sheet is waiting on it: derive now.
      if (sheetOpen) void resolveAddress()
    })
  }, [capped, sheetOpen, resolveAddress])

  /** Open the funding sheet. Funding needs the address the user is shown, so derive one first. */
  const beginFunding = useCallback(() => {
    if (fee == null || claiming) return
    // The sheet moves the wallet's money, so it opens only for an address whose broadcast landed.
    if (deposit) return void setFundOpen(true)
    if (!generating) void resolveAddress().then((ok) => ok && setFundOpen(true))
  }, [fee, deposit, generating, resolveAddress, claiming])

  // `l1.connect` only opens the wallet picker; the account lands renders later, so the click that
  // asked to fund would otherwise stop at "Wallet connected" and need a second one. A picker that
  // closes without a wallet takes the click with it, so a wallet connecting on its own later does
  // not find it waiting. A successful pick cannot close the picker ahead of its account: wagmi
  // stores the connection before RainbowKit reacts to it.
  useEffect(() => {
    if (!fundOnConnect) return
    if (canFund) {
      setFundOnConnect(false)
      beginFunding()
    } else if (!l1.pickerOpen) {
      setFundOnConnect(false)
    }
  }, [fundOnConnect, canFund, l1.pickerOpen, beginFunding])

  const shown = deposit
  const ready = !!shown && !generating && fee != null
  const qrToken = token.address ?? manifestToken
  // Tokens other than the manifest token are swapped into it before the portal credits them.
  const swap = !!token.address
  const route: AddressRoute = {
    kind: "deposit",
    decimals: token.decimals,
    swap,
    feeAtomic: facts && quotedDepositFee(facts.sweepFeeAtomic, facts.fpcFundingCutAtomic),
  }
  const valuation = manifestToken && depositValuation(token, manifestToken, l1ChainId)
  const maxSend = maximumSendAtomic(route, valuation)
  // The address on this screen is derived from the active deployment, so its bucket is the active one.
  const capacity = useTargetCapacity({ kind: "active" })
  const arrivalMinutes = useDepositArrivalMinutes(obsidionWallet?.node, config)
  const capacityEligibility = targetEligibility(capacity, { status: "unknown" })
  const capacityView = fundingCapacityView({
    eligibility: capacityEligibility,
    mode: "address",
    symbol: settlement.symbol,
    sentSymbol: token.symbol,
    exactCredit: !swap,
  })
  const capacityKnown = capacityEligibility.kind === "amount-unknown"
  // No figure fits a swap: the settlement credited is set by the swap.
  const fitsNow =
    !swap && capacityKnown && !capacityEligibility.zero
      ? maximumSendForCapacity(route, capacityEligibility.snapshot.availableAtomic, valuation)
      : undefined
  const limitNow =
    capacityKnown && capacityEligibility.zero
      ? "$0"
      : fitsNow !== undefined && maxSend !== undefined && fitsNow < maxSend
      ? usdFigureGrouped(formatUnits(fitsNow, token.decimals))
      : formatPublicLimit()
  const capacityNote =
    capacityView.tone === "ok" || capacityView.tone === "checking"
      ? undefined
      : [capacityView.statusText, capacityView.detailText].filter(Boolean).join(" ")
  const limitsDrawer = (
    <>
      <LimitsRow
        label="Minimum deposit"
        value={MINIMUM_DEPOSIT}
        info={
          <InfoButton label="About the deposit limit" onClick={() => setAboutLimits("limit")} />
        }
      />
      <LimitsRow
        label="Limit right now"
        value={
          capacityKnown
            ? `${limitNow} incl. fees`
            : capacityEligibility.kind === "checking"
            ? QUOTE_PENDING
            : "Could not check"
        }
        testId="deposit-limit-now"
        info={
          <InfoButton
            label="About network capacity"
            testId="about-capacity-link"
            onClick={() => setAboutLimits("capacity")}
          />
        }
        action={
          <CheckAgainPill
            checking={capacityEligibility.kind === "checking"}
            onClick={capacity.retry}
            testId="funding-capacity-retry"
          />
        }
      />
      <LimitsRow
        label="Fee"
        value={quoteFailed ? "Unavailable" : fee ? usdFigure(fee) : QUOTE_PENDING}
        testId="deposit-fee"
        info={<InfoButton label="About the deposit fee" onClick={() => setAboutLimits("limit")} />}
        action={
          quoteFailed && (
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              data-testid="deposit-facts-retry"
              onClick={reloadFacts}
            >
              Retry
            </button>
          )
        }
      />
      <LimitsRow
        label="Deposit arrival time"
        value={arrivalMinutes === undefined ? "A few minutes" : `~${arrivalMinutes} minutes`}
      />
      {quoteFailed && (
        <p className="ww-deposit-sheet__fine" data-testid="deposit-fee-unavailable">
          {FEE_UNAVAILABLE_NOTE}
        </p>
      )}
      {swap && (
        <p className="ww-deposit-sheet__fine" data-testid="deposit-swap-note">
          Your balance is stored in {settlement.symbol}. Sending another token will automatically
          convert it to {settlement.symbol} at the current market price, so your balance might
          differ.
        </p>
      )}
    </>
  )
  const limitsDetails = {
    limit: (
      <AddressLimitsDetail
        symbol={token.symbol}
        decimals={token.decimals}
        checking={quoteLoading}
        maxSendAtomic={maxSend}
        maxCreditAtomic={maximumCreditAtomic(route, valuation)}
        swapInto={swap ? settlement.symbol : undefined}
      />
    ),
    capacity: (
      <>
        {swap && (
          <p className="ww-about-limits__note" data-testid="address-capacity-swap">
            Maximum send amount for current capacity unavailable: the {settlement.symbol} credited
            from {token.symbol} is set by the swap.
          </p>
        )}
        <p className="ww-about-limits__note">{ADDRESS_RECHECK_NOTE}</p>
      </>
    ),
  }

  // Terminal: overlapping slow reads can both settle funded in the same tick.
  const fundedSeen = useRef(false)
  const markFunded = useCallback(
    (next: bigint) => {
      if (fundedSeen.current) return
      fundedSeen.current = true
      fireEvent("deposit_funded", {
        funding: "external",
        amount_bucket: amountBucket(next, token.decimals),
      })
      setFunded(next)
      // The scanner moves the record on; back on its per-tick lane, the row shows within a tick.
      if (deposit) void gateway.wakeDeposit(deposit.address)
    },
    [token.decimals, deposit, gateway],
  )
  const recordRead = useCallback(
    (next: bigint) => {
      setReadError(false)
      setBalance(next)
      setLastReadAt(Date.now())
      if (next !== 0n) markFunded(next)
    },
    [markFunded],
  )

  // A third-party send leaves no local trace, and the sync loop's own funding read drops to a
  // five-minute lane once the address is ten minutes old — too slow for a screen someone is
  // watching. A seen balance moves the sheet to spotted; the sweep credits it.
  useEffect(() => {
    // The connected-wallet path is tracked by its own detail sheet.
    if (!shown || !qrToken || fundOpen || sent || funded != null) return
    // The demo's fake L1 reports a balance for every address, which would read as
    // an instant external send.
    if (import.meta.env.DEV && isDemoMode()) return
    let cancelled = false
    // Only the picked token is watched; funding in another one still lands via the sync loop's
    // own read, just without this screen noticing.
    const timer = setInterval(() => {
      void readL1TokenBalance(qrToken, shown.address)
        .then((next) => {
          if (!cancelled) recordRead(next)
        })
        .catch((e) => {
          if (cancelled) return
          setReadError(true)
          console.warn("[deposit] funding poll failed:", e)
        })
    }, FUNDING_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [shown, qrToken, fundOpen, sent, funded, recordRead])

  /** The poll's read, on demand. */
  const refresh = () => {
    if (!shown || !qrToken || refreshing) return
    setRefreshing(true)
    readL1TokenBalance(qrToken, shown.address)
      .then(recordRead)
      .catch((e) => {
        setReadError(true)
        console.warn("[deposit] balance read failed:", e)
      })
      .finally(() => setRefreshing(false))
  }

  // A sheet with nothing to show and nothing coming closes: the derivation failed or never started.
  useEffect(() => {
    if (sheetOpen && !deposit && !generating && !capped) setSheetOpen(false)
  }, [sheetOpen, deposit, generating])

  const waitTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(waitTimer.current), [])
  // Copying is the hand-off: after the copied feedback the sheet waits for the funds. A refused
  // clipboard copies nothing, so the sheet stays put.
  const copyAddress = () => {
    if (!shown) return
    void copy(shown.address).then((ok) => {
      if (!ok || step !== "address") return
      clearTimeout(waitTimer.current)
      waitTimer.current = setTimeout(() => setStep("awaiting"), COPIED_MS)
    })
  }
  /** Back to the address: a copy's pending hand-off goes with it. */
  const showAddress = () => {
    clearTimeout(waitTimer.current)
    setStep("address")
  }
  /** A coin row: the sheet for that coin, deriving an address when none is held yet. */
  const openSheet = (next: DepositTokenOption) => {
    setSheetOpen(true)
    // Spotted funds belong to the coin they were read in.
    if (funded != null) return
    // The same coin reopens where it was, waiting included; another coin starts at its address.
    if (next.symbol !== token.symbol) {
      showAddress()
      setBalance(0n)
      setLastReadAt(undefined)
    }
    setToken(next)
    if (!deposit) void resolveAddress()
  }
  /** The held address was spent or may be: the next sheet derives a fresh one. */
  const dropAddress = () => {
    setDeposit(undefined)
    setSheetOpen(false)
    showAddress()
    setBalance(0n)
    setLastReadAt(undefined)
  }
  const phase: DepositSheetPhase =
    funded != null ? "spotted" : !shown ? "creating" : step === "awaiting" ? "waiting" : "ready"
  const paymentUri =
    ready && qrToken
      ? buildErc20TransferUriWithoutAmount({
          token: qrToken,
          chainId: l1ChainId,
          to: shown.address,
        })
      : undefined
  // The sweep cannot credit an amount over the per-transaction limit; over current capacity, or with
  // none, it waits. Unknown capacity promises nothing either way.
  const spottedProblem: DepositSpottedProblem | undefined =
    funded == null
      ? undefined
      : maxSend !== undefined && funded > maxSend
      ? "limit"
      : (capacityKnown && capacityEligibility.zero) || (fitsNow !== undefined && funded > fitsNow)
      ? "capacity"
      : undefined
  // A swapped coin's credit is set by the swap rate, so no figure is promised for it.
  const arriving =
    !swap && funded != null && fee != null
      ? usdFigureGrouped(
          String(Math.max(0, Number(formatUnits(funded, token.decimals)) - Number(fee))),
        )
      : undefined
  const connectLink = (
    <p className="ww-deposit__note">
      <button
        type="button"
        className="zkm-btn-reset ww-deposit__link"
        data-testid="deposit-connect-link"
        disabled={fee == null || claiming}
        onClick={() => {
          if (!canFund) {
            setFundOnConnect(true)
            return void l1.connect()
          }
          beginFunding()
        }}
      >
        {l1.account
          ? `Deposit from ${l1.walletName ?? "wallet"} · ${shortAddr(l1.account)}`
          : bridgeMode
          ? "Or deposit from your browser"
          : "Or connect a wallet to fund"}
      </button>
      {l1.account && (
        <>
          {" "}
          <button type="button" className="zkm-btn-reset ww-deposit__link" onClick={l1.disconnect}>
            Disconnect
          </button>
        </>
      )}
    </p>
  )

  return (
    <div className="ww-panel ww-deposit">
      <div className="ww-deposit__stealth ww-deposit__stealth--top">
        <GradientText size={24} weight={700}>
          Deposit funds
        </GradientText>

        {claiming ? (
          <>
            <div className="ww-deposit__note" style={{ width: "auto" }}>
              Your @tag is still being claimed. Deposit addresses become available once it settles.{" "}
              {escalated
                ? "This is taking longer than usual."
                : "This usually takes about a minute."}{" "}
              {/* Web has no background re-sign; the claim page owns the status check. */}
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__link"
                onClick={() => navigate(handle ? `/claim/${handle}` : "/claim")}
              >
                Check on your claim
              </button>
            </div>
            {connectLink}
          </>
        ) : hold.status !== "none" ? (
          <div
            className="ww-deposit__unresolved"
            role="status"
            data-testid="deposit-send-unresolved"
          >
            {unresolved ? (
              <>
                <b>Waiting for your browser wallet</b>
                <p>
                  A transfer to {shortAddr(unresolved.address)} may still be sent from your browser
                  wallet. If it is, the deposit appears in your activity.
                </p>
              </>
            ) : (
              <>
                <b>Deposit state unavailable</b>
                <p>This browser's saved deposit state can't be read.</p>
              </>
            )}
            <p>New deposits are paused here so the same funds are not sent twice.</p>
            {holdError && (
              <p data-testid="deposit-send-unresolved-error">
                This browser couldn't update its saved state. Try again.
              </p>
            )}
            <div className="ww-deposit__unresolved-actions">
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__link"
                onClick={() =>
                  unresolved
                    ? navigate("/activity")
                    : setHold(readUnresolvedSend(network, unresolvedScope))
                }
              >
                {unresolved ? "View activity" : "Check again"}
              </button>
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__link"
                data-testid="deposit-send-unresolved-restart"
                onClick={startNewDeposit}
              >
                Start a new deposit
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="ww-deposit__fields">
              <p className="ww-deposit__label">Which token are you sending?</p>
              <div className="ww-deposit__coins">
                {coins.map((t) => (
                  <button
                    key={t.symbol}
                    type="button"
                    className="zkm-btn-reset ww-deposit__coin"
                    data-testid={`deposit-coin-${t.symbol}`}
                    disabled={busy && !deposit}
                    onClick={() => openSheet(t)}
                  >
                    <CoinIcon token={t} />
                    <span className="ww-deposit__coin-name">
                      {t.symbol}
                      <small>{COIN_NAMES[t.symbol] ?? t.symbol}</small>
                    </span>
                  </button>
                ))}
              </div>
              <div className="ww-deposit__network">
                <span>
                  Network
                  <Icon name="lock" size={14} />
                </span>
                <b>{chainName}</b>
              </div>
            </div>
            <section className="ww-deposit__info">
              <button
                type="button"
                className="zkm-btn-reset ww-deposit__info-head"
                aria-expanded={infoOpen}
                onClick={() => setInfoOpen((o) => !o)}
              >
                Important information
                <Icon name={infoOpen ? "chevron-up" : "chevron-down"} size={16} />
              </button>
              {infoOpen && <OneTimeAddressPoints points={DEPOSIT_INFO_POINTS} />}
            </section>
            {connectLink}
          </>
        )}
      </div>

      {sheetOpen && (
        <DepositAddressSheet
          token={token}
          chainName={chainName}
          phase={phase}
          address={shown?.address}
          paymentUri={paymentUri}
          publishing={!!shown?.publishing}
          creatingNote={capped ? new AddressesPublishingError().message : undefined}
          canCopy={ready}
          copied={copied}
          onCopy={copyAddress}
          balance={balance}
          lastReadAt={lastReadAt}
          checking={refreshing}
          onCheck={refresh}
          funded={funded}
          arriving={arriving}
          swapInto={swap ? settlement.symbol : undefined}
          limitNow={limitNow}
          limits={limitsDrawer}
          capacityNote={capacityNote}
          arrivalMinutes={arrivalMinutes}
          onPayWithWallet={() => {
            setSheetOpen(false)
            if (!canFund) {
              setFundOnConnect(true)
              return void l1.connect()
            }
            beginFunding()
          }}
          walletLabel={bridgeMode ? "Pay from your browser" : "Pay with wallet"}
          readError={readError}
          problem={spottedProblem}
          limitLabel={formatPublicLimit()}
          onOpenActivity={() => navigate("/activity")}
          onClose={() => {
            setSheetOpen(false)
            // Funds spotted: the deposit carries on in Activity, so the screen is done.
            if (phase === "spotted") return navigate("/")
            // A copy's pending hand-off is dropped; a sheet already waiting keeps waiting.
            clearTimeout(waitTimer.current)
          }}
        />
      )}

      {fundOpen && shown && canFund && (
        <DepositFromWalletModal
          l1={l1}
          deposit={shown}
          token={token}
          fee={fee}
          valuation={manifestToken && depositValuation(token, manifestToken, l1ChainId)}
          onClose={() => setFundOpen(false)}
          onSent={(next) => {
            setFundOpen(false)
            setSent(next)
            // The address was spent; the next visit derives a fresh one.
            dropAddress()
            // A known hash replaces the hold; if the marker cannot be removed, the funded record ends it.
            clearUnresolvedSend(network, unresolvedScope, { address: next.address }).catch(
              (err: unknown) => console.warn("[deposit] could not remove the unresolved send", err),
            )
          }}
          onSendFailed={() => setSent(undefined)}
          onFeeChanged={reloadFacts}
          onApproving={async (submission) => {
            try {
              await holdUnresolvedSend(network, unresolvedScope, {
                address: shown.address,
                at: Date.now(),
                submission,
              })
            } catch (err) {
              // A saved hold this screen is not showing: it waits on it too.
              if (err instanceof UnresolvedSendHeldError) {
                setHold(readUnresolvedSend(network, unresolvedScope))
              }
              throw err
            }
          }}
          onNotApproved={(submission) =>
            // Its hold can land after the refusal; nothing was sent, so it goes.
            clearUnresolvedSend(network, unresolvedScope, { submission }).catch((err: unknown) =>
              console.warn("[deposit] could not remove the unresolved send", err),
            )
          }
          onSendUnresolved={() => {
            // The marker was saved before the approval; this page holds even if it is gone now.
            const saved = readUnresolvedSend(network, unresolvedScope)
            setHold(
              saved.status === "held"
                ? saved
                : { status: "held", send: { address: shown.address, at: Date.now() } },
            )
            setFundOpen(false)
            // That address may already hold the transfer; it is never offered again.
            dropAddress()
          }}
        />
      )}
      {discovered && (
        <DepositDetailModal record={discovered} onClose={() => setDiscovered(undefined)} />
      )}

      {sentRecord && <DepositDetailModal record={sentRecord} onClose={() => setSent(undefined)} />}

      {disclaimer && (
        <DepositPrivacyDisclaimer handle={handle} onClose={() => setDisclaimer(false)} />
      )}

      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic={aboutLimits}
          details={limitsDetails}
          capacity={sourceFromTarget(capacity)}
          settlementSymbol={settlement.symbol}
          onClose={() => setAboutLimits(undefined)}
        />
      )}
    </div>
  )
}
