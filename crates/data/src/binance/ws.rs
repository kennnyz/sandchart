//! Binance kline WebSocket stream with reconnect.
//!
//! Contract with the engine: every connection drop (close frame, read error,
//! failed connect) yields exactly one `Err(ProviderError::Network)`, so the
//! engine knows candles may be missing and backfills. The stream owns the
//! socket directly (no spawned task), so dropping it closes the connection.

use std::time::Duration;

use futures::{StreamExt, stream, stream::BoxStream};
use sandchart_core::{Instrument, Timeframe};
use tokio::{net::TcpStream, time};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async, tungstenite::Message};
use url::Url;

use crate::{LiveCandle, ProviderError};

use super::{Binance, wire::WsEvent};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Binance pings about every 20 s; silence for 3x that means a dead link.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Reconnect delays: `initial`, doubling up to `max`.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    initial: Duration,
    max: Duration,
    next: Duration,
}

impl Backoff {
    pub fn new(initial: Duration, max: Duration) -> Backoff {
        Backoff {
            initial,
            max,
            next: initial,
        }
    }

    /// The delay to wait now; the following one doubles, capped at `max`.
    fn advance(&mut self) -> Duration {
        let now = self.next;
        self.next = (self.next * 2).min(self.max);
        now
    }

    fn reset(&mut self) {
        self.next = self.initial;
    }
}

struct State {
    url: Url,
    inst: Instrument,
    backoff: Backoff,
    idle: Duration,
    socket: Option<Socket>,
    /// Wait this long before the next connect attempt.
    delay: Option<Duration>,
}

impl State {
    fn dropped(&mut self, err: impl std::fmt::Display) -> ProviderError {
        self.socket = None;
        self.delay = Some(self.backoff.advance());
        ProviderError::Network(format!("live stream dropped: {err}"))
    }
}

impl Binance {
    pub(super) fn live_stream(
        &self,
        inst: &Instrument,
        tf: Timeframe,
    ) -> BoxStream<'static, Result<LiveCandle, ProviderError>> {
        let path = format!(
            "ws/{}@kline_{}",
            inst.id.symbol.to_ascii_lowercase(),
            tf.code()
        );
        let url = match self.ws_base.join(&path) {
            Ok(url) => url,
            Err(e) => {
                let err = ProviderError::Network(format!("bad WebSocket URL: {e}"));
                return stream::once(async { Err(err) }).boxed();
            }
        };
        let state = State {
            url,
            inst: inst.clone(),
            backoff: self.backoff,
            idle: self.idle,
            socket: None,
            delay: None,
        };
        stream::unfold(state, next_item).boxed()
    }
}

async fn next_item(mut st: State) -> Option<(Result<LiveCandle, ProviderError>, State)> {
    loop {
        let Some(socket) = st.socket.as_mut() else {
            if let Some(delay) = st.delay.take() {
                time::sleep(delay).await;
            }
            let connected = time::timeout(CONNECT_TIMEOUT, connect_async(st.url.as_str())).await;
            match connected {
                Ok(Ok((socket, _))) => st.socket = Some(socket),
                Ok(Err(e)) => {
                    let err = st.dropped(e);
                    return Some((Err(err), st));
                }
                Err(_) => {
                    let err = st.dropped("connect timed out");
                    return Some((Err(err), st));
                }
            }
            continue;
        };
        // Any frame (kline, ping, other text) counts as activity.
        let read = match time::timeout(st.idle, socket.next()).await {
            Ok(read) => read,
            Err(_) => {
                let err = st.dropped("idle timeout");
                return Some((Err(err), st));
            }
        };
        match read {
            Some(Ok(Message::Text(text))) => match WsEvent::parse(text.as_str(), &st.inst) {
                Ok(Some(live)) => {
                    st.backoff.reset();
                    return Some((Ok(live), st));
                }
                // Not a kline (e.g. a subscription reply).
                Ok(None) => {}
                Err(e) => return Some((Err(e), st)),
            },
            // Pings are answered by tungstenite on the next read/write.
            Some(Ok(Message::Close(_))) => {
                let err = st.dropped("closed by server");
                return Some((Err(err), st));
            }
            Some(Ok(_)) => {}
            Some(Err(e)) => {
                let err = st.dropped(e);
                return Some((Err(err), st));
            }
            None => {
                let err = st.dropped("connection ended");
                return Some((Err(err), st));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::Backoff;

    #[test]
    fn backoff_doubles_caps_and_resets() {
        let s = Duration::from_secs;
        let mut b = Backoff::new(s(1), s(30));
        let seq: Vec<_> = (0..7).map(|_| b.advance()).collect();
        assert_eq!(seq, [s(1), s(2), s(4), s(8), s(16), s(30), s(30)]);
        b.reset();
        assert_eq!(b.advance(), s(1));
    }
}
