"""The subsidy contracts that the subsidy check knows, and the forge evidence that each one needs.

A subsidy is a contract or library under l1-contracts/src that:

- has a name that ends in `Subsidy`, or inherits an interface named `I...Subsidy`;
- reads the gas price: `tx.gasprice` or `block.basefee`, or `gasprice()` or `basefee()` in assembly;
- inherits a subsidy, under any name or import alias, through any number of parents; or
- calls a library that is a subsidy, or attaches it with `using ... for`.

Each one is either tested, with the forge tests that it needs and its known gaps, or exempt, with the reason and a hash
of its source: the imports of its file, its declaration, its body, and each contract under src that it inherits. A
change to that source fails the check until a reviewer accepts the exemption again and updates the hash. A test is
named `path:Contract.function`. check.sh runs this on the `forge test --json` results of the subsidy tests, and it
fails when:

- a subsidy is not in the registry, or the registry names a contract that is not a subsidy (a stale entry);
- another contract or library under src has the name of a subsidy;
- a tested subsidy names no test, or does not name the farm-safety property (`FARM_SAFETY`): one fuzz test over each
  caller shape and one fixed test of each shape, from test/subsidy-check/subsidies/SubsidyFarmSafety.sol. A subsidy in
  `NO_FARM_SAFETY` has a reason instead;
- a test file under l1-contracts/test whose name contains `Subsidy` is outside the subsidy tests (`EVIDENCE_DIR`, and
  the files that `ALLOWED_OUTSIDE` allows by name with a reason), or an allowed file is gone or has no reason;
- a test in the subsidy tests, in the forge test list (`--inventory`), is named by no entry;
- a named test is outside the subsidy tests, or in a test contract whose name does not start with its subsidy's name;
- a named test is not in the results, did not pass, or was skipped, or a result is malformed;
- a test is named twice;
- a named fuzz test had no runs, or calls `vm.assume` (itself, or through a helper or modifier that it reaches in its
  own file or the test files that it imports) or returns early, so that some runs test nothing;
- a gap has no Linear issue, or its test's name does not carry it;
- an exemption has no reason, or its source hash is not the hash of the contract's source today.

Each gas row's fork pin is evidence of DepositSubsidy, so each pin must pass. So is the corner test of each mainnet
flow (gen.py): a live flow's corner test, and a known gap's shortfall test with its issue.
So is each flow's settlement on the fork and its farming test, with their known gaps (flows.SETTLEMENT_GAP_FLOWS and
flows.FARMING_GAP_FLOWS).

The discovery reads source, so it cannot see a free function that reads the gas price, a price that a caller passes in
as a parameter, or pricing that another contract does through an external call. A reviewer asks for those.

Run: python3 -I registry.py <forge test --json results> [--inventory <forge test --list --json output>]
"""

import functools
import hashlib
import json
import os
import pathlib
import re
import sys
import tomllib
from dataclasses import dataclass

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import flows  # noqa: E402
import gas_rows  # noqa: E402
import gen  # noqa: E402

L1 = pathlib.Path(__file__).resolve().parents[1]
SRC = L1 / "src"
# The subsidy tests: each file under this folder, and the files outside it that ALLOWED_OUTSIDE names. Each test that an
# entry names must be one of them, and each test in the folder must be named. Locally, check.sh runs only these.
EVIDENCE_DIR = "test/subsidy-check/"
MIGRATION_OUTSIDE = (
    "MigrationSubsidy pays a profit to the relayer on purpose, so its tests are different. OX-2438 moves them into the "
    "check."
)
PLAIN_WITHDRAWAL_OUTSIDE = "PlainWithdrawalSubsidy is exempt: OX-1880 replaces it and these tests."
ALLOWED_OUTSIDE = {
    "test/periphery/migration/MigrationSubsidy.t.sol": MIGRATION_OUTSIDE,
    "test/periphery/migration/MigrationSubsidy.farmSafety.t.sol": MIGRATION_OUTSIDE,
    "test/periphery/migration/MigrationSubsidy.relayedExit.t.sol": MIGRATION_OUTSIDE,
    "test/periphery/ProverSubsidy.t.sol": "ProverSubsidy is exempt: it pays a flat amount and prices no gas. OX-2404 "
    "removes it.",
    "test/periphery/PlainWithdrawalSubsidy.t.sol": PLAIN_WITHDRAWAL_OUTSIDE,
    "test/periphery/PlainWithdrawalSubsidy.modeledTxGas.t.sol": PLAIN_WITHDRAWAL_OUTSIDE,
    "test/periphery/PlainWithdrawalSubsidy.relayedExit.t.sol": PLAIN_WITHDRAWAL_OUTSIDE,
}
# The --match-path of the forge run of check.sh: the subsidy tests.
FORGE_MATCH = "{" + ",".join((EVIDENCE_DIR + "**", *sorted(ALLOWED_OUTSIDE))) + "}"


def in_evidence(path: str, allowed_outside: dict = ALLOWED_OUTSIDE) -> bool:
    """Whether a test file, by its path under l1-contracts, is one of the subsidy tests."""
    return path.startswith(EVIDENCE_DIR) or path in allowed_outside


@dataclass(frozen=True)
class Gap:
    issue: str
    """The Linear issue of the gap, such as OX-2234."""
    test: str
    """A test that passes while the gap is there. Its name carries the issue, such as testFuzz_Gap_OX2234_..."""


@dataclass(frozen=True)
class Tested:
    tests: tuple[str, ...]
    gaps: tuple[Gap, ...] = ()


