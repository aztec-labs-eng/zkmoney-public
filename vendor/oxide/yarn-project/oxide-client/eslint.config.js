import base from '../eslint.config.js';

// External clients build these modules without `@oxide/noir-contracts.js`. See "Bindings-free client modules" in
// AGENTS.md.
const BINDINGS_FREE_MODULES = [
  'src/atlatl/process_withdrawal_request.ts',
  'src/broadcaster_calls.ts',
  'src/capsules.ts',
  'src/eth_usd_price_feed.ts',
  'src/l1_operation_quote.ts',
  'src/l2_operations.ts',
  'src/partial_epoch_proof_profit.ts',
  'src/published_withdrawal.ts',
  'src/sipa_event_calls.ts',
  'src/withdraw_escrows/*',
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
