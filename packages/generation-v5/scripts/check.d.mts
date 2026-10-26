export declare const dist: string
export declare const boundaryFile: string
export declare const protocol: number
export declare const bundleInputs: string[]
export declare const inputsHash: string
export declare const assetName: string
export declare function readBundle(
  dir?: string,
):
  | { files: Map<string, string>; walletCommit: string; protocol: number; inputs: string }
  | undefined