@dataclass(frozen=True)
class Exempt:
    reason: str
    source: str = ""
    """The `source_hash` of the contract when a reviewer accepted the exemption."""


def suite(path: str, contract: str, *functions: str) -> tuple[str, ...]:
    return tuple(f"{path}:{contract}.{function}" for function in functions)


DEPOSIT_QUOTE = "test/subsidy-check/subsidies/DepositSubsidy.quote.t.sol"
DEPOSIT_METER = "test/subsidy-check/subsidies/DepositSubsidy.meter.t.sol"
DEPOSIT_PAYMENT = "test/subsidy-check/subsidies/DepositSubsidy.payment.t.sol"
DEPOSIT_FARM_SAFETY = "test/subsidy-check/subsidies/DepositSubsidy.farmSafety.t.sol"
DEPOSIT_ADMIN = "test/subsidy-check/subsidies/DepositSubsidy.admin.t.sol"
DEPOSIT_RELAYS = "test/subsidy-check/subsidies/DepositSubsidy.executorPath.t.sol"
DEPOSIT_DEPLOY_ENTRY = "test/subsidy-check/subsidies/DepositSubsidy.deployAndSweep.t.sol"
DEPOSIT_INTENTS = "test/subsidy-check/subsidies/DepositSubsidy.intentPricing.t.sol"
DEPOSIT_MINIMUM_CREDIT = "test/subsidy-check/subsidies/DepositSubsidy.minCreditedAmount.t.sol"
DEPOSIT_CEILINGS = "test/subsidy-check/subsidies/DepositSubsidy.sweepGas.t.sol"
MIGRATION_QUOTE = "test/subsidy-check/subsidies/MigrationSubsidy.quote.t.sol"
MIGRATION_FARM_SAFETY = "test/periphery/migration/MigrationSubsidy.farmSafety.t.sol"


# The farm-safety property (README.md#farm-safety). Each tested subsidy names both tests, which its test contract inherits
# from SubsidyFarmSafety, except a subsidy in NO_FARM_SAFETY.
FARM_SAFETY = (
    "testFuzz_GivenAnyCaller_ThenOnlyARelayerTransactionDrawsFromThePot",
    "test_GivenEachCaller_ThenOnlyARelayerTransactionDrawsFromThePot",
)
NO_FARM_SAFETY = {
    "MigrationSubsidy": "It pays a profit to the relayer on purpose, so a relayer gains from its own migration. Its "
    "eligibility tests are in MigrationSubsidy.farmSafety.t.sol until OX-2438 gives it the property.",
}


def gas_row_pins() -> tuple[str, ...]:
    """The fork pin of each gas row."""
    return tuple(f"{gas_rows.PINS}:{gas_rows.PIN_SUITE}.{gas_rows.pin_test(row)}" for row in sorted(gas_rows.rows()))


def flow_corner_tests() -> tuple[tuple[str, ...], tuple[Gap, ...]]:
    """The corner tests of each mainnet flow that must be live, and a gap for each one that is a known gap."""
    found, _, _ = flows.flows()
    suite_id = f"{gen.CORNERS.relative_to(L1)}:{gen.CORNER_SUITE}"
    tests, gaps = [], []
    for f in found:
        issue = flows.GAP_FLOWS.get(f.id)
        if issue is None:
            tests.append(f"{suite_id}.{gen.corner_test(f)}")
        else:
            gaps.append(Gap(issue, f"{suite_id}.{gen.corner_test(f)}"))
    return tuple(tests), tuple(gaps)


LIVE_FLOW_TESTS, GAP_FLOW_TESTS = flow_corner_tests()


def flow_settlement_tests() -> tuple[tuple[str, ...], tuple[Gap, ...]]:
    """The settlement and farming tests of each mainnet flow, and a gap for each known settlement or farming gap."""
    found, _, _ = flows.flows()
    suite_id = f"{gen.SETTLEMENTS.relative_to(L1)}:{gen.SETTLEMENT_SUITE}"
    tests, gaps = [], []
    for f in found:
        for gap_flows, test in ((flows.SETTLEMENT_GAP_FLOWS, gen.settlement_test(f)),
                                (flows.FARMING_GAP_FLOWS, gen.farming_test(f))):  # fmt: skip
            issue = gap_flows.get(f.id)
            if issue is None:
                tests.append(f"{suite_id}.{test}")
            else:
                gaps.append(Gap(issue, f"{suite_id}.{test}"))
    return tuple(tests), tuple(gaps)


SETTLEMENT_TESTS, SETTLEMENT_GAP_TESTS = flow_settlement_tests()
SETTLEMENT_STATES = "test/subsidy-check/fork/DepositSubsidy.settlementStates.fork.t.sol"

