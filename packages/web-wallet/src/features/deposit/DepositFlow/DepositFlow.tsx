import { Fragment, useState, type ReactNode } from "react"
import { useStore } from "@obsidion/front-core"
import { Icon, PrimaryGradientButton, RowChevron } from "@obsidion/web-ds"
import { fmt } from "../../../lib/fmt"
import { Crumb } from "../../../ui/flow/Crumb/Crumb"
import { FlowCard, FlowHead } from "../../../ui/flow/FlowCard/FlowCard"
import flowCopy from "../../../ui/flow/flow.copy"
import flowStyles from "../../../ui/flow/flow.module.css"
import { NetworkCoinPicker } from "../../../ui/flow/NetworkCoinPicker/NetworkCoinPicker"
import { WalletPill } from "../../../ui/flow/WalletPill/WalletPill"
import type { Coin, PickerNetwork } from "../../../ui/flow/NetworkCoinPicker/NetworkCoinPicker"
import { settleStep, useFlowSteps } from "../../../ui/flow/useFlowSteps"
import { ModalSteps } from "../../../ui/Modal"
import {
  lastDepositNetwork,
  rememberDepositNetwork,
} from "../../../platform/storage/lastDepositNetwork"
import type { SavedL1Wallet } from "../../../session/savedL1Wallets"
import { useSession } from "../../../session/session"
import { tokenName } from "../../token/tokenName"
import { firstDepositNetwork } from "../bridgeChains"
import type { BridgeRoute } from "../bridgeChains"
import { CoinIcon, OriginTokenIcon } from "../../../ui/CoinIcon/CoinIcon"
import { DepositPrivacyDisclaimer } from "../DepositPrivacyDisclaimer/DepositPrivacyDisclaimer"
import walletCopy from "../ChangeWalletPicker/ChangeWalletPicker.copy"
import type { DepositTokenOption } from "../../sipa/loadDepositFacts"
import copy from "./DepositFlow.copy"
import styles from "./DepositFlow.module.css"

type Step = "pick" | "intro" | "method" | "privacy"
export type DepositFlowStep = Step

export type WalletKind = "fund" | "bridge"

/** What the landing entry asked for: after the pick, the wallet, the address or the method. */
export type DepositIntent = "wallet" | "address" | "bridge"

/**
 * "start" picks for the intro step and moves on; "change" changes the open step in place; "wallet"
 * changes the account the open sheet sends from.
 */
type PickerMode = "start" | "change" | "wallet"

/** What the user picked in the first step. */
export interface DepositOrigin {
  chainId: number
  symbol: string
}

/** Moves the flow from a sheet the screen hosts in it. */
export interface DepositFlowNav {
  origin: DepositOrigin
  /** Back to the first step, the picks kept. */
  restart: () => void
  /** On to the wallet that sends the picked coin. */
  toWallet: () => void
  /** The network and coin over the sheet; `locked` while a send or an address is in flight. */
  crumb: (locked: boolean) => ReactNode
  /** Opens the network and coin picker; a pick there changes the open step in place. */
  change: () => void
  /** Opens the wallet picker over the open sheet; set with `walletPicker`. */
  changeWallet?: () => void
}

/** A sheet the screen owns, shown as the flow's current step. */
export interface DepositFlowSheet {
  key: string
  node: ReactNode
  /** Follows a new network or coin, or closes the sheet for the flow to pick the next step. */
  onOrigin?: (next: DepositOrigin) => "kept" | "closed"
}

/** Wording a payment flow swaps in for the deposit copy. */
export interface DepositFlowLabels {
  /** The picker's title and the intro's field. */
  from?: string
  /** The method row that leads to the address. */
  address?: string
  /** Why the wallet row is off, shown in its place while it is. */
  walletBlocked?: string
}

/**
 * One modal for every deposit: network and coin from one picker, then how to send, then the
 * address or the wallet. The address, funding and bridge sheets belong to the screen; it hands back the one that
 * is open through `sheet`, and closing it returns to the step under it.
 */
