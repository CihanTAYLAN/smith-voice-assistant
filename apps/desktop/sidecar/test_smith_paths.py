"""Veri koku cozumleme testleri (smith_paths.py ve onu kullanan sidecar'lar).

Yalniz sentetik veri ve gecici dizin kullanir; gercek Smith veri dizinine YAZMAZ.
Kok cozumleme saf fonksiyonla (ortam disaridan verilir) sinanir, process env'ine
yalniz `patch.dict` ile ve kapsam icinde dokunulur.
"""

from __future__ import annotations

import contextlib
import importlib
import io
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import fs_xray_connector as fs
import intel_connector as intel
import machine_state_connector as machine
import smith_paths
import speaker_server as speaker

P = pathlib.Path


class ResolveDataRootTests(unittest.TestCase):
    def test_env_overrides_default(self):
        env = {"SMITH_DATA_DIR": "D:\\veri", "USERPROFILE": "C:\\Users\\x", "HOME": "/home/x"}
        for windows in (True, False):
            self.assertEqual(smith_paths.resolve_data_root(env, windows), P("D:\\veri"))

    def test_blank_env_is_unset_and_value_is_trimmed(self):
        for blank in ("", "   ", "\t"):
            env = {"SMITH_DATA_DIR": blank, "USERPROFILE": "C:\\Users\\x"}
            self.assertEqual(
                smith_paths.resolve_data_root(env, True), P("C:\\Users\\x") / ".smith", repr(blank)
            )
        self.assertEqual(
            smith_paths.resolve_data_root({"SMITH_DATA_DIR": "  D:\\veri  "}, True), P("D:\\veri")
        )

    def test_windows_default_is_userprofile_dot_smith(self):
        env = {
            "USERPROFILE": "C:\\Users\\x",
            "HOME": "/yanlis",
            "LOCALAPPDATA": "C:\\Users\\x\\AppData\\Local",
            "APPDATA": "C:\\Users\\x\\AppData\\Roaming",
        }
        self.assertEqual(smith_paths.resolve_data_root(env, True), P("C:\\Users\\x") / ".smith")

    def test_other_platforms_default_is_home_dot_smith(self):
        env = {"HOME": "/home/x", "XDG_DATA_HOME": "/home/x/.local/share"}
        self.assertEqual(smith_paths.resolve_data_root(env, False), P("/home/x") / ".smith")

    def test_other_home_variable_is_the_fallback(self):
        self.assertEqual(
            smith_paths.resolve_data_root({"HOME": "/c/Users/x"}, True), P("/c/Users/x") / ".smith"
        )
        self.assertEqual(
            smith_paths.resolve_data_root({"USERPROFILE": "C:\\Users\\x"}, False),
            P("C:\\Users\\x") / ".smith",
        )

    def test_appdata_is_never_a_fallback(self):
        env = {
            "LOCALAPPDATA": "C:\\Users\\x\\AppData\\Local",
            "APPDATA": "C:\\Users\\x\\AppData\\Roaming",
        }
        self.assertIsNone(smith_paths.resolve_data_root(env, True))
        self.assertIsNone(smith_paths.resolve_data_root(env, False))

    def test_data_root_reads_process_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"SMITH_DATA_DIR": tmp}):
                self.assertEqual(smith_paths.data_root(), P(tmp))
                # Cozumleme yan etkisiz: dizin olusturmaz, olan dizine dokunmaz.
            self.assertEqual(sorted(os.listdir(tmp)), [])


