import type { Address, Hex } from 'viem';

type LinkReference = {
  start: number;
  length: number;
};

export type LinkReferences = Record<string, Record<string, readonly LinkReference[]>>;
export type LinkLibraries = Record<string, Address>;

export function linkBytecode(bytecode: Hex, linkReferences: LinkReferences, libraries: LinkLibraries): Hex {
  let linked = bytecode.slice(2);

  for (const librariesBySource of Object.values(linkReferences)) {
    for (const [libraryName, references] of Object.entries(librariesBySource)) {
      const address = libraries[libraryName];
      if (!address) {
        throw new Error(`missing deployment address for linked library ${libraryName}`);
      }

      for (const { start, length } of references) {
        if (length !== 20) {
          throw new Error(`unsupported link reference length ${length} for ${libraryName}`);
        }

        const offset = start * 2;
        linked = linked.slice(0, offset) + address.slice(2).toLowerCase() + linked.slice(offset + length * 2);
      }
    }
  }

  if (linked.includes('__$')) {
    throw new Error('linked bytecode still contains unresolved library placeholders');
  }

  return `0x${linked}` as Hex;
}
