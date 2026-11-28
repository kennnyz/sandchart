//! Core types shared by every Sandchart crate.
//!
//! Prices and quantities are integers in ticks (`i64`); see [`decimal`].

pub mod decimal;
pub mod drawing;
pub mod model;
pub mod position;
pub mod timeframe;

pub use decimal::{
    DecimalError, JS_SAFE_MAX, format_scaled, parse_scaled, parse_scaled_rounded, scale_from_step,
};
pub use drawing::{Anchor, Drawing, DrawingBody, Style};
pub use model::{Candle, Instrument, InstrumentId};
pub use position::{Outcome, PositionBody, Side, Status};
pub use timeframe::Timeframe;
