import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EthAddress } from '@aztec/foundation/eth-address';

import { readFile } from 'node:fs/promises';

/**
 * Reader for the published `<deployment-env>.v4.json` deployment env manifest
 * (shape: scripts/src/generated/deployment-env-manifest.schema.json). The relayer pins one entry by portal and
 * watches the other L1-operation entries on the same rollup version.
 */

/** The deployment-env-manifest fields the relayer uses for one deployment. */
export interface DeploymentEnvManifestPublicConfig {
  /** This deployment's Portal; SIPAs settle straight into it, and it is the key their implementations are
   *  blessed under. */
  portal: EthAddress;
  l2Token: AztecAddress;
  token: EthAddress;
  rollupVersion: bigint;
  enclaveUrl: string;
  broadcaster: AztecAddress;
  withdrawalSubsidy: EthAddress;
  proverSubsidy: EthAddress;
  plainWithdrawalExecutor: EthAddress;
  operationExecutor: EthAddress;
  fpcFunder: EthAddress;
}

/** One manifest deployment and the label that names it. */
export interface ResolvedManifestDeployment {
  label: string;
  publicConfig: DeploymentEnvManifestPublicConfig;
}

export interface ResolvedDeploymentEnvManifest {
  current: ResolvedManifestDeployment;
  historical: ResolvedManifestDeployment[];
  /** Why this relayer cannot read each historical entry that it would watch. */
  unreadable: string[];
}

/** Inputs for deployment-env-manifest resolution. Tests inject `fetch` to avoid network access. */
export interface ResolveDeploymentEnvManifestOptions {
  deploymentEnvManifestUrl: string;
  portal: EthAddress;
  fetch?: typeof fetch;
}

interface RawDeployment {
  withdrawalProtocol?: unknown;
  portal?: unknown;
  label?: unknown;
  rollupVersion?: unknown;
  l2Token?: unknown;
  token?: unknown;
  enclaveUrl?: unknown;
  l2Broadcaster?: unknown;
  withdrawalSubsidy?: unknown;
  proverSubsidy?: unknown;
  plainWithdrawalExecutor?: unknown;
  operationExecutor?: unknown;
  fpcFunder?: unknown;
}

interface DeploymentEnvManifestDocument {
  schemaVersion?: unknown;
  deployments?: unknown;
}

/**
 * Fetch `<deployment-env>.v4.json`, pin one entry by portal and select the historical entries to watch.
 * Only these entries are parsed. An older entry can lack a field that this relayer reads, and it stays a supported
 * deployment for other consumers.
 */
export async function resolveDeploymentEnvManifest(
  opts: ResolveDeploymentEnvManifestOptions,
): Promise<ResolvedDeploymentEnvManifest> {
  const url = opts.deploymentEnvManifestUrl;
  const entries = await readDocument(url, opts.fetch ?? fetch);
  const portal = opts.portal.toString().toLowerCase();
  const pinned = entries.find(entry => typeof entry.portal === 'string' && entry.portal.toLowerCase() === portal);
  if (!pinned) {
    const available = entries.map(nameOf).join(', ') || '(none)';
    throw new Error(
      `deployment env manifest ${url} has no deployment with portal ${opts.portal} (available: ${available}).`,
    );
  }
  const current = parseDeployment(url, pinned);
  const historical: ResolvedManifestDeployment[] = [];
  const unreadable: string[] = [];
  for (const entry of entries) {
    if (
      entry === pinned ||
      entry.withdrawalProtocol !== 'l1-operation' ||
      entry.rollupVersion !== pinned.rollupVersion
    ) {
      continue;
    }
    try {
      historical.push(parseDeployment(url, entry));
    } catch (err: unknown) {
      unreadable.push(message(err));
    }
  }
  return { current, historical, unreadable };
}

function nameOf(entry: RawDeployment): string {
  return `${String(entry.label)}:${String(entry.portal)}`;
}

