//! Wire types of the Tauri commands and events. JSON is camelCase; candles are columnar
//! so a 200 000-candle history is six flat arrays, not 200 000 objects.

use sandchart_core::{Candle, Instrument, InstrumentId, JS_SAFE_MAX};
use sandchart_data::{DayChange, ProviderError};
use sandchart_engine::{ChartPage, ConnectionState, EngineError, LiveEvent};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum DtoError {
    #[error("a price or volume is too large for the UI (beyond 2^53 - 1 ticks)")]
    UnsafeTicks,
}

/// What kind of trouble a command hit; the UI picks its banner text by it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProblemCode {
    Network,
    RateLimited,
    Blocked,
    UnsafeTicks,
    Other,
}

/// The error of every command and the warning of a candle page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemDto {
    pub code: ProblemCode,
    /// The raw error text, for a tooltip or the log.
    pub message: String,
    /// Set when the exchange said how long to wait (`Retry-After`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_s: Option<u64>,
}

impl ProblemDto {
    pub fn other(message: impl std::fmt::Display) -> Self {
        Self {
            code: ProblemCode::Other,
            message: message.to_string(),
            retry_after_s: None,
        }
    }
}

impl From<&ProviderError> for ProblemDto {
    fn from(e: &ProviderError) -> Self {
        let (code, retry_after_s) = match e {
            ProviderError::Network(_) => (ProblemCode::Network, None),
            ProviderError::RateLimited { retry_after_s } => {
                (ProblemCode::RateLimited, Some(*retry_after_s))
            }
            ProviderError::Blocked { .. } => (ProblemCode::Blocked, None),
            ProviderError::Http { .. } | ProviderError::Parse(_) => (ProblemCode::Other, None),
        };
        Self {
            code,
            message: e.to_string(),
            retry_after_s,
        }
    }
}

impl From<EngineError> for ProblemDto {
    fn from(e: EngineError) -> Self {
        match &e {
            EngineError::Provider(p) => p.into(),
            _ => Self::other(e),
        }
    }
}

impl From<DtoError> for ProblemDto {
    fn from(e: DtoError) -> Self {
        Self {
            code: ProblemCode::UnsafeTicks,
            message: e.to_string(),
            retry_after_s: None,
        }
    }
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
    pub warning: Option<ProblemDto>,
}

pub fn to_candles_dto(page: ChartPage) -> Result<CandlesDto, DtoError> {
    Ok(CandlesDto {
        columns: ColumnsDto::from_candles(&page.candles)?,
        instrument: page.instrument.into(),
        at_history_start: page.at_history_start,
        warning: page.warning.as_ref().map(ProblemDto::from),
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
        /// The cached series was replaced: the chart starts over from these candles.
        reset: bool,
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
        LiveEvent::Backfilled { candles, reset } => LiveDto::Backfilled {
            candles: ColumnsDto::from_candles(&candles)?,
            reset,
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
        ConnectionState::Connecting => "connecting",
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
    fn problems_carry_a_code_and_the_retry_hint() {
        let json = |e: &ProviderError| serde_json::to_value(ProblemDto::from(e)).unwrap();
        let limited = json(&ProviderError::RateLimited { retry_after_s: 90 });
        assert_eq!(limited["code"], "rate_limited");
        assert_eq!(limited["retryAfterS"], 90);
        assert!(limited["message"].as_str().unwrap().contains("90"));
        let net = json(&ProviderError::Network("down".into()));
        assert_eq!(net["code"], "network");
        assert!(net.get("retryAfterS").is_none());
        assert_eq!(
            json(&ProviderError::Blocked { status: 451 })["code"],
            "blocked"
        );
        assert_eq!(json(&ProviderError::Parse("x".into()))["code"], "other");

        let engine = ProblemDto::from(EngineError::Provider(ProviderError::Blocked {
            status: 403,
        }));
        assert_eq!(engine.code, ProblemCode::Blocked);
        let unknown = ProblemDto::from(EngineError::UnknownSource("csv".into()));
        assert_eq!(unknown.code, ProblemCode::Other);
        assert_eq!(
            ProblemDto::from(DtoError::UnsafeTicks).code,
            ProblemCode::UnsafeTicks
        );
    }

    #[test]
    fn page_warning_is_a_problem() {
        let mut p = page(vec![candle(0, 1)]);
        p.warning = Some(ProviderError::RateLimited { retry_after_s: 5 });
        let json = serde_json::to_value(to_candles_dto(p).unwrap()).unwrap();
        assert_eq!(json["warning"]["code"], "rate_limited");
        assert_eq!(json["warning"]["retryAfterS"], 5);
    }

    #[test]
    fn backfilled_carries_the_reset_flag() {
        let dto = to_live_dto(LiveEvent::Backfilled {
            candles: vec![candle(0, 1)],
            reset: true,
        })
        .unwrap();
        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["kind"], "backfilled");
        assert_eq!(json["reset"], true);
        assert_eq!(json["candles"]["time"].as_array().unwrap().len(), 1);
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
