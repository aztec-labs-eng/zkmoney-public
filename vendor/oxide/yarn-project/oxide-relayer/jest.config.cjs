module.exports = {
  extensionsToTreatAsEsm: ['.ts'],
  testRegex: './src/.*\\.test\\.(js|mjs|ts)$',
  rootDir: './src',
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' } },
      },
    ],
  },
  moduleNameMapper: {
    // ci-jest never builds sibling workspaces' dest/, so resolve their subpath imports to TS sources
    '^@oxide/oxide-lib/(.*)\\.js$': '<rootDir>/../../oxide-lib/src/$1.ts',
    '^@oxide/watcher-lib/event-store$': '<rootDir>/../../watcher-lib/src/event_store.ts',
    '^@oxide/watcher-lib/cursor$': '<rootDir>/../../watcher-lib/src/cursor.ts',
    '^@oxide/watcher-lib/ingester$': '<rootDir>/../../watcher-lib/src/ingester.ts',
    '^@oxide/watcher-lib/sanctions$': '<rootDir>/../../watcher-lib/src/sanctions/index.ts',
    '^(\\.{1,2}/.*)\\.[cm]?js$': '$1',
  },
  moduleDirectories: ['node_modules', '<rootDir>/../../node_modules'],
};
