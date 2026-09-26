import { Icon } from "@obsidion/web-ds"
import { shortAddr } from "../format"
import { DepositFact } from "./DepositFact"

export function DepositHashFact({
  label,
  hash,
  url,
}: {
  label: string
  hash: string
  url?: string
}) {
  const text = shortAddr(hash)
  return (
    <DepositFact label={label}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {text} <Icon name="share-box" size={16} />
        </a>
      ) : (
        <b>{text}</b>
      )}
    </DepositFact>
  )
}
