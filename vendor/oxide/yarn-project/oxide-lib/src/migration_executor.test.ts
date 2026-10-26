import { Fr } from '@aztec-labs/aztec.js/fields';
import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { decodeExecutorRelayerPayload } from './executor.js';
import {
  buildMigrationExecutorCall,
  decodeMigrationPayload,
  encodeMigrationPayload,
  migratedAmount,
} from './migration_executor.js';

describe('migration codec', () => {
  const recipientCommitment = new Fr(0x1234n);

  it('encodes the commitment word and the tip word', () => {
    const payload = encodeMigrationPayload({ recipientCommitment, relayerTip: 75317531n });

    expect(payload).toHaveLength(64);
    expect(payload.toString('hex')).toBe(
      '0000000000000000000000000000000000000000000000000000000000001234' +
        '00000000000000000000000000000000000000000000000000000000047d411b',
    );
    expect(decodeMigrationPayload(payload)).toEqual({ recipientCommitment, relayerTip: 75317531n });
  });

  it('accepts the commitment as a field or hex', () => {
    const fromField = encodeMigrationPayload({ recipientCommitment, relayerTip: 0n });
    expect(
      encodeMigrationPayload({ recipientCommitment: recipientCommitment.toString() as `0x${string}`, relayerTip: 0n }),
    ).toEqual(fromField);
  });

  it('rejects a zero commitment', () => {
    expect(() => encodeMigrationPayload({ recipientCommitment: Fr.ZERO, relayerTip: 0n })).toThrow(/must not be zero/);
    expect(() => decodeMigrationPayload(Buffer.alloc(64))).toThrow(/must not be zero/);
  });

  it('rejects a commitment that is not a field element', () => {
    expect(() => encodeMigrationPayload({ recipientCommitment: `0x${'ff'.repeat(32)}`, relayerTip: 0n })).toThrow(
      /not a field element/,
    );
  });

  it('rejects a commitment of the wrong length', () => {
    expect(() => encodeMigrationPayload({ recipientCommitment: `0x${'01'.repeat(31)}`, relayerTip: 0n })).toThrow(
      /exactly 32 bytes/,
    );
  });

  it('rejects a negative tip', () => {
    expect(() => encodeMigrationPayload({ recipientCommitment, relayerTip: -1n })).toThrow(/negative/);
  });

  it('rejects malformed payload lengths', () => {
    expect(() => decodeMigrationPayload(Buffer.alloc(63))).toThrow(/64/);
    expect(() => decodeMigrationPayload(Buffer.alloc(65))).toThrow(/64/);
  });
});

describe('migrated amount', () => {
  it('subtracts the tip from the executor amount', () => {
    expect(migratedAmount(100n, 0n)).toBe(100n);
    expect(migratedAmount(100n, 99n)).toBe(1n);
  });

  it('rejects a tip that leaves nothing to migrate', () => {
    expect(() => migratedAmount(100n, 100n)).toThrow(/nothing/);
    expect(() => migratedAmount(100n, 101n)).toThrow(/exceeds/);
  });
});

describe('migration executor call', () => {
  const executor = EthAddress.fromString('0x2222222222222222222222222222222222222222');
  const recipientCommitment = new Fr(7n);

  it('defaults to no tip and a zero tip recipient', () => {
    const call = buildMigrationExecutorCall({ executor, recipientCommitment });

    expect(call.executor).toEqual(executor);
    expect(decodeMigrationPayload(call.userPayload)).toEqual({ recipientCommitment, relayerTip: 0n });
    expect(decodeExecutorRelayerPayload(call.relayerPayload)).toEqual({ tipRecipient: EthAddress.ZERO });
  });

  it('names the tip recipient in the 20-byte relayer payload', () => {
    const tipRecipient = EthAddress.fromString('0x3333333333333333333333333333333333333333');
    const call = buildMigrationExecutorCall({ executor, recipientCommitment, relayerTip: 5n, tipRecipient });

    expect(decodeMigrationPayload(call.userPayload).relayerTip).toBe(5n);
    expect(call.relayerPayload).toEqual(tipRecipient.toBuffer());
  });
});
