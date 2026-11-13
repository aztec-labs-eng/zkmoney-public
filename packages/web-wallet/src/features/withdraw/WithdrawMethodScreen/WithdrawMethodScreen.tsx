import { useEffect, useId, useRef, useState } from "react"
import { useLocation, useMatch, useNavigate } from "react-router-dom"
import { ContactRow, Icon, NumberedStepRow, RowChevron } from "@obsidion/web-ds"
import { useStore } from "@obsidion/front-core"
import { isDesktopL1SubmitActive } from "../../../platform/desktopBridge"
import { useL1Wallet } from "../../../session/useL1Wallet"
import { useSession } from "../../../session/session"
import { etherfiEntryShown } from "../../../config/features"
import { fireEvent } from "../../../lib/analytics"
import { IconStack } from "../../../ui/IconStack/IconStack"
import { ChainStack } from "../../../ui/flow/ChainStack/ChainStack"
import { MethodOption } from "../../../ui/MethodOption/MethodOption"
import { shortL1Addr } from "../../../ui/format"
import { useScreenFlow } from "../../../ui/useScreenFlow"
import { CoinIcon } from "../../../ui/CoinIcon/CoinIcon"
import { PrivacyBadge, PrivacyPopover, PrivacyRatedModal } from "../PrivacyBadge/PrivacyBadge"
import { useWalletPrivacy } from "../useWalletPrivacy"
import { isEtherfiContact, useSavedL1WalletList } from "../../../session/savedL1Wallets"
import { WITHDRAWAL_RECEIVE_ASSETS } from "../withdrawAssets"
import type { BridgeOutChain } from "../bridgeOutQuote"
import { UNREAD } from "../../fees/highFees"
import { preferredBridgeChain } from "../../deposit/bridgeChains"
import { useOxideTuple } from "../useOxideTuple"
import { useFreshAddressAvailable } from "../freshAddressAvailability"
import { useEtherfiAvailable } from "../etherfi"
import etherfiCopy from "../etherfi.copy"
import { WithdrawFlow } from "../WithdrawFlow/WithdrawFlow"
import type { WithdrawFlowEntry, WithdrawLocationState } from "../../../session/routeStates"
import type { WithdrawStart } from "../WithdrawFlow/withdrawStart"
import { connectedRecipient } from "../WithdrawFlow/walletRecipient"
import copy from "./WithdrawMethodScreen.copy"
import chainsCopy from "../../../ui/chains.copy"

/** How to add a history-free account in the wallets users most often already hold. */
const WALLET_GUIDES = [
  {
    name: "MetaMask",
    steps: [
      "Open MetaMask and click the account name at the top.",
      "Choose Add account or hardware wallet, then Add a new account.",
      "Copy the new address and paste it on the next step.",
    ],
  },
  {
    name: "Rainbow",
    steps: [
      "Open Rainbow and tap the account name at the top.",
      "Choose Add another wallet, then Create a new wallet.",
      "Copy the new address and paste it on the next step.",
    ],
  },
  {
    name: "Rabby",
    steps: [
      "Open Rabby and click the address at the top.",
      "Choose Add an address, then Add from current seed phrase.",
      "Copy the new address and paste it on the next step.",
    ],
  },
] as const

function FreshAddressHowTo() {
  const [open, setOpen] = useState(false)
  const [guide, setGuide] = useState<(typeof WALLET_GUIDES)[number]>(WALLET_GUIDES[0])
  const bodyId = useId()
  return (
    <div className="ww-deposit__facts ww-withdraw__howto">
      <button
        type="button"
        className="zkm-btn-reset ww-sheet__fact"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
      >
        Need a fresh address? See how to create one.
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </button>
      {open && (
        <div id={bodyId} className="ww-deposit__fields">
          <div className="zkm-amount-chips" role="tablist" aria-label={copy.walletGuides}>
            {WALLET_GUIDES.map((g) => (
              <button
                key={g.name}
                type="button"
                role="tab"
                aria-selected={g === guide}
                className={
                  "zkm-btn-reset zkm-pressable zkm-amount-chip zkm-amount-chip--flat" +
                  (g === guide ? " zkm-amount-chip--selected" : "")
                }
                onClick={() => setGuide(g)}
              >
                {g.name}
              </button>
            ))}
          </div>
          <div className="ww-deposit__fields" role="tabpanel">
            {guide.steps.map((step, i) => (
              <NumberedStepRow key={step} index={i + 1}>
                {step}
              </NumberedStepRow>
            ))}
          </div>
          <p className="ww-sheet__note">
            A new account in a wallet you already own is fine: onchain it has no history. Your main
            account does.
          </p>
        </div>
      )}
    </div>
  )
}

/** Reports the landing's open once, when it shows without an entry's sheet over it. */
function useReportPickerOpened() {
  const atPicker = useMatch("/withdraw") !== null
  const reported = useRef(false)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (!atPicker || reported.current) return
    reported.current = true
    fireEvent("withdraw_opened", { method: "picker" })
  }, [atPicker])
}

