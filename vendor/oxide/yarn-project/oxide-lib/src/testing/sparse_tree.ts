import { Fr } from '@aztec/aztec.js/fields';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import type { Tuple } from '@aztec/foundation/serialize';
import { MembershipWitness, SiblingPath } from '@aztec/foundation/trees';

/** A test Merkle tree that holds its leaves from index 0 and pads every missing node with the zero subtree hash. */
export class SparseTree {
  private constructor(
    private readonly height: number,
    private readonly levels: Fr[][],
    private readonly zeroHashes: Fr[],
  ) {}

  static async build(height: number, leaves: Fr[], separator: number): Promise<SparseTree> {
    const hash = (l: Fr, r: Fr) => poseidon2HashWithSeparator([l, r], separator);
    const zeroHashes: Fr[] = [Fr.ZERO];
    for (let i = 0; i < height; i++) {
      zeroHashes.push(await hash(zeroHashes[i]!, zeroHashes[i]!));
    }

    const levels: Fr[][] = [leaves.slice()];
    for (let lvl = 0; lvl < height; lvl++) {
      const cur = levels[lvl]!;
      const next: Fr[] = [];
      for (let i = 0; i * 2 < cur.length; i++) {
        next.push(await hash(cur[i * 2]!, cur[i * 2 + 1] ?? zeroHashes[lvl]!));
      }
      levels.push(next);
    }
    return new SparseTree(height, levels, zeroHashes);
  }

  get root(): Fr {
    return this.levels[this.height]?.[0] ?? this.zeroHashes[this.height]!;
  }

  siblingPath<N extends number>(leafIndex: number): Tuple<Fr, N> {
    if (leafIndex < 0 || leafIndex >= this.levels[0]!.length) {
      throw new Error(`leaf index ${leafIndex} out of range [0, ${this.levels[0]!.length})`);
    }

    const path: Fr[] = [];
    let idx = leafIndex;
    for (let lvl = 0; lvl < this.height; lvl++) {
      path.push(this.levels[lvl]![idx ^ 1] ?? this.zeroHashes[lvl]!);
      idx >>= 1;
    }
    return path as Tuple<Fr, N>;
  }

  membershipWitness<N extends number>(leafIndex: number): MembershipWitness<N> {
    return new MembershipWitness(this.height as N, BigInt(leafIndex), this.siblingPath<N>(leafIndex));
  }

  siblingPathObject<N extends number>(leafIndex: number): SiblingPath<N> {
    return new SiblingPath(
      this.height as N,
      this.siblingPath<N>(leafIndex).map(node => node.toBuffer()),
    );
  }
}
