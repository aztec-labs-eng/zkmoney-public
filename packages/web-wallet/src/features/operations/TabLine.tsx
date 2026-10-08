/** The one line that says whether the tab may close for an operation, read off its record. */
import { useTabLine, type TabLine as TabLineState } from "./operations"

/** A visitor's page is not a wallet tab to them. */
export type TabPlace = "tab" | "page"

export function tabLineText(line: TabLineState, place: TabPlace = "tab"): string {
  return line === "keep"
    ? `Keep this ${place} open until it's sent`
    : `Sent · You can close this ${place}`
}

export function TabLine({
  operationId,
  place,
}: {
  operationId: string | undefined
  place?: TabPlace
}) {
  const line = useTabLine(operationId)
  return line ? (
    <span className={`ww-tabline ww-tabline--${line}`}>{tabLineText(line, place)}</span>
  ) : null
}
