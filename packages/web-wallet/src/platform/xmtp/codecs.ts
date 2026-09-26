import { AztecPaymentRequestCodec, ConnectBackCodec } from "@obsidion/sdk"

/**
 * browser-sdk v7's codec interface is the registry-free content-type-primitives shape
 * (`{contentType, encode(content), decode(content), fallback, shouldPush}`) the shared @obsidion/sdk
 * codecs already implement, so they register as-is; the `Client.create`/`build` call site casts
 * across the primitives-v2 vs wasm-bindings nominal types (structurally identical).
 */
export const webConnectBackCodec = new ConnectBackCodec()
export const webPaymentRequestCodec = new AztecPaymentRequestCodec()

/** Every codec the web client registers: connect-backs and payment requests. */
export const webXmtpCodecs = [webConnectBackCodec, webPaymentRequestCodec]
