/**
 * The shipped-configuration notice cannot reload over a running proof. The view decides it, so
 * the guard is pinned here.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { startTabBoundOperation } from "../support/operations"
import { BakedProfileNotice } from "../../src/ui/ConfigNotice"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it("cannot reload over a running proof", async () => {
  const reload = vi.fn()
  const end = await startTabBoundOperation()
  await act(async () => {
    root.render(<BakedProfileNotice publishedAt="2026-08-12T00:00:00.000Z" reload={reload} />)
  })
  const button = container.querySelector("button")!
  expect(button.disabled).toBe(true)
  await act(async () => end())
  expect(button.disabled).toBe(false)
})
