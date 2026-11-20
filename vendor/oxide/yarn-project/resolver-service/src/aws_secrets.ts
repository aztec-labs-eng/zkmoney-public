const SECRET_ENV_VARS = [
  'OXIDE_RESOLVER_PRIVATE_KEY',
  'OXIDE_RESOLVER_DB_URL',
  'OXIDE_RESOLVER_REDIS_URL',
  'OXIDE_RESOLVER_L1_RPC_URL',
] as const;

export async function loadAwsSecrets(): Promise<void> {
  const pending = SECRET_ENV_VARS.filter(name => process.env[`${name}_SECRET_ID`]);
  if (pending.length === 0) {
    return;
  }
  // A lazy import keeps local deployments independent of AWS credentials.
  const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  try {
    for (const name of pending) {
      const secretId = process.env[`${name}_SECRET_ID`]!;
      const version = process.env[`${name}_SECRET_VERSION_ID`];
      const res = await client.send(
        new GetSecretValueCommand({
          SecretId: secretId,
          ...(version ? { VersionId: version } : {}),
        }),
      );
      if (version && res.VersionId !== version) {
        throw new Error(`secret ${secretId} returned a different version`);
      }
      if (!res.SecretString) {
        throw new Error(`secret ${secretId} (for ${name}) has no string value`);
      }
      const field = process.env[`${name}_SECRET_JSON_FIELD`];
      let value = res.SecretString;
      if (field) {
        try {
          value = JSON.parse(value)[field];
        } catch {
          throw new Error(`secret ${secretId} is not valid JSON`);
        }
        if (typeof value !== 'string' || !value) {
          throw new Error(`secret ${secretId} has no string field ${field}`);
        }
      }
      process.env[name] = value;
    }
  } finally {
    client.destroy();
  }
}
