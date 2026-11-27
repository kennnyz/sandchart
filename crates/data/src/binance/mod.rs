//! Binance spot market data (public endpoints, no keys).

mod rest;
mod wire;
mod ws;

use std::time::Duration;

use async_trait::async_trait;
use futures::stream::BoxStream;
use sandchart_core::{Candle, Instrument, Timeframe};
use url::Url;

use crate::{DayChange, LiveCandle, Provider, ProviderError};

const SOURCE: &str = "binance";
const REST_BASE: &str = "https://data-api.binance.vision";
const WS_BASE: &str = "wss://data-stream.binance.vision";
const TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_INITIAL: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);

pub struct Binance {
    rest_base: Url,
    ws_base: Url,
    http: reqwest::Client,
    backoff: ws::Backoff,
    idle: Duration,
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
            backoff: ws::Backoff::new(RECONNECT_INITIAL, RECONNECT_MAX),
            idle: ws::IDLE_TIMEOUT,
        }
    }

    /// Override the live-stream reconnect delays (default 1 s up to 30 s).
    pub fn with_reconnect_backoff(mut self, initial: Duration, max: Duration) -> Binance {
        self.backoff = ws::Backoff::new(initial, max);
        self
    }

    /// Override how long the live stream may stay silent before it is
    /// treated as dropped (default 60 s).
    pub fn with_idle_timeout(mut self, idle: Duration) -> Binance {
        self.idle = idle;
        self
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
        inst: &Instrument,
        tf: Timeframe,
    ) -> BoxStream<'static, Result<LiveCandle, ProviderError>> {
        self.live_stream(inst, tf)
    }

    async fn day_changes(&self, insts: &[Instrument]) -> Result<Vec<DayChange>, ProviderError> {
        self.fetch_day_changes(insts).await
    }
}
