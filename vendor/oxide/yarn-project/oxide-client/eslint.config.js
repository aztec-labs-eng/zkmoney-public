import base from '../eslint.config.js';

// External clients build these modules without `@oxide/noir-contracts.js`. See "Bindings-free client modules" in
// AGENTS.md.
const BINDINGS_FREE_MODULES = [
  'src/atlatl/withdrawal_finalization.ts',
  'src/broadcaster_calls.ts',
  'src/capsules.ts',
  'src/deposit_refund_eligibility.ts',
  'src/eth_usd_price_feed.ts',
  'src/executors/*',
  'src/l1_operation_quote.ts',
  'src/l2_operations.ts',
  'src/partial_epoch_proof_profit.ts',
  'src/passkey_rotation.ts',
  'src/record_update.ts',
  'src/sipa_event_calls.ts',
  'src/submitted_withdrawal.ts',
  'src/token_registration.ts',
  'src/withdraw_escrows/*',
  'src/withdrawal_recovery.ts',
  'src/withdrawal_finalization_request.ts',
  'src/withdrawal_in_tx.ts',
];

const BINDINGS_FREE_REASON =
  'External clients build the bindings-free modules without @oxide/noir-contracts.js, with their own bindings. ' +
  'See "Bindings-free client modules" in AGENTS.md.';

export default [
  ...base,
  {
    files: BINDINGS_FREE_MODULES,
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: import.meta.dirname,
          zones: [
            {
              target: BINDINGS_FREE_MODULES,
              from: ['../noir-contracts.js', 'src/broadcaster.ts', 'src/sipa_events.ts', 'src/index.ts'],
              message: `Import a bindings-free module, and type each contract handle structurally. ${BINDINGS_FREE_REASON}`,
            },
          ],
        },
      ],
    },
  },
];
