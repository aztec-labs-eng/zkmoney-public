import { type AztecNode, createAztecNodeClient } from '@aztec/aztec.js/node';
import { jsonStringify } from '@aztec/foundation/json-rpc';
import type { JsonRpcFetch } from '@aztec/foundation/json-rpc/client';

const API_KEY_HEADER = 'x-api-key';
const RATE_LIMIT_STATUS = 429;
const RATE_LIMIT_DELAYS_MS = [250, 500, 1000, 2000];
const TRANSPORT_DELAYS_MS = [1_000, 2_000, 3_000];

export interface AztecNodeEndpoint {
  url: string;
  apiKey?: string;
}

type FetchResult = Awaited<ReturnType<JsonRpcFetch>>;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

// `redirect: 'error'` because the Fetch standard drops `Authorization` across origins but keeps
// every other header, so following a redirect would hand the key to whoever answered.
async function sendOnce(host: string, body: unknown, headers: Record<string, string>): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetch(host, {
      method: 'POST',
      body: jsonStringify(body),
      headers: { 'content-type': 'application/json', ...headers },
      redirect: 'error',
    });
  } catch (err) {
    throw new Error(`Error fetching from host ${host}: ${String(err)}`);
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  if (!res.ok) {
    throw new HttpStatusError(res.status, `Error ${res.status} from server ${host}: ${parsed ? text : res.statusText}`);
  }
  if (parsed === undefined) {
    throw new Error(`Failed to parse body as JSON: ${text}`);
  }
  return { response: parsed, headers: res.headers };
}

function delayBeforeRetry(err: unknown, attempt: number, noRetry?: boolean): number | undefined {
  if (noRetry) {
    return undefined;
  }
  if (err instanceof HttpStatusError) {
    if (err.status === RATE_LIMIT_STATUS) {
      return RATE_LIMIT_DELAYS_MS[attempt];
    }
    return err.status >= 500 ? TRANSPORT_DELAYS_MS[attempt] : undefined;
  }
  return TRANSPORT_DELAYS_MS[attempt];
}

// The SDK transport treats every 4xx as final, so a rate limit gets no wait. This one reads the
// status, so a 429 waits and a rejected key does not. It bounds one call, not the caller's poll loop.
function keyedFetch(apiKey: string): JsonRpcFetch {
  return async (host, body, extraHeaders = {}, noRetry) => {
    const headers = { ...extraHeaders, [API_KEY_HEADER]: apiKey };
    for (let attempt = 0; ; attempt++) {
      try {
        return await sendOnce(host, body, headers);
      } catch (err) {
        const delay = delayBeforeRetry(err, attempt, noRetry);
        if (delay === undefined) {
          throw err;
        }
        await sleep(delay);
      }
    }
  };
}

function isSafeForCredentials(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

// Without a key this is the SDK default, unchanged. `x-api-key` is the only form the keyed
// endpoints accept.
export function createNodeClient({ url, apiKey }: AztecNodeEndpoint): AztecNode {
  const key = apiKey?.trim();
  if (!key) {
    return createAztecNodeClient(url);
  }
  if (!isSafeForCredentials(url)) {
    throw new Error(`Refusing to send the Aztec node API key to ${new URL(url).origin}: use https.`);
  }
  return createAztecNodeClient(url, undefined, keyedFetch(key));
}
