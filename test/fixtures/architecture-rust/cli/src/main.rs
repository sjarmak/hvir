extern crate shop_core;

mod commands;

use ::std::env;
use clap::Parser as _;
use shop_core::{api, store::Store as ShopStore};

pub struct Args;

fn main() {
    commands::run(Args, env::args().count());
    let _ = (api::NAME, None::<ShopStore>);
}