export function DepositFlow({
  l1ChainId,
  chainName,
  coins,
  token,
  onPickToken,
  routes,
  saved,
  wallet,
  walletChainId,
  intent,
  startChainId,
  startSymbol,
  originLocked = false,
  steps,
  intro,
  labels,
  fundReady,
  bridgeReady = true,
  addressReady,
  status,
  privacyRows,
  onAddress,
  onWallet,
  sheet,
  walletPicker,
  onClose,
}: {
  l1ChainId: number
  chainName: string
  /** The L1 deposit coins. */
  coins: DepositTokenOption[]
  /** The L1 coin the screen prices. */
  token: DepositTokenOption
  onPickToken: (token: DepositTokenOption) => void
  /** The other chains, in profile order. */
  routes: BridgeRoute[]
  /** The saved wallet the flow was opened from. */
  saved?: SavedL1Wallet
  /** The connected wallet; named over the picker when the flow sends from it. */
  wallet?: { name: string; address: string }
  /** The connected wallet's chain: a wallet's flow opens on it where offered. */
  walletChainId?: number
  /** Unset, a pick moves on to the method. */
  intent?: DepositIntent
  /** The network the intro starts on; the L1 when unset. */
  startChainId?: number
  /** The coin the intro starts on, where that network offers it. */
  startSymbol?: string
  /** The network and coin are set: their controls show them and open no picker. */
  originLocked?: boolean
  /** The steps it opens on, the last one showing. */
  steps?: DepositFlowStep[]
  /** A first step over the picker: the heading, then the picked coin with its L1 note. */
  intro?: { heading: ReactNode; l1Note: ReactNode }
  /** Wording for a flow that pays rather than deposits; each falls back to the deposit copy. */
  labels?: DepositFlowLabels
  /** The L1 fee is known, so a wallet can fund. */
  fundReady: boolean
  /** A wallet can bridge in. */
  bridgeReady?: boolean
  /** An address can be handed out now. */
  addressReady: boolean
  /** Why no deposit can start; replaces the first step's picker or fields. */
  status?: ReactNode
  /** The privacy step's minimum, fee and limit rows; unset, the address follows the method. */
  privacyRows?: ReactNode
  onAddress: () => void
  /** Sends from the connected wallet, connecting one first when there is none. */
  onWallet: (kind: WalletKind, saved?: SavedL1Wallet) => void
  sheet: (nav: DepositFlowNav) => DepositFlowSheet | undefined
  /** The wallet picker's rows; `close` returns to the sheet under it. */
  walletPicker?: (close: () => void) => ReactNode
  onClose: () => void
}) {
  const { device, database } = useSession()
  const first: Step = intro ? "intro" : "pick"
  const [history, setHistory] = useState<Step[]>(steps ?? [first])
  const [chainId, setChainId] = useState(startChainId ?? l1ChainId)
  const [symbol, setSymbol] = useState(startSymbol ?? token.symbol)
  const [picking, setPicking] = useState<PickerMode | null>(null)
  // The last mode opened, still shown while the closed picker slides out.
  const [mode, setMode] = useState<PickerMode>("start")
  // Each opening remounts the picker, which starts it again from the current pick.
  const [opened, setOpened] = useState(0)
  const lastNetwork = lastDepositNetwork(useStore(device).lastDepositNetwork)

  const networks: PickerNetwork[] = [
    { chainId: l1ChainId, name: chainName },
    ...routes.map(({ chain }) => ({ chainId: chain.chainId, name: chain.name })),
  ]
  const coinsOn = (id: number, size = 32): Coin[] =>
    id === l1ChainId
      ? coins.map((coin) => ({
          symbol: coin.symbol,
          name: tokenName(coin.symbol),
          icon: <CoinIcon token={coin} size={size} badge={false} />,
        }))
      : (routes.find((r) => r.chain.chainId === id)?.tokens ?? []).map((t) => {
          return {
            symbol: t.symbol,
            name: tokenName(t.symbol),
            icon: <OriginTokenIcon symbol={t.symbol} coins={coins} size={size} />,
            comingSoon: t.comingSoon,
          }
        })
  const network = networks.find((n) => n.chainId === chainId) ?? networks[0]!
  const offered = coinsOn(network.chainId)
  const coin = offered.find((c) => c.symbol === symbol && !c.comingSoon) ?? offered[0]!
  const onL1 = network.chainId === l1ChainId
  const firstNetwork = firstDepositNetwork({
    intent,
    networks,
    l1ChainId,
    lastNetwork,
    walletChainId,
  })

  /** Keeps the coin where the network offers it, else its first; an L1 coin is the screen's. */
  const pick = (nextChain: number, nextSymbol: string): DepositOrigin | undefined => {
    const list = coinsOn(nextChain).filter((c) => !c.comingSoon)
    const kept = list.find((c) => c.symbol === nextSymbol) ?? list[0]
    setChainId(nextChain)
    // A payment's network is not a deposit's.
    if (!intro) {
      rememberDepositNetwork(database, nextChain)
    }
    if (!kept) return undefined
    setSymbol(kept.symbol)
    const l1Coin = nextChain === l1ChainId && coins.find((c) => c.symbol === kept.symbol)
    if (l1Coin) onPickToken(l1Coin)
    return { chainId: nextChain, symbol: kept.symbol }
  }
  const go = (next: Step) => setHistory((h) => [...h, next])
  /** `l1` is the network about to be picked, where it is not yet the shown one. */
  const toWallet = (l1 = onL1) => onWallet(l1 ? "fund" : "bridge", saved)
  /** Where the first pick leads: the step the intent names when it can start, else the method. */
  const proceed = (nextChain: number) => {
    const l1 = nextChain === l1ChainId
    if (intent === "wallet" && (l1 ? fundReady : bridgeReady)) return toWallet(l1)
    if (intent === "address" && l1 && addressReady && privacyRows) return go("privacy")
    go("method")
  }
  /** The method note's switch to the L1, where the address works. */
  const toL1 = () => {
    if (!pick(l1ChainId, coin.symbol)) return
    if (intent === "address" && addressReady && privacyRows) go("privacy")
  }

  /** A pick from the crumb: the open step follows it, or the flow re-plans from the method. */
  const change = (nextChain: number, nextSymbol: string) => {
    if (nextChain === network.chainId && nextSymbol === coin.symbol) return
    const next = pick(nextChain, nextSymbol)
    if (!next) return
    // The address is on the L1 only.
    const kept = open
      ? open.onOrigin?.(next) === "kept"
      : step !== "privacy" || next.chainId === l1ChainId
    if (kept) return
    setHistory([first, "method"])
    toWallet(next.chainId === l1ChainId)
  }
  const openPicker = (next: PickerMode) => {
    setOpened((n) => n + 1)
    setMode(next)
    setPicking(next)
  }
  const crumb = (locked: boolean) => (
    <Crumb
      network={network}
      coin={coin.symbol}
      coinIcon={coinsOn(network.chainId, 20).find((c) => c.symbol === coin.symbol)?.icon}
      locked={locked || originLocked}
      onOpen={() => openPicker("change")}
    />
  )

  const nav: DepositFlowNav = {
    origin: { chainId: network.chainId, symbol: coin.symbol },
    restart: () => setHistory([first]),
    toWallet: () => toWallet(),
    crumb,
    change: () => openPicker("change"),
    changeWallet: walletPicker && (() => openPicker("wallet")),
  }
  const open = sheet(nav)
  // A deposit that cannot start now says why in place of the first step.
  const blocked = !!status && !open
  const step = blocked ? first : history.at(-1) ?? first

  const { showPicker, key, dir } = useFlowSteps({
    key: open?.key ?? step,
    depth: history.length + (open ? 1 : 0),
    picking: !!picking,
    opensOnPicker: first === "pick",
  })

  /** Every step goes back; the first one closes the flow. */
  const back = () => {
    if (showPicker) return setPicking(null)
    if (history.length > 1) return setHistory((h) => h.slice(0, -1))
    onClose()
  }
  /** A coin from the overlay: the intro moves on to the method, a change returns to its step. */
  const choose = (chain: number, symbol: string) => {
    const was = picking
    if (!was || was === "wallet") return
    setPicking(null)
    if (was === "change") return change(chain, symbol)
    pick(chain, symbol)
    go("method")
  }

  const card = (label: string, children: ReactNode, crumbed = false, className?: string) => (
    <FlowCard
      label={label}
      onBack={back}
      onClose={onClose}
      crumb={crumbed && crumb(false)}
      className={className}
    >
      {children}
    </FlowCard>
  )
  const head = (title: string, subtitle?: string) => <FlowHead title={title} subtitle={subtitle} />
  const row = (
    props: {
      icon: ReactNode
      title: string
      detail?: string
      comingSoon?: boolean
      onClick: () => void
      testId: string
    },
    disabled = false,
  ) => (
    <button
      type="button"
      data-testid={props.testId}
      className={[
        "zkm-btn-reset zkm-pressable ww-move-landing__new ww-move-landing__new--wallet",
        flowStyles.row,
        props.comingSoon && styles.soon,
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={disabled || props.comingSoon}
      onClick={props.onClick}
    >
      <span className="ww-move-landing__plus">{props.icon}</span>
      <span>
        <b className={styles.rowTitle}>
          <span>{props.title}</span>
          {props.comingSoon && <span className={styles.soonPill}>{copy.method.soon}</span>}
        </b>
        {props.detail && <small>{props.detail}</small>}
      </span>
      {!props.comingSoon && !disabled && <RowChevron />}
    </button>
  )

  const pickerTitle = labels?.from ?? copy.title
  const walletAside = intent === "wallet" && wallet && (
    <WalletPill wallet={wallet.name} address={wallet.address} />
  )
  const picker = () => {
    if (mode === "wallet" && walletPicker) {
      const close = () => setPicking(null)
      return (
        <FlowCard label={walletCopy.title} onBack={close} onClose={onClose}>
          {head(walletCopy.title)}
          <Fragment key={opened}>{walletPicker(close)}</Fragment>
        </FlowCard>
      )
    }
    // A later step keeps its coin where the chain offers it; the intro picks a coin.
    return (
      <NetworkCoinPicker
        key={opened}
        title={pickerTitle}
        titleAside={walletAside}
        networks={networks}
        coinsOn={coinsOn}
        current={{ chainId: network.chainId, symbol: coin.symbol }}
        onPick={choose}
        onBack={back}
        onClose={onClose}
      />
    )
  }

  const own = () => {
    if (step === "privacy")
      return (
        <DepositPrivacyDisclaimer
          rows={privacyRows}
          onContinue={onAddress}
          onBack={back}
          onClose={onClose}
        />
      )
    if (step === "method")
      return card(
        copy.method.title,
        <>
          {head(copy.method.title)}
          <div className={flowStyles.rows}>
            {row(
              {
                icon: <Icon name="wallet" size={20} color="#fff" />,
                title: copy.method.wallet,
                detail:
                  (onL1 ? !fundReady : !bridgeReady) && labels?.walletBlocked
                    ? labels.walletBlocked
                    : fmt(onL1 ? copy.method.walletSend : copy.method.walletBridge, {
                        network: network.name,
                      }),
                onClick: () => toWallet(),
                testId: "deposit-method-wallet",
              },
              onL1 ? !fundReady : !bridgeReady,
            )}
            {row(
              {
                icon: <Icon name="qr-code" size={20} color="#fff" />,
                title: labels?.address ?? copy.method.address,
                detail: copy.method.addressDetail,
                comingSoon: !onL1,
                onClick: () => (privacyRows ? go("privacy") : onAddress()),
                testId: "deposit-method-address",
              },
              !addressReady,
            )}
            {!onL1 && (
              <p className={flowStyles.note}>
                <Icon name="information-line" size={12} color="var(--text-secondary)" />
                <span>
                  {fmt(copy.method.l1Only, { network: chainName })}{" "}
                  <button
                    type="button"
                    className={`zkm-btn-reset ${styles.noteLink}`}
                    onClick={toL1}
                  >
                    {chainName}
                  </button>{" "}
                  {copy.method.l1OnlyAfter}
                </span>
              </p>
            )}
          </div>
        </>,
        true,
        flowStyles.method,
      )
    if (step === "pick")
      return blocked ? (
        <FlowCard label={copy.title} onClose={onClose}>
          {head(copy.title)}
          {status}
        </FlowCard>
      ) : (
        <NetworkCoinPicker
          title={pickerTitle}
          titleAside={walletAside}
          networks={networks}
          coinsOn={coinsOn}
          current={{ chainId: firstNetwork }}
          onPick={(chain, symbol) => {
            if (pick(chain, symbol)) proceed(chain)
          }}
          onBack={history.length > 1 ? back : undefined}
          onClose={onClose}
        />
      )
    return card(
      copy.title,
      <>
        {intro?.heading}
        {status ?? (
          <>
            <div className="ww-deposit-coin__fields">
              <div className="ww-deposit-coin__field">
                <span>{labels?.from ?? copy.intro.from}</span>
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit-coin__select"
                  data-testid="deposit-coin-select"
                  aria-haspopup="dialog"
                  disabled={originLocked}
                  onClick={() => openPicker("start")}
                >
                  {coinsOn(network.chainId, 44).find((c) => c.symbol === coin.symbol)?.icon}
                  <span className="ww-deposit__coin-name">
                    {fmt(flowCopy.crumb.label, { coin: coin.symbol, network: network.name })}
                  </span>
                  {!originLocked && <Icon name="chevron-down" size={12} color="#fdfdfd" />}
                </button>
              </div>
              <p className="ww-deposit-coin__note">
                {onL1
                  ? intro?.l1Note
                  : fmt(copy.intro.noteBridge, { coin: coin.symbol, network: network.name })}
              </p>
            </div>
            <PrimaryGradientButton
              title={copy.intro.continue}
              testId="deposit-select-continue"
              onClick={() => go("method")}
              className="ww-deposit-sheet__cta"
            />
          </>
        )}
      </>,
    )
  }

  return (
    <ModalSteps
      label={copy.label}
      animateHeight
      className={flowStyles.card}
      dir={dir}
      onAnimationEnd={settleStep}
    >
      <Fragment key={key}>{showPicker ? picker() : open ? open.node : own()}</Fragment>
    </ModalSteps>
  )
}
