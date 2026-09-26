import home from "../assets/phone/home.svg"
import person from "../assets/phone/person.svg"
import coins from "../assets/phone/coins.svg"
import arrow_down from "../assets/phone/arrow-down.svg"
import send from "../assets/phone/send.svg"
import tray_withdraw from "../assets/phone/tray-withdraw.svg"
import history_clock from "../assets/phone/history-clock.svg"
import settings from "../assets/phone/settings.svg"
import logout from "../assets/phone/logout.svg"
import qr_code from "../assets/phone/qr-code.svg"
import x from "../assets/phone/x.svg"
import search from "../assets/phone/search.svg"
import menu from "../assets/phone/menu.svg"
import arrow_left from "../assets/phone/arrow-left.svg"
import search_field from "../assets/phone/search-field.svg"
import scan from "../assets/phone/scan.svg"
import chevron_right from "../assets/phone/chevron-right.svg"
import copy from "../assets/phone/copy.svg"
import share_forward from "../assets/phone/share-forward.svg"
import bell from "../assets/phone/bell.svg"
import eye from "../assets/phone/eye.svg"
import flashlight from "../assets/phone/flashlight.svg"

const sources = {
  "home": home,
  "person": person,
  "coins": coins,
  "arrow-down": arrow_down,
  "send": send,
  "tray-withdraw": tray_withdraw,
  "history-clock": history_clock,
  "settings": settings,
  "logout": logout,
  "qr-code": qr_code,
  "x": x,
  "search": search,
  "menu": menu,
  "arrow-left": arrow_left,
  "search-field": search_field,
  "scan": scan,
  "chevron-right": chevron_right,
  "copy": copy,
  "share-forward": share_forward,
  "bell": bell,
  "eye": eye,
  "flashlight": flashlight,
} as const

export type PhoneIconName = keyof typeof sources

/** Opt-in glyphs exported from the web-wallet phone Figma frames. */
export function PhoneIcon({
  name,
  size = 24,
  color = "currentColor",
  className,
}: {
  name: PhoneIconName
  size?: number
  color?: string
  className?: string
}) {
  const mask = `url("${sources[name]}") center / contain no-repeat`
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "inline-block",
        flexShrink: 0,
        width: size,
        height: size,
        backgroundColor: color,
        mask,
        WebkitMask: mask,
      }}
    />
  )
}