SUBSIDIES = {
    "DepositSubsidy": Tested(
        tests=(
            *suite(
                DEPOSIT_QUOTE,
                "DepositSubsidyQuoteTest",
                "testFuzz_GivenAnyInput_ThenTheSubsidyIsAtMostThePricedGasCostTheCapAndThePot",
                "test_GivenARelayerTransaction_ThenTheNoFarmingBoundIsReachedWithAPositivePayment",
                "testFuzz_GivenTheEnvelope_ThenTheFeeAndTheSubsidyPayTheRequiredPayout",
                "testFuzz_GivenNoMargin_ThenThePayoutIsShortByAtMostOneTokenWei",
                "test_GivenTheSmallestProfitWithoutTheMargin_ThenThePayoutIsShortByOneTokenWei",
                "testFuzz_GivenTheSmallestProfitThatPays_ThenThePayoutLandsExactlyOnTheRequiredPayout",
                "test_GivenAResidueThatLeavesSlack_ThenThePayoutIsOneAboveTheRequiredPayout",
                "test_GivenAResidueThatLeavesNoSlack_ThenThePayoutIsTheRequiredPayout",
                "testFuzz_GivenALiveCorner_ThenEveryLowerPriceAndEverySmallerTransactionIsLive",
                "test_GivenTheFeeAtTheProfit_ThenTheSubsidyIsTheGasCost",
                "test_GivenAFeeBelowTheProfit_ThenTheFeeCapsTheProfit",
                "test_GivenAFeeAboveTheProfit_ThenTheSurplusComesOffTheGasCost",
                "test_GivenATargetPayoutAtTheFee_ThenTheSubsidyIsZero",
                "test_GivenTheCapBinds_ThenTheSubsidyIsTheCap",
                "test_GivenThePotHoldsTheQuote_ThenItPaysTheQuote",
                "test_GivenAFractionalGasCost_ThenItIsRoundedDown",
                "test_GivenATipBelowTheCap_ThenTheWholeGasPriceIsPriced",
                "test_GivenATipAtTheCap_ThenTheWholeGasPriceIsPriced",
                "test_GivenATipAboveTheCap_ThenTheGasPriceIsPricedAtTheBaseFeePlusTheCap",
                "test_GivenNoPricedGas_ThenTheSubsidyIsZero",
                "testFuzz_GivenAnyInputIncludingALargeTargetPayout_ThenTheSubsidyIsExactlyTheFeeOffsetQuote",
                "test_GivenATargetPayoutAbove2To128_ThenTheSubsidyIsTheCap",
                "testFuzz_GivenATokenWithAnyDecimals_ThenTheTokenWeiPerEthScalesWithItsDecimals",
                "test_GivenASixDecimalToken_ThenTheQuotePaysTheGasInTheUnitsOfTheToken",
                "testFuzz_GivenAnyFeedRound_ThenThePriceIsReadOnlyWhileItIsFreshAndNotNegative",
                "test_GivenAFeedAtTheMaxAge_ThenTheQuoteIsPriced",
                "test_GivenAFeedOneSecondPastTheMaxAge_ThenTheQuoteIsZero",
                "test_GivenAFeedDatedOneSecondAhead_ThenTheQuoteIsZero",
                "test_GivenAZeroFeedAnswer_ThenTheQuoteIsZero",
                "test_GivenANegativeFeedAnswer_ThenTheQuoteIsZero",
            ),
            *suite(
                DEPOSIT_METER,
                "DepositSubsidyMeterTest",
                "testFuzz_GivenAnUnclippedRelay_ThenThePricedGasIsTheGrossGasLessTheProtocolRefunds",
                "test_GivenARefundAboveAFifthOfTheGross_ThenAFifthOfTheGrossIsSubtracted",
                "test_GivenARefundAtAFifthOfTheGross_ThenTheRefundIsSubtractedWhole",
                "testFuzz_GivenSoundGasBounds_ThenThePricedGasIsAtMostTheChargedGas",
                "testFuzz_GivenAnUnpricedRefund_ThenTheOverpricingIsAtMostThatRefund",
                "test_GivenAnUnpricedRefund_ThenThePricedGasIsAboveTheChargedGas",
                "testFuzz_GivenACeiling_ThenThePricedGasIsAtMostTheCeilingPlusTheFreshBalanceGas",
                "testFuzz_GivenACeilingOfZero_ThenEveryTokenGetsAZeroCeiling",
                "testFuzz_GivenATokenThatItDoesNotRoute_ThenTheCeilingIsZero",
                "testFuzz_GivenARelayerTransaction_ThenTheMeterKeepsTheExecutorContext",
                "test_GivenARoutedToken_ThenTheCeilingAddsItsAllowances",
                "testFuzz_GivenACeilingForEachIntent_ThenEachIntentGetsItsOwn",
                "testFuzz_GivenAnyCalldata_ThenTheMeterPricesItAtTheEvmCost",
                "test_GivenEachLengthOfAPartialWord_ThenTheMeterPricesTheCalldataAtTheEvmCost",
                "test_GivenZeroPaddedCalldata_ThenTheMeterPricesEachZeroByteAtTheEvmCost",
            ),
            *suite(
                DEPOSIT_FARM_SAFETY,
                "DepositSubsidyFarmSafetyTest",
                *FARM_SAFETY,
                "test_GivenACreditAtTheMinimum_ThenTheRelayIsPaidAsWithNoMinimumAndOneTokenWeiBelowIsNot",
            ),
            *suite(
                DEPOSIT_ADMIN,
                "DepositSubsidyAdminTest",
                "test_GivenConstructed_ThenImmutablesDerivedFromGateway",
                "test_GivenConstructed_ThenPriceFeedStored",
                "test_GivenConstructed_ThenOwnerIsConstructorArg",
                "test_GivenZeroOwner_WhenConstructed_ThenReverts",
                "test_GivenCodelessFeed_WhenConstructed_ThenReverts",
                "test_GivenFeedWithout8Decimals_WhenConstructed_ThenReverts",
                "test_GivenInitialCeilings_WhenConstructed_ThenEachIntentHasItsCeiling",
                "test_GivenOwner_WhenSetDepositConfig_ThenStoresAndAnnounces",
                "test_GivenNonOwner_WhenSetDepositConfig_ThenReverts",
                "test_GivenOwner_WhenSetSweepGasCeiling_ThenStoresAndEmits",
                "test_GivenNonOwner_WhenSetSweepGasCeiling_ThenReverts",
                "test_GivenOwner_WhenDefundCalled_ThenTransfersFullBalanceToOwner",
                "test_GivenNonOwner_WhenDefundCalled_ThenReverts",
            ),
            *suite(
                DEPOSIT_RELAYS,
                "DepositSubsidyExecutorPathTest",
                "test_GivenZeroPaddedProofs_ThenThePaddingIsPricedAtWhatItCosts",
            ),
            *suite(
                DEPOSIT_DEPLOY_ENTRY,
                "DepositSubsidyDeployAndSweepTest",
                "test_GivenACeilingBoundSIPAAlreadyDeployed_WhenDeployAndSweep_ThenItGetsNoDeployAllowance",
                "test_GivenAnUnknownToken_WhenDeployAndSweepDeploys_ThenNothingIsPriced",
            ),
            *suite(
                DEPOSIT_INTENTS,
                "DepositSubsidyIntentPricingTest",
                "test_GivenAnAnswerThatWouldOverflowTheQuote_ThenTheSweepStillLands",
                "test_GivenAnAddPasskeyCeilingOfZero_ThenAnAddPasskeySweepDrawsNothingWhileADepositSweepIsPaid",
            ),
            *suite(
                DEPOSIT_MINIMUM_CREDIT,
                "DepositSubsidyMinCreditedAmountUsdcTest",
                "test_GivenAUsdcCreditBelowTheMinimum_ThenTheSweepLandsWithoutASubsidy",
                "test_GivenAUsdcCreditAtTheMinimum_ThenItIsPaid",
            ),
            *suite(
                DEPOSIT_CEILINGS,
                "DepositSubsidySweepGasTest",
                "test_GivenAWarmResweepThroughTheDeployEntry_ThenItDrawsNoDeployAllowance",
                "test_GivenTheCheapestRegistration_ThenTheMeterBindsRatherThanTheCeiling",
            ),
            *suite(
                DEPOSIT_PAYMENT,
                "DepositSubsidyPaymentTest",
                "test_GivenARelayerTransactionWhoseFeePaysTheTarget_ThenTheSubsidySendsNoTransfer",
                "test_GivenAnIntentWithACeilingOfZero_WhenAFirstSweepIsRelayed_ThenTheSubsidyPaysNothing",
                "test_GivenAnIntentWithACeiling_WhenAFirstSweepIsRelayed_ThenTheSubsidyPays",
            ),
            *gas_row_pins(),
            *LIVE_FLOW_TESTS,
            *SETTLEMENT_TESTS,
            *suite(
                SETTLEMENT_STATES,
                "DepositSubsidySettlementStatesForkTest",
                "test_GivenACreditBelowTheMinimum_ThenTheSubsidyPaysNothingAndTheRelayerDefers",
                "test_GivenAnIntentWithACeilingOfZero_ThenTheSubsidyPaysNothingAndTheRelayerDefers",
                "test_GivenACapOneTokenWeiBelowTheRelayersCost_ThenTheRelayerDefers",
                "test_GivenACapAtTheRelayersCost_ThenTheRelayerSendsAndTheExecutorAccepts",
                "test_GivenAnEmptyPot_ThenTheRelayerDefersUntilThePotIsFunded",
                "test_GivenAPartlyFundedPot_ThenTheSubsidyIsThePot",
                "test_GivenTheSusdsResweepWhereItsSubsidyTurnsOff_ThenTheFeeAlonePaysWithNoTransfer",
                "test_GivenADustyExecutor_ThenARelayerThatHoldsTheTokenGainsNothing",
            ),
        ),
        gaps=(
            *GAP_FLOW_TESTS,
            *SETTLEMENT_GAP_TESTS,
        ),
    ),
    "MigrationSubsidy": Tested(
        tests=(
            *suite(
                MIGRATION_QUOTE,
                "MigrationSubsidyQuoteTest",
                "testFuzz_GivenAnyInput_ThenTheSubsidyIsAtMostTheGasCostPlusTheProfitTheCapAndThePot",
                "testFuzz_GivenTheEnvelope_ThenTheSubsidyPaysTheRequiredPayout",
                "testFuzz_GivenALiveCorner_ThenEveryLowerPriceAndEverySmallerTransactionIsLive",
                "test_GivenNoPricedGasOrNoTokenPrice_ThenTheSubsidyIsZero",
                "test_GivenAZeroGasPrice_ThenTheSubsidyIsTheProfit",
                "test_GivenAProfit_ThenTheSubsidyIsTheGasCostPlusTheProfit",
                "test_GivenTheCapOrThePotBinds_ThenTheSubsidyIsClamped",
                "test_GivenAFractionalGasCost_ThenItIsRoundedDown",
                "test_GivenATipAboveTheCap_ThenTheGasPriceIsCappedAtTheBaseFeePlusTheCap",
                "testFuzz_GivenAnyInputIncludingALargePayout_ThenTheSubsidyIsExactlyTheGasCostPlusTheProfit",
                "testFuzz_GivenATokenWithAnyDecimals_ThenTheTokenWeiPerEthScalesWithItsDecimals",
                "test_GivenASixDecimalToken_ThenTheQuotePaysTheGasInTheUnitsOfTheToken",
            ),
            *suite(
                MIGRATION_FARM_SAFETY,
                "MigrationSubsidyFarmSafetyTest",
                "test_GivenARelayerTransaction_ThenTheMigrationIsPaid",
                "test_GivenAnUnfrozenSource_WhenAWithdrawalIsRelayed_ThenTheMigrationLandsAndThePotIsUntouched",
                "test_GivenADirectCallToThePortal_ThenTheMigrationLandsAndThePotIsUntouched",
                "test_GivenAContractCaller_ThenTheMigrationLandsAndThePotIsUntouched",
                "test_GivenAnotherPayoutToken_ThenTheMigrationLandsAndThePotIsUntouched",
                "test_GivenAMigratedAmountUnderTheFloor_ThenTheMigrationLandsAndThePotIsUntouched",
                "test_GivenAMigratedAmountAtTheFloor_ThenTheMigrationIsPaid",
            ),
        ),
    ),
    "PlainWithdrawalSubsidy": Exempt(
        "OX-1880 replaces its modeled quote with a meter and adds its property tests.",
        "696dfd418578",
    ),
    "ProverSubsidy": Exempt("It pays a flat amount per claim that the owner sets. It prices no gas.", "f1d4e85cbca0"),
    "OperationExecutor": Exempt(
        "It reads tx.gasprice to require that the payout covers the relayer's gas. It pays nothing from a pot.",
        "1e8ed65adfe1",
    ),
}

