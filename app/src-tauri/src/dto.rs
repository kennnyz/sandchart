//! Wire types of the Tauri commands and events. JSON is camelCase; candles are columnar
//! so a 200 000-candle history is six flat arrays, not 200 000 objects.

use sandchart_core::{Candle, Instrument, InstrumentId, JS_SAFE_MAX};
use sandchart_data::DayChange;
use sandchart_engine::{ChartPage, ConnectionState, LiveEvent};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DtoError {
    #[error("a price or volume is too large for the UI (beyond 2^53 - 1 ticks)")]
    UnsafeTicks,
}

/// JavaScript numbers hold integers exactly only up to 2^53 - 1.
fn safe(v: i64) -> Result<i64, DtoError> {
    if v.unsigned_abs() > JS_SAFE_MAX.unsigned_abs() {
        Err(DtoError::UnsafeTicks)
    } else {
        Ok(v)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstrumentIdDto {
    pub source: String,
    pub symbol: String,
}

impl From<InstrumentId> for InstrumentIdDto {
    fn from(id: InstrumentId) -> Self {
        Self {
            source: id.source,
            symbol: id.symbol,
        }
    }
}

impl From<InstrumentIdDto> for InstrumentId {
    fn from(id: InstrumentIdDto) -> Self {
        Self {
            source: id.source,
            symbol: id.symbol,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstrumentDto {
    pub id: InstrumentIdDto,
    pub base: String,
    pub quote: String,
    pub price_scale: u8,
    pub qty_scale: u8,
}

impl From<Instrument> for InstrumentDto {
    fn from(i: Instrument) -> Self {
        Self {
            id: i.id.into(),
            base: i.base,
            quote: i.quote,
            price_scale: i.price_scale,
            qty_scale: i.qty_scale,
        }
    }
}

/// Parallel arrays, oldest candle first.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct ColumnsDto {
    pub time: Vec<i64>,
    pub open: Vec<i64>,
    pub high: Vec<i64>,
    pub low: Vec<i64>,
    pub close: Vec<i64>,
    pub volume: Vec<i64>,
}

impl ColumnsDto {
    fn from_candles(candles: &[Candle]) -> Result<Self, DtoError> {
        let mut out = Self::default();
        for c in candles {
            out.time.push(safe(c.open_time)?);
            out.open.push(safe(c.open)?);
            out.high.push(safe(c.high)?);
            out.low.push(safe(c.low)?);
            out.close.push(safe(c.close)?);
            out.volume.push(safe(c.volume)?);
        }
        Ok(out)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandlesDto {
    pub instrument: InstrumentDto,
    #[serde(flatten)]
    pub columns: ColumnsDto,
    pub at_history_start: bool,
    pub warning: Option<String>,
}

pub fn to_candles_dto(page: ChartPage) -> Result<CandlesDto, DtoError> {
    Ok(CandlesDto {
        columns: ColumnsDto::from_candles(&page.candles)?,
        instrument: page.instrument.into(),
        at_history_start: page.at_history_start,
        warning: page.warning,
    })
}

/// Payload of the `live:{id}` events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LiveDto {
    Candle {
        time: i64,
        open: i64,
        high: i64,
        low: i64,
        close: i64,
        volume: i64,
        closed: bool,
    },
    Backfilled {
        candles: ColumnsDto,
    },
    Disconnected,
}

pub fn to_live_dto(event: LiveEvent) -> Result<LiveDto, DtoError> {
    Ok(match event {
        LiveEvent::Candle(live) => {
            let c = live.candle;
            LiveDto::Candle {
                time: safe(c.open_time)?,
                open: safe(c.open)?,
                high: safe(c.high)?,
                low: safe(c.low)?,
                close: safe(c.close)?,
                volume: safe(c.volume)?,
                closed: live.closed,
            }
        }
        LiveEvent::Backfilled(candles) => LiveDto::Backfilled {
            candles: ColumnsDto::from_candles(&candles)?,
        },
        LiveEvent::Disconnected => LiveDto::Disconnected,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayChangeDto {
    pub id: InstrumentIdDto,
    pub last: i64,
    pub change_bp: i32,
}

pub fn to_day_change_dto(d: DayChange) -> Result<DayChangeDto, DtoError> {
    Ok(DayChangeDto {
        id: d.id.into(),
        last: safe(d.last)?,
        change_bp: d.change_bp,
    })
}

/// Payload of the `connection` event.
pub fn connection_name(state: ConnectionState) -> &'static str {
    match state {
        ConnectionState::Connected => "connected",
        ConnectionState::Reconnecting => "reconnecting",
        ConnectionState::Offline => "offline",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sandchart_core::{Candle, Instrument, InstrumentId, JS_SAFE_MAX};
    use sandchart_engine::ChartPage;

    fn page(candles: Vec<Candle>) -> ChartPage {
        ChartPage {
            instrument: Instrument {
                id: InstrumentId {
                    source: "binance".into(),
                    symbol: "BTCUSDT".into(),
                },
                base: "BTC".into(),
                quote: "USDT".into(),
                price_scale: 2,
                qty_scale: 5,
            },
            candles,
            at_history_start: false,
            warning: None,
        }
    }

    fn candle(i: i64, close: i64) -> Candle {
        Candle {
            open_time: 1_700_000_000_000 + i * 60_000,
            open: 100 + i,
            high: 120 + i,
            low: 90 + i,
            close,
            volume: 5 + i,
        }
    }

    #[test]
    fn dto_is_columnar() {
        let dto = to_candles_dto(page((0..3).map(|i| candle(i, 110 + i)).collect())).unwrap();
        assert_eq!(dto.columns.time.len(), 3);
        assert_eq!(dto.columns.open, [100, 101, 102]);
        assert_eq!(dto.columns.high.len(), 3);
        assert_eq!(dto.columns.low.len(), 3);
        assert_eq!(dto.columns.close, [110, 111, 112]);
        assert_eq!(dto.columns.volume.len(), 3);

        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["time"].as_array().unwrap().len(), 3);
        assert_eq!(json["atHistoryStart"], false);
        assert_eq!(json["instrument"]["priceScale"], 2);
    }

    #[test]
    fn dto_rejects_unsafe_ticks() {
        let err = to_candles_dto(page(vec![candle(0, JS_SAFE_MAX + 1)])).unwrap_err();
        assert!(matches!(err, DtoError::UnsafeTicks));
        let err = to_candles_dto(page(vec![candle(0, -JS_SAFE_MAX - 1)])).unwrap_err();
        assert!(matches!(err, DtoError::UnsafeTicks));
        assert!(to_candles_dto(page(vec![candle(0, JS_SAFE_MAX)])).is_ok());
    }
}
