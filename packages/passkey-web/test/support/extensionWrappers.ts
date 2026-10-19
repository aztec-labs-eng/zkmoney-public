/**
 * The `navigator.credentials.create` wrappers password-manager extensions install, as
 * `Function.prototype.toString` printed them on 2026-10-16 (Mac Chrome), and the stand-ins a test
 * uses for the browser's own methods.
 */

/** 1Password 8.12.4x: reads the request's `hints` and falls through to the native call. */
export const ONEPASSWORD_CREATE =
  "async function j(e){return await O(e?.publicKey?.hints)?B(e):d.credentials.create(e)}"

/**
 * Bitwarden, matching its open-source fido2-page-script.ts; the capture's elided middle is filled
 * in from that file. Never reads `hints`; falls back to the browser only on `fallbackRequested`.
 */
export const BITWARDEN_CREATE = `function createWebAuthnCredential(options) {
    return fido2_page_script_awaiter(this, void 0, void 0, function* () {
        if (!isWebauthnCall(options)) {
            return yield browserCredentials.create(options);
        }
        const authenticatorAttachmentIsPlatform = (options === null || options === void 0 ? void 0 : options.publicKey) && options.publicKey.authenticatorSelection && options.publicKey.authenticatorSelection.authenticatorAttachment === "platform";
        const fallbackSupported = (authenticatorAttachmentIsPlatform && browserNativeWebauthnPlatformAuthenticatorSupport) || (!authenticatorAttachmentIsPlatform && browserNativeWebauthnSupport);
        try {
            const response = yield messenger.request({
                type: MessageTypes.CredentialCreationRequest,
                data: WebauthnUtils.mapCredentialCreationOptions(options, fallbackSupported),
            }, options === null || options === void 0 ? void 0 : options.signal);
            if (response.type !== MessageTypes.CredentialCreationResponse || !response.result) {
                throw new Error("Something went wrong.");
            }
            return WebauthnUtils.mapCredentialRegistrationResult(response.result);
        }
        catch (error) {
            if (fallbackSupported && "fallbackRequested" in error && error.fallbackRequested) {
                yield waitForFocus();
                return yield browserCredentials.create(options);
            }
            throw rehydrateDOMException(error);
        }
    });
}`

/** LastPass: posts to the extension; falls back to `window.__nativeCredentialsCreate`. */
export const LASTPASS_CREATE =
  't=>new Promise((e,r)=>{var n;const o=function(){window.removeEventListener("message",f),e(null)};function s(){var n;null===(n=t.signal)||void 0===n||n.removeEventListener("abort",o),"undefined"!==typeof PublicKeyCredential&&(PublicKeyCredential.isConditionalMediationAvailable=window.__isConditionalMediationAvailable,PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable=window.__isUserVerifyingPlatformAuthenticatorAvailable),window.__nativeCredentialsCreate(t).then(e).catch(r)}if(!t.publicKey)return s();try{y(h.CREDENTIAL_CREATE_METHOD_OVERRIDDEN,i(t.publicKey))}catch(u){console.error(u),s()}const f=r=>{var n;if(r.origin===location.origin&&null!==(n=r.data)&&void 0!==n&&n.response){var i,f;if(null===(i=r.data)||void 0===i?void 0:i.response.cancelWithoutNative)return void e(null);const n=null===(f=r.data)||void 0===f?void 0:f.response.credential;if(n)try{var h;const r=function(t){return{...a(t),getClientExtensionResults:()=>({})}}(n);"undefined"!==typeof PublicKeyCredential&&(r.toJSON=l),null===(h=t.signal)||void 0===h||h.removeEventListener("abort",o),"undefined"!==typeof PublicKeyCredential&&Object.setPrototypeOf(r,PublicKeyCredential.prototype),"undefined"!==typeof AuthenticatorAttestationResponse&&Object.setPrototypeOf(r.response,AuthenticatorAttestationResponse.prototype),e(r)}catch(u){console.error(u),s()}else s()}};window.addEventListener("message",f),null===(n=t.signal)||void 0===n||n.addEventListener("abort",o)})'

/** Proton Pass: messages the extension; falls through to the native call when it does not intercept. */
export const PROTON_PASS_CREATE =
  'e=>h(async(t,r)=>{var n;if(!(null==e?void 0:e.publicKey)||!N.getState().connected)return t(u(e));if(null==(n=e.signal)?void 0:n.aborted)return r(new c(e.signal.reason,"AbortError"));let o=await N.sendMessage({type:d.PASSKEY_CREATE,payload:{request:JSON.stringify(l(e.publicKey))}},{timeout:e.publicKey.timeout,signal:e.signal});if("error"===o.type)return P({data:o,onReject:r,onFallback:()=>t(u(e))});if(!o.intercept)return T.debug("[WebAuthn] Intercept cancelled for `create`"),t(u(e));let i=(e=>{let{response:t}=e;return Object.setPrototypeOf({attestationObject:new a(t.attestation_object).buffer,clientDataJSON:new a(t.client_data_json).buffer,getAuthenticatorData:()=>new a(t.authenticator_data).buffer,getPublicKey:()=>t.public_key?new a(t.public_key).buffer:null,getPublicKeyAlgorithm:()=>t.public_key_algorithm,getTransports:()=>(null==t?void 0:t.transports)??[]},AuthenticatorAttestationResponse.prototype)})(o.response.credential);return t(C(_(o.response.credential,i,C)))})'

/** Real natives with the methods' own names: they print as `function create() { [native code] }`. */
export const NATIVE_CREATE: unknown = Object.create
export const NATIVE_GET: unknown = Reflect.get

/** The captured source as a real function, never called, so its print is the captured text. */
export const wrapperFrom = (source: string): unknown => (0, eval)(`(${source})`)

/** Installs a stand-in for `navigator.credentials`; the returned function puts the original back. */
export function installCredentials(value: unknown): () => void {
  const before = Object.getOwnPropertyDescriptor(navigator, "credentials")
  Object.defineProperty(navigator, "credentials", { value, configurable: true })
  return () => {
    if (before) Object.defineProperty(navigator, "credentials", before)
    else delete (navigator as { credentials?: unknown }).credentials
  }
}
