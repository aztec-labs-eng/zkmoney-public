/**
 * The wallet a manual withdrawal exit sends from: connect, switch network, or name the connected
 * account, so the user sees who submits (and, on a paylink recovery, who must sign) before they
 * press. The connected row opens the account modal, the way to a different account.
 */
import { Icon } from "@obsidion/web-ds"
import connectIcon from "../../assets/deposit/eth-fill.svg"
import { shortAddr } from "../../ui/format"
import type { useL1Wallet } from "../deposit/l1Wallet"

type ExitWallet = Pick<
  ReturnType<typeof useL1Wallet>,
  "account" | "walletName" | "connecting" | "wrongChain" | "connect" | "switchNetwork"
>

export function ExitWalletRow({ l1, chainName }: { l1: ExitWallet; chainName: string }) {
  return (
    <button
      type="button"
      className="zkm-btn-reset zkm-pressable ww-deposit__connect"
      disabled={l1.connecting}
      onClick={() => void (l1.account && l1.wrongChain ? l1.switchNetwork() : l1.connect())}
    >
      <span className="ww-deposit__connect-icon">
        <img src={connectIcon} alt="" width={24} height={24} />
      </span>
      <span className="ww-deposit__connect-text">
        <b>
          {!l1.account
            ? "Connect your wallet"
            : l1.wrongChain
            ? `Switch to ${chainName}`
            : "Sending from your connected wallet"}
        </b>
        <span>
          {l1.account
            ? `${l1.walletName ?? "Wallet"} · ${shortAddr(l1.account)}`
            : "Use Rainbow, MetaMask, Rabby, or WalletConnect"}
        </span>
      </span>
      <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
    </button>
  )
}
