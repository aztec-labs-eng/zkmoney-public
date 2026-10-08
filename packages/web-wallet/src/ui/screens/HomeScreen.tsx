import { useEffect, useRef, useState } from "react"
import {
  HomeQuickActionsRow,
  Icon,
  LiquidGlassPill,
  PrimaryGradientButton,
  ProgressSpinner,
  Spinner,
} from "@obsidion/web-ds"
import { useBalance } from "@obsidion/front-core"
import { useNavigate } from "react-router-dom"
import { DepositArt } from "../DepositArt"
import { HighGasNotice } from "../HighGasNotice"
import { PhoneIcon, type PhoneIconName } from "../PhoneIcon"
import { usePhoneLayout } from "../usePhoneLayout"
import gift from "../../assets/home/gift.webp"
import iosApp from "../../assets/home/ios-app.webp"
import quickFresh from "../../assets/home/quick-fresh.webp"
import quickPaylink from "../../assets/home/quick-paylink.webp"
import shareTag from "../../assets/home/share-tag.webp"
import { loadWalletIdentity } from "../../features/identity/walletIdentity"
import { LostRegistrationNoticeCard } from "../../features/onboarding/LostRegistrationNoticeCard"
import { useRegistrationDepositOwed } from "../../features/onboarding/openRegistration"
import { openActivationPrompt } from "../../features/onboarding/activationPrompt"
import { ShareTagModal } from "../../features/contacts/ShareTagModal"
import {
  RegisterNameCard,
  SecureNameNoticeCard,
} from "../../features/onboarding/SecureNameNoticeCard"
import { getConfig } from "../../config/env"
import { healRegistrationDeposits } from "../../features/onboarding/registrationDepositSeed"
import { peekClaimStash } from "../../features/paylink/claimStash"
import { takeClaimPromptRequest, useClaimPromptRequest } from "../../features/paylink/claimPrompt"
import { useClaimLinkFlow } from "../../features/paylink/useClaimLinkFlow"
import { useFreshAddressAvailable } from "../../features/withdraw/freshAddressAvailability"
import { usdBalance } from "../format"
import { useHideBalances } from "../prefs"
import { useCopy, useLinkSharing } from "../hooks"
import { ActivityListSkeleton, BalanceSkeleton } from "../Skeletons"
import { customEndpointsLabel } from "../EndpointsModal"
import { useActivityEntries, type ActivityEntry } from "./useActivityEntries"

/**
 * Home. Reached through the identity and unlock gates. Balance comes from
 * the shared front-core asset layer.
 */
const HOME_TXN_TABS = ["Transactions", "Pending"] as const

