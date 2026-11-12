"""Tests of registry.py: the shapes of subsidy that discovery must find, and the evidence it must refuse.

The evidence cases run on fixtures/forge-results.json, which a real `forge test --json` run wrote, with only the fields
that the registry reads. A refusal test asserts that the registry refuses, and that a problem names what it refuses.

Run: python3 -I test_registry.py (check.sh runs it).
"""

import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import flows  # noqa: E402
import gas_rows  # noqa: E402
import gen  # noqa: E402
import registry  # noqa: E402
from registry import Exempt, Gap, Tested  # noqa: E402

PRICED = "contract DepositSubsidy { function price() internal view returns (uint256) { return tx.gasprice; } }"
FEE_MATH = "library FeeMath { function price() internal view returns (uint256) { return block.basefee; } }"
FIXTURE = json.loads((HERE / "fixtures" / "forge-results.json").read_text())
SUITE = "test/subsidy-check/tmpfixture/FixtureSubsidy.t.sol:FixtureSubsidyTest"
FIXTURE_SOURCE = """import {FixtureHelpers} from "@test/subsidy-check/tmpfixture/FixtureHelpers.sol";
contract FixtureSubsidyTest is FixtureHelpers {
  modifier large(uint256 _x) { vm.assume(_x > 1); _; }
  function testFuzz_GivenAFuzzTest_ThenItRuns(uint256 _x) external pure { assertLe(_small(_x), 10, "b"); }
  function testFuzz_GivenAFuzzTest_ThenItAssumes(uint256 _x) external pure { vm.assume(_x > 1); }
  function testFuzz_GivenAFuzzTest_ThenItReturns(uint256 _x) external pure { if (_x > 1) { return; } }
  function testFuzz_GivenAFuzzTest_ThenItAssumesInAHelper(uint256 _x) external pure { _large(_x); }
  function testFuzz_GivenAFuzzTest_ThenItAssumesInAModifier(uint256 _x) external pure large(_x) {}
  function testFuzz_GivenAFuzzTest_ThenItAssumesWithForgeStd(address _a) external pure { assumeNotZeroAddress(_a); }
  function testFuzz_GivenAnyCaller_ThenOnlyARelayerTransactionDrawsFromThePot(uint256 _x) external pure { _small(_x); }
}
"""
FIXTURE_HELPERS = """contract FixtureHelpers {
  function _small(uint256 _x) internal pure returns (uint256) { return bound(_x, 0, 10); }
  function _large(uint256 _x) internal pure returns (uint256) { return _atLeast(_x, 2); }
  function _atLeast(uint256 _x, uint256 _min) internal pure returns (uint256) { vm.assume(_x >= _min); return _x; }
}
"""


def discover(**files: str) -> dict:
    with tempfile.TemporaryDirectory() as src:
        for name, code in files.items():
            (pathlib.Path(src) / f"{name}.sol").write_text(code)
        return registry.subsidy_contracts(pathlib.Path(src))


def hashes(**files: str) -> dict:
    with tempfile.TemporaryDirectory() as src:
        for name, code in files.items():
            (pathlib.Path(src) / f"{name}.sol").write_text(code)
        return registry.source_hashes(pathlib.Path(src))


def test(function: str) -> str:
    return f"{SUITE}.{function}"


def assert_refused(case: unittest.TestCase, found: list[str], *names: str) -> None:
    """The registry refuses: it reports a problem, and a problem names each of `names`."""
    case.assertTrue(found, "the registry accepts it")
    for name in names:
        case.assertTrue(any(name in problem for problem in found), f"no problem names {name}: {found}")


