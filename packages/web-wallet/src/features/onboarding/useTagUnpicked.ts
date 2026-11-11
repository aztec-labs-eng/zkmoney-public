import { useStore } from "@obsidion/front-core"
import { enteredIdentity } from "../../session/account"
import { useSession } from "../../session/session"

/** Whether the drawn tag is still a draft: it stays hidden until the passkey is made. */
export function useTagUnpicked(): boolean {
  const { identity, device, signup, page } = useSession()
  const draft = useStore(signup.state, (s) => s.drawnOffer)
  const entered = enteredIdentity(useStore(identity), useStore(device).passkeyMap, page.config.rpId)
  return draft !== undefined && entered === null
}
