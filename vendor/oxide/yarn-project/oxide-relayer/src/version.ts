/** The release version that the image build sets in `OXIDE_RELAYER_VERSION`. A build without a release reports `dev`. */
export function relayerVersion(): string {
  return process.env.OXIDE_RELAYER_VERSION?.trim() || 'dev';
}
