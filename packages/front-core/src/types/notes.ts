export interface PlainNote {
  contractAddress: string
  storageSlot: string
  recipient: string
  txHash: string
  nonce: string
  items: string[]
}

export interface ProcessedNote {
  header: {
    contract_address: string
    storage_slot: string
    note_hash_counter: number
    nonce: string
  }
  value: string
  owner: string
  randomness: string
}

export interface NoteStore {
  owner: string
  note: PlainNote
  blockNumber: number
  processedNote?: ProcessedNote
  tokenName?: string
  tokenSymbol?: string
  tokenDecimals?: number
  tokenPrice?: number
  tokenLogo?: string
}
