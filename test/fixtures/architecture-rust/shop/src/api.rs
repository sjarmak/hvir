pub mod v1;

use crate::nowhere::Thing;
use crate::{codes::NOT_FOUND, Store};

pub const NAME: &str = "api";

pub fn lookup(_store: &Store, _thing: Thing) -> u16 {
    NOT_FOUND
}
