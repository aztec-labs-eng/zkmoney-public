import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, it } from '@jest/globals';

import { buildMigrationOperation } from './migration_operation.js';

const subsidy = EthAddress.random();
const subsidyToken = EthAddress.random();

describe('buildMigrationOperation', () => {
  it('targets the migration subsidy, keeps the portal calldata and runs at once', () => {
    const operation = buildMigrationOperation({ subsidy, payoutToken: subsidyToken, calldata: '0xdeadbeef' });

    expect(operation.target).toEqual(subsidy);
    expect(operation.payoutToken).toEqual(subsidyToken);
    expect(operation.calldata).toEqual(Buffer.from('deadbeef', 'hex'));
    expect(operation.condition.kind).toBe(L1OperationConditionKind.Immediate);
  });
});
