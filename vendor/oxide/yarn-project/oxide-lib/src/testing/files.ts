// Local mirror of `@aztec/foundation/testing/files::updateInlineTestData`. Foundation's helper
// walks 5 directories up from its own module location to find the repo root, which works in the
// aztec-packages monorepo (foundation lives at `<repo>/yarn-project/foundation/`) but lands one
// level too short in this repo, where foundation is a hoisted dependency at
// `<repo>/yarn-project/node_modules/@aztec/foundation/`. We mirror the helper here and find the
// repo root by walking up looking for `.git` instead.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('could not find repo root (no .git in any ancestor)');
}

function isGenerateTestDataEnabled(): boolean {
  return process.env['OXIDE_GENERATE_TEST_DATA'] === '1';
}

/**
 * Looks for a variable assignment in the target file and updates the value, only if test data
 * generation is enabled. Matches both `let X = ...;` (Noir locals, TS) and `pub global X: T = ...;`
 * (Noir globals).
 *
 * @remarks Requires `OXIDE_GENERATE_TEST_DATA=1` to be set.
 */
export function updateInlineTestData(targetFileFromRepoRoot: string, itemName: string, value: string): void {
  if (!isGenerateTestDataEnabled()) {
    return;
  }
  const targetFile = join(findRepoRoot(), targetFileFromRepoRoot);
  const contents = readFileSync(targetFile, 'utf8');
  const regex = new RegExp(`(let|pub\\s+global)\\s+${itemName}(\\s*:\\s*[^=]+)?\\s*=\\s*([\\s\\S]*?);`, 'g');
  if (!regex.exec(contents)) {
    throw new Error(`Test data marker for ${itemName} not found in ${targetFile}`);
  }
  const updated = contents.replace(regex, (_, decl, ty) => `${decl} ${itemName}${(ty || '').trimEnd()} = ${value};`);
  writeFileSync(targetFile, updated);
}