class Discovery(unittest.TestCase):
    def test_a_subclass_with_another_name_is_a_subsidy(self):
        self.assertIn("Reward", discover(a=PRICED, b="contract Reward is DepositSubsidy {}"))

    def test_a_subclass_through_an_import_alias_is_a_subsidy(self):
        found = discover(a=PRICED, b='import {DepositSubsidy as Base} from "./a.sol";\ncontract Renamed is Base {}')
        self.assertIn("Renamed", found)

    def test_an_import_alias_means_only_what_its_own_file_imports(self):
        found = discover(
            a=PRICED,
            b='import {DepositSubsidy as Base} from "./a.sol";\ncontract Renamed is Base {}',
            c="contract Helper {}",
            d='import {Helper as Base} from "./c.sol";\ncontract Plain is Base {}',
        )
        self.assertIn("Renamed", found)
        self.assertNotIn("Plain", found)

    def test_a_subclass_with_constructor_arguments_is_a_subsidy(self):
        self.assertIn("Pays", discover(a=PRICED, b="contract Pays is Ownable(msg.sender), DepositSubsidy { }"))

    def test_an_assembly_read_of_the_gas_price_is_a_subsidy(self):
        found = discover(
            a="contract Payer { function f() external view returns (uint256 p) { assembly { p := gasprice() } } }"
        )
        self.assertIn("Payer", found)

    def test_a_library_that_reads_the_base_fee_and_its_callers_are_subsidies(self):
        found = discover(
            a=FEE_MATH,
            b="contract Pays { function f() external view returns (uint256) { return FeeMath.price(); } }",
        )
        self.assertIn("FeeMath", found)
        self.assertIn("Pays", found)

    def test_a_library_called_through_an_import_alias_is_a_subsidy(self):
        found = discover(
            a=FEE_MATH,
            b='import {FeeMath as FM} from "./a.sol";\n'
            "contract Pays { function f() external view returns (uint256) { return FM.price(); } }",
        )
        self.assertIn("Pays", found)

    def test_a_contract_that_attaches_a_subsidy_library_with_using_is_a_subsidy(self):
        library = (
            "library FeeMath { function price(uint256 g) internal view returns (uint256) { return g * tx.gasprice; } }"
        )
        found = discover(
            a=library,
            b="contract Pays { using FeeMath for uint256; function f(uint256 g) external view returns (uint256) "
            "{ return g.price(); } }",
            c="using FeeMath for uint256;\ncontract FilePays { function f(uint256 g) external view returns (uint256) "
            "{ return g.price(); } }",
            d="library Other { function twice(uint256 x) internal pure returns (uint256) { return 2 * x; } }\n"
            "contract Plain { using Other for uint256; function f(uint256 x) external pure returns (uint256) "
            "{ return x.twice(); } }",
        )
        self.assertIn("Pays", found)
        self.assertIn("FilePays", found)
        self.assertNotIn("Plain", found)

    def test_comments_and_strings_do_not_count(self):
        found = discover(a='contract Quiet {\n  // tx.gasprice\n  /* block.basefee */\n  string s = "gasprice()";\n}')
        self.assertNotIn("Quiet", found)

    def test_a_subsidy_whose_name_another_contract_has_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            src = pathlib.Path(root)
            for path in ("a", "b"):
                (src / path).mkdir()
            (src / "a/ProverSubsidy.sol").write_text(PRICED.replace("DepositSubsidy", "ProverSubsidy"))
            (src / "b/ProverSubsidy.sol").write_text("contract ProverSubsidy {}")
            contracts = registry.subsidy_contracts(src)
            found = registry.name_clashes(contracts, src)
            assert_refused(self, found, "ProverSubsidy", "a/ProverSubsidy.sol", "b/ProverSubsidy.sol")
            (src / "b/ProverSubsidy.sol").write_text("contract Other {}")
            self.assertEqual(registry.name_clashes(contracts, src), [])

    def test_an_interface_is_not_a_subsidy(self):
        found = discover(a="interface IProverSubsidy { function pay() external; }")
        self.assertEqual(found, {})


