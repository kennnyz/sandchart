//! `new`: writes the project template.

use std::fs;
use std::path::Path;
use std::process::ExitCode;

use sandchart_indicators::is_user_id;

const FILES: [(&str, &str); 6] = [
    ("Cargo.toml", include_str!("../template/Cargo.toml.tmpl")),
    ("src/lib.rs", include_str!("../template/src/lib.rs.tmpl")),
    ("AGENTS.md", include_str!("../template/AGENTS.md.tmpl")),
    ("README.md", include_str!("../template/README.md.tmpl")),
    (".gitignore", include_str!("../template/.gitignore.tmpl")),
    (
        "rust-toolchain.toml",
        include_str!("../template/rust-toolchain.toml.tmpl"),
    ),
];

pub fn run(name: &str) -> Result<ExitCode, String> {
    check_name(name)?;
    let dir = Path::new(name);
    if dir.exists() {
        return Err(format!("{name} already exists"));
    }
    for (file, template) in FILES {
        let path = dir.join(file);
        let write = || -> std::io::Result<()> {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, template.replace("{{name}}", name))
        };
        write().map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    }
    println!("created {name}/");
    println!(
        "next: cd {name} && sandchart-indicator build && sandchart-indicator test target/wasm32-wasip2/release/{}.wasm",
        name.replace('-', "_")
    );
    Ok(ExitCode::SUCCESS)
}

/// The name is a Cargo package name and the second half of the id `local.<name>`.
fn check_name(name: &str) -> Result<(), String> {
    let package_ok = name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !package_ok || !is_user_id(&format!("local.{name}")) {
        return Err(format!(
            "invalid name \"{name}\": use lower-case letters, digits, '-' and '_', starting with a letter"
        ));
    }
    Ok(())
}
