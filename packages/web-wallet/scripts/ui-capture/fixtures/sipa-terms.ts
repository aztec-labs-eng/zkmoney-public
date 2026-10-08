import * as actual from "@obsidion/sdk"
import { fixtureState } from "./control"
import { captureSipaPortalTerms } from "./processing-origin"
export * from "@obsidion/sdk"

/** The recorded SIPA's terms from the capture source the processing observer reads; the real read otherwise. */
export const readSipaPortalTerms: typeof actual.readSipaPortalTerms = (client, implementation) =>
  fixtureState() ? captureSipaPortalTerms() : actual.readSipaPortalTerms(client, implementation)
