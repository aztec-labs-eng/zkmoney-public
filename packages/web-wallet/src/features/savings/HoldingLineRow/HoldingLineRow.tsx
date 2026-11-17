import { ComingSoonPill, HoldingRow, RatePill } from "@obsidion/web-ds"
import { fmt } from "../../../lib/fmt"
import { CoinIcon } from "../../../ui/CoinIcon/CoinIcon"
import { ICONS } from "../../../ui/CoinIcon/coinIcons"
import { HIDDEN_BALANCE, usdAtomicFloor } from "../../../ui/format"
import coin from "../../../assets/deposit/coin.svg"
import { apyPercent } from "../EarningsCalculator"
import type { HoldingRowView } from "../holdingRows"
import copy from "./HoldingLineRow.copy"

export const COIN = 40

/** How a line names itself: its coin, title, the line under it, and its rate. */
export function holdingFace(row: HoldingRowView) {
  const rateName = row.words?.rateName
  return {
    icon: (row.symbol !== undefined && ICONS[row.symbol]) || coin,
    title: row.symbol ?? rateName ?? copy.unnamed,
    subtitle: row.exitOnly ? copy.exitOnly : row.symbol === undefined ? undefined : rateName,
    rate: row.rate === undefined ? undefined : fmt(copy.rate, { apy: apyPercent(row.rate) }),
  }
}

/** A Savings line as a row: its coin, symbol, yield, worth and rate. */
export function HoldingLineRow({
  row,
  hidden,
  onClick,
}: {
  row: HoldingRowView
  hidden: boolean
  onClick?: () => void
}) {
  const face = holdingFace(row)
  return (
    <HoldingRow
      icon={<CoinIcon token={{ icon: face.icon }} size={COIN} />}
      title={face.title}
      badge={row.isNew ? <ComingSoonPill size="sm" label={copy.new} /> : undefined}
      subtitle={face.subtitle}
      value={
        hidden
          ? HIDDEN_BALANCE
          : row.value === undefined
          ? copy.unvalued
          : usdAtomicFloor(row.value)
      }
      rate={face.rate && <RatePill size="sm" label={face.rate} />}
      onClick={onClick}
    />
  )
}
