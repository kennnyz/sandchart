//! WASI stubs that keep a host call from blocking or growing without bound:
//! a monotonic clock that never moves (so a sleep returns at once) and a log
//! stream that keeps the first bytes and drops the rest.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use bytes::Bytes;
use wasmtime::component::{HasData, Linker, Resource, ResourceTable};
use wasmtime_wasi::cli::{IsTerminal, StdoutStream};
use wasmtime_wasi::p2::bindings::clocks::monotonic_clock;
use wasmtime_wasi::p2::{DynPollable, OutputStream, Pollable, StreamResult, subscribe};

use crate::sandbox::HostState;

/// Replaces `wasi:clocks/monotonic-clock` from wasmtime-wasi. Its `now` is 0,
/// and every subscription is ready at once: time does not pass in the
/// sandbox, so `sleep` and poll timeouts return immediately instead of
/// blocking the host thread, where neither fuel nor the epoch can stop them.
pub(crate) fn add_frozen_clock(linker: &mut Linker<HostState>) -> wasmtime::Result<()> {
    linker.allow_shadowing(true);
    let added = monotonic_clock::add_to_linker::<HostState, FrozenClock>(linker, |s| {
        FrozenClockView { table: s.table() }
    });
    linker.allow_shadowing(false);
    added
}

struct FrozenClock;

impl HasData for FrozenClock {
    type Data<'a> = FrozenClockView<'a>;
}

struct FrozenClockView<'a> {
    table: &'a mut ResourceTable,
}

impl FrozenClockView<'_> {
    fn ready(&mut self) -> wasmtime::Result<Resource<DynPollable>> {
        let ready = self.table.push(Ready)?;
        subscribe(self.table, ready)
    }
}

impl monotonic_clock::Host for FrozenClockView<'_> {
    fn now(&mut self) -> wasmtime::Result<monotonic_clock::Instant> {
        Ok(0)
    }

    fn resolution(&mut self) -> wasmtime::Result<monotonic_clock::Duration> {
        Ok(1)
    }

    fn subscribe_instant(
        &mut self,
        _when: monotonic_clock::Instant,
    ) -> wasmtime::Result<Resource<DynPollable>> {
        self.ready()
    }

    fn subscribe_duration(
        &mut self,
        _duration: monotonic_clock::Duration,
    ) -> wasmtime::Result<Resource<DynPollable>> {
        self.ready()
    }
}

/// A pollable that is always ready.
struct Ready;

#[wasmtime_wasi::async_trait]
impl Pollable for Ready {
    async fn ready(&mut self) {}
}

/// stdout and stderr of one call: keeps the first `limit` bytes and accepts
/// and drops the rest, so a chatty module neither traps nor grows host memory.
#[derive(Clone)]
pub(crate) struct LogPipe {
    buf: Arc<Mutex<Vec<u8>>>,
    limit: usize,
}

/// How much a guest may write in one go; any size works since excess is dropped.
const WRITE_PERMIT: usize = 64 * 1024;

impl LogPipe {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            buf: Arc::default(),
            limit,
        }
    }

    /// What was kept, and whether anything was dropped.
    pub(crate) fn contents(&self) -> (Vec<u8>, bool) {
        let buf = self.buf.lock().unwrap_or_else(|e| e.into_inner());
        (buf.clone(), buf.len() > self.limit)
    }

    fn append(&self, bytes: &[u8]) {
        let mut buf = self.buf.lock().unwrap_or_else(|e| e.into_inner());
        // One byte past the limit marks that the log was cut.
        let room = (self.limit + 1).saturating_sub(buf.len());
        buf.extend_from_slice(&bytes[..bytes.len().min(room)]);
    }
}

impl IsTerminal for LogPipe {
    fn is_terminal(&self) -> bool {
        false
    }
}

impl StdoutStream for LogPipe {
    fn p2_stream(&self) -> Box<dyn OutputStream> {
        Box::new(self.clone())
    }

    fn async_stream(&self) -> Box<dyn tokio::io::AsyncWrite + Send + Sync> {
        Box::new(self.clone())
    }
}

#[wasmtime_wasi::async_trait]
impl Pollable for LogPipe {
    async fn ready(&mut self) {}
}

impl OutputStream for LogPipe {
    fn write(&mut self, bytes: Bytes) -> StreamResult<()> {
        self.append(&bytes);
        Ok(())
    }

    fn flush(&mut self) -> StreamResult<()> {
        Ok(())
    }

    fn check_write(&mut self) -> StreamResult<usize> {
        Ok(WRITE_PERMIT)
    }
}

impl tokio::io::AsyncWrite for LogPipe {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.append(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_pipe_keeps_the_first_bytes() {
        let mut pipe = LogPipe::new(4);
        pipe.write(Bytes::from_static(b"abc")).unwrap();
        assert_eq!(pipe.contents(), (b"abc".to_vec(), false));
        pipe.write(Bytes::from_static(b"defgh")).unwrap();
        pipe.write(Bytes::from_static(b"ijk")).unwrap();
        let (kept, cut) = pipe.contents();
        assert!(cut);
        assert_eq!(&kept[..4], b"abcd");
        assert_eq!(pipe.check_write().unwrap(), WRITE_PERMIT);
    }
}
