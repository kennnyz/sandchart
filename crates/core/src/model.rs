//! Instrument and candle types.

use serde::{Deserialize, Serialize};

/// Identifies an instrument within a data source, e.g. `binance` / `BTCUSDT`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct InstrumentId {
    pub source: String,
    pub symbol: String,
}

/// A tradable instrument with the tick scales used to store its numbers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Instrument {
    pub id: InstrumentId,
    pub base: String,
    pub quote: String,
    /// Decimal places of one price tick.
    pub price_scale: u8,
    /// Decimal places of one quantity tick.
    pub qty_scale: u8,
}

/// One OHLCV bar. `open_time` is milliseconds since the Unix epoch (UTC),
/// prices are in price ticks and `volume` is in quantity ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candle {
    pub open_time: i64,
    pub open: i64,
    pub high: i64,
    pub low: i64,
    pub close: i64,
    pub volume: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn id(symbol: &str) -> InstrumentId {
        InstrumentId {
            source: "binance".into(),
            symbol: symbol.into(),
        }
    }

    #[test]
    fn instrument_id_is_hashable_by_value() {
        let set: HashSet<_> = [id("BTCUSDT"), id("BTCUSDT"), id("ETHUSDT")].into();
        assert_eq!(set.len(), 2);
    }

    #[test]
    fn candle_serde_round_trip() {
        let c = Candle {
            open_time: 1_700_000_000_000,
            open: 6_144_301,
            high: 6_150_000,
            low: 6_100_000,
            close: 6_120_000,
            volume: 123_456_789,
        };
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(serde_json::from_str::<Candle>(&json).unwrap(), c);
    }

    #[test]
    fn instrument_serde_round_trip() {
        let i = Instrument {
            id: id("BTCUSDT"),
            base: "BTC".into(),
            quote: "USDT".into(),
            price_scale: 2,
            qty_scale: 5,
        };
        let json = serde_json::to_string(&i).unwrap();
        assert_eq!(serde_json::from_str::<Instrument>(&json).unwrap(), i);
    }
}
