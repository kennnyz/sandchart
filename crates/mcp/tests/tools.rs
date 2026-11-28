//! The server in-process, driven by an rmcp client over an in-memory duplex pipe, against a
//! temp data folder and a wiremock Binance. No test touches the real network.

use std::sync::Arc;
use std::time::{Duration, Instant};

use rmcp::model::{CallToolRequestParams, CallToolResult};
use rmcp::service::{RoleClient, RunningService, ServiceError};
use rmcp::{ServiceExt, model::Tool};
use sandchart_core::position::Side;
use sandchart_core::replay::{Command, ReplayFile};
use sandchart_core::{Candle, Drawing, DrawingBody, Instrument, InstrumentId, Style, Timeframe};
use sandchart_data::Binance;
use sandchart_engine::Engine;
use sandchart_mcp::Sandchart;
use serde_json::{Value, json};
use url::Url;
use wiremock::matchers::{method, path, query_param_is_missing};
use wiremock::{Mock, MockServer, ResponseTemplate};

const EXCHANGE_INFO: &str = include_str!("../../data/tests/fixtures/exchange_info.json");
const H: i64 = 3_600_000;
/// Open time of the first of the 30 hourly candles the mock serves.
const T0: i64 = 1_700_000_000_000 / H * H;
const BARS: i64 = 30;

/// Candle `i` (0..30): close 100.00 + i, high and low 0.50 away, volume 1.
fn candle(i: i64) -> Candle {
    let close = 10_000 + 100 * i;
    Candle {
        open_time: T0 + i * H,
        open: close,
        high: close + 50,
        low: close - 50,
        close,
        volume: 100_000,
    }
}

fn price(ticks: i64) -> String {
    format!("{}.{:02}", ticks / 100, ticks % 100)
}

/// Kline rows for `candles`, as Binance sends them.
fn kline_rows(candles: &[Candle]) -> String {
    let rows: Vec<Value> = candles
        .iter()
        .map(|c| {
            json!([
                c.open_time,
                price(c.open),
                price(c.high),
                price(c.low),
                price(c.close),
                "1.00000000",
                c.open_time + H - 1,
                "0",
                1,
                "0",
                "0",
                "0"
            ])
        })
        .collect();
    Value::Array(rows).to_string()
}

fn json_body(body: String) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_raw(body.into_bytes(), "application/json")
}

struct Harness {
    client: RunningService<RoleClient, ()>,
    mock: MockServer,
    dir: tempfile::TempDir,
}

fn binance(mock: &MockServer) -> Binance {
    Binance::new(
        Url::parse(&mock.uri()).unwrap(),
        Url::parse("ws://127.0.0.1:1").unwrap(),
    )
}

async fn harness() -> Harness {
    harness_with(json_body(EXCHANGE_INFO.to_owned())).await
}

/// A harness whose exchange answers the instrument list with `info`.
async fn harness_with(info: ResponseTemplate) -> Harness {
    let mock = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/exchangeInfo"))
        .respond_with(info)
        .mount(&mock)
        .await;
    // Nothing exists before the 30 candles, so a page further back is empty.
    Mock::given(method("GET"))
        .and(path("/api/v3/klines"))
        .respond_with(Series((0..BARS).map(candle).collect()))
        .mount(&mock)
        .await;
    serve(mock).await
}

/// The server over `mock`, which answers the exchange's endpoints.
async fn serve(mock: MockServer) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let engine = Engine::open_secondary(dir.path(), None, vec![Arc::new(binance(&mock))]).unwrap();
    let (server_io, client_io) = tokio::io::duplex(1 << 20);
    let server = Sandchart::new(Arc::new(engine));
    tokio::spawn(async move {
        let running = server.serve(server_io).await.unwrap();
        let _ = running.waiting().await;
    });
    let client = ().serve(client_io).await.unwrap();
    Harness { client, mock, dir }
}

impl Harness {
    async fn try_call(
        &self,
        name: &'static str,
        args: Value,
    ) -> Result<CallToolResult, ServiceError> {
        let args = args.as_object().cloned().expect("arguments are an object");
        self.client
            .call_tool(CallToolRequestParams::new(name).with_arguments(args))
            .await
    }

