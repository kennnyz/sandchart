//! In-app updates: check the release manifest and install a signed update.
//! The plugin does the download, the signature check and the install; this module decides
//! whether this copy may update itself and turns the plugin's errors into readable causes.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Error, Update, UpdaterExt};
use time::format_description::well_known::Rfc3339;

use crate::dto::{InstallBlocker, ProblemDto, UpdateInfoDto, UpdateProgressDto};

/// Shortest gap between two `chunk` messages: at most 20 a second reach the UI.
const CHUNK_INTERVAL: Duration = Duration::from_millis(50);

/// The update found by the last check, kept for `install_update`.
#[derive(Default)]
pub struct UpdaterState(Mutex<Option<Update>>);

impl UpdaterState {
    fn lock(&self) -> MutexGuard<'_, Option<Update>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Whether this copy cannot replace itself. `os` is `std::env::consts::OS`, `appimage_env` the
/// `APPIMAGE` variable the AppImage runtime sets, `exe` the running binary.
pub fn install_blocker(os: &str, appimage_env: Option<&str>, exe: &Path) -> Option<InstallBlocker> {
    match os {
        // The manifest's `linux-x86_64` entry is the AppImage; a `.deb` install must not get it.
        "linux" if appimage_env.is_none_or(str::is_empty) => Some(InstallBlocker::NotAppImage),
        // A translocated or DMG-mounted app sits on a read-only path that cannot be replaced.
        "macos"
            if exe.to_string_lossy().contains("/AppTranslocation/")
                || exe.starts_with("/Volumes/") =>
        {
            Some(InstallBlocker::Translocated)
        }
        _ => None,
    }
}

fn current_blocker() -> Result<Option<InstallBlocker>, ProblemDto> {
    let exe = std::env::current_exe()
        .map_err(|e| ProblemDto::other(format!("cannot find the app's own path: {e}")))?;
    let appimage = std::env::var("APPIMAGE").ok();
    Ok(install_blocker(
        std::env::consts::OS,
        appimage.as_deref(),
        &exe,
    ))
}

/// The plugin's error as a problem whose message names the cause.
fn update_problem(e: &Error) -> ProblemDto {
    ProblemDto::other(match e {
        Error::Reqwest(r) if r.is_decode() => format!("the update manifest is malformed: {e}"),
        Error::Reqwest(_) => format!("could not reach the update server: {e}"),
        // Its Display wraps the text in backticks.
        Error::Network(s) => format!("the update download failed: {s}"),
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => "the update signature is not valid".to_owned(),
        Error::Serialization(_)
        | Error::Semver(_)
        | Error::UrlParse(_)
        | Error::TargetNotFound(_)
        | Error::TargetsNotFound(_) => format!("the update manifest is malformed: {e}"),
        Error::ReleaseNotFound => {
            "the update server has no release manifest (no release yet, or the server failed)"
                .to_owned()
        }
        Error::Io(_)
        | Error::FailedToDetermineExtractPath
        | Error::TempDirNotFound
        | Error::TempDirNotOnSameMountPoint
        | Error::PreviousAppNotRestored(_)
        | Error::BinaryNotFoundInArchive
        | Error::InvalidUpdaterFormat
        | Error::AuthenticationFailed
        | Error::DebInstallFailed
        | Error::PackageInstallFailed => format!("could not install the update: {e}"),
        _ => e.to_string(),
    })
}

fn fail(e: Error) -> ProblemDto {
    // The signature message drops the plugin's detail; the log keeps it.
    eprintln!("update failed: {e}");
    update_problem(&e)
}

/// Turns the plugin's download callbacks into channel messages.
#[derive(Default)]
struct Progress {
    started: bool,
    downloaded: u64,
    /// `downloaded` as of the last `chunk` message.
    sent: u64,
    last_sent_at: Option<Instant>,
}

impl Progress {
    fn chunk(&mut self, len: usize, total: Option<u64>, now: Instant) -> Vec<UpdateProgressDto> {
        let mut out = Vec::new();
        if !self.started {
            self.started = true;
            out.push(UpdateProgressDto::Started { total });
        }
        self.downloaded += len as u64;
        if self
            .last_sent_at
            .is_none_or(|t| now.duration_since(t) >= CHUNK_INTERVAL)
        {
            self.last_sent_at = Some(now);
            self.sent = self.downloaded;
            out.push(UpdateProgressDto::Chunk {
                downloaded: self.downloaded,
            });
        }
        out
    }

