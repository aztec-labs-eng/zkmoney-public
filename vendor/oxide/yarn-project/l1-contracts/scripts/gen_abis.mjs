#!/usr/bin/env node
// Reads foundry-emitted artifacts under `../../l1-contracts/out/` and writes typed (`as const`)
// ABI + bytecode constants to `src/abis/*.ts`. viem's contract-handle inference only narrows method return
// types when the ABI is a literal-typed `as const` value, so a JSON `assert { type: 'json' }`
// import isn't enough — we need the ABI to be a `.ts` file the compiler can see the literal
// shape of.
//
// Run after recompiling solidity:
//
//   (cd ../../l1-contracts && forge build) && node scripts/gen_abis.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'src', 'abis');
const L1_CONTRACTS = join(ROOT, '..', '..', 'l1-contracts');
const FOUNDRY_OUT = join(L1_CONTRACTS, 'out');

// Map `<sym>` to its source artifact JSON. `<sym>` becomes `<sym>Abi` / `<sym>Bytecode` exports
// in a generated `<sym>.ts` file under `src/abis/`.
const TARGETS = {
  MetadataV2Registry: { root: FOUNDRY_OUT, rel: 'MetadataV2.sol/MetadataV2Registry.json' },
  MetadataV2Controller: { root: FOUNDRY_OUT, rel: 'MetadataV2.sol/MetadataV2Controller.json' },
  OxidePortal: { root: FOUNDRY_OUT, rel: 'OxidePortal.sol/OxidePortal.json' },
  PlainWithdrawalExecutor: {
    root: FOUNDRY_OUT,
    rel: 'PlainWithdrawalExecutor.sol/PlainWithdrawalExecutor.json',
  },
  FirstProverProofSubmitter: {
    root: FOUNDRY_OUT,
    rel: 'FirstProverProofSubmitter.sol/FirstProverProofSubmitter.json',
  },
  IFPCFunder: { root: FOUNDRY_OUT, rel: 'IFPCFunder.sol/IFPCFunder.json' },
  // Every custom error of the periphery contracts, so a client can decode a revert by name.
  Errors: { root: FOUNDRY_OUT, rel: 'Errors.sol/Errors.json' },
  DepositSubsidy: { root: FOUNDRY_OUT, rel: 'DepositSubsidy.sol/DepositSubsidy.json' },
  WithdrawalSubsidy: { root: FOUNDRY_OUT, rel: 'WithdrawalSubsidy.sol/WithdrawalSubsidy.json' },
  ProverSubsidy: { root: FOUNDRY_OUT, rel: 'ProverSubsidy.sol/ProverSubsidy.json' },
  MockCertManager: { root: FOUNDRY_OUT, rel: 'MockCertManager.sol/MockCertManager.json' },
  MockNitroValidator: { root: FOUNDRY_OUT, rel: 'MockNitroValidator.sol/MockNitroValidator.json' },
  // Test-friendly CertManager that pre-saves the test root via its constructor — pair with a
  // real `NitroValidator` to validate fixtures from `gen_test_attestation` end-to-end.
  TestCertManager: { root: FOUNDRY_OUT, rel: 'TestCertManager.sol/TestCertManager.json' },
  // The HonkVerifier emitted by bb is auto-generated and named `HonkVerifier` inside each file
  // (one per refund circuit). Foundry indexes artifacts under `out/<file>.sol/<contract>.json`,
  // so the three HonkVerifiers don't collide despite sharing the contract name.
  FrozenNotesRefundVerifier: { root: FOUNDRY_OUT, rel: 'FrozenNotesRefundVerifier.sol/HonkVerifier.json' },
  FrozenDepositRefundVerifier: {
    root: FOUNDRY_OUT,
    rel: 'FrozenDepositRefundVerifier.sol/HonkVerifier.json',
  },
  UnprocessedDepositRefundVerifier: {
    root: FOUNDRY_OUT,
    rel: 'UnprocessedDepositRefundVerifier.sol/HonkVerifier.json',
  },
  // Each verifier declares `accumulateRelationEvaluations` as `external pure` on a `RelationsLib`
  // co-located in the same .sol file. The Solidity compiler emits the library as a separately
  // deployable contract and leaves a `__$<hash>$__` placeholder in the verifier bytecode that must
  // be replaced with the library's deployment address before sending the verifier deploy tx.
  // The libraries (one per refund verifier) are compiled from textually identical sources but live
  // in different files, so foundry indexes them under distinct paths and the placeholder hashes differ.
  FrozenNotesRelationsLib: { root: FOUNDRY_OUT, rel: 'FrozenNotesRefundVerifier.sol/RelationsLib.json' },
  FrozenDepositRelationsLib: { root: FOUNDRY_OUT, rel: 'FrozenDepositRefundVerifier.sol/RelationsLib.json' },
  UnprocessedDepositRelationsLib: {
    root: FOUNDRY_OUT,
    rel: 'UnprocessedDepositRefundVerifier.sol/RelationsLib.json',
  },
  // Oxide-forked cert manager + nitro validator under `src/core/lib/` — swap solarity's affine
  // P-384 verify for the Jacobian implementation (~4.5× cheaper under EIP-7883), expose
  // `getVerified` on the cert manager, and add `verifyAttestationHash` / `verifyAttestationSignature`
  // staging entry points on the validator. AWS root constants are byte-for-byte preserved.
  CertManager: { root: FOUNDRY_OUT, rel: 'CertManager.sol/CertManager.json' },
  NitroValidator: { root: FOUNDRY_OUT, rel: 'NitroValidator.sol/NitroValidator.json' },
  // Periphery: name registry + stealth-deposit resolver. bb emits the resolver verifier as a
  // `HonkVerifier` contract (linked against its own `ZKTranscriptLib`); MockPortal comes from
  // the registry test fixtures.
  NameRegistry: { root: FOUNDRY_OUT, rel: 'NameRegistry.sol/NameRegistry.json' },
  AccountMetadataRegistry: { root: FOUNDRY_OUT, rel: 'AccountMetadataRegistry.sol/AccountMetadataRegistry.json' },
  // The registration payment policy (fee token, floor, fee, beneficiary allowlist, waiver). Plain deploy — not
  // library-linked — so the deploy helper needs only its ABI + bytecode.
  RegistrationController: { root: FOUNDRY_OUT, rel: 'RegistrationController.sol/RegistrationController.json' },
  // Permissionless L1 -> L2 relay of a registered name; the controller notifies through it at registration.
  NamePortal: { root: FOUNDRY_OUT, rel: 'NamePortal.sol/NamePortal.json' },
  // The shared custody base every intent clones; its ABI carries `sweep`/`swept`/`Sweep` the relayer drives on a
  // clone. Each intent is a separate `SIPABase` implementation selected by address at deploy time.
  SIPA: { root: FOUNDRY_OUT, rel: 'SIPABase.sol/SIPABase.json' },
  // The intent implementations. One set per rollup version, deployed against that version's Portal and then
  // blessed on the permanent factory, so the deploy needs bytecode, not just ABI.
  DepositSIPA: { root: FOUNDRY_OUT, rel: 'DepositSIPA.sol/DepositSIPA.json' },
  RegistrationSIPA: { root: FOUNDRY_OUT, rel: 'RegistrationSIPA.sol/RegistrationSIPA.json' },
  UpdateMetadataSIPA: { root: FOUNDRY_OUT, rel: 'UpdateMetadataSIPA.sol/UpdateMetadataSIPA.json' },
  AccountMetadataController: {
    root: FOUNDRY_OUT,
    rel: 'IAccountMetadataController.sol/IAccountMetadataController.json',
  },
  SIPAFactory: { root: FOUNDRY_OUT, rel: 'SIPAFactory.sol/SIPAFactory.json' },
  SIPAResolver: { root: FOUNDRY_OUT, rel: 'Resolver.sol/Resolver.json' },
  OperationExecutor: { root: FOUNDRY_OUT, rel: 'OperationExecutor.sol/OperationExecutor.json' },
  // Test-only operation target — pays a fixed reward to its caller; e2e drives the executor with it.
  MockOperation: { root: FOUNDRY_OUT, rel: 'MockOperation.sol/MockOperation.json' },
  MockPortal: { root: FOUNDRY_OUT, rel: 'MockPortal.sol/MockPortal.json' },
  FPCFunderTestnet: { root: FOUNDRY_OUT, rel: 'FPCFunderTestnet.sol/FPCFunderTestnet.json' },
  FPCFunderDAI: { root: FOUNDRY_OUT, rel: 'FPCFunderDAI.sol/FPCFunderDAI.json' },
  // Test-only UniversalRouter stand-in — e2e etches it at the funder's pinned router address.
  MockSwapRouter: { root: FOUNDRY_OUT, rel: 'MockSwapRouter.sol/MockSwapRouter.json' },
  // Abstract: only the ABI is used.
  EscrowBase: { root: FOUNDRY_OUT, rel: 'EscrowBase.sol/EscrowBase.json' },
  // Swap-on-withdraw feature (disposable — purge these with `src/swap_on_withdraw.ts`). MockUniversalRouter is the
  // feature's route-honoring test router; MockCurve3Pool stands in for the 3pool the DAI hops go through;
  // MockUniswapV2Pair and MockWETH9 stand in for the DAI/WETH pair and WETH of the DAI-for-gas swap.
  SwapEscrow: { root: FOUNDRY_OUT, rel: 'SwapEscrow.sol/SwapEscrow.json' },
  SwapEscrowFactory: { root: FOUNDRY_OUT, rel: 'SwapEscrowFactory.sol/SwapEscrowFactory.json' },
  MockUniversalRouter: { root: FOUNDRY_OUT, rel: 'MockUniversalRouter.sol/MockUniversalRouter.json' },
  MockCurve3Pool: { root: FOUNDRY_OUT, rel: 'MockCurve3Pool.sol/MockCurve3Pool.json' },
  MockUniswapV2Pair: { root: FOUNDRY_OUT, rel: 'MockUniswapV2Pair.sol/MockUniswapV2Pair.json' },
  MockWETH9: { root: FOUNDRY_OUT, rel: 'MockWETH9.sol/MockWETH9.json' },
  // CCTP bridge-on-withdraw feature (disposable — purge these with `src/cctp_bridge_on_withdraw.ts`).
  CCTPBridgeEscrow: { root: FOUNDRY_OUT, rel: 'CCTPBridgeEscrow.sol/CCTPBridgeEscrow.json' },
  CCTPBridgeEscrowFactory: { root: FOUNDRY_OUT, rel: 'CCTPBridgeEscrowFactory.sol/CCTPBridgeEscrowFactory.json' },
  MockTokenMessengerV2: { root: FOUNDRY_OUT, rel: 'MockTokenMessengerV2.sol/MockTokenMessengerV2.json' },
  // Across bridge-on-withdraw feature (disposable — purge these with `src/across_bridge_on_withdraw.ts`).
  AcrossBridgeEscrow: { root: FOUNDRY_OUT, rel: 'AcrossBridgeEscrow.sol/AcrossBridgeEscrow.json' },
  AcrossBridgeEscrowFactory: { root: FOUNDRY_OUT, rel: 'AcrossBridgeEscrowFactory.sol/AcrossBridgeEscrowFactory.json' },
  MockAcrossSpokePool: { root: FOUNDRY_OUT, rel: 'MockAcrossSpokePool.sol/MockAcrossSpokePool.json' },
  // Sky savings experiment.
  SkyWithdrawalExecutor: { root: FOUNDRY_OUT, rel: 'SkyWithdrawalExecutor.sol/SkyWithdrawalExecutor.json' },
  SkyEscrow: { root: FOUNDRY_OUT, rel: 'SkyEscrow.sol/SkyEscrow.json' },
  SkyEscrowFactory: { root: FOUNDRY_OUT, rel: 'SkyEscrowFactory.sol/SkyEscrowFactory.json' },
  MockDaiUsds: { root: FOUNDRY_OUT, rel: 'MockDaiUsds.sol/MockDaiUsds.json' },
  MockSUsds: { root: FOUNDRY_OUT, rel: 'MockSUsds.sol/MockSUsds.json' },
  MultiPortalProofSubmitter: { root: FOUNDRY_OUT, rel: 'MultiPortalProofSubmitter.sol/MultiPortalProofSubmitter.json' },
  // ERC-4337 account that is a user's stable identity, plus the CREATE2 factory that deploys it.
  OxideAccount: { root: FOUNDRY_OUT, rel: 'OxideAccount.sol/OxideAccount.json' },
  OxideAccountFactory: { root: FOUNDRY_OUT, rel: 'OxideAccountFactory.sol/OxideAccountFactory.json' },
  // Canonical ERC-4337 EntryPoint v0.8 (test-only) — deployed in e2e to drive UserOps end-to-end.
  EntryPoint: { root: FOUNDRY_OUT, rel: 'EntryPoint.sol/EntryPoint.json' },
  // Test-only paymaster — sponsors a zero-balance account's UserOp (signature-gated) in e2e.
  OxidePaymaster: { root: FOUNDRY_OUT, rel: 'OxidePaymaster.sol/OxidePaymaster.json' },
  // The deploy flow uses the pinned resolver verifier (the one the deployed SIPAResolver accepts proofs from — see
  // noir-projects/resolver_circuit/repin.sh), not the build-local src/generated/ResolverVerifier.sol.
  ResolverVerifier: { root: FOUNDRY_OUT, rel: 'PinnedResolverVerifier.sol/HonkVerifier.json' },
  ZKTranscriptLib: { root: FOUNDRY_OUT, rel: 'PinnedResolverVerifier.sol/ZKTranscriptLib.json' },
  ResolverRelationsLib: { root: FOUNDRY_OUT, rel: 'PinnedResolverVerifier.sol/RelationsLib.json' },
  MockPortal: { root: FOUNDRY_OUT, rel: 'MockPortal.sol/MockPortal.json' },
  // Stands in for the retired deposit Pool: the legacy SIPA fixture in sipa_recovery.test.ts pins its rollup
  // version through the old `rollupVersion()` getter.
  MockLegacyDepositPool: { root: FOUNDRY_OUT, rel: 'MockLegacyDepositPool.sol/MockLegacyDepositPool.json' },
  MockVerifier: { root: FOUNDRY_OUT, rel: 'MockVerifier.sol/MockVerifier.json' },
  // Chainlink feed stub — the subsidy contracts require a feed with code, so tests deploy this.
  MockV3Aggregator: { root: FOUNDRY_OUT, rel: 'MockV3Aggregator.sol/MockV3Aggregator.json' },
};

mkdirSync(OUT_DIR, { recursive: true });

for (const [sym, { root, rel }] of Object.entries(TARGETS)) {
  const json = JSON.parse(readFileSync(join(root, rel), 'utf8'));
  const abi = json.abi;
  const bytecode = json.bytecode.object;
  const linkReferences = json.bytecode.linkReferences ?? {};
  const sourceLabel = `l1-contracts/out/${rel}`;
  const file = `// AUTO-GENERATED by scripts/gen_abis.mjs from ${sourceLabel}.
// Do not edit by hand — re-run the script after changing the solidity.

export const ${sym}Abi = ${JSON.stringify(abi, null, 2)} as const;

export const ${sym}Bytecode = '${bytecode}' as \`0x\${string}\`;

export const ${sym}LinkReferences = ${JSON.stringify(linkReferences, null, 2)} as const;
`;
  const out = join(OUT_DIR, `${sym}.ts`);
  writeFileSync(out, file);
  console.log(`wrote ${out} (${abi.length} abi entries, ${bytecode.length / 2 - 1} bytecode bytes)`);
}
