//! `sandchart-indicator`: create, build and test a Sandchart indicator. `test`
//! runs the module in the same host the app uses, so what passes here loads
//! and draws in the app.

mod build;
mod csv;
mod new;
mod test;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a new indicator project in ./<NAME>
    New {
        /// Lower-case name: letters, digits, `-` and `_`, starting with a letter.
        /// The indicator id becomes `local.<NAME>`.
        name: String,
    },
    /// Build the project for wasm32-wasip2 and check that the app can load it
    Build {
        /// The project directory
        #[arg(long, default_value = ".")]
        path: PathBuf,
    },
    /// Run a built module on candles and report what the app would see
    Test {
        /// The built `.wasm` file
        file: PathBuf,
        /// Candles as CSV with the header `time,open,high,low,close,volume`
        /// (time in Unix milliseconds, oldest first); default: 2000 generated bars
        #[arg(long)]
        csv: Option<PathBuf>,
        /// Set a parameter, as `id=value`; repeat for more
        #[arg(long = "param", value_name = "ID=VALUE")]
        params: Vec<String>,
        /// Print one JSON object instead of text
        #[arg(long)]
        json: bool,
    },
}

fn main() -> ExitCode {
    let result = match Cli::parse().command {
        Command::New { name } => new::run(&name),
        Command::Build { path } => build::run(&path),
        Command::Test {
            file,
            csv,
            params,
            json,
        } => test::run(&file, csv.as_deref(), &params, json),
    };
    match result {
        Ok(code) => code,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}