COMMENT_OR_STRING = re.compile(r"//[^\n]*|/\*.*?\*/|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'", re.S)
DECLARATION = re.compile(r"\b(contract|library|interface)\s+(\w+)\s*(?:is\s+([^{]*))?\{")
IMPORT = re.compile(r"\bimport\b([^;\"']*)[\"']([^\"']*)[\"'][^;]*;")
IMPORT_NAMES = re.compile(r"\{([^}]*)\}")
ALIAS = re.compile(r"^(\w+)(?:\s+as\s+(\w+))?$")
GAS_PRICE_READ = re.compile(r"\btx\s*\.\s*gasprice\b|\bblock\s*\.\s*basefee\b|\b(?:gasprice|basefee)\s*\(\s*\)")
INTERFACE_SUBSIDY = re.compile(r"I\w*Subsidy")
ISSUE = re.compile(r"[A-Z]+-\d+")
TEST_ID = re.compile(r"^(?P<path>[^:]+\.sol):(?P<contract>\w+)\.(?P<function>\w+)$")
# vm.assume, vm.assumeNoRevert, and the assume helpers of forge-std, such as assumeNotZeroAddress.
ASSUMES = re.compile(r"\bassume\w*\s*\(")
RETURNS = re.compile(r"\breturn\s*;")
DEFINITION = re.compile(r"\b(?:function|modifier)\s+(\w+)\s*\(")
WORD = re.compile(r"\b\w+\b")
USING = re.compile(r"\busing\s+(\w+)\s+for\b")
MEMBER = re.compile(r"\b(\w+)\s*\.")


