import {
  accountPersonalSignHash,
  encodeR1UserOpSignature,
  type R1PublicKeyArg,
  type WebAuthnAuthArg,
} from "@oxide/l1-contracts"
import type { Address, Hex, PrivateKeyAccount } from "viem"
import type { OxideL1Reader } from "./oxideRegistration"

export interface AccountPasskey {
  key: R1PublicKeyArg
  sign: (challenge: Hex) => Promise<WebAuthnAuthArg>
}

interface AccountSigningArgs {
  account: Address
  chainId: number
  hash: Hex
  reader: Pick<OxideL1Reader, "getCode" | "readAuthKeys">
  passkey?: AccountPasskey
}

/** ERC-1271 signature over `hash` from `account`: the bootstrap key until a passkey is installed. */
export async function signAccountDigest(
  args: AccountSigningArgs & { bootstrap: PrivateKeyAccount },
): Promise<Hex> {
  const challenge = accountPersonalSignHash(args.account, args.chainId, args.hash)
  const keys = await installedKeys(args)
  if (!keys.length) return args.bootstrap.sign({ hash: challenge })
  return await signWithPasskey(keys, challenge, args.passkey)
}

/** ERC-1271 signature over `hash` from `account`'s installed passkey; refuses a bootstrap-only account. */
export async function signAccountDigestWithPasskey(args: AccountSigningArgs): Promise<Hex> {
  const keys = await installedKeys(args)
  if (!keys.length) throw new Error("Finish setting up your account's passkey, then try again")
  return await signWithPasskey(
    keys,
    accountPersonalSignHash(args.account, args.chainId, args.hash),
    args.passkey,
  )
}

async function installedKeys(args: AccountSigningArgs) {
  const code = await args.reader.getCode(args.account)
  return code && code !== "0x" ? await args.reader.readAuthKeys(args.account, 64) : []
}

async function signWithPasskey(
  keys: Awaited<ReturnType<typeof installedKeys>>,
  challenge: Hex,
  passkey: AccountPasskey | undefined,
): Promise<Hex> {
  if (!passkey) throw new Error("Unlock the installed account passkey to sign")
  const index = keys.findIndex(
    ({ key }) =>
      key.qx.toLowerCase() === passkey.key.qx.toLowerCase() &&
      key.qy.toLowerCase() === passkey.key.qy.toLowerCase(),
  )
  if (index < 0) throw new Error("This passkey is not installed on the recovery account")
  return encodeR1UserOpSignature(BigInt(index), await passkey.sign(challenge))
}
