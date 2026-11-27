# ADR 0003: Self-update

Date: 2026-11-28. Status: accepted.

## Context

Until 0.2 a user had to find the Releases page, pick the right file and reinstall by hand. Most will not, so fixes would not reach them. Sandchart has no server and no accounts, and builds are not signed with OS code-signing certificates, so any update path must not lean on either. An update replaces the program the user runs, so it must be impossible for anyone but the project to publish one that the app accepts. GitHub Releases is already where builds live.

## Decision

1. **The Tauri updater plugin, with a static `latest.json` on the release.** The app fetches `https://github.com/kennnyz/sandchart/releases/latest/download/latest.json`. The release workflow writes that file (`scripts/updater_manifest.py`) with the URL and signature of one bundle per platform: `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`. The plugin downloads the bundle, verifies its minisign signature against the public key in `plugins.updater.pubkey` (`tauri.conf.json`), installs it, and the app restarts. All logic is in Rust (`app/src-tauri/src/update.rs`); the UI only decides when to check and draws the banner. No JS updater or process plugin is used.
2. **The signing key belongs to the owner.** The owner generates it with `tauri signer generate`, protects it with a password, and keeps the key file and the password in a password manager. The public key is committed. The private key and password exist as the repository secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which only the build job's tauri-action step receives. They are never in the repo or in logs. GitHub secrets cannot be read back, so the password manager is the only backup.
3. **What losing the key means.** If the private key or its password is lost, no new update can be signed with the key that installed copies trust. Those copies accept no further update. Users must download and install a new build by hand, and that build carries a new public key. Treat the backup as part of releasing.
4. **Key rotation while the old key still works.** Ship one release signed with the old key whose `tauri.conf.json` already holds the new public key. Users update to it as usual. Then replace both secrets with the new key and sign later releases with it. Do not switch the secrets first: copies in the field would reject the update.
5. **The check is on by default, with a switch.** The first check runs 10 s after start, then one is due when 24 h have passed since the last, looked for every hour against the wall clock (a monotonic timer stops while a laptop sleeps). The user turns it off with "Check automatically" in the version popover (`localStorage` key `sandchart.updates.auto`); a manual check still works. The request goes to `github.com`, which redirects to `release-assets.githubusercontent.com`; both are listed in the README and in the popover. Nothing about the user is sent. A failed automatic check is silent and retried later; a failed manual check or download shows the error and Retry.
6. **Windows ships NSIS, per user, and no MSI.** `bundle.windows.nsis.installMode` is `currentUser`, so install and update need no administrator rights and show no elevation prompt. The updater runs the installer in `passive` mode. The Windows updater file is the `-setup.exe` itself.
7. **The draft release is the gate.** The workflow only creates a draft. The owner checks `latest.json` (four platforms, each with a `url` and a `signature`) and publishes it as the latest release, not a pre-release. `releases/latest` ignores drafts and pre-releases, so installed apps see nothing until that step.
8. **Network timeouts.** The updater's HTTP client gets a 15 s connect timeout and a 30 s read (idle) timeout, so a stalled connection fails instead of hanging; a download that keeps receiving bytes may take longer. A whole check is limited to 30 s. The plugin has none of these by default.
9. **Where the app cannot update itself, it says so and installs nothing.** On macOS, a copy running from `/Volumes/` (the disk image) or from an `AppTranslocation` path (a quarantined app started from Downloads) is on a read-only path that cannot be replaced; the banner asks the user to move Sandchart to Applications. On Linux only an AppImage (the `APPIMAGE` variable is set) updates in the app; a `.deb` is owned by the package manager and gets a link to the release page. The check is done in Rust before any install.
10. **Database migrations only go forward.** 0.2 migrates the SQLite file on first start. 0.1 refuses a newer schema, so an update cannot be undone by installing 0.1 again. Data is kept.

## Alternatives considered

- **A "new version available" link only.** No signing key and no risk, but the user still downloads and installs by hand. That is the status quo that left users on old builds.
- **Nothing.** Cheapest. Users stay on old versions, including ones with known bugs.
- **MSI on Windows.** Installs per machine and needs administrator rights, which a self-updating app cannot get without a prompt each time. NSIS per user avoids it.
- **A hosted update server.** Could stage rollouts, but it is a service to run, pay for and secure, and it would be a new host that sees every user's IP. A static file on GitHub needs none of it.
- **OS code signing to protect updates.** Costs money and still leaves the updater needing its own integrity check on Linux. The project key covers all platforms.
- **Updating the `.deb` in the app.** It needs root and the package manager's database. Out of scope; the link to the release page is enough.

## Consequences

- One long-lived secret decides which updates installed copies accept. Losing it strands them (decision 3). A leak is handled like a rotation (decision 4), and at once, because whoever holds the key and can also change the project's releases can ship code to every copy.
- Every release needs the owner to look at the draft and publish it. A tag alone never reaches users.
- A bad release published as latest reaches users within a day. Take it down at once (unpublish it) and publish a fixed, higher version; a version number is never reused.
- The app now makes requests to GitHub by default. The README privacy section lists them and the switch.
- A macOS user who runs from the DMG or Downloads must move the app once before updating works.
- `.deb` users update by installing the new package themselves.
- The first release with the updater (0.2) cannot be reached by update from 0.1, which has no updater. 0.1 users install 0.2 by hand once.
