//! Binance JSON shapes and their conversion into core types.

use sandchart_core::{
    Candle, Instrument, InstrumentId, parse_scaled, parse_scaled_rounded, scale_from_step,
};
use serde::Deserialize;
use serde_json::Value;

use crate::{DayChange, LiveCandle, ProviderError};

use super::SOURCE;

#[derive(Deserialize)]
pub struct ExchangeInfo {
    pub symbols: Vec<SymbolInfo>,
}

#[derive(Deserialize)]
pub struct SymbolInfo {
    symbol: String,
    status: String,
    #[serde(rename = "baseAsset")]
    base_asset: String,
    #[serde(rename = "quoteAsset")]
    quote_asset: String,
    #[serde(rename = "isSpotTradingAllowed")]
    is_spot_trading_allowed: bool,
    filters: Vec<Value>,
}

impl SymbolInfo {
    /// `None` for symbols that are not tradable on spot, or whose filters
    /// are missing or unusable; one odd symbol must not hide all the others.
    pub fn into_instrument(self) -> Option<Instrument> {
        if self.status != "TRADING" || !self.is_spot_trading_allowed {
            return None;
        }
        let step = |filter: &str, key: &str| -> Option<u8> {
            let f = self
                .filters
                .iter()
                .find(|f| f.get("filterType").and_then(Value::as_str) == Some(filter))?;
            scale_from_step(f.get(key)?.as_str()?).ok()
        };
        let price_scale = step("PRICE_FILTER", "tickSize")?;
        let qty_scale = step("LOT_SIZE", "stepSize")?;
        Some(Instrument {
            id: InstrumentId {
                source: SOURCE.into(),
                symbol: self.symbol,
            },
            base: self.base_asset,
            quote: self.quote_asset,
            price_scale,
            qty_scale,
        })
    }
}

fn parse_err(what: &str) -> ProviderError {
    ProviderError::Parse(what.to_string())
}

/// One kline row: `[openTime, open, high, low, close, volume, ...]`.
pub fn parse_kline(row: &[Value], inst: &Instrument) -> Result<Candle, ProviderError> {
    let price = |i: usize| -> Result<i64, ProviderError> {
        let s = row
            .get(i)
            .and_then(Value::as_str)
            .ok_or_else(|| parse_err("kline field"))?;
        parse_scaled_rounded(s, inst.price_scale)
            .map_err(|e| ProviderError::Parse(format!("kline price: {e}")))
    };
    let volume = row
        .get(5)
        .and_then(Value::as_str)
        .ok_or_else(|| parse_err("kline volume"))?;
    Ok(Candle {
        open_time: row
            .first()
            .and_then(Value::as_i64)
            .ok_or_else(|| parse_err("kline open time"))?,
        open: price(1)?,
        high: price(2)?,
        low: price(3)?,
        close: price(4)?,
        volume: parse_scaled_rounded(volume, inst.qty_scale)
            .map_err(|e| ProviderError::Parse(format!("kline volume: {e}")))?,
    })
}

/// A WebSocket message; only kline events carry a `k` object.
#[derive(Deserialize)]
pub struct WsEvent {
    k: Option<WsKline>,
}

#[derive(Deserialize)]
struct WsKline {
    t: i64,
    o: String,
    h: String,
    l: String,
    c: String,
    v: String,
    x: bool,
}

impl WsEvent {
    /// `Ok(None)` for messages that are not klines.
    pub fn parse(text: &str, inst: &Instrument) -> Result<Option<LiveCandle>, ProviderError> {
        let event: WsEvent = serde_json::from_str(text)
            .map_err(|e| ProviderError::Parse(format!("live message: {e}")))?;
        let Some(k) = event.k else {
            return Ok(None);
        };
        let price = |s: &str| {
            parse_scaled_rounded(s, inst.price_scale)
                .map_err(|e| ProviderError::Parse(format!("live kline price: {e}")))
        };
        Ok(Some(LiveCandle {
            candle: Candle {
                open_time: k.t,
                open: price(&k.o)?,
                high: price(&k.h)?,
                low: price(&k.l)?,
                close: price(&k.c)?,
                volume: parse_scaled_rounded(&k.v, inst.qty_scale)
                    .map_err(|e| ProviderError::Parse(format!("live kline volume: {e}")))?,
            },
            closed: k.x,
        }))
    }
}

#[derive(Deserialize)]
pub struct Ticker24h {
    symbol: String,
    #[serde(rename = "lastPrice")]
    last_price: String,
    #[serde(rename = "priceChangePercent")]
    price_change_percent: String,
}

impl Ticker24h {
    pub fn symbol(&self) -> &str {
        &self.symbol
    }

    pub fn into_day_change(self, inst: &Instrument) -> Result<DayChange, ProviderError> {
        let last = parse_scaled_rounded(&self.last_price, inst.price_scale)
            .map_err(|e| ProviderError::Parse(format!("lastPrice: {e}")))?;
        Ok(DayChange {
            id: inst.id.clone(),
            last,
            change_bp: percent_to_bp(&self.price_change_percent)?,
        })
    }
}

/// Percent string to basis points (`"1.840"` is `184`), rounding half away
/// from zero at two decimals. No floats.
pub fn percent_to_bp(s: &str) -> Result<i32, ProviderError> {
    let bad = || ProviderError::Parse(format!("priceChangePercent {s:?}"));
    let (negative, unsigned) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let (int, frac) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    if !int.bytes().chain(frac.bytes()).all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    let cut = frac.len().min(2);
    let truncated = format!("{int}.{}", &frac[..cut]);
    let mut magnitude = parse_scaled(&truncated, 2).map_err(|_| bad())?;
    if frac.as_bytes().get(2).is_some_and(|&d| d >= b'5') {
        magnitude += 1;
    }
    let bp = if negative { -magnitude } else { magnitude };
    i32::try_from(bp).map_err(|_| bad())
}

#[cfg(test)]
mod tests {
    use super::percent_to_bp;

    #[test]
    fn percent_to_basis_points() {
        let cases = [
            ("1.840", 184),
            ("1.84", 184),
            ("1.8", 180),
            ("2", 200),
            ("0.00", 0),
            ("-0.00", 0),
            ("1.845", 185),
            ("1.844", 184),
            ("-1.845", -185),
            ("-2.345", -235),
            ("-2.344", -234),
            ("+0.005", 1),
            ("0.004", 0),
            ("12.3456", 1235),
        ];
        for (input, want) in cases {
            assert_eq!(percent_to_bp(input), Ok(want), "{input}");
        }
    }

    #[test]
    fn percent_rejects_garbage() {
        for input in ["", ".", "abc", "1.x", "1.8e1", "--1", "99999999999999"] {
            assert!(percent_to_bp(input).is_err(), "{input}");
        }
    }
}
