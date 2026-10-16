import { useState } from "react"
import { StyledQr } from "../../ui/StyledQr"
import { CODE_LOGO } from "./ReceiveCodeFace"

/** The printed code's host: it opens the pay page, and wallets resolve it through ENS. */
export const printedCodeHost = (tag: string) => `${tag}.zk.money`

const blurb = (tag: string) =>
  `Scan with your phone camera, or send USDC to ${printedCodeHost(tag)} from any Ethereum wallet.`

async function dataUrl(src: string): Promise<string> {
  const blob = await (await fetch(src)).blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > width) {
      lines.push(line)
      line = word
    } else line = next
  }
  return [...lines, line]
}

/** Draws the card to a PNG. An SVG drawn as an image loads nothing external, so the logo goes inline. */
async function cardPng(qr: SVGSVGElement, tag: string): Promise<Blob> {
  const logo = await dataUrl(CODE_LOGO)
  const xml = new XMLSerializer()
    .serializeToString(qr)
    .replace(`href="${CODE_LOGO}"`, `href="${logo}"`)
  const code = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`)
  const canvas = document.createElement("canvas")
  canvas.width = 1200
  canvas.height = 1700
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("no canvas")
  const font = getComputedStyle(document.body).fontFamily
  const text = (s: string, y: number, size: number, weight = 700, color = "#141413") => {
    ctx.font = `${weight} ${size}px ${font}`
    ctx.fillStyle = color
    ctx.fillText(s, 600, y)
  }
  ctx.fillStyle = "#fff"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textAlign = "center"
  text("zk.money", 110, 44)
  text("Scan to pay", 220, 80)
  ctx.drawImage(code, 200, 290, 800, 800)
  text(`@${tag}`, 1200, 72)
  text(printedCodeHost(tag), 1275, 44, 500, "#6b6b6b")
  ctx.font = `500 36px ${font}`
  wrap(ctx, blurb(tag), 960).forEach((line, i) => text(line, 1390 + i * 50, 36, 500, "#141413"))
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no image"))), "image/png"),
  )
}

/**
 * The printed card: the tag's own host, so it never expires. Kept off screen; printing shows only it.
 */
export function PrintedCard({ tag }: { tag: string }) {
  return (
    <div className="ww-print-card ww-print-card--offscreen" aria-hidden>
      <span className="ww-print-card__brand">zk.money</span>
      <span className="ww-print-card__title">Scan to pay</span>
      <StyledQr
        value={`https://${printedCodeHost(tag)}`}
        icon={CODE_LOGO}
        size={220}
        label="Your printable code"
      />
      <b className="ww-print-card__tag">@{tag}</b>
      <span className="ww-print-card__host">{printedCodeHost(tag)}</span>
      <p>{blurb(tag)}</p>
    </div>
  )
}

/** Downloads the printed card for `tag` as a PNG. */
export function useSaveCard(tag: string) {
  const [saving, setSaving] = useState(false)
  const save = async () => {
    const qr = document.querySelector<SVGSVGElement>(".ww-print-card svg")
    if (!qr || saving) return
    setSaving(true)
    try {
      const url = URL.createObjectURL(await cardPng(qr, tag))
      const a = document.createElement("a")
      a.href = url
      a.download = `${tag}-zk-money.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      console.warn("[receive] card image failed:", err)
    } finally {
      setSaving(false)
    }
  }
  return { saving, save }
}
