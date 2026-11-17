import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterEach, expect, jest, test } from '@jest/globals';

import { loadAwsSecrets } from './aws_secrets.js';

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

test('the gateway resolves the reviewed L1 RPC JSON field at its exact secret version', async () => {
  process.env.OXIDE_RESOLVER_L1_RPC_URL_SECRET_ID = 'staging-rpc';
  process.env.OXIDE_RESOLVER_L1_RPC_URL_SECRET_VERSION_ID = 'reviewed';
  process.env.OXIDE_RESOLVER_L1_RPC_URL_SECRET_JSON_FIELD = 'url';
  const send = jest
    .spyOn(SecretsManagerClient.prototype, 'send')
    .mockResolvedValue({ SecretString: '{"url":"https://rpc.invalid/private"}', VersionId: 'reviewed' } as never);
  const destroy = jest.spyOn(SecretsManagerClient.prototype, 'destroy');
  await loadAwsSecrets();
  expect((send.mock.calls[0][0] as { input: unknown }).input).toEqual({
    SecretId: 'staging-rpc',
    VersionId: 'reviewed',
  });
  expect(process.env.OXIDE_RESOLVER_L1_RPC_URL).toBe('https://rpc.invalid/private');
  expect(destroy).toHaveBeenCalledTimes(1);
});

test('a mismatched version cannot replace the gateway RPC and closes the client', async () => {
  process.env.OXIDE_RESOLVER_L1_RPC_URL_SECRET_ID = 'staging-rpc';
  process.env.OXIDE_RESOLVER_L1_RPC_URL_SECRET_VERSION_ID = 'reviewed';
  delete process.env.OXIDE_RESOLVER_L1_RPC_URL;
  jest
    .spyOn(SecretsManagerClient.prototype, 'send')
    .mockResolvedValue({ SecretString: 'https://private.invalid', VersionId: 'other' } as never);
  const destroy = jest.spyOn(SecretsManagerClient.prototype, 'destroy');
  await expect(loadAwsSecrets()).rejects.toThrow('different version');
  expect(process.env.OXIDE_RESOLVER_L1_RPC_URL).toBeUndefined();
  expect(destroy).toHaveBeenCalledTimes(1);
});
