use aztec::{
    authwit::entrypoint::FunctionCall,
    context::PrivateContext,
    protocol::{
        constants::DOM_SEP__SIGNATURE_PAYLOAD,
        hash::poseidon2_hash_with_separator,
        traits::{Deserialize, Hash, Serialize},
    },
};
use std::meta::derive;

pub global ACCOUNT_MAX_CALLS: u32 = 5;

#[derive(Deserialize, Serialize)]
pub struct AppPayload {
    pub function_calls: [FunctionCall; ACCOUNT_MAX_CALLS],
    pub tx_nonce: Field,
}

impl Hash for AppPayload {
    fn hash(self) -> Field {
        poseidon2_hash_with_separator(self.serialize(), DOM_SEP__SIGNATURE_PAYLOAD)
    }
}

impl AppPayload {
    pub fn execute_call(context: &mut PrivateContext, call: FunctionCall) {
        if !call.target_address.is_zero() {
            if call.is_public {
                context.call_public_function_with_calldata_hash(
                    call.target_address,
                    call.args_hash,
                    call.is_static,
                    call.hide_msg_sender,
                );
            } else {
                assert(
                    !call.hide_msg_sender,
                    "Incompatible flag. `hide_msg_sender = true` is only available for public calls.",
                );
                let _result = context.call_private_function_with_args_hash(
                    call.target_address,
                    call.function_selector,
                    call.args_hash,
                    call.is_static,
                );
            }
        }
    }

    pub fn execute_calls(self, context: &mut PrivateContext) {
        for call in self.function_calls {
            Self::execute_call(context, call);
        }
    }

    pub fn execute_calls_app_phase(self, context: &mut PrivateContext) {
        for i in 1..ACCOUNT_MAX_CALLS {
            let call = self.function_calls[i];
            Self::execute_call(context, call);
        }
    }

    pub fn execute_setup_call(self, context: &mut PrivateContext) {
        Self::execute_call(context, self.function_calls[0]);
    }
}
