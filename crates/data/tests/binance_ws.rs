// tungstenite handshake callback signature
#![allow(clippy::result_large_err)]

use std::time::Duration;

use futures::{Stream, StreamExt};
use sandchart_core::{Instrument, InstrumentId, Timeframe};
use sandchart_data::{Binance, LiveCandle, Provider, ProviderError};
use tokio::{net::TcpListener, sync::mpsc, time::timeout};
use tokio_tungstenite::{accept_hdr_async, tungstenite::Message};
use url::Url;

fn instrument() -> Instrument {
    Instrument {
        id: InstrumentId {
            source: "binance".into(),
            symbol: "BTCUSDT".into(),
        },
        base: "BTC".into(),
        quote: "USDT".into(),
        price_scale: 2,
        qty_scale: 5,
    }
}

fn kline(t: i64, close: &str, closed: bool) -> String {
    format!(
        r#"{{"e":"kline","E":1,"s":"BTCUSDT","k":{{"t":{t},"T":{},"s":"BTCUSDT","i":"1m","o":"100.00","h":"102.50","l":"99.10","c":"{close}","v":"1.50000","x":{closed}}}}}"#,
        t + 59_999
    )
}

/// Local WebSocket server. Each accepted connection runs `script`, which
/// gets the request path and the socket; the server reports every
/// connection end on `ended`.
struct Server {
    url: Url,
    paths: mpsc::UnboundedReceiver<String>,
    ended: mpsc::UnboundedReceiver<()>,
}

async fn serve<F, Fut>(script: F) -> Server
where
    F: Fn(usize, tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Fut
        + Send
        + Sync
        + 'static,
    Fut: std::future::Future<Output = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>>
        + Send
        + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("ws://{}", listener.local_addr().unwrap())).unwrap();
    let (paths_tx, paths) = mpsc::unbounded_channel();
    let (ended_tx, ended) = mpsc::unbounded_channel();
    let script = std::sync::Arc::new(script);
    tokio::spawn(async move {
        let mut n = 0;
        while let Ok((tcp, _)) = listener.accept().await {
            let paths_tx = paths_tx.clone();
            let ended_tx = ended_tx.clone();
            let script = script.clone();
            let index = n;
            n += 1;
            tokio::spawn(async move {
                let ws = accept_hdr_async(tcp, |req: &_, resp| {
                    let req: &tokio_tungstenite::tungstenite::handshake::server::Request = req;
                    paths_tx.send(req.uri().path().to_string()).ok();
                    Ok(resp)
                })
                .await
                .unwrap();
                let mut ws = script(index, ws).await;
                // Wait until the peer is gone.
                while let Some(Ok(_)) = ws.next().await {}
                ended_tx.send(()).ok();
            });
        }
    });
    Server { url, paths, ended }
}

fn provider(ws: Url) -> Binance {
    Binance::new(Url::parse("http://127.0.0.1:1").unwrap(), ws)
        .with_reconnect_backoff(Duration::from_millis(10), Duration::from_millis(40))
}

async fn next<S: Stream<Item = Result<LiveCandle, ProviderError>> + Unpin>(
    s: &mut S,
) -> Result<LiveCandle, ProviderError> {
    timeout(Duration::from_secs(5), s.next())
        .await
        .expect("stream timed out")
        .expect("stream ended")
}

#[tokio::test]
async fn parses_kline_message() {
    use futures::SinkExt;
    let mut server = serve(|_, mut ws| async move {
        ws.send(Message::text(r#"{"result":null,"id":1}"#))
            .await
            .unwrap();
        ws.send(Message::text(kline(60_000, "101.25", false)))
            .await
            .unwrap();
        ws.send(Message::text(kline(60_000, "101.30", true)))
            .await
            .unwrap();
        ws
    })
    .await;
    let p = provider(server.url.clone());
    let mut s = p.live(&instrument(), Timeframe::M1);

    let a = next(&mut s).await.unwrap();
    assert!(!a.closed);
    assert_eq!(a.candle.open_time, 60_000);
    assert_eq!(a.candle.open, 10_000);
    assert_eq!(a.candle.high, 10_250);
    assert_eq!(a.candle.low, 9_910);
    assert_eq!(a.candle.close, 10_125);
    assert_eq!(a.candle.volume, 150_000);
    let b = next(&mut s).await.unwrap();
    assert!(b.closed);
    assert_eq!(b.candle.close, 10_130);

    assert_eq!(server.paths.recv().await.unwrap(), "/ws/btcusdt@kline_1m");
}

#[tokio::test]
async fn reconnects_after_server_close() {
    use futures::SinkExt;
    let server = serve(|n, mut ws| async move {
        ws.send(Message::text(kline(
            60_000 * (n as i64 + 1),
            "101.00",
            false,
        )))
        .await
        .unwrap();
        if n == 0 {
            ws.close(None).await.unwrap();
        }
        ws
    })
    .await;
    let p = provider(server.url.clone());
    let mut s = p.live(&instrument(), Timeframe::M1);

    assert_eq!(next(&mut s).await.unwrap().candle.open_time, 60_000);
    assert!(matches!(next(&mut s).await, Err(ProviderError::Network(_))));
    assert_eq!(next(&mut s).await.unwrap().candle.open_time, 120_000);
}

#[tokio::test]
async fn connect_failure_yields_one_error_per_attempt() {
    // Nothing listens on port 1.
    let p = provider(Url::parse("ws://127.0.0.1:1").unwrap());
    let mut s = p.live(&instrument(), Timeframe::M1);
    for _ in 0..3 {
        assert!(matches!(next(&mut s).await, Err(ProviderError::Network(_))));
    }
}

#[tokio::test]
async fn drop_closes_socket() {
    use futures::SinkExt;
    let mut server = serve(|_, mut ws| async move {
        ws.send(Message::text(kline(60_000, "101.00", false)))
            .await
            .unwrap();
        ws
    })
    .await;
    let p = provider(server.url.clone());
    let mut s = p.live(&instrument(), Timeframe::M1);
    next(&mut s).await.unwrap();
    drop(s);
    timeout(Duration::from_secs(1), server.ended.recv())
        .await
        .expect("server did not see the connection end")
        .unwrap();
}
