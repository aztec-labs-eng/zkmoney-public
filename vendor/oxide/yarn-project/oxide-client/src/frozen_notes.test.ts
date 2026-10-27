import { NO_FROM } from '@aztec-labs/aztec.js/account';
import type { SimulateInteractionOptions } from '@aztec-labs/aztec.js/contracts';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import { describe, expect, it, jest } from '@jest/globals';

import { getRefundableFrozenNotes } from './frozen_notes.js';

describe('getRefundableFrozenNotes', () => {
  async function enumerate(owner: AztecAddress, simulateOptions?: SimulateInteractionOptions) {
    const simulate = jest.fn((_options: SimulateInteractionOptions) => Promise.resolve({ offchainEffects: [] }));
    const contract = {
      address: await AztecAddress.random(),
      // eslint-disable-next-line camelcase
      methods: { enumerate_owned_notes: () => ({ simulate }) },
    } as any;
    const archive = { checkpointEndBlockHeader: { hash: () => Promise.resolve(Fr.random()) } } as any;
    await getRefundableFrozenNotes({} as any, contract, {} as any, owner, jest.fn() as any, archive, simulateOptions);
    return simulate;
  }

  it('enumerates the notes as the owner by default', async () => {
    const owner = await AztecAddress.random();
    expect(await enumerate(owner)).toHaveBeenCalledWith({ from: owner });
  });

  it("enumerates an escrow's notes with the caller's simulate options", async () => {
    const escrow = await AztecAddress.random();
    const options: SimulateInteractionOptions = { from: NO_FROM, additionalScopes: [escrow] };
    expect(await enumerate(escrow, options)).toHaveBeenCalledWith(options);
  });
});
