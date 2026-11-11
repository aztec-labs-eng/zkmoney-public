const DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }
const UTC_DATE = new Intl.DateTimeFormat("en-US", { ...DAY, timeZone: "UTC" })
const LOCAL_DATE = new Intl.DateTimeFormat("en-US", DAY)

function format(formatter: Intl.DateTimeFormat, iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : formatter.format(date)
}

export const formatUtcDate = (iso: string) => format(UTC_DATE, iso)
export const formatLocalDate = (iso: string) => format(LOCAL_DATE, iso)
