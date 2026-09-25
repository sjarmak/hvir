use shop_core::api::v1::handle;

#[test]
fn handles() {
    assert!(handle().is_ok());
}
