use sandchart_core::{Instrument, InstrumentId, Timeframe, parse_scaled};
use sandchart_data::{Binance, Provider, ProviderError};
use serde_json::Value;
use url::Url;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path, query_param},
};

const EXCHANGE_INFO: &str = include_str!("fixtures/exchange_info.json");
const KLINES: &str = include_str!("fixtures/klines_btcusdt_1h.json");
const TICKER: &str = include_str!("fixtures/ticker_24hr.json");

fn provider(server: &MockServer) -> Binance {
    let base = Url::parse(&server.uri()).unwrap();
    Binance::new(base, Url::parse("ws://127.0.0.1:1").unwrap())
}

fn instrument(symbol: &str, price_scale: u8, qty_scale: u8) -> Instrument {
    Instrument {
        id: InstrumentId {
            source: "binance".into(),
            symbol: symbol.into(),
        },
        base: symbol.trim_end_matches("USDT").into(),
        quote: "USDT".into(),
        price_scale,
        qty_scale,
    }
}

fn json(body: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_raw(body.as_bytes().to_vec(), "application/json")
}

#[tokio::test]
async fn parses_exchange_info() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/exchangeInfo"))
        .respond_with(json(EXCHANGE_INFO))
        .mount(&server)
        .await;

    let insts = provider(&server).instruments().await.unwrap();

    let symbols: Vec<_> = insts.iter().map(|i| i.id.symbol.as_str()).collect();
    assert_eq!(symbols, ["BTCUSDT", "PEPEUSDT"]);
    let btc = &insts[0];
    assert_eq!((btc.price_scale, btc.qty_scale), (2, 5));
    assert_eq!((btc.base.as_str(), btc.quote.as_str()), ("BTC", "USDT"));
    assert_eq!(btc.id.source, "binance");
    let pepe = &insts[1];
    assert_eq!((pepe.price_scale, pepe.qty_scale), (8, 0));
}

#[tokio::test]
async fn parses_klines_ascending() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/klines"))
        .and(query_param("symbol", "BTCUSDT"))
        .and(query_param("interval", "1h"))
        .and(query_param("limit", "5"))
        .respond_with(json(KLINES))
        .mount(&server)
        .await;
    let rows: Vec<Vec<Value>> = serde_json::from_str(KLINES).unwrap();

    let candles = provider(&server)
        .history(&instrument("BTCUSDT", 2, 5), Timeframe::H1, None, 5)
        .await
        .unwrap();

    assert_eq!(candles.len(), 5);
    assert!(candles.windows(2).all(|w| w[0].open_time < w[1].open_time));
    assert_eq!(candles[0].open_time, rows[0][0].as_i64().unwrap());
    assert_eq!(
        candles[0].open,
        parse_scaled(rows[0][1].as_str().unwrap(), 2).unwrap()
    );
    assert_eq!(candles[0].volume, parse_scaled("512.34000000", 5).unwrap());
}

#[tokio::test]
async fn sends_end_time_minus_one() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/klines"))
        .and(query_param(
            "endTime",
            (1_700_000_000_000_i64 - 1).to_string(),
        ))
        .respond_with(json("[]"))
        .expect(1)
        .mount(&server)
        .await;

    let candles = provider(&server)
        .history(
            &instrument("BTCUSDT", 2, 5),
            Timeframe::H1,
            Some(1_700_000_000_000),
            100,
        )
        .await
        .unwrap();

    assert!(candles.is_empty());
}

#[tokio::test]
async fn rate_limit_respects_retry_after() {
    for status in [429, 418] {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(status).insert_header("Retry-After", "7"))
            .mount(&server)
            .await;
        let err = provider(&server).instruments().await.unwrap_err();
        assert_eq!(err, ProviderError::RateLimited { retry_after_s: 7 });
    }
}

#[tokio::test]
async fn rate_limit_without_header_defaults_to_60() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(429))
        .mount(&server)
        .await;
    let err = provider(&server).instruments().await.unwrap_err();
    assert_eq!(err, ProviderError::RateLimited { retry_after_s: 60 });
}

#[tokio::test]
async fn geo_block_is_reported() {
    for status in [451, 403] {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(status))
            .mount(&server)
            .await;
        let err = provider(&server).instruments().await.unwrap_err();
        assert_eq!(err, ProviderError::Blocked { status });
    }
}

#[tokio::test]
async fn other_http_errors_carry_status_and_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(400).set_body_string("{\"code\":-1121}"))
        .mount(&server)
        .await;
    let err = provider(&server).instruments().await.unwrap_err();
    assert_eq!(
        err,
        ProviderError::Http {
            status: 400,
            body: "{\"code\":-1121}".into()
        }
    );
}

#[tokio::test]
async fn malformed_body_is_a_parse_error() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(json("{\"nope\":1}"))
        .mount(&server)
        .await;
    let err = provider(&server).instruments().await.unwrap_err();
    assert!(matches!(err, ProviderError::Parse(_)), "{err:?}");
}

#[tokio::test]
async fn parses_day_changes() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/ticker/24hr"))
        .and(query_param("symbols", "[\"BTCUSDT\",\"PEPEUSDT\"]"))
        .respond_with(json(TICKER))
        .expect(1)
        .mount(&server)
        .await;
    let insts = [instrument("BTCUSDT", 2, 5), instrument("PEPEUSDT", 8, 0)];

    let changes = provider(&server).day_changes(&insts).await.unwrap();

    assert_eq!(changes.len(), 2);
    assert_eq!(changes[0].id.symbol, "BTCUSDT");
    assert_eq!(changes[0].change_bp, 184);
    assert_eq!(changes[0].last, parse_scaled("61791.77000000", 2).unwrap());
    assert_eq!(changes[1].change_bp, -235);
    assert_eq!(changes[1].last, 1234);
}

#[tokio::test]
async fn malformed_ticker_rows_are_skipped() {
    let server = MockServer::start().await;
    let body = r#"[
      { "symbol": "BTCUSDT", "priceChangePercent": "1.840", "lastPrice": "61791.77000000" },
      { "symbol": "ETHUSDT", "priceChangePercent": "abc", "lastPrice": "3000.00" },
      { "symbol": "SOLUSDT", "lastPrice": "150.00" },
      { "symbol": "PEPEUSDT", "priceChangePercent": "-2.345", "lastPrice": "0.00001234" }
    ]"#;
    Mock::given(method("GET"))
        .and(path("/api/v3/ticker/24hr"))
        .respond_with(json(body))
        .mount(&server)
        .await;
    let insts = [
        instrument("BTCUSDT", 2, 5),
        instrument("ETHUSDT", 2, 4),
        instrument("SOLUSDT", 2, 3),
        instrument("PEPEUSDT", 8, 0),
    ];

    let changes = provider(&server).day_changes(&insts).await.unwrap();

    let symbols: Vec<_> = changes.iter().map(|c| c.id.symbol.as_str()).collect();
    assert_eq!(symbols, ["BTCUSDT", "PEPEUSDT"]);
}

#[tokio::test]
async fn day_changes_of_nothing_makes_no_request() {
    let server = MockServer::start().await;
    let changes = provider(&server).day_changes(&[]).await.unwrap();
    assert!(changes.is_empty());
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn provider_is_object_safe() {
    let server = MockServer::start().await;
    let p: std::sync::Arc<dyn Provider> = std::sync::Arc::new(provider(&server));
    assert_eq!(p.source(), "binance");
}
