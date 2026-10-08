import type { Logger } from "@aztec/foundation/log"
import { AztecSQLiteOPFSStore, SqlitePoolBusyError } from "@aztec/kv-store/sqlite-opfs"

const WEBKIT_HELD_FILE_MESSAGE = "The object is in an invalid state."

export async function openPooledStore(
  log: Logger,
  name: string,
  directory: string,
): Promise<AztecSQLiteOPFSStore> {
  try {
    return await AztecSQLiteOPFSStore.open(log, name, false, directory)
  } catch (e) {
    if (e instanceof Error && e.message === WEBKIT_HELD_FILE_MESSAGE) {
      throw Object.assign(new SqlitePoolBusyError(directory), { cause: e })
    }
    throw e
  }
}
