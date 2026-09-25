use super::Args;
use crate::commands::helpers::assist;

mod helpers;

pub fn run(_args: Args, _count: usize) {
    assist();
}
