import { XMLParser, XMLValidator } from 'fast-xml-parser';

import { addressKey } from '../address_key.js';

export interface SdnList {
  addresses: ReadonlySet<string>;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;

interface SdnDocument {
  sdnList?: {
    sdnEntry?: Array<{
      idList?: {
        id?: Array<{ idType?: unknown; idNumber?: unknown }>;
      };
    }>;
  };
}

export function parseSdnList(xml: string): SdnList {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error('SDN list is not well-formed XML: ' + validation.err.msg);
  }
  const document = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    processEntities: false,
    trimValues: true,
    isArray: (_name, path) => typeof path === 'string' && (path === 'sdnList.sdnEntry' || path.endsWith('.idList.id')),
  }).parse(xml) as SdnDocument;

  const addresses = new Set<string>();
  for (const entry of document.sdnList?.sdnEntry ?? []) {
    for (const id of entry.idList?.id ?? []) {
      if (
        typeof id.idType === 'string' &&
        id.idType.startsWith('Digital Currency Address - ') &&
        typeof id.idNumber === 'string' &&
        EVM_ADDRESS.test(id.idNumber)
      ) {
        addresses.add(addressKey(id.idNumber));
      }
    }
  }
  if (addresses.size === 0) {
    throw new Error('SDN list has no EVM addresses');
  }
  return { addresses };
}
