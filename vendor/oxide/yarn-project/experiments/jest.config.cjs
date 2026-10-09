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
    '^(\\.{1,2}/.*)\\.[cm]?js$': '$1',
  },
  moduleDirectories: ['node_modules', '<rootDir>/../../node_modules'],
};
