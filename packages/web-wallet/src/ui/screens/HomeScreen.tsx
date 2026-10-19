import { useEffect, useLayoutEffect, useState, useRef } from "react"
import { parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  Icon,
  LiquidGlassPill,
  PrimaryGradientButton,
  ProgressSpinner,
  Spinner,
} from "@obsidion/web-ds"
import {
  type SavingsDirection,
  type SavingsPosition,
  savingsEarned,
  savingsEarningsPending,
  useBalance,
  useSavings,
} from "@obsidion/front-core"
import { useLocation, useNavigate } from "react-router-dom"
import { DepositArt } from "../DepositArt"
import { HighGasNotice, HighL2FeeNotice } from "../HighGasNotice"
import { PhoneIcon } from "../PhoneIcon"
import { usePhoneLayout } from "../usePhoneLayout"
import { LostRegistrationNoticeCard } from "../../features/onboarding/LostRegistrationNoticeCard"
import { inviteLink, useInvite } from "../../features/invite/useInvite"
import { RegisterNameCard } from "../../features/onboarding/SecureNameNoticeCard"
import { ActivationHome } from "../../features/onboarding/ActivationHome"
import { useNameClaimPending } from "../../features/onboarding/openRegistration"
import { getConfig } from "../../config/env"
import { healRegistrationDeposits } from "../../features/onboarding/registrationDepositSeed"
import { peekClaimStash } from "../../features/paylink/claimStash"
import { takeClaimPromptRequest, useClaimPromptRequest } from "../../features/paylink/claimPrompt"
import { useClaimLinkFlow } from "../../features/paylink/useClaimLinkFlow"
import { AccountSwitcher, type SavingsAccount } from "../../features/savings/AccountSwitcher"
import { EarningsCalculatorSheet, apyPercent } from "../../features/savings/EarningsCalculator"
import { MoveFundsSheet } from "../../features/savings/MoveFundsSheet"
import { SavingsArt } from "../../features/savings/SavingsArt"
import { SavingsCards } from "../../features/savings/SavingsCards"
import {
  ESTIMATE_TITLE,
  splitTicking,
  useSavingsEstimate,
} from "../../features/savings/savingsEstimate"
import { RequestsUnavailableNotice } from "../../features/requests/RequestsUnavailableNotice"
import { usdAtomicFloor } from "../format"
import { useHideBalances } from "../prefs"
import { BalanceSkeleton } from "../Skeletons"
import { customEndpointsLabel } from "../EndpointsModal"
import { HomeActions, type HomeAction } from "./HomeActions"
import { HomeTransactions } from "./HomeTransactions"
import { useActivityEntries } from "./useActivityEntries"
import earnCoin from "../../assets/home/earn-coin.webp"
import gift from "../../assets/home/gift.webp"
import { UpgradeBanner } from "../../features/migration/UpgradeIntro"
import iosApp from "../../assets/home/ios-app.webp"
import quickFresh from "../../assets/home/quick-fresh.webp"
import quickPaylink from "../../assets/home/quick-paylink.webp"
import shareTag from "../../assets/home/share-tag.webp"
import { useFreshAddressAvailable } from "../../features/withdraw/freshAddressAvailability"
import { useCopy, useLinkSharing } from "../hooks"

/**
 * Home. Reached through the identity and unlock gates. Balance comes from
 * the shared front-core asset layer. Where a savings deployment exists the card switches between
 * Main and Savings; `/savings` is Home on the Savings account, with its cards under the card.
 */
const QUICK_SLIDES = [
  {
    id: "fresh",
    label: "Withdraw to a fresh address",
    title: "Exit money to a fresh address",
    body: "Withdraw to a new address and add gas simultaneously. Full onchain privacy.",
    art: quickFresh,
    path: "/withdraw/fresh",
  },
  {
    id: "paylink",
    label: "Create payment link",
    title: "Send money to anyone via paylink",
    body: "Generate a shareable paylink. You can pay anyone, no account needed.",
    art: quickPaylink,
    path: "/links/new",
  },
]

