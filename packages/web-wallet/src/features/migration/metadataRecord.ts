import {
  task,
  type Milestones,
  type Query,
  type QueryFactory,
  type Service,
  type Task,
} from "@obsidion/front-core"
import type { AccountRecordState, ObsidionAccount } from "@obsidion/sdk"

/** How the account's L1 metadata record names it, read once a session for every reader. */
export const metadataRecordStates = (
  query: QueryFactory,
  account: Service<ObsidionAccount>,
  read: (account: ObsidionAccount) => Promise<AccountRecordState>,
): Query<[], AccountRecordState> =>
  query<[], AccountRecordState>("metadataRecordState", {
    load: async (signal) => read(await account.ready(signal)),
  })

/**
 * Marks `oldVersionsRead` when the record names the account on this version: it upgraded or was
 * made here, so the upgrade check reads its old versions in the background.
 */
export function oldVersionsByRecord(deps: {
  account: Service<ObsidionAccount>
  record: Query<[], AccountRecordState>
  milestones: Pick<Milestones, "mark">
}): Task {
  return task("oldVersionsByRecord", {
    needs: { account: deps.account },
    every: "once",
    run: async ({ signal }) => {
      if ((await deps.record().read(signal)) === "current") deps.milestones.mark("oldVersionsRead")
    },
  })
}
