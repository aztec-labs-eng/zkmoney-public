import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GradientInitialAvatar, type GradientInitialAvatarProps } from "../src/components/Avatars"

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

function render(props: GradientInitialAvatarProps) {
  act(() => root.render(createElement(GradientInitialAvatar, props)))
  return host.firstElementChild as HTMLDivElement
}

describe("GradientInitialAvatar updates", () => {
  it("changes a renamed contact's initial and colors while preserving its ring and margin", () => {
    const errors = vi.spyOn(console, "error")
    const props = { name: "Rainbow", ringed: true, size: 96, style: { margin: "0 auto" } }
    const avatar = render(props)
    const before = {
      image: avatar.style.backgroundImage,
      padding: avatar.style.padding,
      shadow: avatar.style.boxShadow,
      width: avatar.style.width,
      height: avatar.style.height,
    }
    expect(avatar.textContent).toBe("R")
    expect(before.image).toContain("linear-gradient")
    expect(Number.parseFloat(before.padding)).toBeGreaterThan(0)
    expect(before.shadow).toContain("inset")

    render({ ...props, name: "Weekend savings and travel expenses wallet" })

    expect(host.firstElementChild).toBe(avatar)
    expect(avatar.textContent).toBe("W")
    expect(avatar.style.backgroundImage).not.toBe(before.image)
    expect(getComputedStyle(avatar).backgroundClip).toBe("content-box")
    expect(avatar.style.padding).toBe(before.padding)
    expect(avatar.style.boxShadow).toBe(before.shadow)
    expect(avatar.style.width).toBe(before.width)
    expect(avatar.style.height).toBe(before.height)
    expect(avatar.style.marginLeft).toBe("auto")
    expect(avatar.style.marginRight).toBe("auto")
    expect(errors).not.toHaveBeenCalled()
  })

  it("updates explicit colors without resetting clipping or reporting conflicting styles", () => {
    const errors = vi.spyOn(console, "error")
    const avatar = render({ name: "Ada", colors: ["#ff0000", "#0000ff"] })
    const before = avatar.style.backgroundImage

    render({ name: "Ada", colors: ["#00ff00", "#ff00ff"] })

    expect(host.firstElementChild).toBe(avatar)
    expect(avatar.textContent).toBe("A")
    expect(avatar.style.backgroundImage).not.toBe(before)
    expect(getComputedStyle(avatar).backgroundClip).toBe("content-box")
    expect(errors).not.toHaveBeenCalled()
  })
})
