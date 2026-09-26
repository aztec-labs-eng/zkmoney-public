import base from '../eslint.config.js';

// External clients build these modules without `@oxide/noir-contracts.js`. See "Bindings-free client modules" in
// AGENTS.md.
const BINDINGS_FREE_MODULES = [
  'src/atlatl/process_withdrawal_request.ts',
  'src/broadcaster_calls.ts',
  'src/capsules.ts',
  'src/l2_operations.ts',
  'src/published_withdrawal.ts',
  'src/sipa_event_calls.ts',
  'src/swap_on_withdraw.ts',
];

const BINDINGS_FREE_REASON =
  'External clients build the bindings-free modules without @oxide/noir-contracts.js, with their own bindings. ' +
  'See "Bindings-free client modules" in AGENTS.md.';

export default [
  ...base,
  {
    files: BINDINGS_FREE_MODULES,
    rules: {
      // Same as the base rule plus the bindings ban.
      'no-restricted-imports': [
        'error',
        {
          paths: ['./broadcaster.js', './sipa_events.js', './index.js'].map(name => ({
            name,
            message: `This module imports the generated bindings. Import a bindings-free module. ${BINDINGS_FREE_REASON}`,
          })),
          patterns: [
            {
              group: ['dest'],
              message: 'You should not be importing from a build directory. Did you accidentally do a relative import?',
            },
            {
              group: ['@oxide/noir-contracts.js', '@oxide/noir-contracts.js/*'],
              message: `Do not import the generated bindings. Type the contract handle structurally. ${BINDINGS_FREE_REASON}`,
            },
          ],
        },
      ],
    },
  },
];
