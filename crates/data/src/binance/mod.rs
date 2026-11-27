//! Binance spot market data (public endpoints, no keys).

mod rest;
mod wire;

use std::time::Duration;

use async_trait::async_trait;
use futures::{StreamExt, stream::BoxStream};
use sandchart_core::{Candle, Instrument, Timeframe};
use url::Url;

use crate::{DayChange, LiveCandle, Provider, ProviderError};

const SOURCE: &str = "binance";
const REST_BASE: &str = "https://data-api.binance.vision";
const WS_BASE: &str = "wss://data-stream.binance.vision";
const TIMEOUT: Duration = Duration::from_secs(10);

pub struct Binance {
    rest_base: Url,
    #[expect(dead_code, reason = "used by the WebSocket stream in the next task")]
    ws_base: Url,
    http: reqwest::Client,
}

impl Binance {
    pub fn new(rest_base: Url, ws_base: Url) -> Binance {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("sandchart/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("HTTP client with static configuration must build");
        Binance {
            rest_base,
            ws_base,
            http,
        }
    }

    pub fn default_hosts() -> Binance {
        Binance::new(
            Url::parse(REST_BASE).expect("static URL"),
            Url::parse(WS_BASE).expect("static URL"),
        )
    }
}

#[async_trait]
impl Provider for Binance {
    fn source(&self) -> &str {
        SOURCE
    }

    async fn instruments(&self) -> Result<Vec<Instrument>, ProviderError> {
        self.fetch_instruments().await
    }

    async fn history(
        &self,
        inst: &Instrument,
        tf: Timeframe,
        end_before: Option<i64>,
        limit: u16,
    ) -> Result<Vec<Candle>, ProviderError> {
        self.fetch_history(inst, tf, end_before, limit).await
    }

    fn live(
        &self,
        _inst: &Instrument,
        _tf: Timeframe,
    ) -> BoxStream<'static, Result<LiveCandle, ProviderError>> {
        futures::stream::once(async {
            Err(ProviderError::Network(
                "live stream not implemented yet".into(),
            ))
        })
        .boxed()
    }

    async fn day_changes(&self, insts: &[Instrument]) -> Result<Vec<DayChange>, ProviderError> {
        self.fetch_day_changes(insts).await
    }
}
