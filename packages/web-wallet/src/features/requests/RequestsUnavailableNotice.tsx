import { Icon } from "@obsidion/web-ds"

/** Requests sent to the user are hidden because the contacts or the sends could not be read. */
export function RequestsUnavailableNotice() {
  return (
    <p className="ww-requests-unavailable" role="status">
      <Icon name="information-line" size={16} />
      Requests sent to you can't be loaded right now. Trying again…
    </p>
  )
}