@dataclass(frozen=True)
class Unit:
    kind: str
    name: str
    bases: tuple[str, ...]
    body: str
    uses: tuple[str, ...] = ()
    """The libraries that `using ... for` attaches in the unit, or at the level of its file."""
    calls: tuple[str, ...] = ()
    """The names whose members the unit reads (`Name.member`): the libraries that it calls."""
    file: pathlib.Path | None = None
    header: str = ""
    """The declaration before the body, such as `contract A is B, C(1)`."""
    imports: tuple[str, ...] = ()
    """The import directives of its file."""
    base_files: tuple[tuple[pathlib.Path, ...], ...] = ()
    """For each base, the files that can declare it: its own file, or the files that its file imports it from."""


def _strip_comments(code: str) -> str:
    return COMMENT_OR_STRING.sub(lambda m: m.group(0) if m.group(0)[0] in "\"'" else " ", code)


@functools.cache
def remappings() -> tuple[tuple[str, str], ...]:
    """The remappings of foundry.toml that have no context, longest prefix first."""
    profile = tomllib.loads((L1 / "foundry.toml").read_text())["profile"]["default"]
    found = [entry.partition("=")[::2] for entry in profile.get("remappings", [])]
    return tuple(sorted(((p, t) for p, t in found if ":" not in p), key=lambda m: -len(m[0])))


def resolve(imported: str, importer: pathlib.Path, root: pathlib.Path) -> pathlib.Path:
    """The file that an import path names, as forge resolves it in the project at `root`."""
    if imported.startswith("."):
        return pathlib.Path(os.path.normpath(importer.parent / imported))
    for prefix, target in remappings():
        if imported.startswith(prefix):
            return pathlib.Path(os.path.normpath(root / target / imported[len(prefix) :]))
    return pathlib.Path(os.path.normpath(root / imported))


def imports(code: str, file: pathlib.Path, root: pathlib.Path) -> tuple[list[str], dict, list]:
    """The import directives of a file without comments, each name that it imports by name with the name it has in
    the imported file and that file, and each file that it imports."""
    directives, named, files = [], {}, []
    for m in IMPORT.finditer(_strip_comments(code)):
        target = resolve(m.group(2), file, root)
        directives.append(" ".join(m.group(0).split()))
        files.append(target)
        listed = IMPORT_NAMES.search(m.group(1))
        for item in listed.group(1).split(",") if listed else ():
            alias = ALIAS.match(item.strip())
            if alias:
                named[alias.group(2) or alias.group(1)] = (alias.group(1), target)
    return directives, named, files


def _body(code: str, open_brace: int) -> str:
    depth = 0
    for i in range(open_brace, len(code)):
        if code[i] == "{":
            depth += 1
        elif code[i] == "}":
            depth -= 1
            if depth == 0:
                return code[open_brace + 1 : i]
    return code[open_brace + 1 :]