class Evidence(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        path = pathlib.Path(self.root.name) / "test/subsidy-check/tmpfixture/FixtureSubsidy.t.sol"
        path.parent.mkdir(parents=True)
        path.write_text(FIXTURE_SOURCE)
        (path.parent / "FixtureHelpers.sol").write_text(FIXTURE_HELPERS)

    def tearDown(self):
        self.root.cleanup()

    def problems(self, entry, raw=None, name="FixtureSubsidy", no_farm_safety=None):
        raw = FIXTURE if raw is None else raw
        if no_farm_safety is None:
            no_farm_safety = {name: "a fixture without the property"} if isinstance(entry, Tested) else {}
        return registry.problems(raw, {name: "test"}, {name: entry}, pathlib.Path(self.root.name), {}, no_farm_safety)

    def test_an_entry_with_passing_evidence_is_accepted(self):
        entry = Tested(
            (test("test_GivenAUnitTest_ThenItPasses"), test("testFuzz_GivenAFuzzTest_ThenItRuns")),
            (Gap("Cause", f"{SUITE}.test_GivenAUnitTest_ThenItPasses_Gap_Cause_"),),
        )
        raw = copy.deepcopy(FIXTURE)
        tests = raw[SUITE]["test_results"]
        tests["test_GivenAUnitTest_ThenItPasses_Gap_Cause_()"] = tests["test_GivenAUnitTest_ThenItPasses()"]
        self.assertEqual(self.problems(entry, raw), [])

    def test_results_that_also_hold_other_suites_are_accepted(self):
        raw = copy.deepcopy(FIXTURE)
        failing = FIXTURE[SUITE]["test_results"]["test_GivenAUnitTest_ThenItFails()"]
        raw["test/periphery/Other.t.sol:OtherTest"] = {"test_results": {"test_Other()": failing}}
        self.assertEqual(self.problems(Tested((test("test_GivenAUnitTest_ThenItPasses"),)), raw), [])

    def test_an_entry_with_no_evidence_is_refused(self):
        assert_refused(self, self.problems(Tested(())), "FixtureSubsidy")

    def test_an_exempt_entry_needs_no_evidence(self):
        self.assertEqual(self.problems(Exempt("a reason")), [])

    def test_a_failing_test_is_refused(self):
        failing = test("test_GivenAUnitTest_ThenItFails")
        assert_refused(self, self.problems(Tested((failing,))), failing)

    def test_a_fuzz_test_with_a_counterexample_is_refused(self):
        failing = test("testFuzz_GivenAFuzzTest_ThenItFindsACounterexample")
        assert_refused(self, self.problems(Tested((failing,))), failing)

    def test_a_skipped_test_is_refused(self):
        skipped = test("test_GivenASkippedTest_ThenItSkips")
        assert_refused(self, self.problems(Tested((skipped,))), skipped)

    def test_a_missing_test_is_refused(self):
        missing = test("test_GivenNothing_ThenNothing")
        assert_refused(self, self.problems(Tested((missing,))), missing)

    def test_a_fuzz_test_with_no_runs_is_refused(self):
        raw = copy.deepcopy(FIXTURE)
        raw[SUITE]["test_results"]["testFuzz_GivenAFuzzTest_ThenItRuns(uint256)"]["kind"]["Fuzz"]["runs"] = 0
        fuzz = test("testFuzz_GivenAFuzzTest_ThenItRuns")
        assert_refused(self, self.problems(Tested((fuzz,)), raw), fuzz)

    def test_a_fuzz_test_that_assumes_or_returns_early_is_refused(self):
        raw = copy.deepcopy(FIXTURE)
        tests = raw[SUITE]["test_results"]
        runs = tests["testFuzz_GivenAFuzzTest_ThenItRuns(uint256)"]
        for name in ("Assumes", "Returns", "AssumesInAHelper", "AssumesInAModifier", "AssumesWithForgeStd"):
            tests[f"testFuzz_GivenAFuzzTest_ThenIt{name}(uint256)"] = runs
            fuzz = test(f"testFuzz_GivenAFuzzTest_ThenIt{name}")
            assert_refused(self, self.problems(Tested((fuzz,)), raw), fuzz)

    def test_a_malformed_result_is_refused(self):
        raw = copy.deepcopy(FIXTURE)
        del raw[SUITE]["test_results"]["test_GivenAUnitTest_ThenItPasses()"]["status"]
        assert_refused(self, self.problems(Tested((test("test_GivenAUnitTest_ThenItPasses"),)), raw), SUITE)
        assert_refused(self, self.problems(Exempt("r"), {SUITE: {}}), SUITE)
        assert_refused(self, self.problems(Exempt("r"), []))

    def test_a_results_file_that_is_missing_or_not_json_is_refused(self):
        bad = pathlib.Path(self.root.name) / "results.json"
        bad.write_text("{")
        for path in (bad, pathlib.Path(self.root.name) / "missing.json"):
            run = subprocess.run(
                [sys.executable, "-I", str(HERE / "registry.py"), str(path)], capture_output=True, text=True
            )
            self.assertNotEqual(run.returncode, 0)
            self.assertIn(str(path), run.stderr)

    def test_a_test_named_twice_is_refused(self):
        twice = test("test_GivenAUnitTest_ThenItPasses")
        assert_refused(self, self.problems(Tested((twice, twice))), twice)

    def test_a_test_of_another_subsidy_is_refused(self):
        passing = test("test_GivenAUnitTest_ThenItPasses")
        assert_refused(self, self.problems(Tested((passing,)), name="OtherSubsidy"), passing)

    def test_a_test_outside_the_subsidy_tests_is_refused(self):
        raw = {"test/periphery/Other.t.sol:FixtureSubsidyTest": FIXTURE[SUITE]}
        outside = "test/periphery/Other.t.sol:FixtureSubsidyTest.test_GivenAUnitTest_ThenItPasses"
        assert_refused(self, self.problems(Tested((outside,)), raw), outside)

    def test_a_gap_needs_a_cause_label_in_its_test_name(self):
        passing = test("test_GivenAUnitTest_ThenItPasses")
        assert_refused(self, self.problems(Tested((), (Gap("", passing),))), passing)
        assert_refused(self, self.problems(Tested((), (Gap("Cause", passing),))), passing)

    def test_an_exemption_with_no_reason_is_refused(self):
        assert_refused(self, self.problems(Exempt("  ")), "FixtureSubsidy")

    def test_an_exemption_whose_source_changed_is_refused(self):
        def found(source):
            entries = {"FixtureSubsidy": Exempt("a reason", source)}
            sources = {"FixtureSubsidy": "abc123abc123"}
            root = pathlib.Path(self.root.name)
            return registry.problems(FIXTURE, {"FixtureSubsidy": "test"}, entries, root, sources, {})

        self.assertEqual(found("abc123abc123"), [])
        assert_refused(self, found("000000000000"), "FixtureSubsidy", "abc123abc123")

    def test_a_change_to_the_imports_the_bases_or_an_inherited_contract_changes_the_source_hash(self):
        base = "contract Base { function f() internal {} }"
        child = 'import {Base} from "./a.sol";\nimport {Ownable} from "@oz/access/Ownable.sol";\n'
        exempt = "contract ProverSubsidy is Base, Ownable { function pay() external {} }"
        before = hashes(a=base, b=child + exempt)["ProverSubsidy"]
        changed = {
            "an import": hashes(a=base, b=child.replace("@oz/", "@openzeppelin/contracts/") + exempt),
            "a base": hashes(a=base, b=child + exempt.replace("Base, Ownable", "Ownable")),
            "an inherited contract": hashes(a=base.replace("{}", "{ revert(); }"), b=child + exempt),
        }
        for what, found in changed.items():
            self.assertNotEqual(found["ProverSubsidy"], before, f"a change to {what} keeps the source hash")

    def test_a_format_change_keeps_the_source_hash(self):
        self.assertEqual(registry.source_hash("a  b\n\tc"), registry.source_hash("a b c"))
        self.assertNotEqual(registry.source_hash("a b c"), registry.source_hash("a b d"))

    def farm_safety_results(self):
        raw = copy.deepcopy(FIXTURE)
        tests = raw[SUITE]["test_results"]
        fuzz, fixed = registry.FARM_SAFETY
        tests[f"{fuzz}(uint256)"] = tests["testFuzz_GivenAFuzzTest_ThenItRuns(uint256)"]
        tests[f"{fixed}()"] = tests["test_GivenAUnitTest_ThenItPasses()"]
        return raw

    def test_an_entry_with_the_farm_safety_property_is_accepted(self):
        entry = Tested(tuple(test(function) for function in registry.FARM_SAFETY))
        self.assertEqual(self.problems(entry, self.farm_safety_results(), no_farm_safety={}), [])

    def test_an_entry_without_the_farm_safety_property_is_refused(self):
        fuzz, fixed = registry.FARM_SAFETY
        raw = self.farm_safety_results()
        assert_refused(self, self.problems(Tested((test(fixed),)), raw, no_farm_safety={}), "FixtureSubsidy", fuzz)
        assert_refused(self, self.problems(Tested((test(fuzz),)), raw, no_farm_safety={}), "FixtureSubsidy", fixed)

    def test_an_entry_without_the_farm_safety_property_needs_a_reason(self):
        passing = Tested((test("test_GivenAUnitTest_ThenItPasses"),))
        assert_refused(self, self.problems(passing, no_farm_safety={"FixtureSubsidy": "  "}), "FixtureSubsidy")
        found = self.problems(passing, no_farm_safety={"FixtureSubsidy": "r", "GoneSubsidy": "r"})
        assert_refused(self, found, "GoneSubsidy")
        assert_refused(self, self.problems(Exempt("r"), no_farm_safety={"FixtureSubsidy": "r"}), "FixtureSubsidy")

    def test_a_stale_entry_is_refused(self):
        found = registry.problems(FIXTURE, {}, {"GoneSubsidy": Exempt("r")}, pathlib.Path(self.root.name))
        assert_refused(self, found, "GoneSubsidy")

    def test_a_subsidy_with_no_entry_is_refused(self):
        found = registry.problems(FIXTURE, {"NewSubsidy": "test"}, {}, pathlib.Path(self.root.name))
        assert_refused(self, found, "NewSubsidy")


class Location(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.root.name)

    def tearDown(self):
        self.root.cleanup()

    def write(self, *paths):
        for path in paths:
            (self.path / path).parent.mkdir(parents=True, exist_ok=True)
            (self.path / path).write_text("contract C {}")

    def test_a_nested_file_in_the_check_is_a_subsidy_test_and_a_file_outside_is_not(self):
        self.assertTrue(registry.in_evidence("test/subsidy-check/subsidies/DepositSubsidy.quote.t.sol", {}))
        self.assertFalse(registry.in_evidence("test/periphery/DepositSubsidy.t.sol", {}))
        self.assertTrue(registry.in_evidence("test/periphery/DepositSubsidy.t.sol", {"test/periphery/DepositSubsidy.t.sol": "r"}))

    def test_a_subsidy_test_file_outside_the_check_is_refused(self):
        self.write("test/subsidy-check/subsidies/NewSubsidy.t.sol", "test/periphery/NewSubsidy.t.sol", "test/periphery/Other.t.sol")
        found = registry.location_problems(self.path, {})
        assert_refused(self, found, "test/periphery/NewSubsidy.t.sol")
        self.assertEqual(len(found), 1, found)

    def test_a_file_that_is_allowed_by_name_is_accepted(self):
        self.write("test/periphery/NewSubsidy.t.sol")
        self.assertEqual(registry.location_problems(self.path, {"test/periphery/NewSubsidy.t.sol": "a reason"}), [])

    def test_an_allowance_that_is_stale_or_has_no_reason_is_refused(self):
        self.write("test/periphery/NewSubsidy.t.sol")
        assert_refused(self, registry.location_problems(self.path, {"test/periphery/NewSubsidy.t.sol": " "}), "NewSubsidy")
        found = registry.location_problems(self.path, {"test/periphery/NewSubsidy.t.sol": "r", "test/periphery/GoneSubsidy.t.sol": "r"})
        assert_refused(self, found, "test/periphery/GoneSubsidy.t.sol")


class Inventory(unittest.TestCase):
    PATH = "test/subsidy-check/subsidies/FixtureSubsidy.t.sol"

    def entries(self, *tests):
        return {"FixtureSubsidy": Tested(tuple(f"{self.PATH}:{t}" for t in tests))}

    def test_an_inventory_that_the_entries_name_is_accepted(self):
        inventory = {self.PATH: {"FixtureSubsidyTest": ["test_A", "test_B"]}, "test/periphery/Other.t.sol": {"O": ["test_C"]}}
        entries = self.entries("FixtureSubsidyTest.test_A", "FixtureSubsidyTest.test_B")
        self.assertEqual(registry.inventory_problems(inventory, entries), [])

    def test_a_test_in_the_check_that_no_entry_names_is_refused(self):
        inventory = {self.PATH: {"FixtureSubsidyTest": ["test_A", "test_B"]}}
        found = registry.inventory_problems(inventory, self.entries("FixtureSubsidyTest.test_A"))
        assert_refused(self, found, f"{self.PATH}:FixtureSubsidyTest.test_B")

    def test_a_test_with_the_name_of_a_named_test_in_another_contract_is_refused(self):
        inventory = {self.PATH: {"FixtureSubsidyTest": ["test_A"], "FixtureSubsidyOtherTest": ["test_A"]}}
        found = registry.inventory_problems(inventory, self.entries("FixtureSubsidyTest.test_A"))
        assert_refused(self, found, f"{self.PATH}:FixtureSubsidyOtherTest.test_A")

    def test_the_tests_of_an_abstract_contract_are_named_in_the_contracts_that_inherit_it(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / "test/subsidy-check/subsidies/Base.sol"
            path.parent.mkdir(parents=True)
            path.write_text("abstract contract FixtureSubsidyBase { function test_A() external {} }")
            inventory = {"test/subsidy-check/subsidies/Base.sol": {"FixtureSubsidyBase": ["test_A"]}}
            self.assertEqual(registry.inventory_problems(inventory, {}, pathlib.Path(root)), [])
            path.write_text("contract FixtureSubsidyBase { function test_A() external {} }")
            assert_refused(self, registry.inventory_problems(inventory, {}, pathlib.Path(root)), "FixtureSubsidyBase")

    def test_a_malformed_inventory_is_refused(self):
        assert_refused(self, registry.inventory_problems([], {}))
        assert_refused(self, registry.inventory_problems({self.PATH: []}, {}), self.PATH)
        assert_refused(self, registry.inventory_problems({self.PATH: {"FixtureSubsidyTest": None}}, {}), self.PATH)
        assert_refused(self, registry.inventory_problems({self.PATH: {"FixtureSubsidyTest": [1]}}, {}), self.PATH)


def family(**axes):
    return {"row": "dai", "intent": "deposit", "axes": axes, "exclude": []}


def row(**fields):
    return {"row": "dai", "intent": "deposit", **fields}


class States(unittest.TestCase):
    def test_a_state_with_no_gas_row_is_refused(self):
        found = gas_rows.state_problems({"a": row(input="dai")}, {"families": {"f": family(input=["dai", "usdc"])}})
        assert_refused(self, found, "usdc")

    def test_two_gas_rows_for_one_state_are_refused(self):
        found = gas_rows.state_problems(
            {"first": row(input="dai"), "second": row(input="dai")}, {"families": {"f": family(input=["dai"])}}
        )
        assert_refused(self, found, "first", "second")

    def test_a_gas_row_with_an_undeclared_value_is_refused(self):
        found = gas_rows.state_problems(
            {"a": row(input="dai"), "b": row(input="weth")}, {"families": {"f": family(input=["dai"])}}
        )
        assert_refused(self, found, "weth")

    def test_a_gas_row_of_no_family_is_refused(self):
        found = gas_rows.state_problems({"orphan": {"row": "susds", "intent": "deposit"}}, {"families": {}})
        assert_refused(self, found, "orphan")

    def test_an_exclusion_needs_a_reason(self):
        states = {"families": {"f": {**family(input=["dai", "usdc"]), "exclude": [{"when": {"input": "usdc"}}]}}}
        found = gas_rows.state_problems({"a": row(input="dai")}, states)
        assert_refused(self, found, "usdc")


class Flows(unittest.TestCase):
    def test_two_tables_that_route_one_row_are_refused(self):
        flow = flows.Flow("v6-prod", "dai", "deposit", "fixtureVariant", 1, 1, 1, 1, 1, 1)
        assert_refused(self, gen.problems([flow, flow], [], {}), "v6-prod/dai/deposit/fixtureVariant")
        self.assertFalse([p for p in gen.problems([flow], [], {}) if flow.id in p])


if __name__ == "__main__":
    unittest.main()
