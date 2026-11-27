//! The built-in indicators, compiled into the app. Build them first:
//! `cargo build --manifest-path indicators/Cargo.toml --target wasm32-wasip2 --release`.

macro_rules! builtin {
    ($id:literal, $file:literal) => {
        (
            $id,
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../indicators/target/wasm32-wasip2/release/",
                $file
            )) as &'static [u8],
        )
    };
}

static BUILTINS: [(&str, &[u8]); 5] = [
    builtin!("builtin.sma", "builtin_sma.wasm"),
    builtin!("builtin.ema", "builtin_ema.wasm"),
    builtin!("builtin.bollinger", "builtin_bollinger.wasm"),
    builtin!("builtin.rsi", "builtin_rsi.wasm"),
    builtin!("builtin.macd", "builtin_macd.wasm"),
];

/// `(id, module bytes)` of every built-in indicator.
pub fn builtins() -> &'static [(&'static str, &'static [u8])] {
    &BUILTINS
}