def _bases(text: str, aliases: dict) -> tuple[str, ...]:
    """The names in an `is` list, without constructor arguments, with each import alias resolved."""
    names, depth, current = [], 0, ""
    for ch in text + ",":
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            name = current.strip().split(".")[-1]
            if name:
                names.append(aliases.get(name, name))
            current = ""
            continue
        if depth == 0 and ch not in "()":
            current += ch
    return tuple(names)


def units(src: pathlib.Path) -> list[Unit]:
    """Each contract, library and interface under `src`, the `src` of a forge project. A name resolves through the
    import aliases of its own file."""
    src = src.resolve()
    found = []
    for path in sorted(src.rglob("*.sol")):
        text = path.read_text()
        code = COMMENT_OR_STRING.sub(" ", text)
        directives, named, imported = imports(text, path, src.parent)
        aliases = {local: original for local, (original, _) in named.items()}
        declarations = [(m, _body(code, m.end() - 1)) for m in DECLARATION.finditer(code)]
        declared = {m.group(2) for m, _ in declarations}
        file_level = code
        for m, body in declarations:
            start = m.end()
            file_level = file_level[:start] + " " * len(body) + file_level[start + len(body) :]
        file_uses = {aliases.get(n, n) for n in USING.findall(file_level)}
        for m, body in declarations:
            kind, name, bases = m.group(1), m.group(2), m.group(3) or ""
            uses = tuple(sorted(file_uses | {aliases.get(n, n) for n in USING.findall(body)}))
            calls = tuple(sorted({aliases.get(n, n) for n in MEMBER.findall(body)}))
            local_bases = _bases(bases, {})
            base_files = tuple(
                (path,) if b in declared else (named[b][1],) if b in named else tuple(imported) for b in local_bases
            )
            header = " ".join(m.group(0)[:-1].split())
            found.append(
                Unit(kind, name, _bases(bases, aliases), body, uses, calls, path, header, tuple(directives), base_files)
            )
    return found


def source_hash(body: str) -> str:
    """A hash of a unit's source without comments, strings and spacing, so that a format change keeps it."""
    return hashlib.sha256(" ".join(body.split()).encode()).hexdigest()[:12]


def source_hashes(src: pathlib.Path = SRC) -> dict[str, str]:
    """The source hash of each contract and library under `src`, by name. It covers the import directives of the
    unit's file, its declaration and its body, and the source hash of each contract under `src` that it inherits, so a
    change to its imports, its bases or the code it inherits changes it. It does not cover the libraries that it
    calls, such as Errors, which many contracts share."""
    concrete = [u for u in units(src) if u.kind != "interface"]
    by_file = {(u.file, u.name): u for u in concrete}
    memo: dict[tuple, str] = {}

    def digest(u: Unit, seen: frozenset) -> str:
        key = (u.file, u.name)
        if key not in memo:
            parents = []
            for base, files in zip(u.bases, u.base_files):
                parent = next((by_file[(f, base)] for f in files if (f, base) in by_file), None)
                if parent is not None and (parent.file, parent.name) not in seen:
                    parents.append(digest(parent, seen | {key}))
            memo[key] = source_hash(" ".join((*u.imports, u.header, u.body, *parents)))
        return memo[key]

    return {u.name: digest(u, frozenset()) for u in concrete}


def subsidy_contracts(src: pathlib.Path = SRC) -> dict[str, str]:
    """Each subsidy under `src`, with the reason it is one."""
    candidates = [u for u in units(src) if u.kind != "interface"]
    found = {}
    for u in candidates:
        if u.name.endswith("Subsidy"):
            found[u.name] = "its name ends in Subsidy"
        elif any(INTERFACE_SUBSIDY.fullmatch(b) for b in u.bases):
            found[u.name] = "it inherits an I...Subsidy interface"
        elif GAS_PRICE_READ.search(u.body):
            found[u.name] = "it reads the gas price"
    libraries = {u.name for u in candidates if u.kind == "library"}
    changed = True
    while changed:
        changed = False
        for u in candidates:
            if u.name in found:
                continue
            parent = next((b for b in u.bases if b in found), None)
            library = next((lib for lib in found if lib in libraries and (lib in u.calls or lib in u.uses)), None)
            if parent or library:
                found[u.name] = f"it inherits {parent}" if parent else f"it calls the library {library}"
                changed = True
    return found


def name_clashes(contracts: dict, src: pathlib.Path = SRC) -> list[str]:
    """A problem for each subsidy whose name another contract or library under `src` also declares. The registry and
    the source hashes know each subsidy by its name alone, so another contract with its name could use its entry."""
    files: dict[str, list[str]] = {}
    for u in units(src):
        if u.kind != "interface":
            files.setdefault(u.name, []).append(str(u.file.relative_to(src.resolve())))
    return [
        f"{name} is declared in {' and '.join(files[name])}: give each subsidy a name that no other contract or "
        "library under l1-contracts/src has"
        for name in sorted(contracts)
        if len(files.get(name, ())) > 1
    ]


def definitions(path: pathlib.Path, root: pathlib.Path) -> dict[str, list[tuple[str, str]]]:
    """Each function and modifier, by name, with the text after its name and its body, in `path` and in each file
    under `root`/test that it imports, through any number of imports."""
    found: dict[str, list[tuple[str, str]]] = {}
    seen, pending = set(), [pathlib.Path(os.path.normpath(path))]
    while pending:
        file = pending.pop()
        if file in seen or not file.exists():
            continue
        seen.add(file)
        text = file.read_text()
        code = COMMENT_OR_STRING.sub(" ", text)
        for m in DEFINITION.finditer(code):
            end = min((i for i in (code.find("{", m.end()), code.find(";", m.end())) if i >= 0), default=len(code))
            body = _body(code, end) if code[end : end + 1] == "{" else ""
            found.setdefault(m.group(1), []).append((code[m.end() : end], body))
        tests = pathlib.Path(os.path.normpath(root / "test"))
        pending += [f for f in imports(text, file, root)[2] if f.is_relative_to(tests)]
    return found


