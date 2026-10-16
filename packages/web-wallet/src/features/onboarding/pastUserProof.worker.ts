/// <reference lib="webworker" />
import { bytesToHex, type Hex } from "viem"
import { proveNoirCircuit, type NoirCircuit } from "../../platform/noirProver"
import { isPastUserAddress, NotPastUserError, pastUserInputs } from "./pastUserProof"

export type PastUserProofRequest =
  | { kind: "prove"; signature: Hex; owner: Hex; leavesUrl: string }
  | { kind: "lookup"; address: Hex; leavesUrl: string }

export type PastUserProofReply =
  | { ok: true; proof: Hex; publicInputs: string[] }
  | { ok: true; eligible: boolean }
  | { ok: false; notPastUser: boolean; error: string }

const log = (msg: string, ...rest: unknown[]) => console.log(`[past-user] ${msg}`, ...rest)

async function loadLeaves(url: string): Promise<Uint8Array> {
  // The list is served with an hour's cache; a dev stack regenerates it on every restart.
  const res = await fetch(url, { cache: import.meta.env.DEV ? "no-cache" : "default" })
  if (!res.ok) throw new Error(`The past-user list did not load (HTTP ${res.status}).`)
  return new Uint8Array(await res.arrayBuffer())
}

async function reply(data: PastUserProofRequest): Promise<PastUserProofReply> {
  if (data.kind === "lookup") {
    return {
      ok: true,
      eligible: await isPastUserAddress(data.address, await loadLeaves(data.leavesUrl)),
    }
  }
  log("loading circuit and leaves", data.leavesUrl)
  const [circuit, leaves] = await Promise.all([
    import("../../../../contracts/src/artifacts/target/eligibility/eligibility.json").then(
      (m) => (m.default ?? m) as unknown as NoirCircuit,
    ),
    loadLeaves(data.leavesUrl),
  ])
  log(`loaded circuit and ${leaves.length / 32} leaves (${leaves.length} bytes)`)
  const inputs = await pastUserInputs({ signature: data.signature, owner: data.owner, leaves })
  log("inputs built", { merkle_root: inputs.merkle_root, owner: inputs.owner })
  const { proof, publicInputs } = await proveNoirCircuit(circuit, inputs, "past-user")
  log("proved", { publicInputs })
  return { ok: true, proof: bytesToHex(proof), publicInputs }
}

self.onmessage = async ({ data }: MessageEvent<PastUserProofRequest>) => {
  try {
    self.postMessage(await reply(data))
  } catch (err) {
    console.error(`[past-user] ${data.kind} failed`, err)
    self.postMessage({
      ok: false,
      notPastUser: err instanceof NotPastUserError,
      error: err instanceof Error ? err.message : String(err),
    } satisfies PastUserProofReply)
  }
}
