//! Core types shared by every Sandchart crate.
//!
//! Prices and quantities are integers in ticks (`i64`); see [`decimal`].

pub mod decimal;
pub mod model;
pub mod timeframe;

pub use decimal::{DecimalError, JS_SAFE_MAX, format_scaled, parse_scaled, scale_from_step};
pub use model::{Candle, Instrument, InstrumentId};
pub use timeframe::Timeframe;
