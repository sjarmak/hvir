use super::*;
use crate::errors::Error;

pub struct Handler;

pub fn handle() -> Result<Handler, Error> {
    let _ = NAME;
    Ok(Handler)
}
