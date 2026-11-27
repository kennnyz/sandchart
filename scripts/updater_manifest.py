#!/usr/bin/env python3
"""Write the Tauri updater manifest (latest.json) for a release.

Usage:
  scripts/updater_manifest.py --dir DIR --tag TAG --repo OWNER/NAME --notes TEXT --out FILE

DIR holds the release files and their .sig files. Every platform below must
match exactly one file with a non-empty .sig next to it, or the script exits 1
and writes nothing.
"""

import argparse
import datetime
import json
import os
import re
import sys

# Platform key in latest.json -> file name suffix in the release.
PLATFORMS = {
    "darwin-aarch64": "_aarch64-apple-darwin.app.tar.gz",
    "darwin-x86_64": "_x86_64-apple-darwin.app.tar.gz",
    "windows-x86_64": "-setup.exe",
    "linux-x86_64": ".AppImage",
}

TAG_RE = re.compile(r"^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$")


class ManifestError(Exception):
    pass


def build_manifest(directory, tag, repo, notes, now):
    match = TAG_RE.match(tag)
    if not match:
        raise ManifestError(f"tag {tag!r} is not v<semver>")
    names = sorted(os.listdir(directory))
    platforms = {}
    for platform, suffix in PLATFORMS.items():
        found = [n for n in names if n.endswith(suffix)]
        if not found:
            raise ManifestError(f"{platform}: no file ending in {suffix!r} in {directory}")
        if len(found) > 1:
            raise ManifestError(f"{platform}: more than one file ending in {suffix!r}: {', '.join(found)}")
        name = found[0]
        sig_path = os.path.join(directory, name + ".sig")
        try:
            with open(sig_path, encoding="utf-8") as f:
                signature = f.read().strip()
        except FileNotFoundError:
            raise ManifestError(f"{platform}: signature {name}.sig is missing") from None
        if not signature:
            raise ManifestError(f"{platform}: signature {name}.sig is empty")
        platforms[platform] = {
            "signature": signature,
            "url": f"https://github.com/{repo}/releases/download/{tag}/{name}",
        }
    return {
        "version": match.group(1),
        "notes": notes,
        "pub_date": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }


def main():
    parser = argparse.ArgumentParser(description="Write the Tauri updater latest.json.")
    parser.add_argument("--dir", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--repo", required=True, help="OWNER/NAME")
    parser.add_argument("--notes", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        print(f"updater_manifest: repo {args.repo!r} is not OWNER/NAME", file=sys.stderr)
        return 1
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        manifest = build_manifest(args.dir, args.tag, args.repo, args.notes, now)
    except ManifestError as e:
        print(f"updater_manifest: {e}", file=sys.stderr)
        return 1
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
