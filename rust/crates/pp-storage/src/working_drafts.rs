pub mod observation;

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "D13 manifest consumers land in a later slice")
)]
mod manifest;
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "D13 manifest consumers land in a later slice")
)]
mod siblings;

#[cfg(test)]
mod siblings_tests;