function parseDeployment(url: string, raw: unknown): ResolvedManifestDeployment {
  const entry = (raw ?? {}) as RawDeployment;
  const portal = typeof entry.portal === 'string' ? entry.portal : '(no portal)';
  const label = typeof entry.label === 'string' ? entry.label : '(no label)';
  try {
    return {
      label,
      publicConfig: {
        portal: field(entry, 'portal', v => EthAddress.fromString(v)),
        l2Token: field(entry, 'l2Token', v => AztecAddress.fromStringUnsafe(v)),
        token: field(entry, 'token', v => EthAddress.fromString(v)),
        rollupVersion: field(entry, 'rollupVersion', rollupVersionOf),
        enclaveUrl: field(entry, 'enclaveUrl', v => v),
        broadcaster: field(entry, 'l2Broadcaster', v => AztecAddress.fromStringUnsafe(v)),
        withdrawalSubsidy: field(entry, 'withdrawalSubsidy', v => EthAddress.fromString(v)),
        proverSubsidy: field(entry, 'proverSubsidy', v => EthAddress.fromString(v)),
        plainWithdrawalExecutor: field(entry, 'plainWithdrawalExecutor', v => EthAddress.fromString(v)),
        operationExecutor: field(entry, 'operationExecutor', v => EthAddress.fromString(v)),
        fpcFunder: field(entry, 'fpcFunder', v => EthAddress.fromString(v)),
      },
    };
  } catch (err: unknown) {
    throw new Error(`deployment env manifest ${url}: deployment ${portal} (${label}): ${message(err)}`);
  }
}
function rollupVersionOf(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error('not a decimal integer');
  }
  return BigInt(value);
}

function field<T>(entry: RawDeployment, key: keyof RawDeployment, convert: (value: string) => T): T {
  const value = entry[key];
  if (typeof value !== 'string') {
    throw new Error(`${key} missing`);
  }
  try {
    return convert(value);
  } catch (err: unknown) {
    throw new Error(`${key} ${JSON.stringify(value)}: ${message(err)}`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readDocument(url: string, fetchFn: typeof fetch): Promise<RawDeployment[]> {
  const raw = await fetchRaw(url, fetchFn);
  let doc: DeploymentEnvManifestDocument;
  try {
    doc = JSON.parse(raw) as DeploymentEnvManifestDocument;
  } catch (err: unknown) {
    throw new Error(`deployment env manifest ${url} is not valid JSON: ${message(err)}`);
  }
  if (doc?.schemaVersion !== '4') {
    throw new Error(
      `deployment env manifest ${url} has unsupported schemaVersion ${JSON.stringify(doc?.schemaVersion)} (want "4"; the relayer reads <env>.v4.json).`,
    );
  }
  if (!Array.isArray(doc.deployments)) {
    throw new Error(`deployment env manifest ${url} has no deployments array.`);
  }
  const entries = doc.deployments as RawDeployment[];
  rejectDuplicates(url, entries);
  return entries;
}

function rejectDuplicates(url: string, entries: RawDeployment[]): void {
  const byPortal = new Map<string, RawDeployment>();
  const byLabel = new Map<string, RawDeployment>();
  for (const entry of entries) {
    const portal = typeof entry.portal === 'string' ? entry.portal.toLowerCase() : undefined;
    const label = typeof entry.label === 'string' ? entry.label : undefined;
    const samePortal = portal === undefined ? undefined : byPortal.get(portal);
    if (samePortal) {
      throw new Error(
        `deployment env manifest ${url} has two deployments with portal ${portal}: ${nameOf(samePortal)} and ${nameOf(entry)}.`,
      );
    }
    const sameLabel = label === undefined ? undefined : byLabel.get(label);
    if (sameLabel) {
      throw new Error(
        `deployment env manifest ${url} has two deployments with label ${label}: ${nameOf(sameLabel)} and ${nameOf(entry)}.`,
      );
    }
    if (portal !== undefined) {
      byPortal.set(portal, entry);
    }
    if (label !== undefined) {
      byLabel.set(label, entry);
    }
  }
}

async function fetchRaw(url: string, fetchFn: typeof fetch): Promise<string> {
  if (url.startsWith('file://')) {
    return readFile(new URL(url), 'utf8');
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return readFile(url, 'utf8');
  }
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`deployment env manifest fetch ${url} returned HTTP ${res.status}`);
  }
  return res.text();
}
