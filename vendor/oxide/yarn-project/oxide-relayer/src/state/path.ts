import type { EthAddress } from '@aztec/foundation/eth-address';

export const PORTAL_STATE_PLACEHOLDER = '{portal}';

/** Resolve one deployment's SQLite file without allowing multiple portals to share a database. */
export function statePathForPortal(template: string, portal: EthAddress, deploymentCount: number): string {
  if (template.includes(PORTAL_STATE_PLACEHOLDER)) {
    return template.replaceAll(PORTAL_STATE_PLACEHOLDER, portal.toString().toLowerCase());
  }
  if (deploymentCount > 1) {
    throw new Error(
      `SQLite state path must contain ${PORTAL_STATE_PLACEHOLDER} when the manifest contains multiple deployments.`,
    );
  }
  return template;
}