/** The wallet card's recent-activity widget: two tabs over the shared feed, three newest rows. */
function HomeTransactions({
  entries,
  hydrated,
  onViewAll,
}: {
  entries: ActivityEntry[]
  hydrated: boolean
  onViewAll: () => void
}) {
  const [tab, setTab] = useState<(typeof HOME_TXN_TABS)[number]>("Transactions")
  const visible = (tab === "Pending" ? entries.filter((e) => e.pending) : entries).slice(0, 3)

  return (
    <div className="ww-home-txns">
      <div className="ww-home-txns__bar">
        <div className="ww-home-txns__tabs">
          {HOME_TXN_TABS.map((t) => (
            <button
              aria-pressed={tab === t}
              key={t}
              type="button"
              className="zkm-btn-reset"
              data-active={tab === t || undefined}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <button type="button" className="zkm-btn-reset ww-home-txns__viewall" onClick={onViewAll}>
          View all
        </button>
      </div>
      <div className="ww-home-txns__rows">
        {!hydrated && <ActivityListSkeleton rows={3} />}
        {hydrated && visible.map((entry) => entry.node)}
        {hydrated && visible.length === 0 && (
          <span className="ww-home-txns__empty">Nothing pending.</span>
        )}
      </div>
    </div>
  )
}

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
  const slides = QUICK_SLIDES.filter((slide) => slide.id !== "fresh" || fresh)
  const paged = slides.length > 1
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
  const identity = loadWalletIdentity()
  // Until the boot detection settles a pending registration, the tag renders as
  // claiming-in-progress — never as settled ownership of a name that may be lost.
  const { walletBalance, balanceKnown, balanceSyncing, balanceSyncProgress } = useBalance()
  const [hideBal, setHideBal] = useHideBalances()
  const balanceText = hideBal ? "$••••••" : usdBalance(walletBalance)
  const [inviteOpen, setInviteOpen] = useState(true)
  // While the name waits for its deposit, every Deposit control raises the activation sheet the
  // shell hosts, since that deposit is the one the account needs first.
  const nameAwaitingDeposit = useRegistrationDepositOwed()
  const openDeposit = () => (nameAwaitingDeposit ? openActivationPrompt() : navigate("/deposit"))
  const [shareTagOpen, setShareTagOpen] = useState(false)
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
  )
  const { entries, hydrated, detailModals } = useActivityEntries()
  const customEndpoints = customEndpointsLabel(getConfig().endpoints)
  const requestEntries = entries.filter((entry) => entry.incomingRequest)
  const feedEntries = entries.filter((entry) => !entry.incomingRequest)

  const inviteLink = `invite.zk.money/@${identity?.handle ?? ""}`
  const inviteUrl = `https://${inviteLink}`
  const { copied: inviteCopied, copy: copyInvite } = useCopy()
  // Share falls back to the clipboard where the Web Share API is absent, and says so.
  const { copied: inviteShared, share: shareInvite } = useLinkSharing(inviteUrl, "Invite friends")

  return (
    <>
      <HighGasNotice />
      <LostRegistrationNoticeCard />
      <SecureNameNoticeCard onActivate={openActivationPrompt} />
      <RegisterNameCard />
      <div className="ww-home">
        <section className="ww-home__wallet">
          <div className="ww-home__balance">
            <div className="ww-home__balance-label">
              <span>Balance</span>
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
                {balanceKnown && balanceSyncing && (
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
            {!hideBal && !balanceKnown ? (
              <BalanceSkeleton />
            ) : (
              <span
                className={`ww-home__balance-value${
                  phone && balanceText.length > 12 ? " ww-home__balance-value--long" : ""
                }${balanceKnown && balanceSyncing ? " ww-home__balance-value--syncing" : ""}`}
                data-testid="wallet-balance"
                aria-busy={balanceKnown && balanceSyncing}
              >
                {balanceText}
              </span>
            )}
          </div>
          {phone ? (
            <div className="zkm-quick-actions ww-home__phone-actions">
              {(
                [
                  ["Deposit", "coins", "/deposit"],
                  ["Receive", "arrow-down", "/receive"],
                  ["Send", "send", "/send"],
                  ["Withdraw", "tray-withdraw", "/withdraw"],
                ] satisfies [string, PhoneIconName, string][]
              ).map(([title, icon, path]) => (
                <button
                  key={title}
                  type="button"
                  className="zkm-btn-reset zkm-quick-action zkm-pressable"
                  onClick={() => (path === "/deposit" ? openDeposit() : navigate(path))}
                >
                  <span className="zkm-quick-action__tile">
                    <PhoneIcon name={icon} size={32} />
                  </span>
                  <span className="zkm-quick-action__caption">{title}</span>
                </button>
              ))}
            </div>
          ) : (
            <HomeQuickActionsRow
              actions={[
                { title: "Deposit", icon: "coins", onClick: openDeposit },
                { title: "Send", icon: "send", onClick: () => navigate("/send") },
                { title: "Receive", icon: "arrow-down", onClick: () => navigate("/receive") },
                { title: "Withdraw", icon: "tray-withdraw", onClick: () => navigate("/withdraw") },
              ]}
            />
          )}
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
        </section>

        {!phone && (
          <aside className="ww-home__rail">
            <QuickActions />

            <button
              type="button"
              className="zkm-btn-reset ww-banner ww-banner--row"
              onClick={() => setShareTagOpen(true)}
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

            {inviteOpen && (
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
                  <code>{inviteLink}</code>
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
      {shareTagOpen && <ShareTagModal onClose={() => setShareTagOpen(false)} />}
    </>
  )
}