/** The rail's promo slides, one per view. The row scrolls natively; the arrows only move it. */
function QuickActions() {
  const navigate = useNavigate()
  const row = useRef<HTMLDivElement>(null)
  const fresh = useFreshAddressAvailable() === true
  const savings = useSavings()
  const apy = savings.position?.apy
  const slides = [
    ...(savings.available
      ? [
          {
            id: "savings",
            label: "Open Savings",
            title:
              apy === undefined
                ? "Earn on your savings"
                : `Earn ${apyPercent(apy)} APY on your savings`,
            body: "Watch your balance tick up in real time.",
            art: earnCoin,
            path: "/savings",
          },
        ]
      : []),
    ...QUICK_SLIDES.filter((slide) => slide.id !== "fresh" || fresh),
  ]
  const paged = slides.length > 1
  // Savings and the fresh-address slide arrive after first paint, ahead of the paylink slide the
  // row snapped to; Chromium then re-snaps to that same slide, which is now the last. Lead with
  // the first slide whenever the set changes.
  const slideSet = slides.map((slide) => slide.id).join()
  useLayoutEffect(() => {
    if (row.current) row.current.scrollLeft = 0
  }, [slideSet])
  const scrollRow = (views: number) =>
    row.current?.scrollBy({ left: views * row.current.clientWidth, behavior: "smooth" })

  return (
    <div className="ww-quick">
      <div className="ww-quick__head">
        <span>Quick actions</span>
        {paged && (
          <span className="ww-quick__arrows">
            <button
              type="button"
              className="zkm-btn-reset"
              aria-label="Scroll back"
              onClick={() => scrollRow(-1)}
            >
              <Icon name="chevron-right" size={8.5} color="#fff" />
            </button>
            <button
              type="button"
              className="zkm-btn-reset"
              aria-label="Scroll forward"
              onClick={() => scrollRow(1)}
            >
              <Icon name="chevron-right" size={8.5} color="#fff" />
            </button>
          </span>
        )}
      </div>
      <div className="ww-quick__slides" ref={row}>
        {slides.map((slide, i) => (
          <button
            key={slide.id}
            type="button"
            className={`zkm-btn-reset ww-banner ww-quick__slide ww-quick__slide--${slide.id}`}
            aria-label={slide.label}
            onClick={() => navigate(slide.path)}
          >
            <span className="ww-banner__text">
              <span className="ww-banner__title">{slide.title}</span>
              <span className="ww-banner__body">{slide.body}</span>
            </span>
            {paged && (
              <span className="ww-quick__stepper">
                <span className="ww-quick__track">
                  <span style={{ width: `${(100 * (i + 1)) / slides.length}%` }} />
                </span>
                {i + 1}/{slides.length}
              </span>
            )}
            <img src={slide.art} alt="" />
          </button>
        ))}
      </div>
    </div>
  )
}

const HIDDEN = "$••••••"
const EARNED_TITLE =
  "What your Savings balance is worth above what it cost you, at today's share price."

/** Stays up while any endpoint is not the default; leads to where the endpoints are set. */
function CustomEndpointsPill({
  label,
  onOpenSettings,
}: {
  label: string
  onOpenSettings: () => void
}) {
  return (
    <button
      type="button"
      className="zkm-btn-reset"
      style={{ textDecoration: "none" }}
      onClick={onOpenSettings}
    >
      <LiquidGlassPill label={label} icon="settings" iconLeading labelFontSize={12} />
    </button>
  )
}

/**
 * A Savings figure carried to now at its rate, its small digits ticking (more of them on a small
 * balance); the tick re-renders only this. `at` maps the carried value to the figure shown.
 */