const NO_ROUTES: BridgeOutChain[] = []

/** `.ww-privacy__pop`'s distance from the row's center, and the room it keeps from the edge. */
const POP_GAP = 17
const POP_MARGIN = 8

/** Whether a privacy row's popover fits between its badge and the page's visible bottom. */
function popFitsBelow(row: HTMLElement) {
  const pop = row.querySelector<HTMLElement>(".ww-privacy__pop")
  if (!pop) return true
  const rect = row.getBoundingClientRect()
  const main = row.closest(".ww-main")?.getBoundingClientRect().bottom ?? window.innerHeight
  const top = rect.top + rect.height / 2 + POP_GAP
  return top + pop.offsetHeight + POP_MARGIN <= Math.min(main, window.innerHeight)
}

/**
 * `/withdraw`: the entry banners over the saved wallets, each opening `WithdrawFlow`.
 * `/withdraw/fresh`, `/withdraw/bridge` and `/withdraw/etherfi` open it on that entry, and a
 * navigation carrying {@link WithdrawLocationState} opens it at once.
 */
export function WithdrawMethodScreen({
  start,
}: {
  /** Where the landing and its flow open on their first showing. */
  start?: WithdrawStart
}) {
  const { page } = useSession()
  const { config } = page
  // The start holds for the flow's first showing only: closing it ends it.
  const [opening, setOpening] = useState(start)
  const available = useFreshAddressAvailable()
  const { wallets: saved, failed: savedFailed } = useSavedL1WalletList(Infinity)
  const rated = useWalletPrivacy(saved)
  const [ratedOpen, setRatedOpen] = useState(false)
  // The saved wallet whose privacy popover opens above its badge.
  const [popAbove, setPopAbove] = useState<string>()
  const etherfiAvailable = useEtherfiAvailable(etherfiEntryShown)
  const etherfi = etherfiEntryShown && etherfiAvailable
  const tuple = useOxideTuple()
  const routesRead = useStore(tuple ? page.bridgeOutRoutes(tuple.l2Token) : UNREAD)
  const routes = routesRead.status === "ready" ? routesRead.value : NO_ROUTES
  const withdrawChains = [
    { chainId: config.l1ChainId, name: chainsCopy.ethereum },
    ...routes.map(({ chain }) => chain),
  ]
  const routesKnown = tuple === null || routesRead.status !== "pending"
  const bridgeStart = preferredBridgeChain(
    routes.map((route) => route.chain),
    config.l1ChainId,
  )
  const location = useLocation()
  const navigate = useNavigate()
  const requested = (location.state as WithdrawLocationState | null)?.withdraw
  const [flow, setFlow] = useState<WithdrawFlowEntry | undefined>(start?.entry ?? requested)
  const segment = useMatch("/withdraw/:entry")?.params.entry
  // The bridge entry waits for the routes, so it starts on the first bridge chain.
  const routed: WithdrawFlowEntry | undefined =
    segment === "fresh"
      ? {}
      : segment === "bridge" && routesKnown
      ? bridgeStart
        ? { startChainId: bridgeStart.chainId }
        : {}
      : segment === "etherfi"
      ? { start: "etherfi" }
      : undefined
  const entry = routed ?? flow
  // A start's page opens the flow in place.
  const open = (path: string, next: WithdrawFlowEntry) =>
    start ? setFlow(next) : navigate(`/withdraw/${path}`)
  useReportPickerOpened()

  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  /** For the connected account, the network its wallet is on, where the flow offers it. */
  const walletStart = (address: string) =>
    l1.account?.toLowerCase() === address.toLowerCase()
      ? withdrawChains.find((c) => c.chainId === l1.chainId)?.chainId
      : undefined
  const landing = useScreenFlow(
    { requested, location, navigate, l1, saved, withdrawChains, entry },
    (live) => {
      let dropped = false
      let shown: AbortSignal | undefined
      return {
        /** Drops the request that opened the flow, so a reload does not reopen it. */
        start(signal: AbortSignal) {
          shown = signal
          const { requested, location, navigate } = live()
          if (dropped || !requested) return
          dropped = true
          navigate(location.pathname + location.search, { replace: true, state: null })
        },
        /** Connects a new wallet, then opens the flow to it on the network and coin picker. */
        async connectThenPick() {
          // The desktop launcher has no wallet extension to connect: the address step takes one.
          if (isDesktopL1SubmitActive()) return setFlow({})
          const { openPicker, pickerShown } = live().l1
          const wallet = await page.l1Wallet.connectAnother(openPicker, pickerShown, shown)
          const { saved, withdrawChains, entry: open } = live()
          // A wallet connected from an open flow is that flow's.
          if (!wallet || open) return
          const { account, chainId, walletName } = wallet
          const entry = saved.find((w) => w.address.toLowerCase() === account.toLowerCase())?.entry
          setFlow({
            ...connectedRecipient(account, saved, walletName),
            etherfi: !!entry && isEtherfiContact(entry),
            atAmount: true,
            pick: true,
            startChainId: withdrawChains.find((c) => c.chainId === chainId)?.chainId,
          })
        },
      }
    },
  )

  return (
    <div className="ww-move-landing ww-move-landing--withdraw">
      <h1>{copy.title}</h1>
      {available !== undefined && etherfi !== undefined && (
        <>
          {(available || routes.length > 0) && (
            <div className="ww-move-landing__intro">
              <div className="ww-method-banners">
                {available && (
                  <MethodOption
                    banner
                    title={copy.fresh.title}
                    body={copy.fresh.body}
                    testId="withdraw-fresh"
                    onOpen={() => open("fresh", {})}
                  >
                    <IconStack front>
                      {WITHDRAWAL_RECEIVE_ASSETS.map((asset) => (
                        <CoinIcon key={asset.id} token={asset} size={26} />
                      ))}
                    </IconStack>
                  </MethodOption>
                )}
                {routes.length > 0 && (
                  <MethodOption
                    banner
                    title={copy.bridge.title}
                    body={copy.bridge.body}
                    testId="withdraw-bridge-out"
                    onOpen={() => open("bridge", { startChainId: bridgeStart!.chainId })}
                  >
                    <span className="ww-deposit-banner__icons">
                      <ChainStack chains={withdrawChains} size={26} />
                    </span>
                  </MethodOption>
                )}
              </div>
              {available && <FreshAddressHowTo />}
            </div>
          )}
          {entry && (
            <WithdrawFlow
              key={routed ? segment : "flow"}
              entry={entry}
              routes={routes}
              l1ChainId={config.l1ChainId}
              start={opening}
              onClose={() => {
                setOpening(undefined)
                setFlow(undefined)
                if (routed) navigate("/withdraw", { replace: true })
              }}
            />
          )}
          <section className="ww-move-landing__wallets">
            <span className="ww-move-landing__wallets-head">{copy.savedWallets}</span>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-move-landing__new ww-move-landing__new--wallet"
              data-testid="withdraw-new-address"
              onClick={() => void landing.connectThenPick()}
            >
              <span className="ww-move-landing__plus">
                <Icon name="wallet" size={20} />
              </span>
              <span>
                <b>{copy.connect}</b>
                <small>{copy.connectDetail}</small>
              </span>
              <RowChevron />
            </button>
            {/* Without a banner that opens it, the address step keeps its own row. */}
            {!available && routes.length === 0 && (
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-move-landing__new ww-move-landing__new--wallet"
                data-testid="withdraw-typed-address"
                onClick={() => setFlow({})}
              >
                <span className="ww-move-landing__plus">
                  <Icon name="plus" size={20} />
                </span>
                <span>
                  <b>{copy.newAddress}</b>
                </span>
                <RowChevron />
              </button>
            )}
            {savedFailed && (
              <p className="ww-pay__error" role="alert" data-testid="withdraw-saved-failed">
                {copy.savedFailed}
              </p>
            )}
            {saved.length > 0 && (
              <div className="ww-move-landing__list">
                {saved.map((wallet) => {
                  const privacy = rated.get(wallet.address.toLowerCase())
                  const row = (
                    <ContactRow
                      key={wallet.address}
                      name={wallet.name}
                      tag={shortL1Addr(wallet.address)}
                      isL1
                      onClick={() =>
                        setFlow({
                          recipient: wallet.address,
                          name: wallet.name,
                          etherfi: isEtherfiContact(wallet.entry),
                          atAmount: true,
                          startChainId: walletStart(wallet.address),
                        })
                      }
                      trailing={privacy && <PrivacyBadge privacy={privacy} />}
                    />
                  )
                  if (!privacy) return row
                  return (
                    <div
                      key={wallet.address}
                      className="ww-privacy-row"
                      data-place={popAbove === wallet.address ? "above" : undefined}
                      onPointerEnter={(e) =>
                        setPopAbove(popFitsBelow(e.currentTarget) ? undefined : wallet.address)
                      }
                    >
                      {row}
                      <PrivacyPopover
                        privacy={privacy}
                        onRated={() => setRatedOpen(true)}
                        onFresh={available ? () => setFlow({}) : undefined}
                      />
                    </div>
                  )
                })}
              </div>
            )}
            {etherfi && (
              <MethodOption
                icon={<Icon name="bank" size={22} color="#fff" />}
                title={copy.etherfi.title}
                body={copy.etherfi.body}
                onOpen={() => open("etherfi", { start: "etherfi" })}
              >
                <span className="ww-withdraw__tags">
                  <span className="ww-withdraw__tag" data-tone="warning">
                    {etherfiCopy.assets}
                  </span>
                </span>
              </MethodOption>
            )}
          </section>
        </>
      )}
      {ratedOpen && <PrivacyRatedModal onClose={() => setRatedOpen(false)} />}
    </div>
  )
}
