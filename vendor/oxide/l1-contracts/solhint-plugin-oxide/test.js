// Run the env rule fixtures from l1-contracts/: `node solhint-plugin-oxide/test.js`.
const assert = require("node:assert/strict");
const { processStr } = require("solhint");

const config = require("../.solhint.json");

const HEADER = "// SPDX-License-Identifier: Apache-2.0\npragma solidity >=0.8.27;\n";

function lint(fileName, body) {
  return processStr(HEADER + body, config, fileName)
    .reports.map((report) => report.ruleId)
    .sort();
}

const cases = [
  {
    name: "no-set-env rejects vm.setEnv in a test",
    file: "test/script/DeployFoo.t.sol",
    body: `import {Test} from "forge-std/Test.sol";
contract DeployFooTest is Test {
  function setUp() public {
    vm.setEnv("OXIDE_OWNER", vm.toString(address(0xA11CE)));
  }
}`,
    expect: ["oxide/no-set-env"],
  },
  {
    name: "no-set-env rejects vm.setEnv in a script",
    file: "script/DeployFoo.s.sol",
    body: `import {OxideScript} from "./OxideScript.sol";
contract DeployFoo is OxideScript {
  function run() external {
    vm.setEnv("OXIDE_OWNER", "");
  }
}`,
    expect: ["oxide/no-set-env"],
  },
  {
    name: "env-reads-in-oxide-script rejects raw vm.env* reads in a script",
    file: "script/DeployFoo.s.sol",
    body: `import {Script} from "forge-std/Script.sol";
contract DeployFoo is Script {
  function run() external view returns (address owner, address portal) {
    owner = vm.envOr("OXIDE_OWNER", msg.sender);
    portal = vm.envAddress("OXIDE_PORTAL");
  }
}`,
    expect: ["oxide/env-reads-in-oxide-script", "oxide/env-reads-in-oxide-script"],
  },
  {
    name: "env-reads-in-oxide-script rejects raw reads under a test directory outside the package",
    file: "/tmp/test/elsewhere/script/DeployFoo.s.sol",
    body: `import {Script} from "forge-std/Script.sol";
contract DeployFoo is Script {
  function run() external view returns (address) {
    return vm.envAddress("OXIDE_PORTAL");
  }
}`,
    expect: ["oxide/env-reads-in-oxide-script"],
  },
  {
    name: "env-reads-in-oxide-script accepts a script that reads through the helpers",
    file: "script/DeployFoo.s.sol",
    body: `import {OxideScript} from "./OxideScript.sol";
contract DeployFoo is OxideScript {
  function run() external view returns (address owner, address portal) {
    owner = _envOr("OXIDE_OWNER", msg.sender);
    portal = _envAddress("OXIDE_PORTAL");
  }
}`,
    expect: [],
  },
  {
    name: "env-reads-in-oxide-script accepts raw reads in the base itself",
    file: "script/OxideScript.sol",
    body: `import {Script} from "forge-std/Script.sol";
abstract contract OxideScript is Script {
  function _envAddress(string memory _name) internal view virtual returns (address) {
    return vm.envAddress(_name);
  }
}`,
    expect: [],
  },
  {
    name: "env-reads-in-oxide-script accepts raw reads in a test",
    file: "test/core/Foo.t.sol",
    body: `import {Test} from "forge-std/Test.sol";
contract FooTest is Test {
  function test_gasGuard() public view {
    if (!vm.envOr("FORGE_COVERAGE", false)) {}
  }
}`,
    expect: [],
  },
];

let failures = 0;
for (const c of cases) {
  const got = lint(c.file, c.body);
  try {
    assert.deepEqual(got, [...c.expect].sort());
    console.log(`ok   ${c.name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${c.name} (${c.file})\n  expected ${JSON.stringify(c.expect)}\n  got      ${JSON.stringify(got)}`);
  }
}
if (failures > 0) {
  console.error(`${failures} of ${cases.length} solhint-plugin-oxide cases failed`);
  process.exit(1);
}
console.log(`${cases.length} solhint-plugin-oxide cases passed`);
