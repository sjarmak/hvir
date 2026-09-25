mod sqlite;

use std::collections::HashMap;

use serde::Serialize;

use self::sqlite::Pool;
use super::errors::Error;

#[derive(Serialize)]
pub struct Store {
    items: HashMap<String, String>,
}

impl Store {
    pub fn open(_pool: Pool) -> Result<Self, Error> {
        Ok(Self { items: HashMap::new() })
    }
}
