import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { statePathForPortal } from './path.js';

const PORTAL = EthAddress.fromString('0x00000000000000000000000000000000000000ab');

describe('statePathForPortal', () => {
  it('expands every portal placeholder using the normalized address', () => {
    expect(statePathForPortal('/data/{portal}/relayer-{portal}.sqlite3', PORTAL, 3)).toBe(
      `/data/${PORTAL.toString().toLowerCase()}/relayer-${PORTAL.toString().toLowerCase()}.sqlite3`,
    );
  });

  it('preserves a fixed path for one deployment', () => {
    expect(statePathForPortal('/data/state.sqlite3', PORTAL, 1)).toBe('/data/state.sqlite3');
  });

  it('rejects a fixed path for multiple deployments', () => {
    expect(() => statePathForPortal('/data/state.sqlite3', PORTAL, 2)).toThrow(/must contain \{portal\}/);
  });
});
