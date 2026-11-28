"""Tests for updater_manifest.py. Run: python3 -m unittest discover -s scripts -p 'test_*.py'"""

import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "updater_manifest.py")
REPO = "kennnyz/sandchart"
TAG = "v0.2.0"

FILES = {
    "darwin-aarch64": "Sandchart_0.2.0_aarch64-apple-darwin.app.tar.gz",
    "darwin-x86_64": "Sandchart_0.2.0_x86_64-apple-darwin.app.tar.gz",
    "windows-x86_64": "Sandchart_0.2.0_x64-setup.exe",
    "linux-x86_64": "Sandchart_0.2.0_amd64.AppImage",
}


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.out = os.path.join(self.dir, "latest.json")
        for platform, name in FILES.items():
            self.write(name, "bundle")
            self.write(name + ".sig", f"  sig-{platform}\n")
        # Files that must be ignored.
        self.write("Sandchart_0.2.0_aarch64.dmg", "dmg")
        self.write("Sandchart_0.2.0_amd64.deb", "deb")
        self.write("sandchart-indicator-x86_64-apple-darwin.tar.gz", "cli")
        self.write("sandchart-mcp-aarch64-apple-darwin.tar.gz", "mcp")
        self.write("sandchart-mcp-x86_64-pc-windows-msvc.zip", "mcp")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as f:
            f.write(text)

    def run_script(self, tag=TAG):
        return subprocess.run(
            [sys.executable, SCRIPT, "--dir", self.dir, "--tag", tag, "--repo", REPO,
             "--notes", "See the release page.", "--out", self.out],
            capture_output=True, text=True,
        )

    def assert_fails(self, result, needle):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(needle, result.stderr)
        self.assertFalse(os.path.exists(self.out), "no manifest on failure")

    def test_four_platforms(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.out, encoding="utf-8") as f:
            manifest = json.load(f)
        self.assertEqual(set(manifest), {"version", "notes", "pub_date", "platforms"})
        self.assertEqual(manifest["version"], "0.2.0")
        self.assertEqual(manifest["notes"], "See the release page.")
        pub = datetime.datetime.fromisoformat(manifest["pub_date"].replace("Z", "+00:00"))
        self.assertEqual(pub.utcoffset(), datetime.timedelta(0))
        self.assertEqual(set(manifest["platforms"]), set(FILES))
        for platform, name in FILES.items():
            entry = manifest["platforms"][platform]
            self.assertEqual(set(entry), {"signature", "url"})
            self.assertEqual(entry["signature"], f"sig-{platform}")
            self.assertEqual(
                entry["url"],
                f"https://github.com/{REPO}/releases/download/{TAG}/{name}",
            )

    def test_version_strips_only_leading_v(self):
        result = self.run_script(tag="v1.10.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        with open(self.out, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["version"], "1.10.0")

    def test_missing_windows(self):
        os.remove(os.path.join(self.dir, FILES["windows-x86_64"]))
        os.remove(os.path.join(self.dir, FILES["windows-x86_64"] + ".sig"))
        self.assert_fails(self.run_script(), "windows-x86_64")

    def test_missing_sig(self):
        os.remove(os.path.join(self.dir, FILES["linux-x86_64"] + ".sig"))
        self.assert_fails(self.run_script(), FILES["linux-x86_64"] + ".sig")

    def test_empty_sig(self):
        self.write(FILES["darwin-x86_64"] + ".sig", " \n")
        self.assert_fails(self.run_script(), FILES["darwin-x86_64"] + ".sig")

    def test_two_archives_for_one_platform(self):
        extra = "Sandchart_0.1.0_aarch64-apple-darwin.app.tar.gz"
        self.write(extra, "old")
        self.write(extra + ".sig", "sig")
        self.assert_fails(self.run_script(), "darwin-aarch64")

    def test_bad_tag(self):
        self.assert_fails(self.run_script(tag="v"), "tag")


if __name__ == "__main__":
    unittest.main()