def _fuzz_source(path: pathlib.Path, function: str, root: pathlib.Path) -> tuple[str, str] | None:
    """The body of a test function, and all the source that it reaches: its modifiers, and each function and modifier
    that it or they name, through any number of calls. A name resolves to each definition with that name."""
    defs = definitions(path, root)
    if function not in defs:
        return None
    header, body = defs[function][0]
    named, pending, reached = {function}, [header + " " + body], []
    while pending:
        text = pending.pop()
        reached.append(text)
        for name in set(WORD.findall(text)) - named:
            if name in defs:
                named.add(name)
                pending += [h + " " + b for h, b in defs[name]]
    return body, " ".join(reached)


class Results:
    """The results of `forge test --json`, by suite (`path:Contract`) and test function name."""

    def __init__(self, raw):
        self.problems: list[str] = []
        self.tests: dict[tuple[str, str], list[tuple[str, dict]]] = {}
        if not isinstance(raw, dict):
            self.problems.append("forge: the results are not a map of suites")
            return
        for suite_id, result in raw.items():
            tests = result.get("test_results") if isinstance(result, dict) else None
            if not isinstance(tests, dict):
                self.problems.append(f"forge: the suite {suite_id} has no test results")
                continue
            for signature, test in tests.items():
                if not isinstance(test, dict) or "status" not in test or "kind" not in test:
                    self.problems.append(f"forge: the result of {suite_id} {signature} is malformed")
                    continue
                name = signature.partition("(")[0]
                self.tests.setdefault((suite_id, name), []).append((signature, test))

    def get(self, suite_id: str, name: str) -> list[tuple[str, dict]]:
        return self.tests.get((suite_id, name), [])


def _test_problems(owner: str, test_id: str, results: Results, root: pathlib.Path) -> list[str]:
    m = TEST_ID.match(test_id)
    if m is None:
        return [f"{owner}: {test_id} is not a test name of the form path:Contract.function"]
    path, contract, function = m.group("path"), m.group("contract"), m.group("function")
    found = []
    if not in_evidence(path):
        found.append(f"{owner}: {test_id} is outside the subsidy tests ({EVIDENCE_DIR}), so check.sh does not run it")
    if not contract.startswith(owner):
        found.append(f"{owner}: {test_id} is in a test contract that is not named after {owner}")
    matches = results.get(f"{path}:{contract}", function)
    if not matches:
        return found + [f"{owner}: {test_id} is not in the forge results"]
    if len(matches) > 1:
        return found + [f"{owner}: {test_id} names {len(matches)} tests with that name"]
    signature, test = matches[0]
    status = test["status"]
    if status == "Skipped":
        found.append(f"{owner}: {test_id} was skipped")
    elif status != "Success":
        found.append(f"{owner}: {test_id} did not pass ({status}: {test.get('reason')})")
    fuzz = test["kind"].get("Fuzz") if isinstance(test["kind"], dict) else None
    if fuzz is not None:
        if not fuzz.get("runs"):
            found.append(f"{owner}: {test_id} is a fuzz test with no runs")
        source = _fuzz_source(root / path, function, root)
        if source is None:
            found.append(f"{owner}: {test_id}: the source of {signature} is not in {path}")
        elif ASSUMES.search(source[1]) or RETURNS.search(source[0]):
            found.append(
                f"{owner}: {test_id} calls vm.assume, itself or through a helper or modifier, or returns early, so "
                "some runs test nothing"
            )
    return found


def location_problems(root: pathlib.Path = L1, allowed_outside: dict = ALLOWED_OUTSIDE) -> list[str]:
    """A problem for each test file under `root`/test whose name contains Subsidy and that is outside the subsidy tests,
    and for each file in `allowed_outside` that is gone or has no reason."""
    found = []
    for file in sorted((root / "test").rglob("*.sol")):
        path = file.relative_to(root).as_posix()
        if "Subsidy" in file.name and not in_evidence(path, allowed_outside):
            found.append(
                f"{path} is a subsidy test outside {EVIDENCE_DIR}: move it into {EVIDENCE_DIR}, or allow it by name "
                "with a reason in ALLOWED_OUTSIDE"
            )
    for path, reason in sorted(allowed_outside.items()):
        if not (root / path).is_file():
            found.append(f"ALLOWED_OUTSIDE names {path}, which does not exist: remove it")
        elif not reason.strip():
            found.append(f"ALLOWED_OUTSIDE allows {path} with no reason")
    return found


def _abstract(path: str, contract: str, root: pathlib.Path) -> bool:
    """Whether `path` declares `contract` abstract. Forge lists the tests of an abstract contract, but runs them only in
    the contracts that inherit it."""
    file = root / path
    code = COMMENT_OR_STRING.sub(" ", file.read_text()) if file.is_file() else ""
    return re.search(rf"\babstract\s+contract\s+{re.escape(contract)}\b", code) is not None


