//! REST calls: exchange info, klines and 24 h tickers.

use std::collections::HashMap;

use reqwest::{Response, StatusCode, header::RETRY_AFTER};
use sandchart_core::{Candle, Instrument, Timeframe};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{
    Binance,
    wire::{ExchangeInfo, Ticker24h, parse_kline},
};
use crate::{DayChange, ProviderError};

const DEFAULT_RETRY_AFTER_S: u64 = 60;
const MAX_KLINES: u16 = 1000;
const MAX_ERROR_BODY: usize = 512;

impl Binance {
    pub(super) async fn fetch_instruments(&self) -> Result<Vec<Instrument>, ProviderError> {
        let url = self.endpoint("api/v3/exchangeInfo")?;
        let info: ExchangeInfo = self.get_json(self.http.get(url)).await?;
        Ok(info
            .symbols
            .into_iter()
            .filter_map(|s| s.into_instrument())
            .collect())
    }

    /// `limit` is clamped to Binance's maximum of 1000 candles per request.
    pub(super) async fn fetch_history(
        &self,
        inst: &Instrument,
        tf: Timeframe,
        end_before: Option<i64>,
        limit: u16,
    ) -> Result<Vec<Candle>, ProviderError> {
        let url = self.endpoint("api/v3/klines")?;
        let mut query = vec![
            ("symbol", inst.id.symbol.clone()),
            ("interval", tf.code().to_string()),
            ("limit", limit.clamp(1, MAX_KLINES).to_string()),
        ];
        if let Some(end) = end_before {
            query.push(("endTime", (end - 1).to_string()));
        }
        let rows: Vec<Vec<Value>> = self.get_json(self.http.get(url).query(&query)).await?;
        let mut candles = rows
            .iter()
            .map(|row| parse_kline(row, inst))
            .collect::<Result<Vec<_>, _>>()?;
        candles.sort_by_key(|c| c.open_time);
        Ok(candles)
    }

    pub(super) async fn fetch_day_changes(
        &self,
        insts: &[Instrument],
    ) -> Result<Vec<DayChange>, ProviderError> {
        if insts.is_empty() {
            return Ok(vec![]);
        }
        let by_symbol: HashMap<&str, &Instrument> =
            insts.iter().map(|i| (i.id.symbol.as_str(), i)).collect();
        let symbols: Vec<&str> = insts.iter().map(|i| i.id.symbol.as_str()).collect();
        let symbols =
            serde_json::to_string(&symbols).map_err(|e| ProviderError::Parse(e.to_string()))?;
        let url = self.endpoint("api/v3/ticker/24hr")?;
        let tickers: Vec<Ticker24h> = self
            .get_json(self.http.get(url).query(&[("symbols", symbols)]))
            .await?;
        tickers
            .into_iter()
            .filter_map(|t| {
                by_symbol
                    .get(t.symbol())
                    .map(|inst| t.into_day_change(inst))
            })
            .collect()
    }

    fn endpoint(&self, path: &str) -> Result<url::Url, ProviderError> {
        self.rest_base
            .join(path)
            .map_err(|e| ProviderError::Network(format!("bad base URL: {e}")))
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, ProviderError> {
        let response = request
            .send()
            .await
            .map_err(|e| ProviderError::Network(e.to_string()))?;
        let response = check_status(response).await?;
        response
            .json::<T>()
            .await
            .map_err(|e| ProviderError::Parse(e.to_string()))
    }
}

async fn check_status(response: Response) -> Result<Response, ProviderError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    match status {
        StatusCode::TOO_MANY_REQUESTS | StatusCode::IM_A_TEAPOT => {
            let retry_after_s = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(DEFAULT_RETRY_AFTER_S);
            Err(ProviderError::RateLimited { retry_after_s })
        }
        StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS | StatusCode::FORBIDDEN => {
            Err(ProviderError::Blocked {
                status: status.as_u16(),
            })
        }
        _ => {
            let mut body = response.text().await.unwrap_or_default();
            body.truncate(body.floor_char_boundary(MAX_ERROR_BODY));
            Err(ProviderError::Http {
                status: status.as_u16(),
                body,
            })
        }
    }
}
