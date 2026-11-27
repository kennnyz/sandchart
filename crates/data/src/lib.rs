//! Market data providers for Sandchart.
//!
//! [`Provider`] is the one trait every data source implements; the engine
//! holds providers as `Arc<dyn Provider>`.

pub mod binance;

use async_trait::async_trait;
use futures::stream::BoxStream;
use sandchart_core::{Candle, Instrument, InstrumentId, Timeframe};
use thiserror::Error;

pub use binance::Binance;

/// A candle from a live stream; `closed` is true once the bar is final.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveCandle {
    pub candle: Candle,
    pub closed: bool,
}

/// Last price and 24 h change of one instrument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayChange {
    pub id: InstrumentId,
    /// Last price in price ticks.
    pub last: i64,
    /// 24 h change in basis points (1.84 % is `184`).
    pub change_bp: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProviderError {
    #[error("network error: {0}")]
    Network(String),
    #[error("rate limited, retry after {retry_after_s} s")]
    RateLimited { retry_after_s: u64 },
    #[error("blocked by the exchange (HTTP {status})")]
    Blocked { status: u16 },
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("unexpected response: {0}")]
    Parse(String),
}

#[async_trait]
pub trait Provider: Send + Sync {
    /// Source name used in [`InstrumentId::source`], e.g. `"binance"`.
    fn source(&self) -> &str;

    /// All tradable instruments.
    async fn instruments(&self) -> Result<Vec<Instrument>, ProviderError>;

    /// Up to `limit` candles that opened strictly before `end_before`
    /// (milliseconds; `None` means now), ascending by open time.
    async fn history(
        &self,
        inst: &Instrument,
        tf: Timeframe,
        end_before: Option<i64>,
        limit: u16,
    ) -> Result<Vec<Candle>, ProviderError>;

    /// Live candle updates for one instrument and timeframe.
    fn live(
        &self,
        inst: &Instrument,
        tf: Timeframe,
    ) -> BoxStream<'static, Result<LiveCandle, ProviderError>>;

    /// 24 h changes for the given instruments. Sources without quotes keep
    /// the default, which returns nothing.
    async fn day_changes(&self, _insts: &[Instrument]) -> Result<Vec<DayChange>, ProviderError> {
        Ok(vec![])
    }
}