function TickingUsd({
  position,
  at,
}: {
  position: SavingsPosition | null
  at: (value: bigint) => bigint
}) {
  const estimate = useSavingsEstimate(position, true)
  if (estimate.value === undefined) return null
  const value = at(estimate.value)
  if (!estimate.ticking) return <>{usdAtomicFloor(value)}</>
  const { whole, ticking } = splitTicking(value)
  return (
    <>
      {whole}
      <small aria-hidden title={ESTIMATE_TITLE}>
        {ticking}
      </small>
    </>
  )
}

export function HomeScreen() {
  // Track registration deposits once their claim inputs are available.
  useEffect(() => {
    const timer = setTimeout(
      () => void healRegistrationDeposits(getConfig()).catch(() => {}),
      4_000,
    )
    return () => clearTimeout(timer)
  }, [])

  const navigate = useNavigate()
  const phone = usePhoneLayout()
  const [inviteOpen, setInviteOpen] = useState(true)
  const { code: inviteCode } = useInvite()
  const inviteText = inviteCode && inviteLink(inviteCode)
  const inviteUrl = inviteText && `https://${inviteText}`
  const { copied: inviteCopied, copy: copyInvite } = useCopy()
  // Share falls back to the clipboard where the Web Share API is absent, and says so.
  const { copied: inviteShared, share: shareInvite } = useLinkSharing(inviteUrl, "Invite friends")

  const { walletBalance, balanceKnown, balanceSyncing, balanceSyncProgress } = useBalance()
  const [hideBal, setHideBal] = useHideBalances()
  const savings = useSavings()
  const { pathname } = useLocation()
  // The route picks the account, so the Savings nav item and slide are shortcuts to this view.
  const account: SavingsAccount = savings.available && pathname === "/savings" ? "savings" : "main"
  const setAccount = (next: SavingsAccount) => navigate(next === "savings" ? "/savings" : "/")
  const [sheet, setSheet] = useState<SavingsDirection | { amount?: string } | "calculator" | null>(
    null,
  )
  const openMove = (direction: SavingsDirection, amount?: string) =>
    setSheet(direction === "in" && amount !== undefined ? { amount } : direction)
  const onSavings = account === "savings"
  const apy = savings.position?.apy
  const apyLabel = apy === undefined ? undefined : `${apyPercent(apy)} APY`
  const {
    entries,
    savingsEntries,
    savingsHydrated,
    savingsLedger,
    arriving,
    hydrated,
    requestsUnavailable,
    detailModals,
  } = useActivityEntries()
  // Funds on their way count where they land, flat: they neither tick nor earn until they arrive.
  const mainShown = parseUnits(walletBalance, DEFAULT_DECIMALS) + arriving.main
  const mainText = hideBal ? HIDDEN : usdAtomicFloor(mainShown)
  // The last read value; the ticking figures carry it to now in their own components.
  const estimate = useSavingsEstimate(savings.position, false)
  const savingsShown = estimate.value === undefined ? undefined : estimate.value + arriving.savings
  const savingsValueText = savingsShown === undefined ? undefined : usdAtomicFloor(savingsShown)
  const totalValue =
    savingsShown !== undefined && balanceKnown ? mainShown + savingsShown : undefined
  const savingsText = hideBal ? HIDDEN : savingsValueText ?? "—"
  // What the shares held now have earned: their value (ticking when it ticks) less what they cost.
  // Shown once the position's value is read, while there is a position or a counted move.
  const earnable =
    savingsLedger !== undefined &&
    estimate.value !== undefined &&
    ((savings.position?.shares ?? 0n) > 0n || savingsLedger.counted > 0)
  const sharesHeld = savings.position?.shares ?? 0n
  const earned =
    earnable && savingsLedger && estimate.value !== undefined
      ? savingsEarned(savingsLedger, estimate.value, sharesHeld)
      : undefined
  // Figures still being read from the escrow runs: the slot says so instead of going blank.
  const calculating =
    earnable && !!savingsLedger && earned === undefined && savingsEarningsPending(savingsLedger)
  // Nothing in the slot: the console says why, with every input, once per change.
  const hiddenKey =
    onSavings && !hideBal && earned === undefined && !calculating
      ? [
          savings.hydrated,
          savings.position?.shares,
          savings.position?.value,
          estimate.value,
          savingsLedger?.counted,
          savingsLedger?.shares,
          savingsLedger?.basis,
          savingsLedger?.excluded.map((e) => `${e.withdrawalLocalId}:${e.reason}:${e.backfilling}`),
        ].join("|")
      : undefined
  useEffect(() => {
    if (hiddenKey === undefined) return
    console.info(
      `[savings] earnings hidden: hydrated=${savings.hydrated} position=${
        savings.position
          ? `${savings.position.shares} shares, value ${savings.position.value}`
          : "none"
      } estimate=${estimate.value ?? "none"} ledger=${
        savingsLedger
          ? `counted ${savingsLedger.counted}, shares ${savingsLedger.shares}, basis ${
              savingsLedger.basis
            }, excluded [${savingsLedger.excluded
              .map(
                (e) =>
                  `${e.withdrawalLocalId} (${e.reason}${e.backfilling ? ", backfilling" : ""})`,
              )
              .join(", ")}]`
          : "not read yet"
      }`,
    )
    // Keyed on what the line would say, so it prints once per change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenKey])
  const totalText = hideBal ? HIDDEN : totalValue === undefined ? "—" : usdAtomicFloor(totalValue)
  const balanceText = onSavings ? savingsText : mainText
  const balanceShown = onSavings ? savings.hydrated : balanceKnown
  const syncing = !onSavings && balanceKnown && balanceSyncing
  const openDeposit = () => navigate("/deposit")
  // An inbound paylink stashed by /link — prompts until claimed or dismissed.
  const [claimFragment, setClaimFragment] = useState(peekClaimStash)
  // An activation surface asked for the claim of a link that funds the pending name: its review
  // opens whatever the claim's state, as the place that reports it.
  const requestedClaim = useClaimPromptRequest()
  const [claimAsked, setClaimAsked] = useState(false)
  useEffect(() => {
    if (!requestedClaim) return
    setClaimFragment(takeClaimPromptRequest())
    setClaimAsked(true)
  }, [requestedClaim])
  const claim = useClaimLinkFlow(
    claimFragment,
    () => {
      setClaimFragment(null)
      setClaimAsked(false)
    },
    claimAsked,
    () => setClaimAsked(false),
  )
  const customEndpoints = customEndpointsLabel(getConfig().endpoints)
  const requestEntries = entries.filter((entry) => entry.incomingRequest)
  const feedEntries = entries.filter((entry) => !entry.incomingRequest)

  const receive: HomeAction = {
    title: "Receive",
    icon: "arrow-down",
    phoneIcon: "arrow-down",
    run: () => navigate("/receive"),
  }
  const send: HomeAction = {
    title: "Send",
    icon: "send",
    phoneIcon: "send",
    run: () => navigate("/send"),
  }
  const withdraw: HomeAction = {
    title: "Withdraw",
    icon: "tray-withdraw",
    phoneIcon: "tray-withdraw",
    run: () => navigate("/withdraw"),
  }
  const actions: HomeAction[] = onSavings
    ? [
        { title: "Add to Savings", icon: "earn", phoneIcon: "earn", run: () => setSheet("in") },
        {
          title: "Move to Main Account",
          icon: "payments-arrows-horizontal",
          run: () => setSheet("out"),
        },
      ]
    : phone
    ? [
        { title: "Deposit", icon: "coins", phoneIcon: "coins", run: openDeposit },
        receive,
        send,
        withdraw,
      ]
    : [
        { title: "Deposit", icon: "coins", phoneIcon: "coins", run: openDeposit },
        send,
        receive,
        withdraw,
      ]

  const claimPending = useNameClaimPending()
  const card = (
    <section className="ww-home__wallet">
      <div className="ww-home__balance">
        <div className="ww-home__balance-label">
          {savings.available ? (
            <AccountSwitcher
              selected={account}
              onSelect={setAccount}
              mainBalance={balanceKnown ? mainText : "—"}
              savingsBalance={savingsText}
              total={totalText}
              apyLabel={apyLabel}
            />
          ) : (
            <span>Balance</span>
          )}
          <button
            type="button"
            className="zkm-btn-reset"
            aria-label="Toggle balance visibility"
            style={{ display: "inline-flex", color: "inherit" }}
            onClick={() => setHideBal(!hideBal)}
          >
            {phone && !hideBal ? (
              <PhoneIcon name="eye" size={18} />
            ) : (
              <Icon name={hideBal ? "eye-off" : "eye"} size={18} />
            )}
          </button>
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            {syncing && (
              <LiquidGlassPill
                label={
                  balanceSyncProgress === null
                    ? "Syncing deposits"
                    : `Syncing deposits - ${Math.round(balanceSyncProgress * 100)}%`
                }
                customIcon={
                  balanceSyncProgress === null ? (
                    <Spinner size={12} color="currentColor" />
                  ) : (
                    <ProgressSpinner
                      progress={balanceSyncProgress}
                      size={12}
                      color="currentColor"
                    />
                  )
                }
                iconLeading
                labelFontSize={12}
              />
            )}
            {customEndpoints && (
              <CustomEndpointsPill
                label={customEndpoints}
                onOpenSettings={() => navigate("/settings")}
              />
            )}
          </span>
        </div>
        {!hideBal && !balanceShown ? (
          <BalanceSkeleton />
        ) : (
          <span
            className={`ww-home__balance-value${
              phone && balanceText.length > 12 ? " ww-home__balance-value--long" : ""
            }${syncing ? " ww-home__balance-value--syncing" : ""}`}
            data-testid={onSavings ? "savings-balance" : "wallet-balance"}
            aria-busy={syncing}
          >
            {onSavings && !hideBal && savingsValueText !== undefined ? (
              <TickingUsd position={savings.position} at={(value) => value + arriving.savings} />
            ) : (
              balanceText
            )}
          </span>
        )}
        {onSavings && (apyLabel || (!hideBal && (earned !== undefined || calculating))) && (
          <div className="ww-home__balance-meta">
            {apyLabel && (
              <span
                className="ww-pill ww-pill--green"
                title="Current APY. The rate is variable and set by Sky."
              >
                {apyLabel}
              </span>
            )}
            {!hideBal && earned !== undefined && (
              <span className="ww-home__earned" title={EARNED_TITLE}>
                <b data-positive={earned > 0n || undefined}>
                  {earned > 0n ? "+" : ""}
                  {earned < 0n || !savingsLedger ? (
                    usdAtomicFloor(earned)
                  ) : (
                    <TickingUsd
                      position={savings.position}
                      at={(value) => savingsEarned(savingsLedger, value, sharesHeld) ?? earned}
                    />
                  )}{" "}
                  earned
                </b>
              </span>
            )}
            {!hideBal && earned === undefined && calculating && (
              <span className="ww-home__earned" title={EARNED_TITLE}>
                <b data-testid="earned-calculating">Calculating earnings…</b>
              </span>
            )}
          </div>
        )}
      </div>
      {!onSavings && <UpgradeBanner />}
      <HomeActions actions={actions} phone={phone} />
      {onSavings ? (
        savingsHydrated && savingsEntries.length === 0 ? (
          <div className="ww-home__cta">
            <SavingsArt />
            <PrimaryGradientButton title="Add to Savings" onClick={() => setSheet("in")} />
          </div>
        ) : (
          <HomeTransactions
            entries={savingsEntries}
            hydrated={savingsHydrated}
            onViewAll={() => navigate("/activity?account=savings")}
          />
        )
      ) : (
        <>
          {hydrated && requestsUnavailable && <RequestsUnavailableNotice />}
          {hydrated &&
            requestEntries.map((e) => (
              <div key={e.id} className="ww-home__request">
                {e.node}
              </div>
            ))}
          {hydrated && feedEntries.length === 0 ? (
            <div className="ww-home__cta">
              <DepositArt />
              <PrimaryGradientButton title="Deposit funds" onClick={openDeposit} />
            </div>
          ) : (
            <HomeTransactions
              entries={feedEntries}
              hydrated={hydrated}
              onViewAll={() => navigate("/activity")}
            />
          )}
        </>
      )}
    </section>
  )

  return (
    <>
      <HighL2FeeNotice />
      <HighGasNotice />
      <LostRegistrationNoticeCard />
      {!claimPending && <ActivationHome />}
      <RegisterNameCard />
      <div className="ww-home">
        {claimPending ? (
          <ActivationHome />
        ) : onSavings ? (
          <div className="ww-savings__main">
            {card}
            <SavingsCards onCalculator={() => setSheet("calculator")} />
          </div>
        ) : (
          card
        )}

        {/* The onboarding takes the full width until the name is claimed. */}
        {!phone && !claimPending && (
          <aside className="ww-home__rail">
            <QuickActions />

            <button
              type="button"
              className="zkm-btn-reset ww-banner ww-banner--row"
              onClick={() => navigate("/receive")}
            >
              <img src={shareTag} alt="" />
              <span className="ww-banner__text">
                <span className="ww-banner__title">Share your @tag</span>
                <span className="ww-banner__body">Let your friend find you directly.</span>
              </span>
              <span className="ww-banner__chevron">
                <Icon name="chevron-right" size={8.5} color="#fff" />
              </span>
            </button>

            {inviteOpen && inviteUrl && (
              <div className="ww-invite-card">
                <span className="ww-invite-card__title">Invite friends</span>
                <button
                  type="button"
                  className="zkm-btn-reset ww-invite-card__close"
                  aria-label="Dismiss"
                  onClick={() => setInviteOpen(false)}
                >
                  <Icon name="x" size={14} />
                </button>
                <img className="ww-invite-card__art" src={gift} alt="" />
                <div className="ww-invite-card__field">
                  <span>Referral link</span>
                  <code>{inviteText}</code>
                  <button
                    type="button"
                    className="zkm-btn-reset"
                    aria-label={inviteCopied ? "Copied" : "Copy referral link"}
                    onClick={() => void copyInvite(inviteUrl)}
                  >
                    <Icon name={inviteCopied ? "check" : "copy"} size={16} />
                  </button>
                </div>
                <div className="ww-invite-card__buttons">
                  <button
                    type="button"
                    className="zkm-btn-reset"
                    onClick={() => void copyInvite(inviteUrl)}
                  >
                    {inviteCopied ? "Copied!" : "Copy link"}
                  </button>
                  <button
                    type="button"
                    className="zkm-btn-reset"
                    onClick={() => void shareInvite()}
                  >
                    {inviteShared ? "Link copied!" : "Share"}
                    <Icon name="share-box" size={20} color="#fff" />
                  </button>
                </div>
              </div>
            )}

            <div className="ww-banner ww-banner--row ww-banner--ios">
              <img src={iosApp} alt="" />
              <span className="ww-banner__text">
                <span className="ww-banner__title">iOS app release</span>
                <span className="ww-banner__body">Coming out soon.</span>
              </span>
            </div>
          </aside>
        )}
      </div>

      {claim.modal}
      {detailModals}
      {(sheet === "in" || sheet === "out") && (
        <MoveFundsSheet direction={sheet} onClose={() => setSheet(null)} />
      )}
      {sheet !== null && typeof sheet === "object" && (
        <MoveFundsSheet
          direction="in"
          initialAmount={sheet.amount}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "calculator" && (
        <EarningsCalculatorSheet
          apy={apy}
          balances={{
            savings: savings.position?.value,
            main: balanceKnown ? parseUnits(walletBalance, DEFAULT_DECIMALS) : undefined,
          }}
          onMove={(amount) => openMove("in", String(amount))}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  )
}