    /// The download is complete and verified: flush the count, then announce the install.
    fn finish(&mut self) -> Vec<UpdateProgressDto> {
        let mut out = Vec::new();
        if !self.started {
            self.started = true;
            out.push(UpdateProgressDto::Started { total: None });
        }
        if self.sent != self.downloaded {
            self.sent = self.downloaded;
            out.push(UpdateProgressDto::Chunk {
                downloaded: self.downloaded,
            });
        }
        out.push(UpdateProgressDto::Installing);
        out
    }
}

/// Asks the update server for a newer version; `None` when this one is the latest.
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<Option<UpdateInfoDto>, ProblemDto> {
    let update = app.updater().map_err(fail)?.check().await.map_err(fail)?;
    let info = match &update {
        Some(u) => Some(UpdateInfoDto {
            version: u.version.clone(),
            notes: u.body.clone().unwrap_or_default(),
            date: u.date.and_then(|d| d.format(&Rfc3339).ok()),
            blocker: current_blocker()?,
        }),
        None => None,
    };
    *state.lock() = update;
    Ok(info)
}

/// Downloads, verifies and installs the update of the last check, then restarts the app.
/// On Windows the plugin starts the installer and ends the process itself.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    on_progress: Channel<UpdateProgressDto>,
) -> Result<(), ProblemDto> {
    // Our own check, whatever the plugin would do: it never runs where it cannot install.
    if let Some(blocker) = current_blocker()? {
        return Err(ProblemDto::other(match blocker {
            InstallBlocker::NotAppImage => {
                "this copy is not an AppImage; download the update from the release page"
            }
            InstallBlocker::Translocated => "move Sandchart to Applications, then update",
        }));
    }
    // Taken out, so no lock is held across the download and a second call cannot install
    // the same update twice. A failed attempt puts nothing back: the next one needs a fresh
    // check, which also catches a release published meanwhile.
    let update = state
        .lock()
        .take()
        .ok_or_else(|| ProblemDto::other("check for updates first"))?;
    let progress = Mutex::new(Progress::default());
    let send = |messages: Vec<UpdateProgressDto>| {
        for m in messages {
            if let Err(e) = on_progress.send(m) {
                eprintln!("cannot send update progress: {e}");
            }
        }
    };
    let lock = || progress.lock().unwrap_or_else(|p| p.into_inner());
    update
        .download_and_install(
            |len, total| send(lock().chunk(len, total, Instant::now())),
            || send(lock().finish()),
        )
        .await
        .map_err(fail)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{Duration, Instant};
    use tauri_plugin_updater::Error;

    #[test]
    fn install_blocker_table() {
        let mac_app = Path::new("/Applications/Sandchart.app/Contents/MacOS/sandchart-app");
        let cases: &[(&str, Option<&str>, &str, Option<InstallBlocker>)] = &[
            (
                "linux",
                None,
                "/usr/bin/sandchart-app",
                Some(InstallBlocker::NotAppImage),
            ),
            (
                "linux",
                Some(""),
                "/usr/bin/sandchart-app",
                Some(InstallBlocker::NotAppImage),
            ),
            (
                "linux",
                Some("/home/u/Sandchart.AppImage"),
                "/tmp/.mount_x/sandchart-app",
                None,
            ),
            (
                "macos",
                None,
                "/private/var/folders/xy/T/AppTranslocation/1234/d/Sandchart.app/Contents/MacOS/sandchart-app",
                Some(InstallBlocker::Translocated),
            ),
            (
                "macos",
                None,
                "/Volumes/Sandchart/Sandchart.app/Contents/MacOS/sandchart-app",
                Some(InstallBlocker::Translocated),
            ),
            ("macos", None, mac_app.to_str().unwrap(), None),
            // APPIMAGE means nothing outside Linux.
            (
                "macos",
                Some("/x.AppImage"),
                mac_app.to_str().unwrap(),
                None,
            ),
            (
                "windows",
                None,
                r"C:\Users\u\AppData\Local\Sandchart\sandchart-app.exe",
                None,
            ),
            ("windows", Some(""), "/Volumes/Sandchart/x.exe", None),
        ];
        for (os, appimage, exe, want) in cases {
            assert_eq!(
                install_blocker(os, *appimage, Path::new(exe)),
                *want,
                "{os} {appimage:?} {exe}"
            );
        }
    }

    #[test]
    fn errors_name_their_cause() {
        let msg = |e: Error| update_problem(&e).message;
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert!(
            msg(Error::Network("status 404".into())).starts_with("the update download failed: ")
        );
        assert_eq!(
            msg(Error::Network("status 404".into())),
            "the update download failed: status 404"
        );
        assert_eq!(
            msg(Error::SignatureUtf8("x".into())),
            "the update signature is not valid"
        );
        assert_eq!(
            msg(Error::SignedVersionMismatch {
                signed: "0.2.0".into(),
                announced: "0.3.0".into()
            }),
            "the update signature is not valid"
        );
        assert_eq!(
            msg(Error::MissingSignedVersion),
            "the update signature is not valid"
        );
        let bad_json = serde_json::from_str::<u8>("{").unwrap_err();
        assert!(
            msg(Error::Serialization(bad_json)).starts_with("the update manifest is malformed: ")
        );
        assert!(
            msg(Error::TargetNotFound("linux-x86_64".into()))
                .starts_with("the update manifest is malformed: ")
        );
        assert!(
            msg(Error::ReleaseNotFound).starts_with("the update server has no release manifest")
        );
        assert!(msg(Error::Io(io)).starts_with("could not install the update: "));
        // Anything else keeps the plugin's own text.
        assert_eq!(
            msg(Error::UnsupportedArch),
            Error::UnsupportedArch.to_string()
        );
        assert_eq!(
            update_problem(&Error::ReleaseNotFound).code,
            crate::dto::ProblemCode::Other
        );
    }

    #[test]
    fn progress_starts_once_and_throttles_chunks() {
        let t0 = Instant::now();
        let ms = |n| t0 + Duration::from_millis(n);
        let mut p = Progress::default();
        assert_eq!(
            p.chunk(100, Some(1000), ms(0)),
            [
                UpdateProgressDto::Started { total: Some(1000) },
                UpdateProgressDto::Chunk { downloaded: 100 }
            ]
        );
        // Inside the 50 ms window: nothing goes out, but the count goes on.
        assert!(p.chunk(100, Some(1000), ms(10)).is_empty());
        assert!(p.chunk(100, Some(1000), ms(49)).is_empty());
        assert_eq!(
            p.chunk(100, Some(1000), ms(50)),
            [UpdateProgressDto::Chunk { downloaded: 400 }]
        );
        assert!(p.chunk(100, Some(1000), ms(60)).is_empty());
        // The end flushes the last count, then says it installs.
        assert_eq!(
            p.finish(),
            [
                UpdateProgressDto::Chunk { downloaded: 500 },
                UpdateProgressDto::Installing
            ]
        );
    }

    #[test]
    fn progress_at_most_twenty_chunks_a_second() {
        let t0 = Instant::now();
        let mut p = Progress::default();
        let mut sent = 0;
        for i in 0..10_000u64 {
            // A chunk every 0.1 ms for one second.
            let out = p.chunk(10, None, t0 + Duration::from_micros(i * 100));
            sent += out
                .iter()
                .filter(|m| matches!(m, UpdateProgressDto::Chunk { .. }))
                .count();
        }
        assert!(sent <= 20, "{sent} chunk messages in one second");
    }

    #[test]
    fn progress_finish_without_chunks_still_starts_and_without_news_skips_the_chunk() {
        let t0 = Instant::now();
        let mut p = Progress::default();
        assert_eq!(
            p.finish(),
            [
                UpdateProgressDto::Started { total: None },
                UpdateProgressDto::Installing
            ]
        );
        let mut p = Progress::default();
        p.chunk(5, None, t0);
        assert_eq!(p.finish(), [UpdateProgressDto::Installing]);
    }
}