class ConsumersUseTheSingleRootTests(unittest.TestCase):
    def test_speaker_data_dir_is_under_the_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"SMITH_DATA_DIR": tmp}):
                d = speaker.data_dir()
                self.assertEqual(d, P(tmp) / "speaker")
                self.assertTrue(d.is_dir())
                self.assertEqual(speaker.owner_path(), P(tmp) / "speaker" / "owner.npy")
                self.assertEqual(speaker.owner_meta_path(), P(tmp) / "speaker" / "owner.json")
                self.assertEqual(speaker.adapt_path(), P(tmp) / "speaker" / "owner_adapt.npy")

    def test_awareness_connectors_follow_the_root_at_import(self):
        modules = (fs, intel, machine)
        with tempfile.TemporaryDirectory() as tmp:
            try:
                with patch.dict(os.environ, {"SMITH_DATA_DIR": tmp}):
                    for mod in modules:
                        importlib.reload(mod)
                        self.assertEqual(mod.STATE_DIR, P(tmp) / "awareness", mod.__name__)
                        self.assertEqual(mod.STATE_FILE.parent, mod.STATE_DIR, mod.__name__)
            finally:
                # Sonraki testlere sizmasin: gercek ortamla yeniden yukle.
                for mod in modules:
                    importlib.reload(mod)
        for mod in modules:
            self.assertEqual(mod.STATE_DIR, smith_paths.data_root() / "awareness", mod.__name__)


class LegacyNoticeTests(unittest.TestCase):
    def test_legacy_roots_windows_only_and_include_packages(self):
        with tempfile.TemporaryDirectory() as tmp:
            local = P(tmp)
            real = local / "smith"
            package = local / "Packages" / "Uygulama_abc123" / "LocalCache" / "Local" / "smith"
            other = local / "Packages" / "Baska_xyz"
            for d in (real, package, other):
                d.mkdir(parents=True)
            env = {"LOCALAPPDATA": str(local)}
            self.assertEqual(smith_paths.legacy_roots(env, True), [real, package])
            self.assertEqual(smith_paths.legacy_roots(env, False), [])
            self.assertEqual(smith_paths.legacy_roots({}, True), [])

    def test_notice_when_no_marker_and_legacy_has_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = P(tmp) / "kok"
            legacy = P(tmp) / "eski"
            (legacy / "speaker").mkdir(parents=True)
            (legacy / "speaker" / "owner.npy").write_bytes(b"x")

            msg = smith_paths.legacy_notice(root, [legacy])  # kok HIC yok: tam senaryo
            self.assertIsNotNone(msg)
            self.assertIn("veri koku bos", msg)
            self.assertIn("smith-migrate-data.ps1", msg)
            self.assertIn(str(legacy), msg)

            root.mkdir()
            (root / "window.json").write_text("{}")  # kok dolu ama isaret yok: yine uyari
            self.assertIsNotNone(smith_paths.legacy_notice(root, [legacy]))

            (root / smith_paths.MIGRATION_MARKER).write_text("{}")  # isaret: susar
            self.assertIsNone(smith_paths.legacy_notice(root, [legacy]))

    def test_no_notice_for_empty_locks_or_missing_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = P(tmp) / "kok"
            legacy = P(tmp) / "eski"
            legacy.mkdir()
            self.assertIsNone(smith_paths.legacy_notice(root, [legacy]), "bos dizin")
            for name in ("smith-up.lock", "x.tmp", "y.migrate-part"):
                (legacy / name).write_bytes(b"1")
            self.assertIsNone(smith_paths.legacy_notice(root, [legacy]), "kilit/gecici veri degil")
            self.assertIsNone(smith_paths.legacy_notice(root, [P(tmp) / "yok"]), "olmayan dizin")
            (legacy / "health.json").write_text("{}")
            self.assertIsNotNone(smith_paths.legacy_notice(root, [legacy]))

    def test_warn_prints_once_per_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = P(tmp) / "kok"
            legacy = P(tmp) / "eski"
            legacy.mkdir()
            (legacy / "health.json").write_text("{}")
            err = io.StringIO()
            with patch.dict(os.environ, {"SMITH_DATA_DIR": str(root)}), patch.object(
                smith_paths, "legacy_roots", return_value=[legacy]
            ), patch.object(smith_paths, "_legacy_warned", False), contextlib.redirect_stderr(err):
                smith_paths.warn_if_legacy_data()
                smith_paths.warn_if_legacy_data()
            lines = [line for line in err.getvalue().splitlines() if line.strip()]
            self.assertEqual(len(lines), 1, err.getvalue())
            self.assertIn("veri koku bos", lines[0])
            self.assertFalse(root.exists(), "uyari veri kokunu olusturmaz")


if __name__ == "__main__":
    unittest.main(verbosity=2)
