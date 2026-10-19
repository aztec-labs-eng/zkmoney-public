/**
 * Stand-ins for `navigator.credentials` as the passkey rules read them: a real native prints its
 * own name, 1Password's script reads the request's `hints`, any other script prints as JavaScript.
 */

export const nativeCreate: unknown = Object.create
export const nativeGet: unknown = Reflect.get

/** The shape of 1Password's wrapper, enough for the rules to name it. */
export const onePasswordCreate = () =>
  async function create(request?: { publicKey?: { hints?: unknown } }) {
    void request?.publicKey?.hints
    return null
  }

/** Any other password manager's script. */
export const otherCreate = () => async () => null
