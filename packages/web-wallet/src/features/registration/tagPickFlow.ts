/** A sheet that picks a tag: what is typed, whether it is free, and the pick it runs. */
import { derived, memoryStore, normalizeTag } from "@obsidion/front-core"
import { fireOnboardingEvent } from "../../lib/analytics"
import { nameCheck, type NameAvailability, type ProbePage } from "./nameAvailability"
import type { SignupStash } from "./signupStash"

const VERDICTS: Partial<Record<NameAvailability, string>> = {
  "available": "available",
  "reserved": "taken",
  "blocked": "blocked",
  "blocked-reserved": "blocked",
}

export interface TagPickDeps {
  page: ProbePage
  screen: "activation" | "deposit" | "settings"
  /** The tag already held, which a pick must differ from; only this sheet's pick changes it. */
  current?: string
  /** Keeps what is typed for the tab; a sheet without it keeps its own. */
  signup?: Pick<SignupStash, "state" | "setTagDraft">
  /** Sends the sheet's onboarding events; tests stand in for it. */
  fire?: typeof fireOnboardingEvent
}

export function openTagPickFlow(deps: TagPickDeps) {
  const { signup, fire = fireOnboardingEvent } = deps
  /** The sheet's own text, seeded from the tab's draft, which keeps a copy for a reload. */
  const typed = memoryStore(signup?.state.get().tagDraft ?? "")
  const names = nameCheck(
    deps.page,
    derived([typed], (text) => {
      const handle = normalizeTag(text)
      return handle !== null && handle !== deps.current ? { handle } : undefined
    }),
  )
  const progress = memoryStore<{ busy: boolean; error?: unknown }>({ busy: false })
  /** `name` is the typed tag folded, or null; `available`: the probe found a new tag free. */
  const view = derived([typed, names.check, progress], (text, { status, checking }, p) => {
    const name = normalizeTag(text)
    return { typed: text, name, status, checking, available: status === "available", ...p }
  })
  /** The last tag `onboarding_handle_checked` reported a verdict on. */
  let reported: string | undefined

  return {
    view,
    type(raw: string) {
      typed.set(raw.replace(/^@/, "").toLowerCase())
      signup?.setTagDraft(typed.get())
    },
    /** Runs `run` on the typed tag once it is free; a failure stays on the sheet. */
    async pick(run: (name: string) => Promise<void>) {
      const { name, available, busy } = view.get()
      if (!available || busy || name === null) return
      progress.set({ busy: true })
      try {
        await run(name)
        progress.set({ busy: false })
      } catch (error) {
        progress.set({ busy: false, error })
      }
    },
    start(signal: AbortSignal) {
      fire("name_sheet_opened", { screen: deps.screen })
      const off = names.answer.subscribe(() => {
        const answer = names.answer.get()
        const verdict = answer && VERDICTS[answer.probe.status]
        if (!answer || !verdict || reported === answer.key.handle) return
        reported = answer.key.handle
        fire("onboarding_handle_checked", { status: verdict })
      })
      signal.addEventListener("abort", off)
      names.start(signal)
    },
  }
}
