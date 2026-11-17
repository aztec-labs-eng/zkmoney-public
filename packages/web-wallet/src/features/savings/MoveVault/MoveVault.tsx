import { HoldingSelect, RatePill } from "@obsidion/web-ds"
import { CoinIcon } from "../../../ui/CoinIcon/CoinIcon"
import { PickerList, type PickerItem } from "../../../ui/PickerList/PickerList"
import type { TransferAsset } from "../../../ui/TransferWidget/TransferWidget"
import { COIN, holdingFace } from "../HoldingLineRow/HoldingLineRow"
import type { HoldingRowView } from "../holdingRows"
import copy from "./MoveVault.copy"

/** The coin size of a transfer widget's chip. */
const TRANSFER_COIN = 32

/** A vault as a row of a picker: its coin, name and rate. */
export function vaultPickerItem(row: HoldingRowView): PickerItem {
  const face = holdingFace(row)
  return {
    id: row.id,
    icon: <CoinIcon token={{ icon: face.icon }} size={COIN} />,
    title: face.title,
    ...(face.subtitle === undefined ? {} : { detail: face.subtitle }),
    trailing: face.rate && <RatePill size="sm" label={face.rate} />,
  }
}

/** A vault as a side of the transfer widget: its asset, and its rate under it. */
export function vaultTransferAsset(row: HoldingRowView): TransferAsset {
  const face = holdingFace(row)
  return {
    icon: <CoinIcon token={{ icon: face.icon }} size={TRANSFER_COIN} />,
    symbol: face.title,
    detail: face.rate ?? "",
  }
}

/** A vault as the card a flow moves through. */
export function VaultCard({ row, onChange }: { row: HoldingRowView; onChange?: () => void }) {
  const face = holdingFace(row)
  return (
    <HoldingSelect
      icon={<CoinIcon token={{ icon: face.icon }} size={COIN} />}
      title={face.title}
      rate={face.rate && <RatePill size="xs" label={face.rate} />}
      subtitle={face.subtitle}
      changeLabel={copy.change}
      onChange={onChange}
    />
  )
}

/**
 * The vault a move goes through. `choices` are the vaults that can take the move: with more than
 * one, "Change" calls `onChange`. Given `onPick`, it is the list to pick another from instead.
 */
export function MoveVault({
  row,
  choices,
  onChange,
  onPick,
}: {
  row: HoldingRowView | undefined
  choices: readonly HoldingRowView[]
  onChange?: () => void
  onPick?: (id: string) => void
}) {
  if (onPick)
    return <PickerList selected={row?.id} onPick={onPick} items={choices.map(vaultPickerItem)} />
  if (!row) return null
  return <VaultCard row={row} onChange={choices.length > 1 ? onChange : undefined} />
}
