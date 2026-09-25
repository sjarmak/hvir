//! The shop library crate.
pub mod api;
pub mod store;
mod broken;
mod missing;
#[path = "generated/codes.rs"]
pub mod codes;

mod util {
    pub mod fmt;
}

pub mod errors {
    #[derive(Debug)]
    pub struct Error;
}

pub use crate::store::Store;

pub fn version() -> &'static str {
    "1"
}