    /// The structured result of a call that must succeed.
    async fn call(&self, name: &'static str, args: Value) -> Value {
        let r = self.try_call(name, args).await.unwrap();
        assert_ne!(r.is_error, Some(true), "{name} failed: {:?}", r.content);
        let v = r.structured_content.expect("structured content");
        // The text content is the same JSON, for clients that only read text.
        let text = r.content[0].as_text().expect("text content").text.clone();
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), v);
        v
    }

    /// The message of a call that must fail as a tool error the agent can read.
    async fn fail(&self, name: &'static str, args: Value) -> String {
        let r = self.try_call(name, args).await.unwrap();
        assert_eq!(
            r.is_error,
            Some(true),
            "{name} did not fail: {:?}",
            r.content
        );
        r.content[0].as_text().expect("text content").text.clone()
    }

    async fn requests(&self, p: &str) -> usize {
        let all = self.mock.received_requests().await.unwrap_or_default();
        all.iter().filter(|r| r.url.path() == p).count()
    }
}

fn assert_contains(haystack: &str, needle: &str) {
    assert!(haystack.contains(needle), "{needle:?} not in {haystack:?}");
}

const TOOLS: [&str; 12] = [
    "compute_indicator",
    "delete_alert",
    "delete_drawing",
    "get_candles",
    "list_alerts",
    "list_drawings",
    "list_indicators",
    "position_outcome",
    "run_replay",
    "save_drawing",
    "search_instruments",
    "set_alert",
];

#[tokio::test]
async fn lists_every_tool_with_a_description_and_an_input_schema() {
    let h = harness().await;
    let info = h.client.peer_info().unwrap();
    assert_eq!(info.server_info.as_ref().unwrap().name, "sandchart-mcp");
    assert_contains(info.instructions.as_deref().unwrap(), "priceScale");

    let mut tools: Vec<Tool> = h.client.list_all_tools().await.unwrap();
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    assert_eq!(names, TOOLS);
    for t in &tools {
        let d = t.description.as_deref().unwrap_or_default();
        assert!(!d.is_empty() && d.len() < 400, "{}: {d:?}", t.name);
        assert_eq!(
            t.input_schema.get("type"),
            Some(&json!("object")),
            "{}",
            t.name
        );
    }
    let schema = |name: &str| {
        let t = tools.iter().find(|t| t.name == name).unwrap();
        Value::Object((*t.input_schema).clone()).to_string()
    };
    // Generated from the serde types the server parses with.
    assert_contains(&schema("save_drawing"), "extendLeft");
    assert_contains(&schema("save_drawing"), "\"additionalProperties\":false");
    assert_contains(&schema("set_alert"), "drawingId");
    assert_contains(&schema("position_outcome"), "endT");
    assert_contains(&schema("compute_indicator"), "lastN");
    for name in ["list_alerts", "set_alert"] {
        let t = tools.iter().find(|t| t.name == name).unwrap();
        assert_contains(
            t.description.as_deref().unwrap(),
            "only while the Sandchart app",
        );
    }
    let read_only = |name: &str| {
        let t = tools.iter().find(|t| t.name == name).unwrap();
        t.annotations.as_ref().and_then(|a| a.read_only_hint)
    };
    assert_eq!(read_only("get_candles"), Some(true));
    assert_eq!(read_only("save_drawing"), Some(false));
}

#[tokio::test]
async fn search_downloads_the_instrument_list_once_and_checks_its_limit() {
    let h = harness().await;
    let found = h
        .call("search_instruments", json!({ "query": "btc" }))
        .await;
    assert_eq!(
        found["instruments"],
        json!([{
            "source": "binance", "symbol": "BTCUSDT", "base": "BTC", "quote": "USDT",
            "priceScale": 2, "qtyScale": 5
        }])
    );
    assert!(found.get("warning").is_none());
    let all = h
        .call("search_instruments", json!({ "query": "USDT", "limit": 1 }))
        .await;
    assert_eq!(all["instruments"].as_array().unwrap().len(), 1);
    assert_eq!(h.requests("/api/v3/exchangeInfo").await, 1);

    let e = h
        .fail("search_instruments", json!({ "query": "BTC", "limit": 51 }))
        .await;
    assert_eq!(e, "limit must be 1 to 50, not 51");
    let e = h
        .fail("search_instruments", json!({ "query": "BTC", "limit": 0 }))
        .await;
    assert_eq!(e, "limit must be 1 to 50, not 0");
    let e = h
        .fail("search_instruments", json!({ "query": "X".repeat(65) }))
        .await;
    assert_contains(&e, "at most 64 bytes");
}

