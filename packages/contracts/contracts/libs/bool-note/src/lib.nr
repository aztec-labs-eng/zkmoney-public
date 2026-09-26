use dep::aztec::{
    macros::notes::note, oracle::random::random, 
    protocol_types::{
      address::AztecAddress,
      traits::{Serialize, Packable},
    },
   
};


#[derive(Eq, Serialize, Packable)]
#[note]
pub struct BoolNote {
    pub boolean: bool,
    owner: AztecAddress,
    randomness: Field,
}

impl BoolNote {
  pub fn new(boolean: bool, owner: AztecAddress) -> Self {
    let randomness = unsafe { random()};
    BoolNote { boolean, owner, randomness }
  }

  pub fn get_bool(self) -> bool {
    self.boolean
  }
}