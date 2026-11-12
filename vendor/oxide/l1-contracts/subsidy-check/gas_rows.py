"""The gas rows of gas.json and the state matrix of states.json.

A gas row is one execution variant of one forwarding-table row and intent. It gives two upper bounds that a fork test
pins: `coverGas`, on the gas that the relayer submits to cover, and `unpricedGas`, on that gas less the gas that the
subsidy prices.

states.json declares, for each operation family, the axes of its execution variants. Each combination of the axes,
less the excluded ones, must have exactly one gas row, and each gas row must be exactly one combination. Thus a variant
with no gas row fails the check, and so does a gas row with a value that its family does not declare.
"""

import itertools
import json
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
GAS = HERE / "gas.json"
STATES = HERE / "states.json"
# The fork tests that pin the gas rows, as a path in l1-contracts, and their test contract.
PINS = "test/subsidy-check/fork/DepositSubsidy.gasRows.fork.t.sol"
PIN_SUITE = "DepositSubsidyGasRowsForkTest"


def gas() -> dict:
    return json.loads(GAS.read_text())


def rows() -> dict[str, dict]:
    return gas()["rows"]


def _combinations(family: dict) -> list[dict]:
    names = sorted(family["axes"])
    found = []
    for values in itertools.product(*(family["axes"][name] for name in names)):
        combination = dict(zip(names, values))
        excluded = any(
            all(combination.get(k) == v for k, v in rule["when"].items()) for rule in family.get("exclude", [])
        )
        if not excluded:
            found.append(combination)
    return found


def state_problems(gas_rows: dict[str, dict] | None = None, states: dict | None = None) -> list[str]:
    """What breaks the exact mapping between the state matrix and the gas rows."""
    gas_rows = rows() if gas_rows is None else gas_rows
    states = json.loads(STATES.read_text()) if states is None else states
    found = []
    claimed: dict[str, str] = {}
    for name, family in sorted(states["families"].items()):
        for rule in family.get("exclude", []):
            if not rule.get("reason"):
                found.append(f"states.json: {name} excludes {rule['when']} with no reason")
        members = {r: g for r, g in gas_rows.items() if g["row"] == family["row"] and g["intent"] == family["intent"]}
        for row_name, g in sorted(members.items()):
            for axis, values in family["axes"].items():
                if g.get(axis) not in values:
                    found.append(f"gas.json: {row_name} has {axis} {g.get(axis)!r}, which {name} does not declare")
        for combination in _combinations(family):
            matching = [r for r, g in members.items() if all(g.get(k) == v for k, v in combination.items())]
            if not matching:
                found.append(f"gas.json: {name} has no gas row for {combination}. Add one, with its fork pin")
            elif len(matching) > 1:
                found.append(f"gas.json: {name} has {len(matching)} gas rows for {combination}: {sorted(matching)}")
            for r in matching:
                claimed[r] = name
    for row_name in sorted(gas_rows.keys() - claimed.keys()):
        found.append(f"gas.json: {row_name} is in no family of states.json, or matches no combination of its family")
    return found


def pin_test(row: str) -> str:
    """The name of the fork test that pins a gas row, in PIN_SUITE."""
    return f"test_GasRow_{row}_BoundsTheRelay"