#[tokio::test]
async fn a_failed_instrument_download_is_reported_and_not_retried_at_once() {
    let h = harness_with(ResponseTemplate::new(500)).await;
    let e = h
        .fail("search_instruments", json!({ "query": "BTC" }))
        .await;
    assert_contains(&e, "cannot refresh the instrument list: HTTP 500");
    let e = h
        .fail(
            "get_candles",
            json!({ "symbol": "BTCUSDT", "timeframe": "1h" }),
        )
        .await;
    assert_eq!(
        e,
        "unknown pair binance/BTCUSDT; search_instruments lists them"
    );
    assert_eq!(h.requests("/api/v3/exchangeInfo").await, 1);
}

#[tokio::test]
async fn a_misspelt_or_missing_field_is_refused_before_the_tool_runs() {
    let h = harness().await;
    let e = h
        .fail("search_instruments", json!({ "query": "BTC", "limt": 5 }))
        .await;
    assert_contains(&e, "unknown field `limt`, expected `query` or `limit`");
    let e = h.fail("get_candles", json!({ "symbol": "BTCUSDT" })).await;
    assert_contains(&e, "missing field `timeframe`");
}

#[tokio::test]
async fn candles_come_from_the_provider_with_decimals_and_ticks() {
    let h = harness().await;
    let got = h
        .call(
            "get_candles",
            json!({ "symbol": "btcusdt", "timeframe": "1h", "limit": 3 }),
        )
        .await;
    assert_eq!(got["instrument"]["symbol"], "BTCUSDT");
    assert_eq!(got["timeframe"], "1h");
    let candles = got["candles"].as_array().unwrap();
    assert_eq!(candles.len(), 3);
    assert_eq!(
        candles[2],
        json!({
            "time": T0 + 29 * H,
            "open": "129.00", "high": "129.50", "low": "128.50", "close": "129.00",
            "volume": "1.00000",
            "ticks": [12_900, 12_950, 12_850, 12_900, 100_000]
        })
    );
    assert_eq!(candles[0]["time"], T0 + 27 * H);
    assert_eq!(got["atHistoryStart"], false);

    // All of them: the page before the first one is empty, so history starts there.
    let all = h
        .call(
            "get_candles",
            json!({ "symbol": "BTCUSDT", "timeframe": "1h", "limit": 5000 }),
        )
        .await;
    assert_eq!(all["candles"].as_array().unwrap().len(), BARS as usize);
    assert_eq!(all["atHistoryStart"], true);
    let before = h
        .call(
            "get_candles",
            json!({ "symbol": "BTCUSDT", "timeframe": "1h", "before": T0 + 2 * H }),
        )
        .await;
    let times: Vec<&Value> = before["candles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| &c["time"])
        .collect();
    assert_eq!(times, [&json!(T0), &json!(T0 + H)]);
}

#[tokio::test]
async fn candle_requests_are_checked() {
    let h = harness().await;
    let e = h
        .fail(
            "get_candles",
            json!({ "symbol": "BTCUSDT", "timeframe": "1H" }),
        )
        .await;
    assert_contains(&e, "unknown timeframe \"1H\"; use one of 1m 3m");
    let e = h
        .fail(
            "get_candles",
            json!({ "symbol": "BTCUSDT", "timeframe": "1h", "limit": 5001 }),
        )
        .await;
    assert_eq!(e, "limit must be 1 to 5000, not 5001");
    let e = h
        .fail(
            "get_candles",
            json!({ "symbol": "NOPEUSDT", "timeframe": "1h" }),
        )
        .await;
    assert_eq!(
        e,
        "unknown pair binance/NOPEUSDT; search_instruments lists them"
    );
    let e = h
        .fail(
            "get_candles",
            json!({ "source": "kraken", "symbol": "BTCUSDT", "timeframe": "1h" }),
        )
        .await;
    assert_contains(&e, "unknown pair kraken/BTCUSDT");
}

#[tokio::test]
async fn indicators_are_listed_and_computed_in_the_sandbox() {
    let h = harness().await;
    let list = h.call("list_indicators", json!({})).await;
    let ids: Vec<&str> = list["indicators"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        ids,
        [
            "builtin.sma",
            "builtin.ema",
            "builtin.bollinger",
            "builtin.rsi",
            "builtin.macd"
        ]
    );
    let sma = &list["indicators"][0];
    assert_eq!(sma["params"][0]["id"], "period");

    let got = h
        .call(
            "compute_indicator",
            json!({
                "id": "builtin.sma", "params": { "period": 3 },
                "symbol": "BTCUSDT", "timeframe": "1h", "lastN": 2
            }),
        )
        .await;
    assert_eq!(got["times"], json!([T0 + 28 * H, T0 + 29 * H]));
    // Closes 126, 127, 128 and 127, 128, 129.
    assert_eq!(got["series"][0]["values"], json!([127.0, 128.0]));
    assert_eq!(got["params"]["period"], 3);

    // Before a full window there is no value.
    let first = h
        .call(
            "compute_indicator",
            json!({ "id": "builtin.sma", "params": { "period": 31 }, "symbol": "BTCUSDT", "timeframe": "1h", "lastN": 1 }),
        )
        .await;
    assert_eq!(first["series"][0]["values"], json!([null]));
}

#[tokio::test]
async fn indicator_requests_are_checked() {
    let h = harness().await;
    let run = |id: &str, params: Value, last_n: Value| json!({ "id": id, "params": params, "symbol": "BTCUSDT", "timeframe": "1h", "lastN": last_n });
    let e = h
        .fail("compute_indicator", run("me.nope", json!({}), json!(5)))
        .await;
    assert_contains(
        &e,
        "no indicator \"me.nope\"; available: builtin.sma, builtin.ema",
    );
    let e = h
        .fail(
            "compute_indicator",
            run("builtin.sma", json!({ "length": 5 }), json!(5)),
        )
        .await;
    assert_contains(
        &e,
        "builtin.sma has no parameter \"length\"; its parameters are: period",
    );
    let e = h
        .fail(
            "compute_indicator",
            run("builtin.sma", json!({ "period": "5" }), json!(5)),
        )
        .await;
    assert_contains(&e, "must be an integer");
    let e = h
        .fail(
            "compute_indicator",
            run("builtin.sma", json!({ "period": 0 }), json!(5)),
        )
        .await;
    assert_contains(
        &e,
        "parameter \"period\" of builtin.sma: the integer 0 does not fit an integer in 1..=",
    );
    let e = h
        .fail(
            "compute_indicator",
            run("builtin.sma", json!({}), json!(5001)),
        )
        .await;
    assert_eq!(e, "lastN must be 1 to 5000, not 5001");
}

fn hline(p: i64) -> Value {
    json!({ "kind": "hline", "p": p })
}

#[tokio::test]
async fn drawings_are_saved_listed_and_deleted_with_the_apps_rules() {
    let h = harness().await;
    let saved = h
        .call(
            "save_drawing",
            json!({ "symbol": "BTCUSDT", "priceScale": 2, "body": hline(12_345) }),
        )
        .await;
    let id = saved["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("mcp-") && id.len() <= 64, "{id}");
    assert_eq!(
        saved["style"],
        json!({ "color": 0, "width": 1, "dash": false })
    );
    assert!(saved["updatedAt"].as_i64().unwrap() > 0);
    assert_eq!(
        saved["body"],
        json!({ "kind": "hline", "p": 12_345, "pDecimal": "123.45" })
    );

    // Ticks at another price scale are a mistake (10x or 100x off), not rescaled.
    let trend = json!({
        "id": "t1", "symbol": "BTCUSDT", "priceScale": 3, "z": 2,
        "body": { "kind": "trend", "a": { "t": T0, "p": 10_000 }, "b": { "t": T0 + H, "p": 10_100 },
                  "extendLeft": false, "extendRight": true },
        "style": { "color": 3, "width": 2, "dash": true }
    });
    let e = h.fail("save_drawing", trend.clone()).await;
    assert_eq!(
        e,
        "priceScale must be 2, the price scale of binance/BTCUSDT (prices are ticks at it), not 3"
    );
    let mut trend = trend;
    trend["priceScale"] = json!(2);
    let trend = h.call("save_drawing", trend).await;
    assert_eq!(trend["body"]["a"]["p"], 10_000);

    let list = h
        .call("list_drawings", json!({ "symbol": "BTCUSDT" }))
        .await;
    let ids: Vec<&str> = list["drawings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [id.as_str(), "t1"]);

    let e = h
        .fail(
            "save_drawing",
            json!({ "symbol": "BTCUSDT", "priceScale": 2,
                    "body": { "kind": "trend", "a": { "t": T0, "p": 1 }, "b": { "t": T0, "p": 1 },
                              "extendLeft": false, "extendRight": false } }),
        )
        .await;
    assert_eq!(e, "the two points of a drawing must differ");
    let e = h
        .fail(
            "save_drawing",
            json!({ "symbol": "BTCUSDT", "priceScale": 2, "body": hline(1),
                    "style": { "color": 0, "width": 9, "dash": false } }),
        )
        .await;
    assert_eq!(e, "line width 9 is not in 1..=4");
    let e = h
        .fail(
            "save_drawing",
            json!({ "id": "bad id", "symbol": "BTCUSDT", "priceScale": 2, "body": hline(1) }),
        )
        .await;
    assert_contains(&e, "a drawing id must be 1 to 64 characters");

    h.call("delete_drawing", json!({ "id": id })).await;
    h.call("delete_drawing", json!({ "id": "t1" })).await;
    h.call("delete_drawing", json!({ "id": "t1" })).await;
    let list = h
        .call("list_drawings", json!({ "symbol": "BTCUSDT" }))
        .await;
    assert_eq!(list["drawings"], json!([]));
}

#[tokio::test]
async fn a_position_resolves_over_the_candles_fetched_back_to_its_entry() {
    let h = harness().await;
    // Long at the close of bar 10 (110.00), stop 109.00, take 112.00: bar 12 reaches 112.50.
    let position = json!({
        "side": "long", "entry": { "t": T0 + 10 * H, "p": 11_000 },
        "stop": 10_900, "take": 11_200, "endT": T0 + 29 * H
    });
    let got = h
        .call(
            "position_outcome",
            json!({ "symbol": "BTCUSDT", "timeframe": "1h", "priceScale": 2, "position": position }),
        )
        .await;
    assert_eq!(got["status"], "take");
    assert_eq!(got["exitTime"], T0 + 12 * H);
    assert_eq!(got["ambiguous"], false);
    assert_eq!(got["r"], 2.0);

    let e = h
        .fail(
            "position_outcome",
            json!({ "symbol": "BTCUSDT", "timeframe": "1h", "priceScale": 2, "position": {
                "side": "long", "entry": { "t": T0, "p": 100 }, "stop": 200, "take": 300, "endT": T0 + H
            } }),
        )
        .await;
    assert_eq!(e, "a long position needs stop < entry < take");
    let mut wrong = json!({ "symbol": "BTCUSDT", "timeframe": "1h", "priceScale": 1, "position": position });
    let e = h.fail("position_outcome", wrong.take()).await;
    assert_contains(&e, "priceScale must be 2");
}

fn replay_file() -> String {
    let file = ReplayFile {
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
        timeframe: Timeframe::H1,
        candles: (0..BARS).map(candle).collect(),
        start: 5,
        current: 15,
        // Long at the close of bar 5 (105.00), stop 104.00, take 107.00: bar 7 reaches 107.50.
        commands: vec![Command::Open {
            bar: 5,
            side: Side::Long,
            stop: 10_400,
            take: 10_700,
        }],
    };
    file.to_json()
}

#[tokio::test]
async fn a_replay_file_is_simulated_again_from_its_commands() {
    let h = harness().await;
    let path = h.dir.path().join("session.replay");
    std::fs::write(&path, replay_file()).unwrap();
    let got = h
        .call("run_replay", json!({ "path": path.to_str().unwrap() }))
        .await;
    assert_eq!(got["instrument"]["symbol"], "BTCUSDT");
    assert_eq!(got["timeframe"], "1h");
    assert_eq!(
        (got["start"].clone(), got["current"].clone()),
        (json!(5), json!(15))
    );
    assert_eq!(got["startTime"], T0 + 5 * H);
    let trades = got["trades"].as_array().unwrap();
    assert_eq!(trades.len(), 1);
    let t = &trades[0];
    assert_eq!(t["reason"], "take");
    assert_eq!(t["entryPrice"], 10_500);
    assert_eq!(t["entryPriceDecimal"], "105.00");
    assert_eq!(t["exitPriceDecimal"], "107.00");
    assert_eq!(t["exitTime"], T0 + 7 * H);
    assert_eq!(t["r"], 2.0);
    assert_eq!(got["stats"]["count"], 1);
    assert_eq!(got["stats"]["wins"], 1);
    assert_eq!(got["stats"]["totalR"], 2.0);
}

#[tokio::test]
async fn only_regular_replay_files_within_the_cap_are_read() {
    let h = harness().await;
    let dir = h.dir.path();
    let e = h
        .fail("run_replay", json!({ "path": "session.replay" }))
        .await;
    assert_eq!(e, "\"session.replay\" is not an absolute path");
    let other = dir.join("notes.txt");
    std::fs::write(&other, "x").unwrap();
    let e = h.fail("run_replay", json!({ "path": other })).await;
    assert_contains(&e, "is not a .replay file");
    let folder = dir.join("folder.replay");
    std::fs::create_dir(&folder).unwrap();
    let e = h.fail("run_replay", json!({ "path": folder })).await;
    assert_contains(&e, "is not a regular file");
    let e = h
        .fail("run_replay", json!({ "path": dir.join("missing.replay") }))
        .await;
    assert_contains(&e, "cannot read");
    let big = dir.join("big.replay");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(32 * 1024 * 1024 + 1)
        .unwrap();
    let e = h.fail("run_replay", json!({ "path": big })).await;
    assert_contains(&e, "is larger than 32 MiB");
    let broken = dir.join("broken.replay");
    let whole = replay_file();
    std::fs::write(&broken, &whole[..whole.len() / 2]).unwrap();
    let e = h.fail("run_replay", json!({ "path": broken })).await;
    assert_contains(&e, "broken.replay");
    #[cfg(unix)]
    {
        let fifo = dir.join("fifo.replay");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());
        let e = h.fail("run_replay", json!({ "path": fifo })).await;
        assert_contains(&e, "is not a regular file");
    }
}

#[tokio::test]
async fn alerts_are_set_listed_and_deleted() {
    let h = harness().await;
    let set = h
        .call(
            "set_alert",
            json!({ "symbol": "BTCUSDT", "priceScale": 2, "kind": { "kind": "price", "price": 13_000 },
                    "direction": "above" }),
        )
        .await;
    assert_eq!(set["active"], true);
    assert_eq!(
        set["kind"],
        json!({ "kind": "price", "price": 13_000, "priceDecimal": "130.00" })
    );
    assert_contains(
        set["note"].as_str().unwrap(),
        "only while the Sandchart app",
    );
    let id = set["id"].as_str().unwrap().to_owned();
    let e = h
        .fail(
            "set_alert",
            json!({ "symbol": "BTCUSDT", "priceScale": 4, "kind": { "kind": "price", "price": 13_000 },
                    "direction": "above" }),
        )
        .await;
    assert_contains(&e, "priceScale must be 2, the price scale of binance/BTCUSDT");

    h.call(
        "save_drawing",
        json!({ "id": "line", "symbol": "BTCUSDT", "priceScale": 2, "body": hline(12_000) }),
    )
    .await;
    h.call(
        "set_alert",
        json!({ "id": "on-line", "symbol": "BTCUSDT", "priceScale": 2,
                "kind": { "kind": "drawing", "drawingId": "line" }, "direction": "cross" }),
    )
    .await;
    h.call(
        "save_drawing",
        json!({ "id": "box", "symbol": "BTCUSDT", "priceScale": 2,
                "body": { "kind": "rect", "a": { "t": T0, "p": 1 }, "b": { "t": T0 + H, "p": 2 }, "extendRight": false } }),
    )
    .await;
    let e = h
        .fail(
            "set_alert",
            json!({ "symbol": "BTCUSDT", "priceScale": 2,
                    "kind": { "kind": "drawing", "drawingId": "box" }, "direction": "cross" }),
        )
        .await;
    assert_eq!(e, "an alert can follow only a horizontal or a trend line");

    let list = h.call("list_alerts", json!({})).await;
    let ids: Vec<&str> = list["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [id.as_str(), "on-line"]);

    // Deleting the line takes its alert with it.
    h.call("delete_drawing", json!({ "id": "line" })).await;
    h.call("delete_alert", json!({ "id": id })).await;
    let list = h.call("list_alerts", json!({})).await;
    assert_eq!(list["alerts"], json!([]));
}

#[tokio::test]
async fn at_most_100_alerts_are_active() {
    let h = harness().await;
    for i in 0..100 {
        h.call(
            "set_alert",
            json!({ "id": format!("a{i}"), "symbol": "BTCUSDT", "priceScale": 2,
                    "kind": { "kind": "price", "price": 10_000 + i }, "direction": "cross" }),
        )
        .await;
    }
    let e = h
        .fail(
            "set_alert",
            json!({ "symbol": "BTCUSDT", "priceScale": 2, "kind": { "kind": "price", "price": 1 },
                    "direction": "cross" }),
        )
        .await;
    assert_contains(&e, "at most 100 alerts can be active at once");
}

#[tokio::test]
async fn writes_wait_for_the_app_and_both_see_each_others_changes() {
    let h = harness().await;
    h.call("search_instruments", json!({ "query": "BTCUSDT" }))
        .await;
    // The app: another engine on the same database.
    let app = Engine::open_secondary(h.dir.path(), None, vec![Arc::new(binance(&h.mock))]).unwrap();
    let id = InstrumentId {
        source: "binance".into(),
        symbol: "BTCUSDT".into(),
    };
    app.save_drawing(Drawing {
        id: "from-app".into(),
        instrument: id.clone(),
        price_scale: 2,
        body: DrawingBody::Hline { p: 1 },
        style: Style {
            color: 1,
            width: 1,
            dash: false,
        },
        locked: false,
        z: 0,
        updated_at: 0,
    })
    .await
    .unwrap();
    let list = h
        .call("list_drawings", json!({ "symbol": "BTCUSDT" }))
        .await;
    assert_eq!(list["drawings"][0]["id"], "from-app");

    // While another process holds the write lock, the server's write waits for it.
    let conn = rusqlite::Connection::open(h.dir.path().join("sandchart.db")).unwrap();
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        conn.execute_batch("COMMIT").unwrap();
    });
    let started = Instant::now();
    h.call(
        "save_drawing",
        json!({ "id": "from-agent", "symbol": "BTCUSDT", "priceScale": 2,
                "body": { "kind": "note", "t": T0, "text": "breakout" } }),
    )
    .await;
    assert!(started.elapsed() >= Duration::from_millis(400));
    release.join().unwrap();
    let ids: Vec<String> = app
        .drawings(&id)
        .await
        .unwrap()
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert_eq!(ids, ["from-agent", "from-app"]);
}

#[tokio::test]
async fn the_newest_candle_is_asked_for_again_while_it_is_forming() {
    // Five hourly candles up to the one forming now; the exchange's last close moves.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let forming = now / H * H;
    let page = |last_close: i64| {
        let candles: Vec<Candle> = (0..5)
            .map(|i| Candle {
                open_time: forming - (4 - i) * H,
                ..candle(i)
            })
            .map(|mut c| {
                if c.open_time == forming {
                    c.close = last_close;
                    c.high = c.high.max(last_close);
                }
                c
            })
            .collect();
        json_body(kline_rows(&candles))
    };
    let mock = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/exchangeInfo"))
        .respond_with(json_body(EXCHANGE_INFO.to_owned()))
        .mount(&mock)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v3/klines"))
        .and(query_param_is_missing("endTime"))
        .respond_with(page(10_400))
        .up_to_n_times(1)
        .with_priority(1)
        .mount(&mock)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v3/klines"))
        .and(query_param_is_missing("endTime"))
        .respond_with(page(10_475))
        .with_priority(2)
        .mount(&mock)
        .await;
    let h = serve(mock).await;
    let last = |v: &Value| v["candles"].as_array().unwrap().last().unwrap()["close"].clone();
    let args = json!({ "symbol": "BTCUSDT", "timeframe": "1h", "limit": 2 });
    assert_eq!(last(&h.call("get_candles", args.clone()).await), "104.00");
    // Within the same bar: one more request, and the candle as it is now.
    let again = h.call("get_candles", args).await;
    assert_eq!(last(&again), "104.75");
    assert_eq!(again["candles"].as_array().unwrap().len(), 2);
    assert_eq!(h.requests("/api/v3/klines").await, 2);
}

/// An exchange with a long series: every klines request gets the candles that open at or
/// before its `endTime` (all when there is none), at most `limit`, as Binance answers.
struct Series(Vec<Candle>);

impl wiremock::Respond for Series {
    fn respond(&self, req: &wiremock::Request) -> ResponseTemplate {
        let q = |k: &str| {
            req.url
                .query_pairs()
                .find(|(n, _)| n == k)
                .and_then(|(_, v)| v.parse::<i64>().ok())
        };
        let end = q("endTime").unwrap_or(i64::MAX);
        let limit = q("limit").unwrap_or(500) as usize;
        let upto: Vec<Candle> = self
            .0
            .iter()
            .copied()
            .filter(|c| c.open_time <= end)
            .collect();
        json_body(kline_rows(&upto[upto.len().saturating_sub(limit)..]))
    }
}

#[tokio::test]
async fn a_position_is_resolved_from_its_end_back_and_refused_past_5000_bars() {
    let mock = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v3/exchangeInfo"))
        .respond_with(json_body(EXCHANGE_INFO.to_owned()))
        .mount(&mock)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v3/klines"))
        .respond_with(Series((0..7_000).map(candle).collect()))
        .mount(&mock)
        .await;
    let h = serve(mock).await;
    // Bar 1500 closes at 1600.00; bar 1501 reaches 1601.50, the take. The entry is 4900 bars
    // before the end but 5500 before now: the walk starts at the end.
    let at = |i: i64| T0 + i * H;
    let position = |entry: i64, end: i64| {
        let p = candle(entry).close;
        json!({ "symbol": "BTCUSDT", "timeframe": "1h", "priceScale": 2, "position": {
            "side": "long", "entry": { "t": at(entry), "p": p },
            "stop": p - 100, "take": p + 150, "endT": at(end)
        } })
    };
    let got = h.call("position_outcome", position(1_500, 6_400)).await;
    assert_eq!(got["status"], "take");
    assert_eq!(got["exitTime"], at(1_501));

    let e = h.fail("position_outcome", position(100, 6_400)).await;
    assert_contains(&e, "more than 5000 bars before endT");
}

#[tokio::test]
async fn every_price_of_a_drawing_comes_with_its_decimal_and_saves_back_as_it_is() {
    let h = harness().await;
    let pt = |t: i64, p: i64| json!({ "t": T0 + t * H, "p": p });
    let save = |body: Value| {
        json!({ "symbol": "BTCUSDT", "priceScale": 2, "body": body })
    };
    let cases = [
        (
            json!({ "kind": "trend", "a": pt(0, 10_000), "b": pt(1, 10_150),
                    "extendLeft": false, "extendRight": false }),
            json!({ "kind": "trend", "a": { "t": T0, "p": 10_000, "pDecimal": "100.00" },
                    "b": { "t": T0 + H, "p": 10_150, "pDecimal": "101.50" },
                    "extendLeft": false, "extendRight": false }),
        ),
        (
            json!({ "kind": "position", "side": "long", "entry": pt(0, 10_000), "stop": 9_900,
                    "take": 10_250, "endT": T0 + 5 * H }),
            json!({ "kind": "position", "side": "long",
                    "entry": { "t": T0, "p": 10_000, "pDecimal": "100.00" },
                    "stop": 9_900, "stopDecimal": "99.00", "take": 10_250, "takeDecimal": "102.50",
                    "endT": T0 + 5 * H }),
        ),
        (
            json!({ "kind": "brush", "points": [pt(0, 5), pt(1, -7)] }),
            json!({ "kind": "brush", "points": [
                { "t": T0, "p": 5, "pDecimal": "0.05" }, { "t": T0 + H, "p": -7, "pDecimal": "-0.07" }
            ] }),
        ),
    ];
    for (body, want) in cases {
        let saved = h.call("save_drawing", save(body)).await;
        assert_eq!(saved["body"], want);
        // What an agent read can be saved back unchanged.
        let mut again = save(saved["body"].clone());
        again["id"] = saved["id"].clone();
        assert_eq!(h.call("save_drawing", again).await["body"], want);
    }
    let fib = h
        .call(
            "save_drawing",
            save(json!({ "kind": "fib", "a": pt(0, 1), "b": pt(1, 2), "levels": [0, 0.5, 1] })),
        )
        .await;
    assert_eq!(fib["body"]["levels"], json!([0.0, 0.5, 1.0]));
    assert_eq!(fib["body"]["b"]["pDecimal"], "0.02");
}
