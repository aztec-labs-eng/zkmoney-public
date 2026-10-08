import { useMemo } from "react"
import { encode } from "uqr"

const DARK = "#141413"
const FINDER = 7
/** The logo's clear zone as a share of the code's width; ECC level H forgives up to 30% of the area. */
const LOGO_SHARE = 0.24

/** The three finder patterns, as rounded squares. */
function finders(n: number): string {
  const corners: [number, number][] = [
    [0, 0],
    [n - FINDER, 0],
    [0, n - FINDER],
  ]
  return corners
    .map(
      ([x, y]) =>
        `<rect x="${x}" y="${y}" width="7" height="7" rx="1.75" fill="${DARK}"/>` +
        `<rect x="${x + 1}" y="${y + 1}" width="5" height="5" rx="1.1" fill="#fff"/>` +
        `<rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.9" fill="${DARK}"/>`,
    )
    .join("")
}

function inFinder(x: number, y: number, n: number): boolean {
  const left = x < FINDER
  const right = x >= n - FINDER
  const top = y < FINDER
  const bottom = y >= n - FINDER
  return (left && top) || (right && top) || (left && bottom)
}

/**
 * A QR code drawn as round modules with rounded finder corners, on white so any camera reads it,
 * with an optional logo in the middle. `value` is what a scanner gets, unchanged.
 */
export function StyledQr({
  value,
  icon,
  size = 128,
  label,
}: {
  value: string
  /** An image for the center; raises the error correction so the covered modules are spare. */
  icon?: string
  size?: number
  label?: string
}) {
  const svg = useMemo(() => {
    const { data, size: n } = encode(value, { ecc: icon ? "H" : "M", border: 0 })
    const logo = icon ? Math.round(n * LOGO_SHARE) : 0
    const logoStart = Math.floor((n - logo) / 2)
    const inLogo = (x: number, y: number) =>
      logo > 0 && x >= logoStart && x < logoStart + logo && y >= logoStart && y < logoStart + logo
    let dots = ""
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!data[y][x] || inFinder(x, y, n) || inLogo(x, y)) continue
        dots += `<circle cx="${x + 0.5}" cy="${y + 0.5}" r="0.44" fill="${DARK}"/>`
      }
    }
    const art = icon
      ? `<rect x="${logoStart}" y="${logoStart}" width="${logo}" height="${logo}" rx="${
          logo / 2
        }" fill="#fff"/>` +
        `<image href="${icon}" x="${logoStart + 0.5}" y="${logoStart + 0.5}" width="${
          logo - 1
        }" height="${logo - 1}"/>`
      : ""
    return { n, body: finders(n) + dots + art }
  }, [value, icon])
  return (
    <svg
      viewBox={`0 0 ${svg.n} ${svg.n}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      data-uri={value}
      shapeRendering="geometricPrecision"
      dangerouslySetInnerHTML={{ __html: svg.body }}
    />
  )
}