def inventory_problems(inventory, entries: dict = SUBSIDIES, root: pathlib.Path = L1) -> list[str]:
    """A problem for each test in the subsidy tests that is in the `forge test --list --json` output and that no entry
    names, by its path, contract and function. An abstract contract's tests are named in the contracts that inherit
    it."""
    if not isinstance(inventory, dict):
        return ["forge: the test list is not a map of files"]
    named = set()
    for entry in entries.values():
        if isinstance(entry, Tested):
            named.update(entry.tests, (gap.test for gap in entry.gaps))
    found = []
    for path, contracts in sorted(inventory.items()):
        if not path.startswith(EVIDENCE_DIR):
            continue
        if not isinstance(contracts, dict):
            found.append(f"forge: the test list of {path} is malformed")
            continue
        for contract, functions in sorted(contracts.items()):
            if not isinstance(functions, list) or not all(isinstance(f, str) for f in functions):
                found.append(f"forge: the test list of {path}:{contract} is malformed")
                continue
            if _abstract(path, contract, root):
                continue
            for function in sorted(functions):
                test_id = f"{path}:{contract}.{function}"
                if test_id not in named:
                    found.append(
                        f"{test_id} is in the subsidy tests, but no registry entry names it: name it, or move it out"
                    )
    return found


def problems(
    raw: dict,
    contracts: dict | None = None,
    entries: dict = SUBSIDIES,
    root: pathlib.Path = L1,
    sources: dict | None = None,
    no_farm_safety: dict = NO_FARM_SAFETY,
    inventory=None,
) -> list[str]:
    """The problems of the registry. With no `contracts`, it reads l1-contracts/src for them and for `sources`, and
    l1-contracts/test for the location of the subsidy tests. With an `inventory`, each subsidy test in it must be
    named."""
    found = []
    if contracts is None:
        contracts = subsidy_contracts()
        sources = source_hashes() if sources is None else sources
        found += name_clashes(contracts)
        found += location_problems(root)
    if inventory is not None:
        found += inventory_problems(inventory, entries, root)
    sources = sources or {}
    for name in sorted(contracts.keys() - entries.keys()):
        found.append(f"{name} is a subsidy ({contracts[name]}) with no entry in the registry: test or exempt it")
    for name in sorted(entries.keys() - contracts.keys()):
        found.append(f"the registry names {name}, which is not a subsidy under l1-contracts/src")
    for name, reason in sorted(no_farm_safety.items()):
        if not isinstance(entries.get(name), Tested):
            found.append(f"{name} has no farm-safety property, but it is not a tested subsidy in the registry")
        elif not reason.strip():
            found.append(f"{name}: has no farm-safety property and gives no reason")
    results = Results(raw)
    found += results.problems
    named: dict[str, str] = {}
    for name, entry in entries.items():
        if isinstance(entry, Exempt):
            if not entry.reason.strip():
                found.append(f"{name}: its exemption has no reason")
            if name in contracts and name in sources and entry.source != sources[name]:
                found.append(
                    f"{name}: its source changed since a reviewer accepted its exemption: review the reason, "
                    f'then set its source hash to "{sources[name]}"'
                )
            continue
        if not entry.tests:
            found.append(f"{name}: names no test")
        if name not in no_farm_safety:
            functions = {m.group("function") for m in map(TEST_ID.match, entry.tests) if m}
            for function in FARM_SAFETY:
                if function not in functions:
                    found.append(
                        f"{name}: names no {function}: give it the farm-safety property (README.md#farm-safety)"
                    )
        for test_id in (*entry.tests, *(gap.test for gap in entry.gaps)):
            if test_id in named:
                found.append(f"{name}: {test_id} is named twice (also by {named[test_id]})")
                continue
            named[test_id] = name
            found += _test_problems(name, test_id, results, root)
        for gap in entry.gaps:
            if not ISSUE.fullmatch(gap.issue):
                found.append(f"{name}: the gap {gap.test} has no Linear issue")
            elif f"Gap_{gap.issue.replace('-', '')}_" not in gap.test:
                found.append(f"{name}: the gap test {gap.test} does not carry its issue {gap.issue} in its name")
    return found


def failures(raw: dict) -> list[str]:
    """A readable line for each test in the results that did not pass."""
    lines = []
    for suite_id, result in sorted(raw.items()) if isinstance(raw, dict) else ():
        for signature, test in sorted((result.get("test_results") or {}).items()):
            if test.get("status") in ("Success", "Skipped"):
                continue
            lines.append(f"FAIL {suite_id} {signature}: {test.get('reason')}")
            if test.get("counterexample"):
                lines.append(f"     counterexample: {json.dumps(test['counterexample'])[:400]}")
            for log in test.get("decoded_logs") or []:
                lines.append(f"     {log}")
    return lines


def _read(path: str, what: str):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError) as error:
        print(f"registry: cannot read the {what} {path}: {error}", file=sys.stderr)
        sys.exit(1)


def main() -> None:
    args = sys.argv[1:]
    inventory = None
    if len(args) == 3 and args[1] == "--inventory":
        inventory = _read(args[2], "forge test list")
    elif len(args) != 1:
        print("usage: registry.py <forge results> [--inventory <forge test list>]", file=sys.stderr)
        sys.exit(2)
    raw = _read(args[0], "forge results")
    for line in failures(raw):
        print(line, file=sys.stderr)
    found = problems(raw, inventory=inventory)
    for problem in found:
        print(f"registry: {problem}", file=sys.stderr)
    tested = [name for name, entry in SUBSIDIES.items() if isinstance(entry, Tested)]
    print(f"registry: {len(tested)} tested ({', '.join(tested)}), {len(SUBSIDIES) - len(tested)} exempt")
    sys.exit(1 if found else 0)


if __name__ == "__main__":
    main()
