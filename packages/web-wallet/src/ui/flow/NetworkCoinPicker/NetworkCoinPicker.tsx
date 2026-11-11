import { useState } from "react"
import type { ReactNode } from "react"
import { fmt } from "../../../lib/fmt"
import { ChainIcon } from "../../ChainIcon/ChainIcon"
import { PickerList } from "../../PickerList/PickerList"
import { usePhoneLayout } from "../../usePhoneLayout"
import { FlowCard } from "../FlowCard/FlowCard"
import flowStyles from "../flow.module.css"
import copy from "./NetworkCoinPicker.copy"
import styles from "./NetworkCoinPicker.module.css"

/** Longer coin lists get a search box on the phone. */
const PHONE_COIN_SEARCH = 6

export interface PickerNetwork {
  chainId: number
  name: string
}

export interface Coin {
  symbol: string
  name: string
  icon: ReactNode
  comingSoon?: boolean
}

/**
 * The flow's network and coin step: networks beside the shown network's coins, or on a phone the
 * networks, then the coins of the one tapped. Remount it to start again from `current`.
 */
export function NetworkCoinPicker({
  title,
  titleAside,
  networks,
  coinsOn,
  current,
  onPick,
  onBack,
  onClose,
  testIdPrefix = "deposit",
}: {
  title: string
  titleAside?: ReactNode
  /** At least one. */
  networks: readonly PickerNetwork[]
  coinsOn: (chainId: number) => Coin[]
  /** Without a symbol, no coin starts picked. A network tap clears it until a coin is tapped. */
  current: { chainId: number; symbol?: string }
  onPick: (chainId: number, symbol: string) => void
  /** Leaves the picker; on a phone the coins go back to the networks first. */
  onBack?: () => void
  /** Closes the whole flow. */
  onClose: () => void
  testIdPrefix?: string
}) {
  const phone = usePhoneLayout()
  const [pickChain, setPickChain] = useState<number | null>(null)
  const [phoneCoins, setPhoneCoins] = useState(false)
  // The phone's networks and coins views swap with a fade; the first one arrives with the picker.
  const [swapped, setSwapped] = useState(false)

  const currentNetwork = networks.find((n) => n.chainId === current.chainId) ?? networks[0]!
  const shownChain = pickChain ?? currentNetwork.chainId
  const shownNetwork = networks.find((n) => n.chainId === shownChain) ?? currentNetwork
  const coins = coinsOn(shownChain)
  const showCoins = (next: boolean) => {
    setSwapped(true)
    setPhoneCoins(next)
  }
  const showChain = (id: number) => {
    setPickChain(id)
    if (phone) showCoins(true)
  }

  const networkList = (
    <PickerList
      inPane
      searchLabel={copy.searchNetworks}
      section={(count) => fmt(copy.networks, { count })}
      selected={String(shownChain)}
      items={networks.map((n) => ({
        id: String(n.chainId),
        icon: <ChainIcon chainId={n.chainId} name={n.name} />,
        title: n.name,
        testId: `${testIdPrefix}-chain-${n.chainId}`,
      }))}
      onPick={(id) => showChain(Number(id))}
    />
  )
  const coinList = (
    <PickerList
      inPane
      searchLabel={!phone || coins.length > PHONE_COIN_SEARCH ? copy.searchCoins : undefined}
      section={(count) => fmt(copy.coinsOn, { network: shownNetwork.name, count })}
      selected={pickChain === null ? current.symbol : undefined}
      items={coins.map((c) => ({
        id: c.symbol,
        icon: (
          <span className={`${styles.coinIcon} ww-badged`}>
            {c.icon}
            <span className={styles.coinChain}>
              <ChainIcon chainId={shownChain} name={shownNetwork.name} size={12} />
            </span>
          </span>
        ),
        title: c.name,
        tag: c.symbol,
        detail: shownNetwork.name,
        comingSoon: c.comingSoon,
      }))}
      onPick={(symbol) => onPick(shownChain, symbol)}
    />
  )
  return (
    <FlowCard
      label={title}
      title={title}
      titleAside={titleAside}
      onBack={phone && phoneCoins ? () => showCoins(false) : onBack}
      onClose={onClose}
      className={flowStyles.picker}
    >
      {phone ? (
        <div
          key={phoneCoins ? "coins" : "networks"}
          className={`${flowStyles.pane} ${swapped ? flowStyles.fade : ""}`}
        >
          {phoneCoins ? coinList : networkList}
        </div>
      ) : (
        <div className={flowStyles.panes}>
          <div className={`${flowStyles.pane} ${styles.networks}`}>{networkList}</div>
          <div className={flowStyles.pane}>{coinList}</div>
        </div>
      )}
    </FlowCard>
  )
}
