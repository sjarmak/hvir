use crate::api::{self, v1::Handler};
use super::super::util::fmt::render;

pub struct Pool;

pub fn connect(handler: Handler) -> Pool {
    render(api::NAME);
    let _ = handler;
    Pool
}
