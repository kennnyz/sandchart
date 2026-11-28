//! Wire types of the Tauri commands and events. JSON is camelCase; candles are columnar
//! so a 200 000-candle history is six flat arrays, not 200 000 objects.

use sandchart_core::replay::{Command, Stats, Trade};
use sandchart_core::{
    Candle, Drawing, DrawingBody, Instrument, InstrumentId, JS_SAFE_MAX, Outcome, PositionBody,
    Style,
};
use sandchart_data::{DayChange, ProviderError};
use sandchart_engine::{
    ChartPage, Computed, ConnectionState, EngineError, FailedIndicator, IndicatorInfo,
    IndicatorList, Inspection, Instance, InstanceResult, LiveEvent, ReplayState,
};
use sandchart_indicators::{
    Marker, Meta, ParamKind, ParamSpec, ParamValue, SeriesData, SeriesOut, SeriesSpec,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

// Indicators. The host types serialize `ParamKind` as `{ int: { min, max } }`; the UI
// wants `{ int: [min, max] }`, so params get their own DTOs. Everything else reuses the
// host's JSON (single-word field names, snake_case enums).

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamKindDto {
    Int((i64, i64)),
    Float((f64, f64)),
    Boolean,
    Choice(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParamSpecDto {
    pub id: String,
    pub label: String,
    pub kind: ParamKindDto,
    pub default: ParamValue,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MetaDto {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub params: Vec<ParamSpecDto>,
    pub series: Vec<SeriesSpec>,
}

impl From<ParamSpec> for ParamSpecDto {
    fn from(p: ParamSpec) -> Self {
        let kind = match p.kind {
            ParamKind::Int { min, max } => ParamKindDto::Int((min, max)),
            ParamKind::Float { min, max } => ParamKindDto::Float((min, max)),
            ParamKind::Boolean => ParamKindDto::Boolean,
            ParamKind::Choice(options) => ParamKindDto::Choice(options),
        };
        Self {
            id: p.id,
            label: p.label,
            kind,
            default: p.default,
        }
    }
}

impl From<Meta> for MetaDto {
    fn from(m: Meta) -> Self {
        Self {
            id: m.id,
            name: m.name,
            version: m.version,
            description: m.description,
            params: m.params.into_iter().map(Into::into).collect(),
            series: m.series,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorInfoDto {
    pub meta: MetaDto,
    pub builtin: bool,
    pub repaints: bool,
}

impl From<IndicatorInfo> for IndicatorInfoDto {
    fn from(i: IndicatorInfo) -> Self {
        Self {
            meta: i.meta.into(),
            builtin: i.builtin,
            repaints: i.repaints,
        }
    }
}

/// A module that could not be loaded; the host type's JSON already fits the UI.
pub type FailedIndicatorDto = FailedIndicator;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndicatorListDto {
    pub indicators: Vec<IndicatorInfoDto>,
    pub failed: Vec<FailedIndicatorDto>,
    /// Why the indicator service could not do its work, shown in the dialog.
    pub error: Option<String>,
}

impl From<IndicatorList> for IndicatorListDto {
    fn from(l: IndicatorList) -> Self {
        Self {
            indicators: l.indicators.into_iter().map(Into::into).collect(),
            failed: l.failed,
            error: l.error,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionDto {
    pub meta: MetaDto,
    pub replaces: Option<String>,
}

impl From<Inspection> for InspectionDto {
    fn from(i: Inspection) -> Self {
        Self {
            meta: i.meta.into(),
            replaces: i.replaces,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceDto {
    pub instance: String,
    pub module_id: String,
    pub params: Vec<(String, ParamValue)>,
    pub colors: HashMap<String, u8>,
    pub hidden: bool,
}

impl From<Instance> for InstanceDto {
    fn from(i: Instance) -> Self {
        Self {
            instance: i.instance,
            module_id: i.module_id,
            params: i.params,
            colors: i.colors,
            hidden: i.hidden,
        }
    }
}

impl From<InstanceDto> for Instance {
    fn from(i: InstanceDto) -> Self {
        Self {
            instance: i.instance,
            module_id: i.module_id,
            params: i.params,
            colors: i.colors,
            hidden: i.hidden,
        }
    }
}

/// Values use `null` for a gap: JSON has no NaN. The UI turns `null` back into NaN.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SeriesDataDto {
    Values(Vec<Option<f64>>),
    Markers(Vec<Marker>),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SeriesOutDto {
    pub id: String,
    pub data: SeriesDataDto,
}

impl From<SeriesOut> for SeriesOutDto {
    fn from(s: SeriesOut) -> Self {
        let data = match s.data {
            SeriesData::Values(v) => {
                SeriesDataDto::Values(v.into_iter().map(|x| x.is_finite().then_some(x)).collect())
            }
            SeriesData::Markers(m) => SeriesDataDto::Markers(m),
        };
        Self { id: s.id, data }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedDto {
    pub first_time: i64,
    pub last_time: i64,
    pub series: Vec<SeriesOutDto>,
    pub log: String,
}

impl From<Computed> for ComputedDto {
    fn from(c: Computed) -> Self {
        Self {
            first_time: c.first_time,
            last_time: c.last_time,
            series: c.series.into_iter().map(Into::into).collect(),
            log: c.log,
        }
    }
}

/// `{ ok: ... }` or `{ err: "..." }`; serde's own `Result` shape is `Ok`/`Err`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputeOutcomeDto {
    Ok(ComputedDto),
    Err(String),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstanceResultDto {
    pub instance: String,
    pub result: ComputeOutcomeDto,
}

impl From<InstanceResult> for InstanceResultDto {
    fn from(r: InstanceResult) -> Self {
        Self {
            instance: r.instance,
            result: match r.result {
                Ok(c) => ComputeOutcomeDto::Ok(c.into()),
                Err(e) => ComputeOutcomeDto::Err(e),
            },
        }
    }
}

// Drawings. The body, style, position and outcome JSON comes from core (camelCase fields,
// snake_case kinds); see `sandchart_core::drawing`.

/// A stored drawing, as the UI gets it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawingDto {
    pub id: String,
    pub instrument: InstrumentIdDto,
    pub price_scale: u8,
    pub body: DrawingBody,
    pub style: Style,
    pub locked: bool,
    pub z: i64,
    pub updated_at: i64,
}

impl From<Drawing> for DrawingDto {
    fn from(d: Drawing) -> Self {
        Self {
            id: d.id,
            instrument: d.instrument.into(),
            price_scale: d.price_scale,
            body: d.body,
            style: d.style,
            locked: d.locked,
            z: d.z,
            updated_at: d.updated_at,
        }
    }
}

/// A drawing to save, its prices in ticks at `price_scale` (the scale the UI got it at;
/// the engine rescales to the instrument's current one). The engine sets the update time.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawingInputDto {
    pub id: String,
    pub instrument: InstrumentIdDto,
    pub price_scale: u8,
    pub body: DrawingBody,
    pub style: Style,
    pub locked: bool,
    pub z: i64,
}

impl From<DrawingInputDto> for Drawing {
    fn from(d: DrawingInputDto) -> Self {
        Self {
            id: d.id,
            instrument: d.instrument.into(),
            price_scale: d.price_scale,
            body: d.body,
            style: d.style,
            locked: d.locked,
            z: d.z,
            updated_at: 0,
        }
    }
}

/// A position drawing to resolve, by its drawing id.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PositionInputDto {
    pub id: String,
    pub position: PositionBody,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PositionOutcomeDto {
    pub id: String,
    pub outcome: Outcome,
}

// Replay.

/// The replay session as the UI sees it: the revealed bars from index `from` on (never a
/// bar after `current`), the commands so far, and the trades and statistics from Rust.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStateDto {
    pub instrument: InstrumentDto,
    pub tf: &'static str,
    pub start: u32,
    pub current: u32,
    pub at_end: bool,
    pub from: u32,
    pub bars: ColumnsDto,
    pub commands: Vec<Command>,
    pub trades: Vec<Trade>,
    pub stats: Stats,
}

pub fn to_replay_state_dto(s: ReplayState) -> Result<ReplayStateDto, DtoError> {
    for t in &s.simulation.trades {
        for v in [t.entry_time, t.entry_price, t.initial_stop, t.stop, t.take]
            .into_iter()
            .chain(t.exit_time)
            .chain(t.exit_price)
        {
            safe(v)?;
        }
    }
    Ok(ReplayStateDto {
        bars: ColumnsDto::from_candles(&s.bars)?,
        instrument: s.instrument.into(),
        tf: s.tf.code(),
        start: s.start,
        current: s.current,
        at_end: s.at_end,
        from: s.from,
        commands: s.commands,
        trades: s.simulation.trades,
        stats: s.simulation.stats,
    })
}

// Updates.

/// Why this copy cannot update itself in place; the UI shows a link to the release instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallBlocker {
    /// Linux, but not run as an AppImage (a `.deb` install): the manifest only has the AppImage.
    #[serde(rename = "not_appimage")]
    NotAppImage,
    /// macOS runs the app from a read-only place (App Translocation or a mounted DMG).
    Translocated,
}

/// An update newer than the running version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoDto {
    pub version: String,
    /// Release notes; empty when the manifest has none.
    pub notes: String,
    /// Publish date, RFC 3339.
    pub date: Option<String>,
    pub blocker: Option<InstallBlocker>,
}

/// Messages of the `install_update` channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateProgressDto {
    /// Sent once, when the download starts; `total` is the size in bytes if the server told it.
    Started { total: Option<u64> },
    /// Bytes downloaded so far.
    Chunk { downloaded: u64 },
    /// The download finished; the signature check and the install run now. Either can still
    /// fail, so an error may come after this message.
    Installing,
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

    #[test]
    fn computed_values_map_nan_to_null_and_errors_to_err() {
        use sandchart_engine::{Computed, InstanceResult};
        use sandchart_indicators::{SeriesData, SeriesOut};
        let ok = InstanceResult {
            instance: "a".into(),
            result: Ok(Computed {
                first_time: 10,
                last_time: 30,
                series: vec![SeriesOut {
                    id: "sma".into(),
                    data: SeriesData::Values(vec![f64::NAN, 1.5, f64::INFINITY]),
                }],
                log: String::new(),
            }),
        };
        let json = serde_json::to_value(InstanceResultDto::from(ok)).unwrap();
        assert_eq!(json["instance"], "a");
        assert_eq!(json["result"]["ok"]["firstTime"], 10);
        let values = &json["result"]["ok"]["series"][0]["data"]["values"];
        assert_eq!(values, &serde_json::json!([null, 1.5, null]));

        let err = InstanceResult {
            instance: "b".into(),
            result: Err("out of fuel".into()),
        };
        let json = serde_json::to_value(InstanceResultDto::from(err)).unwrap();
        assert_eq!(json["result"], serde_json::json!({ "err": "out of fuel" }));
    }

    #[test]
    fn meta_json_matches_the_ui_types() {
        use sandchart_indicators::{Meta, ParamKind, ParamSpec, ParamValue, SeriesSpec};
        use sandchart_indicators::{Pane, SeriesKind};
        let meta = Meta {
            id: "builtin.x".into(),
            name: "X".into(),
            version: "0.2.0".into(),
            description: "d".into(),
            params: vec![
                ParamSpec {
                    id: "n".into(),
                    label: "N".into(),
                    kind: ParamKind::Int { min: 1, max: 9 },
                    default: ParamValue::Int(3),
                },
                ParamSpec {
                    id: "m".into(),
                    label: "M".into(),
                    kind: ParamKind::Float { min: 0.5, max: 2.0 },
                    default: ParamValue::Float(1.0),
                },
                ParamSpec {
                    id: "s".into(),
                    label: "S".into(),
                    kind: ParamKind::Choice(vec!["close".into(), "open".into()]),
                    default: ParamValue::Choice("close".into()),
                },
            ],
            series: vec![SeriesSpec {
                id: "f".into(),
                label: "F".into(),
                kind: SeriesKind::Band("a".into(), "b".into()),
                pane: Pane::Own,
                color: 3,
            }],
        };
        let json = serde_json::to_value(MetaDto::from(meta)).unwrap();
        assert_eq!(
            json["params"][0]["kind"],
            serde_json::json!({ "int": [1, 9] })
        );
        assert_eq!(
            json["params"][0]["default"],
            serde_json::json!({ "int": 3 })
        );
        assert_eq!(
            json["params"][1]["kind"],
            serde_json::json!({ "float": [0.5, 2.0] })
        );
        assert_eq!(
            json["params"][2]["kind"],
            serde_json::json!({ "choice": ["close", "open"] })
        );
        assert_eq!(
            json["series"][0]["kind"],
            serde_json::json!({ "band": ["a", "b"] })
        );
        assert_eq!(json["series"][0]["pane"], "own");
    }

    #[test]
    fn instance_dto_is_camel_case_and_round_trips() {
        let json = serde_json::json!({
            "instance": "i1", "moduleId": "builtin.sma",
            "params": [["period", { "int": 20 }]],
            "colors": { "sma": 2 }, "hidden": false
        });
        let dto: InstanceDto = serde_json::from_value(json.clone()).unwrap();
        let inst = sandchart_engine::Instance::from(dto);
        assert_eq!(inst.module_id, "builtin.sma");
        assert_eq!(serde_json::to_value(InstanceDto::from(inst)).unwrap(), json);
    }

    #[test]
    fn indicator_list_carries_failed_modules_and_the_service_error() {
        use sandchart_engine::{FailedIndicator, IndicatorList};
        let list = IndicatorList {
            indicators: vec![],
            failed: vec![FailedIndicator {
                id: "me.x".into(),
                builtin: false,
                error: "not an indicator component".into(),
            }],
            error: Some("cannot read the installed indicators".into()),
        };
        let json = serde_json::to_value(IndicatorListDto::from(list)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "indicators": [],
                "failed": [{ "id": "me.x", "builtin": false, "error": "not an indicator component" }],
                "error": "cannot read the installed indicators"
            })
        );
    }

    #[test]
    fn update_info_is_camel_case_with_a_null_date_and_a_snake_case_blocker() {
        let info = UpdateInfoDto {
            version: "0.3.0".into(),
            notes: "Fixes".into(),
            date: None,
            blocker: Some(InstallBlocker::NotAppImage),
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({
                "version": "0.3.0", "notes": "Fixes", "date": null, "blocker": "not_appimage"
            })
        );
        let info = UpdateInfoDto {
            version: "0.3.0".into(),
            notes: String::new(),
            date: Some("2026-11-28T10:00:00Z".into()),
            blocker: Some(InstallBlocker::Translocated),
        };
        let json = serde_json::to_value(info).unwrap();
        assert_eq!(json["blocker"], "translocated");
        assert_eq!(json["date"], "2026-11-28T10:00:00Z");
        let info = UpdateInfoDto {
            version: "0.3.0".into(),
            notes: String::new(),
            date: None,
            blocker: None,
        };
        assert_eq!(
            serde_json::to_value(info).unwrap()["blocker"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn update_progress_is_tagged_by_kind() {
        let json = |p: UpdateProgressDto| serde_json::to_value(p).unwrap();
        assert_eq!(
            json(UpdateProgressDto::Started { total: Some(42) }),
            serde_json::json!({ "kind": "started", "total": 42 })
        );
        assert_eq!(
            json(UpdateProgressDto::Started { total: None }),
            serde_json::json!({ "kind": "started", "total": null })
        );
        assert_eq!(
            json(UpdateProgressDto::Chunk { downloaded: 7 }),
            serde_json::json!({ "kind": "chunk", "downloaded": 7 })
        );
        assert_eq!(
            json(UpdateProgressDto::Installing),
            serde_json::json!({ "kind": "installing" })
        );
    }

    #[test]
    fn drawing_dtos_are_camel_case_and_round_trip() {
        let input = serde_json::json!({
            "id": "d1",
            "instrument": { "source": "binance", "symbol": "BTCUSDT" },
            "priceScale": 2,
            "body": {
                "kind": "position", "side": "long", "entry": { "t": 10, "p": 100 },
                "stop": 90, "take": 120, "endT": 20
            },
            "style": { "color": 2, "width": 1, "dash": true },
            "locked": false, "z": 3
        });
        let dto: DrawingInputDto = serde_json::from_value(input.clone()).unwrap();
        let mut d = Drawing::from(dto);
        assert_eq!(d.instrument.symbol, "BTCUSDT");
        assert!(matches!(d.body, DrawingBody::Position(p) if p.end_t == 20));
        assert_eq!(d.price_scale, 2);
        d.updated_at = 1_700_000_000_000;
        let out = serde_json::to_value(DrawingDto::from(d)).unwrap();
        let mut expected = input;
        expected["updatedAt"] = 1_700_000_000_000i64.into();
        assert_eq!(out, expected);

        let bad = serde_json::json!({
            "id": "d1", "instrument": { "source": "b", "symbol": "s" }, "priceScale": 2,
            "body": { "kind": "spiral" }, "style": { "color": 0, "width": 1, "dash": false },
            "locked": false, "z": 0
        });
        assert!(serde_json::from_value::<DrawingInputDto>(bad).is_err());
    }

    #[test]
    fn position_dtos_carry_the_drawing_id() {
        let input: PositionInputDto = serde_json::from_value(serde_json::json!({
            "id": "p", "position": {
                "side": "short", "entry": { "t": 1, "p": 100 }, "stop": 110, "take": 85, "endT": 9
            }
        }))
        .unwrap();
        assert_eq!(input.position.take, 85);
        let out = PositionOutcomeDto {
            id: input.id,
            outcome: Outcome {
                status: sandchart_core::Status::Stop,
                exit_time: Some(5),
                ambiguous: true,
                r: -1.0,
            },
        };
        assert_eq!(
            serde_json::to_value(out).unwrap(),
            serde_json::json!({
                "id": "p",
                "outcome": { "status": "stop", "exitTime": 5, "ambiguous": true, "r": -1.0 }
            })
        );
    }

    #[test]
    fn replay_state_json_matches_the_ui_types() {
        use sandchart_core::replay::{Simulation, simulate};
        use sandchart_core::{Side, Timeframe};
        let candles: Vec<Candle> = (0..4).map(|i| candle(i, 110 + i)).collect();
        let commands = vec![Command::Open {
            bar: 1,
            side: Side::Long,
            stop: 90,
            take: 140,
        }];
        let simulation: Simulation = simulate(&candles, 1, 3, &commands).unwrap();
        let state = ReplayState {
            instrument: page(vec![]).instrument,
            tf: Timeframe::H1,
            start: 1,
            current: 3,
            at_end: false,
            from: 3,
            bars: candles[3..].to_vec(),
            commands,
            simulation,
        };
        let json = serde_json::to_value(to_replay_state_dto(state).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "instrument": {
                    "id": { "source": "binance", "symbol": "BTCUSDT" },
                    "base": "BTC", "quote": "USDT", "priceScale": 2, "qtyScale": 5
                },
                "tf": "1h", "start": 1, "current": 3, "atEnd": false, "from": 3,
                "bars": {
                    "time": [1_700_000_180_000i64], "open": [103], "high": [123], "low": [93],
                    "close": [113], "volume": [8]
                },
                "commands": [{ "kind": "open", "bar": 1, "side": "long", "stop": 90, "take": 140 }],
                "trades": [{
                    "side": "long", "entryBar": 1, "entryTime": 1_700_000_060_000i64,
                    "entryPrice": 111, "initialStop": 90, "stop": 90, "take": 140,
                    "exitBar": null, "exitTime": null, "exitPrice": null, "reason": "open",
                    "ambiguous": false, "r": 2.0 / 21.0
                }],
                "stats": {
                    "count": 0, "wins": 0, "losses": 0, "winRate": 0.0, "totalR": 0.0,
                    "averageR": 0.0, "profitFactor": null,
                    "maxDrawdownR": 0.0, "longestLosingStreak": 0
                }
            })
        );
    }

    #[test]
    fn indicator_errors_are_problems_with_their_message() {
        let p = ProblemDto::from(EngineError::Indicator("module is too big".into()));
        assert_eq!(p.code, ProblemCode::Other);
        assert!(p.message.contains("module is too big"));
    }
}
