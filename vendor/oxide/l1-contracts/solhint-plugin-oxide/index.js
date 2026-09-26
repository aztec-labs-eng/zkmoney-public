const { parse } = require("@solidity-parser/parser");

// Comments a tool reads: forge and solhint. The license header before `pragma` is always allowed.
const ALLOWED = /^(forge-lint:|forge-config:|solhint-)/;

class NoComments {
  constructor(reporter, config, inputSrc) {
    this.ruleId = "no-comments";
    this.reporter = reporter;
    this.inputSrc = inputSrc;
  }

  SourceUnit() {
    const ast = parse(this.inputSrc, { comments: true, loc: true });
    const pragma = ast.children.find((child) => child.type === "PragmaDirective");
    const headerEnd = pragma ? pragma.loc.start.line : 0;
    for (const comment of ast.comments) {
      if (comment.loc.end.line < headerEnd) continue;
      const text = comment.value.replace(/^[/*\s]+/, "");
      if (!ALLOWED.test(text)) {
        this.reporter.error(comment, this.ruleId, "Comments are not allowed");
      }
    }
  }
}

const path = require("node:path");

// Resolve paths from the package root to limit exemptions to test/ and script/OxideScript.sol.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

function packageRelative(fileName) {
  const normalized = (fileName || "").replace(/\\/g, "/");
  return path.relative(PACKAGE_ROOT, path.resolve(normalized)).replace(/\\/g, "/");
}

// Both rules match member names to catch aliases and stored function references.
// Receiver types are not checked, so unrelated methods with these names are also rejected.
class NoSetEnv {
  constructor(reporter) {
    this.ruleId = "no-set-env";
    this.reporter = reporter;
  }

  MemberAccess(node) {
    if (node.memberName === "setEnv") {
      this.reporter.error(
        node,
        this.ruleId,
        "setEnv writes the process environment shared by parallel forge tests; use a FakeEnv harness",
      );
    }
  }
}

// Route script reads through OxideScript so tests can replace the environment source.
const ENV_READ = /^env[A-Z]/;
const ENV_BASE = "script/OxideScript.sol";

class EnvReadsInOxideScript {
  constructor(reporter, config, inputSrc, fileName) {
    this.ruleId = "env-reads-in-oxide-script";
    this.reporter = reporter;
    const relative = packageRelative(fileName);
    this.exempt = relative === ENV_BASE || relative.startsWith("test/");
  }

  MemberAccess(node) {
    if (this.exempt) return;
    const member = node.memberName;
    if (ENV_READ.test(member)) {
      this.reporter.error(
        node,
        this.ruleId,
        `${member} outside OxideScript.sol; read the environment through the OxideScript _env helpers`,
      );
    }
  }
}

module.exports = [NoComments, NoSetEnv, EnvReadsInOxideScript];
