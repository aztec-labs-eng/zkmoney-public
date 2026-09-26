use aztec::{
    macros::notes::note,
    protocol::traits::{Deserialize, Hash, Packable, Serialize, ToField},
};

#[derive(Eq, Serialize, Packable, Deserialize)]
#[note]
pub struct BoolNote {
    pub boolean: bool,
}
