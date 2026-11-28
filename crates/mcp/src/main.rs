//! `sandchart-mcp`: the Sandchart MCP server over stdio. Stdout carries only JSON-RPC;
//! everything else goes to stderr.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use rmcp::ServiceExt;
use sandchart_data::Binance;
use sandchart_engine::Engine;
use sandchart_mcp::Sandchart;

const USAGE: &str = "\
Usage: sandchart-mcp [--data-dir <dir>]

The Sandchart MCP server. Speaks the Model Context Protocol over stdin and stdout;
start it from an MCP client, e.g. `claude mcp add sandchart -- sandchart-mcp`.

Options:
  --data-dir <dir>  Use this data folder instead of the app's
  -h, --help        Show this help
  -V, --version     Show the version";

/// The app's folders (`directories::ProjectDirs`, as in the Tauri shell), or `--data-dir`.
struct Dirs {
    data: PathBuf,
    cache: Option<PathBuf>,
}

enum Args {
    Run(Dirs),
    Help,
    Version,
}

fn parse(mut args: impl Iterator<Item = std::ffi::OsString>) -> Result<Args, String> {
    let mut data = None;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("-h" | "--help") => return Ok(Args::Help),
            Some("-V" | "--version") => return Ok(Args::Version),
            Some("--data-dir") => {
                let dir = args.next().ok_or("--data-dir needs a folder")?;
                data = Some(PathBuf::from(dir));
            }
            _ => return Err(format!("unknown argument {arg:?}\n\n{USAGE}")),
        }
    }
    let app = directories::ProjectDirs::from("", "", "Sandchart");
    let cache = app.as_ref().map(|d| d.cache_dir().join("indicators"));
    let data = match data {
        Some(d) => d,
        None => app
            .ok_or("cannot find the OS data directory; pass --data-dir")?
            .data_dir()
            .to_path_buf(),
    };
    Ok(Args::Run(Dirs { data, cache }))
}

async fn run(dirs: Dirs) -> Result<(), String> {
    std::fs::create_dir_all(&dirs.data)
        .map_err(|e| format!("cannot create {}: {e}", dirs.data.display()))?;
    let engine = Engine::open_secondary(
        &dirs.data,
        dirs.cache.as_deref(),
        vec![Arc::new(Binance::default_hosts())],
    )
    .map_err(|e| format!("cannot open {}: {e}", dirs.data.display()))?;
    let service = Sandchart::new(Arc::new(engine))
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| format!("the MCP session did not start: {e}"))?;
    service
        .waiting()
        .await
        .map_err(|e| format!("the MCP session failed: {e}"))?;
    Ok(())
}

fn main() -> ExitCode {
    let dirs = match parse(std::env::args_os().skip(1)) {
        Ok(Args::Run(dirs)) => dirs,
        Ok(Args::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Args::Version) => {
            println!("sandchart-mcp {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("sandchart-mcp: {e}");
            return ExitCode::FAILURE;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("sandchart-mcp: cannot start the runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    let result = runtime.block_on(run(dirs));
    // A pending stdin read cannot be cancelled; do not wait for it on the way out.
    runtime.shutdown_timeout(std::time::Duration::from_secs(1));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("sandchart-mcp: {e}");
            ExitCode::FAILURE
        }
    }
}
