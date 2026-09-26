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
    // ci-jest never builds sibling workspaces' dest/, so resolve @oxide/oxide-lib subpath imports
    // to its TS sources (transformed on the fly by @swc/jest) instead of the unbuilt ./dest/* exports.
    '^@oxide/oxide-lib/(.*)\\.js$': '<rootDir>/../../oxide-lib/src/$1.ts',
    '^(\\.{1,2}/.*)\\.[cm]?js$': '$1',
  },
  moduleDirectories: ['node_modules', '<rootDir>/../../node_modules'],
};
