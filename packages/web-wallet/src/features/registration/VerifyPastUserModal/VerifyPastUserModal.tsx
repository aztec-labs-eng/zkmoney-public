import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Hex } from "viem"
import { useResource } from "@obsidion/front-core"
import {
  GradientSpinner,
  GradientText,
  Icon,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import coinsArt from "../../../assets/onboarding/past-user-coins.webp"
import badgeArt from "../../../assets/onboarding/past-user-badge.webp"
import { fireOnboardingEvent } from "../../../lib/analytics"
import { Modal } from "../../../ui/Modal"
import { shortL1Addr } from "../../../ui/format"
import { useL1Wallet } from "../../../session/l1Wallet"
import { chooseOwnName, type ChosenNameClaim } from "../chooseOwnName"
import {
  ADDRESS_RE,
  PastUserAddressInput,
  type LookupState,
} from "../PastUserAddressInput/PastUserAddressInput"
import { lookupPastUser } from "../pastUserProver"
import { usePastUserCheck } from "../pastUser"
import { useSession } from "../../../session/session"
import { fmt } from "../../../lib/fmt"
import copy from "./VerifyPastUserModal.copy"
import { WalletError } from "@obsidion/core/errors"
import { errorMessage } from "../../../errors/catalog"

/** Text that can still become an address as the user types. */
const ADDRESS_PREFIX_RE = /^0(x[0-9a-fA-F]{0,40})?$/

function Close({ onClick }: { onClick: () => void }) {
  return (
    <div className="ww-verify__close">
      <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={onClick} />
    </div>
  )
}

function Result(props: {
  label: string
  art: ReactNode
  body: ReactNode
  onClose: () => void
  closeButton?: boolean
  children: ReactNode
}) {
  return (
    <Modal
      variant="bare"
      className="ww-verify ww-verify--result"
      label={props.label}
      onClose={props.onClose}
    >
      {props.closeButton && <Close onClick={props.onClose} />}
      {props.art}
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        {props.label}
      </GradientText>
      <p className="ww-verify__body">{props.body}</p>
      {props.children}
    </Modal>
  )
}

/**
 * Proves a past zk.money wallet. The address is checked against the list in this browser before
 * any signature. With `tag` (a paid tag waiting on activation) a pass claims that tag at the free
 * price; otherwise Welcome back hands on to the tag pick.
 */
export function VerifyPastUserModal(props: {
  tag?: string
  claim: ChosenNameClaim
  onChoose: () => void
  onKeepRandom?: () => void
  onPickInstead?: () => void
}) {
  const { state, owner } = usePastUserCheck()
  const wallet = useL1Wallet()
  const session = useSession()
  const { pastUser } = session
  const obsidionAccount = useResource(session.account)
  const check = (account: Hex) => void pastUser.check(account, obsidionAccount ?? undefined)
  const setVerifyOpen = pastUser.setOpen
  const obsidionWallet = useResource(session.wallet)
  const [address, setAddress] = useState<string>(state.account ?? "")
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" })
  const [attempt, setAttempt] = useState(0)
  const [claiming, setClaiming] = useState(false)
  const [claimError, setClaimError] = useState<string>()
  const lookupSeq = useRef(0)
  // What to do once the wallet connects: fill the address, or go on to sign.
  const pending = useRef<"fill" | "sign" | null>(null)

  const close = () => {
    pastUser.reset(owner)
    setVerifyOpen(false)
  }

  useEffect(() => {
    if (!ADDRESS_RE.test(address)) {
      lookupSeq.current++
      setLookup(
        address && !ADDRESS_PREFIX_RE.test(address) ? { kind: "invalid" } : { kind: "idle" },
      )
      return
    }
    const seq = ++lookupSeq.current
    setLookup({ kind: "loading" })
    const timer = setTimeout(async () => {
      try {
        const eligible = await lookupPastUser(address as Hex)
        if (seq === lookupSeq.current) setLookup({ kind: eligible ? "found" : "not-found" })
      } catch {
        if (seq === lookupSeq.current) setLookup({ kind: "error" })
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [address, attempt])

  const same = (account: string | null) => account?.toLowerCase() === address.toLowerCase()

  useEffect(() => {
    if (!wallet.account || !pending.current) return
    const next = pending.current
    pending.current = null
    // A different wallet connected: its address replaces the typed one and is checked first.
    if (next === "sign" && same(wallet.account)) check(wallet.account)
    else setAddress(wallet.account)
  }, [wallet.account]) // eslint-disable-line react-hooks/exhaustive-deps

  const connectWallet = () => {
    if (wallet.account) return setAddress(wallet.account)
    pending.current = "fill"
    void wallet.connect()
  }

  const sign = () => {
    if (wallet.account && same(wallet.account)) return check(wallet.account)
    pending.current = "sign"
    void wallet.connect()
  }

  const claimTag = async (tag: string) => {
    if (!obsidionAccount || !obsidionWallet) return
    setClaiming(true)
    setClaimError(undefined)
    try {
      const over = props.claim(session, obsidionWallet, true, "past_user")
      await chooseOwnName(session, tag, obsidionAccount, over)
      fireOnboardingEvent("name_route_chosen", { route: "past_user" })
      setVerifyOpen(false)
    } catch (e) {
      setClaimError(errorMessage(e))
      setClaiming(false)
    }
  }

  if (state.step === "confirmed") {
    const { tag } = props
    return (
      <Result
        label={copy.confirmed.title}
        art={<img className="ww-verify__badge" src={badgeArt} alt="" />}
        body={tag ? fmt(copy.confirmed.bodyTag, { tag }) : copy.confirmed.body}
        onClose={claiming ? () => {} : close}
        closeButton
      >
        {claimError && (
          <p className="ww-invite__error" role="alert">
            {claimError}
          </p>
        )}
        <PrimaryGradientButton
          title={tag ? fmt(copy.confirmed.claimTag, { tag }) : copy.confirmed.choose}
          testId="past-user-choose"
          isLoading={claiming}
          onClick={() => {
            if (tag) return void claimTag(tag)
            setVerifyOpen(false)
            props.onChoose()
          }}
        />
        {!tag && props.onKeepRandom && (
          <button
            type="button"
            className="zkm-btn-reset ww-verify__link"
            onClick={() => {
              setVerifyOpen(false)
              props.onKeepRandom?.()
            }}
          >
            {copy.confirmed.keepRandom}
          </button>
        )}
      </Result>
    )
  }

  if (state.step === "claimed") {
    return (
      <Result
        label={copy.claimed.title}
        art={
          <svg width="64" height="64" viewBox="0 0 24 24" fill="var(--accent-gold)" aria-hidden>
            <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-1 8v7h2v-7h-2Zm0-3v2h2V7h-2Z" />
          </svg>
        }
        body={copy.claimed.body}
        onClose={close}
      >
        <button
          type="button"
          className="zkm-btn-reset ww-verify__pill"
          onClick={() => {
            pastUser.reset(owner)
            setAddress("")
          }}
        >
          {copy.claimed.retry}
        </button>
      </Result>
    )
  }

  if (state.step === "not_found") {
    return (
      <Result
        label={copy.notFound.title}
        art={<Icon name="x" size={48} color="var(--accent-pink)" />}
        body={copy.notFound.body}
        onClose={close}
      >
        <button type="button" className="zkm-btn-reset ww-verify__pill" onClick={close}>
          {copy.close}
        </button>
      </Result>
    )
  }

  if (state.step === "check" && !state.error) {
    return (
      <Result
        label={copy.checking.title}
        art={<GradientSpinner size={40} />}
        body={copy.checking.body}
        onClose={() => setVerifyOpen(false)}
        closeButton
      >
        <PrimaryGradientButton title={copy.checking.button} isDisabled />
      </Result>
    )
  }

  const signing = state.step === "sign" && !state.error
  return (
    <Modal
      variant="bare"
      className="ww-verify"
      label={copy.title}
      onClose={signing ? () => setVerifyOpen(false) : close}
    >
      <div className="ww-verify__privacy">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="var(--accent-green)" aria-hidden>
          <path d="M12 1l8.22 1.83a1 1 0 0 1 .78.97v9.99a6 6 0 0 1-2.67 4.99L12 23l-6.33-4.22A6 6 0 0 1 3 13.79V3.8a1 1 0 0 1 .78-.97L12 1Zm4.45 7.4-5.36 5.36-2.83-2.83-1.41 1.41 4.24 4.25 6.78-6.78-1.42-1.41Z" />
        </svg>
        <p>{copy.privacy}</p>
      </div>
      <Close onClick={signing ? () => setVerifyOpen(false) : close} />
      <img className="ww-verify__art" src={coinsArt} alt="" />
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        {copy.title}
      </GradientText>
      <p className="ww-verify__lede">{copy.lede}</p>
      <div className="ww-verify__connect">
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-verify__connect-main"
          data-testid="past-user-connect"
          disabled={signing}
          onClick={connectWallet}
        >
          <span className="ww-verify__connect-icon">
            <Icon name="wallet" size={24} color="#fff" />
          </span>
          <span className="ww-verify__connect-text">
            <b>
              {wallet.account
                ? fmt(copy.connect.use, { address: shortL1Addr(wallet.account) })
                : copy.connect.title}
            </b>
            <span>
              {wallet.account
                ? fmt(copy.connect.connected, {
                    with: wallet.walletName
                      ? fmt(copy.connect.connectedWith, { name: wallet.walletName })
                      : "",
                  })
                : copy.connect.options}
            </span>
          </span>
          {!wallet.account && <Icon name="chevron-right" size={16} color="var(--text-secondary)" />}
        </button>
        {wallet.account && (
          <button
            type="button"
            className="zkm-btn-reset ww-verify__pill"
            data-testid="past-user-disconnect"
            disabled={signing}
            onClick={() => {
              if (same(wallet.account)) setAddress("")
              wallet.disconnect()
            }}
          >
            {copy.disconnect}
          </button>
        )}
      </div>
      <div className="ww-verify__or">
        <hr />
        <span>{copy.or}</span>
        <hr />
      </div>
      <PastUserAddressInput
        address={address}
        state={lookup}
        connected={same(wallet.account)}
        onAddress={setAddress}
        onRetry={() => setAttempt((n) => n + 1)}
      />
      {state.error && (
        <p className="ww-invite__error" role="alert">
          {errorMessage(new WalletError(state.error))}
        </p>
      )}
      {lookup.kind === "found" && (
        <div className="ww-verify__sign">
          <PrimaryGradientButton
            title={signing ? copy.signing : copy.sign}
            testId="past-user-sign"
            isDisabled={signing}
            onClick={sign}
          />
          <p className="ww-verify__note">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="var(--text-secondary)"
              aria-hidden
            >
              <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm1 9h-2v6h2v-6Zm0-4h-2v2h2V7Z" />
            </svg>
            {copy.signNote}
          </p>
        </div>
      )}
      {props.onPickInstead && lookup.kind !== "found" && (
        <button
          type="button"
          className="zkm-btn-reset ww-verify__link"
          onClick={() => {
            close()
            props.onPickInstead?.()
          }}
        >
          {copy.pickInstead}
        </button>
      )}
    </Modal>
  )
}
