//! Tool inputs (with their JSON schemas) and the JSON the tools return.
//!
//! Inputs are camelCase like the app's IPC and the core types they embed, and refuse
//! unknown fields, so a misspelt optional field is an error instead of a silent default.
//! Prices go in as integer ticks at a stated `priceScale`, which must be the pair's; outputs
//! give ticks and, next to each, a decimal string (`price` and `priceDecimal`).

use sandchart_core::alert::{Alert, AlertKind, Direction};
use sandchart_core::replay::Trade;
use sandchart_core::{
    Candle, Drawing, DrawingBody, Instrument, PositionBody, Style, format_scaled,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// The only market-data source with a provider.
pub const BINANCE: &str = "binance";

fn binance() -> String {
    BINANCE.to_owned()
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchInput {
    /// Part of a symbol, e.g. "BTC" or "ethusdt"; case does not matter.
    pub query: String,
    /// Most results, 1 to 50; default 20.
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CandlesInput {
    /// Data source; default "binance".
    #[serde(default = "binance")]
    pub source: String,
    /// Symbol, e.g. "BTCUSDT".
    pub symbol: String,
    /// One of 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M.
    pub timeframe: String,
    /// Candles to return, 1 to 5000; default 500.
    pub limit: Option<u32>,
    /// Only candles that open before this time (Unix ms); default: up to now.
    pub before: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndicatorInput {
    /// Indicator id from list_indicators, e.g. "builtin.sma".
    pub id: String,
    /// Parameter values by parameter id, e.g. {"period": 50}; missing ones take their default.
    pub params: Option<Map<String, Value>>,
    /// Data source; default "binance".
    #[serde(default = "binance")]
    pub source: String,
    /// Symbol, e.g. "BTCUSDT".
    pub symbol: String,
    /// One of 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M.
    pub timeframe: String,
    /// Values to return (the newest bars), 1 to 5000; default 200.
    pub last_n: Option<u32>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairInput {
    /// Data source; default "binance".
    #[serde(default = "binance")]
    pub source: String,
    /// Symbol, e.g. "BTCUSDT".
    pub symbol: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrawingInput {
    /// 1 to 64 characters from A-Z a-z 0-9 _ -. An existing id replaces that drawing;
    /// leave it out for a new one.
    pub id: Option<String>,
    /// Data source; default "binance".
    #[serde(default = "binance")]
    pub source: String,
    /// Symbol, e.g. "BTCUSDT".
    pub symbol: String,
    /// Decimal places of the prices in `body`: the pair's priceScale from search_instruments.
    pub price_scale: u8,
    /// The shape. Prices `p`, `stop`, `take` are integer ticks; times `t`, `endT` are Unix ms.
    pub body: DrawingBody,
    /// Colour slot 0-7, width 1-4, dashed; default {"color":0,"width":1,"dash":false}.
    pub style: Option<Style>,
    /// Locked against editing in the app; when left out, kept on an update, else false.
    pub locked: Option<bool>,
    /// Hidden on the chart until the user shows it again; when left out, kept on an update, else false.
    pub hidden: Option<bool>,
    /// Paint order, higher on top; default 0.
    pub z: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdInput {
    /// The id of the drawing or alert, as list_drawings or list_alerts return it.
    pub id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PositionInput {
    /// Data source; default "binance".
    #[serde(default = "binance")]
    pub source: String,
    /// Symbol, e.g. "BTCUSDT".
    pub symbol: String,
    /// One of 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M.
    pub timeframe: String,
    /// Decimal places of the prices in `position`: the pair's priceScale.
    pub price_scale: u8,
    /// Entry {t: Unix ms, p: ticks}, stop and take in ticks at the pair's priceScale, and
    /// endT (Unix ms) after which it is no longer checked.
    pub position: PositionBody,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayInput {
    /// Absolute path of a .replay file the user named.
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlertInput {
    /// 1 to 64 characters from A-Z a-z 0-9 _ -. An existing id replaces that alert; leave
    /// it out for a new one.
    pub id: Option<String>,
    /// Data source; default "binance".
    #[serde(default = "binance")]
    pub source: String,
    /// Symbol, e.g. "BTCUSDT".
    pub symbol: String,
    /// Decimal places of `kind.price`: the pair's priceScale. Needed for a price alert only.
    pub price_scale: Option<u8>,
    /// {"kind":"price","price":ticks} or {"kind":"drawing","drawingId":id} of an hline or
    /// trend drawing of the same pair.
    pub kind: AlertKind,
    /// above, below or cross (either way).
    pub direction: Direction,
}

/// Adds `<field>Decimal` next to every integer tick field of `obj` named in `fields`.
fn add_decimals(obj: &mut Value, fields: &[&str], scale: u8) {
    let Some(map) = obj.as_object_mut() else {
        return;
    };
    for f in fields {
        if let Some(v) = map.get(*f).and_then(Value::as_i64) {
            map.insert(format!("{f}Decimal"), format_scaled(v, scale).into());
        }
    }
}

pub fn instrument(i: &Instrument) -> Value {
    json!({
        "source": i.id.source,
        "symbol": i.id.symbol,
        "base": i.base,
        "quote": i.quote,
        "priceScale": i.price_scale,
        "qtyScale": i.qty_scale,
    })
}

pub fn candle(c: &Candle, i: &Instrument) -> Value {
    let (p, q) = (i.price_scale, i.qty_scale);
    json!({
        "time": c.open_time,
        "open": format_scaled(c.open, p),
        "high": format_scaled(c.high, p),
        "low": format_scaled(c.low, p),
        "close": format_scaled(c.close, p),
        "volume": format_scaled(c.volume, q),
        "ticks": [c.open, c.high, c.low, c.close, c.volume],
    })
}

/// A drawing body with `<field>Decimal` next to every price: `p`, `stop`, `take`, and `p`
/// of the points `a`, `b`, `entry` and `points`. Saving it back works: the extra fields
/// are ignored on input.
fn body(b: &DrawingBody, scale: u8) -> Value {
    let mut v = json!(b);
    add_decimals(&mut v, &["p", "stop", "take"], scale);
    for k in ["a", "b", "entry"] {
        if let Some(point) = v.get_mut(k) {
            add_decimals(point, &["p"], scale);
        }
    }
    if let Some(Value::Array(points)) = v.get_mut("points") {
        for point in points {
            add_decimals(point, &["p"], scale);
        }
    }
    v
}

pub fn drawing(d: &Drawing) -> Value {
    json!({
        "id": d.id,
        "source": d.instrument.source,
        "symbol": d.instrument.symbol,
        "priceScale": d.price_scale,
        "body": body(&d.body, d.price_scale),
        "style": d.style,
        "locked": d.locked,
        "hidden": d.hidden,
        "z": d.z,
        "updatedAt": d.updated_at,
    })
}

pub fn trade(t: &Trade, scale: u8) -> Value {
    let mut v = json!(t);
    add_decimals(
        &mut v,
        &["entryPrice", "initialStop", "stop", "take", "exitPrice"],
        scale,
    );
    v
}

pub fn alert(a: &Alert) -> Value {
    let mut kind = json!(a.kind);
    if matches!(a.kind, AlertKind::Price { .. }) {
        add_decimals(&mut kind, &["price"], a.price_scale);
    }
    let mut v = json!({
        "id": a.id,
        "source": a.instrument.source,
        "symbol": a.instrument.symbol,
        "priceScale": a.price_scale,
        "kind": kind,
        "direction": a.direction,
        "active": a.active,
        "createdAt": a.created_at,
        "triggeredAt": a.triggered_at,
        "triggeredPrice": a.triggered_price,
    });
    add_decimals(&mut v, &["triggeredPrice"], a.price_scale);
    v
}

/// The default style of a drawing an agent makes: slot 0, thin, solid.
pub const DEFAULT_STYLE: Style = Style {
    color: 0,
    width: 1,
    dash: false,
};
