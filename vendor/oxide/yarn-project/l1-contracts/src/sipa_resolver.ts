import {
  type Address,
  type Hex,
  type PublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  toHex,
} from 'viem';
import { namehash, packetToBytes } from 'viem/ens';

import { SIPAResolverAbi } from './artifacts.js';

// CCIP resolution targets a Resolver module. Discover the module with `readResolver` (name_registry.ts).
export function encodeResolve(name: Hex, data: Hex): Hex {
  return encodeFunctionData({ abi: SIPAResolverAbi as any, functionName: 'resolve', args: [name, data] });
}

/** Low-level ENSIP-10 `resolve(name, data)` */
export async function callResolve(
  publicClient: PublicClient,
  sipaResolver: Address,
  name: Hex,
  data: Hex,
): Promise<Hex> {
  return (await publicClient.readContract({
    address: sipaResolver,
    abi: SIPAResolverAbi,
    functionName: 'resolve',
    args: [name, data],
  } as any)) as Hex;
}

/** The standard ENS `addr(node)` getter — the record `resolveName` wraps as the CCIP resolve payload. */
const ADDR_RESOLVER_ABI = parseAbi(['function addr(bytes32 node) view returns (address)']);

/** CCIP-resolve `name` to a SIPA address */
export async function resolveName(publicClient: PublicClient, sipaResolver: Address, name: string): Promise<Address> {
  const data = encodeFunctionData({ abi: ADDR_RESOLVER_ABI, functionName: 'addr', args: [namehash(name)] });
  const resolved = await callResolve(publicClient, sipaResolver, toHex(packetToBytes(name)), data);
  const [address] = decodeAbiParameters(parseAbiParameters('address'), resolved);
  return address;
}

export async function resolveWithProof(
  publicClient: PublicClient,
  sipaResolver: Address,
  response: Hex,
  extraData: Hex,
): Promise<Hex> {
  return (await publicClient.readContract({
    address: sipaResolver,
    abi: SIPAResolverAbi,
    functionName: 'resolveWithProof',
    args: [response, extraData],
  } as any)) as Hex;
}
