/**
 * Dev-only `?demo=<scenario>` boot: the in-process demo profile, so it needs no config service,
 * then the seed, before the first render, so every hook's first read sees a populated wallet. A
 * move onto another `/dev/mock/` builds that mock's page in this document, and the app remounts
 * over it.
 */
import { useState } from "react"
import type { Pace } from "@obsidion/core/cadence"
import { useStore, type QueryEntry } from "@obsidion/front-core"
import { BootGate } from "../BootGate"
import { resolveBootConfig, type ResolveBootConfigInput } from "../config/env"
import type { PageBoot } from "../app/sessionDeps"
import { MockFollow } from "../app/devRoutes"
import type { DemoScenario } from "./demoFlag"
import { demoBootInput } from "./demoProfile"
import { mockBoots } from "./mockBoots"
import { seedDemo } from "./seedDemo"

export function DemoBoot({
  scenario,
  read,
  preview,
  real,
}: {
  scenario: DemoScenario
  /** The page's boot read over `load`, once `after` settles. */
  read: (load: (pace: Pace) => Promise<PageBoot>, after?: Promise<void>) => QueryEntry<PageBoot>
  /** The config editor's draft over a boot input, where it is on. */
  preview: (input: ResolveBootConfigInput) => Promise<ResolveBootConfigInput>
  /** The real app's boot, for an origin the seed refuses. */
  real: (pace: Pace) => Promise<PageBoot>
}) {
  const [boots] = useState(() => {
    const load = async (pace: Pace): Promise<PageBoot> => {
      // Profile first, fixtures last: the seed builds its page over the resolved config.
      const resolved = await resolveBootConfig(await preview(demoBootInput()))
      const seeded = await seedDemo(scenario, resolved, undefined, pace)
      // A refusal (this origin holds a real wallet) boots the real app from the real profile.
      return seeded ? { ...resolved, page: seeded } : real(pace)
    }
    return mockBoots(read(load), (after) => read(load, after))
  })
  const { generation, boot } = useStore(boots.current)
  return (
    <MockFollow.Provider value={boots.follow}>
      <BootGate key={generation} boot={boot} />
    </MockFollow.Provider>
  )
}
