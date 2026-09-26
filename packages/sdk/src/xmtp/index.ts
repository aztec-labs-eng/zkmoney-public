export {
  deriveXmtpSigner,
  deriveEvmAddress,
  signEip191,
  XMTP_SIGNING_DOMAIN_SEPARATOR,
  type XmtpSignerMaterial,
} from "./xmtpCrypto.js"

export { ConnectBackCodec, ConnectBackContentTypeId } from "./ConnectBackCodec.js"

export {
  AztecPaymentRequestCodec,
  AztecPaymentRequestContentTypeId,
} from "./AztecPaymentRequestCodec.js"

export {
  CodecDecodeError,
  ConnectBackContentSchema,
  CONNECT_BACK_UUID_MAX_LEN,
  AztecPaymentRequestContentSchema,
  PAYMENT_REQUEST_NOTE_MAX_LEN,
  type ConnectBackContent,
  type AztecPaymentRequestContent,
} from "./types.js"

export {
  buildConnectBack,
  CONNECT_BACK_VERSION,
  type BuildConnectBackArgs,
} from "./buildConnectBack.js"

export {
  buildPaymentRequest,
  buildPaymentRequestDeclined,
  type BuildPaymentRequestArgs,
  type BuildPaymentRequestDeclinedArgs,
} from "./buildPaymentRequest.js"
