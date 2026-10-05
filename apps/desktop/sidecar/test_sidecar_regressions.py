"""Regression tests for sidecar connectors and local servers.

All tests use synthetic data and temporary directories. They never open a
microphone, contact the gateway, or write to the real Smith data directory.
"""

from __future__ import annotations

import contextlib
import io
import pathlib
import struct
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch

import numpy as np

import code_connector as code
import device_connector as device
import fs_xray_connector as fs
import github_connector as github
import intel_connector as intel
import machine_state_connector as machine
import obsidian_connector as obsidian
import speaker_server as speaker
import stt_server as stt


class ConnectorExitTests(unittest.TestCase):
    def test_machine_write_failure_is_nonzero(self):
        with patch.object(sys, "argv", ["machine_state_connector.py"]), patch.object(
            machine, "load_state", return_value={"kayitlar": {}}
        ), patch.object(machine, "collect_hardware", return_value={"cpu": "x"}), patch.object(
            machine, "collect_disks", return_value=[]
        ), patch.object(
            machine,
            "collect_services",
            return_value={"docker": [], "smith_acik": [], "smith_kapali": [4100]},
        ), patch.object(machine, "login", return_value="token"), patch.object(
            machine, "remember_with_backoff", return_value=500
        ), patch.object(machine.time, "sleep"):
            self.assertEqual(machine.main(), 1)

    def test_fs_write_failure_is_nonzero(self):
        root = Mock(key="tmp")
        with patch.object(sys, "argv", ["fs_xray_connector.py"]), patch.object(
            fs, "ROOTS", [root]
        ), patch.object(fs, "load_state", return_value={"roots": {}}), patch.object(
            fs, "scan_root", return_value=({"dosya": 1, "kismi": False}, [], 0.0)
        ), patch.object(fs, "build_content", return_value="content"), patch.object(
            fs, "login", return_value="token"
        ), patch.object(fs, "remember_with_backoff", return_value=500), patch.object(
            fs.time, "sleep"
        ):
            self.assertEqual(fs.main(), 1)

    def test_code_write_failure_is_nonzero(self):
        with patch.object(sys, "argv", ["code_connector.py", "--sleep", "0"]), patch.object(
            code, "discover_wsl_repos", return_value=([("repo", "/repo")], [])
        ), patch.object(code, "build_wsl_harvest_script", return_value=""), patch.object(
            code, "wsl_bash", return_value=""
        ), patch.object(code, "parse_harvest", return_value={"repo": {"branch": ["main"]}}), patch.object(
            code, "build_sections", return_value=({"ozet": "content"}, [])
        ), patch.object(code, "WIN_REPOS", []), patch.object(code, "login", return_value="token"), patch.object(
            code, "remember_with_backoff", return_value=500
        ), patch.object(code.time, "sleep"):
            self.assertEqual(code.main(), 1)

    def test_obsidian_write_failure_is_nonzero(self):
        with tempfile.TemporaryDirectory(prefix="obsidian-test-") as tmp:
            root = pathlib.Path(tmp)
            note = root / "note.md"
            note.write_text("a meaningful synthetic note for the test", encoding="utf-8")
            with patch.object(sys, "argv", ["obsidian_connector.py", "--sleep", "0"]), patch.object(
                obsidian, "ROOT", root
            ), patch.object(obsidian, "login", return_value="token"), patch.object(
                obsidian, "collect", return_value=[(0.0, note, "vault")]
            ), patch.object(obsidian, "remember_with_backoff", return_value=500), patch.object(
                obsidian.time, "sleep"
            ):
                self.assertEqual(obsidian.main(), 1)

    def test_github_write_failure_is_nonzero(self):
        record = {
            "name": "repo",
            "description": "description",
            "primaryLanguage": {"name": "Python"},
            "visibility": "PRIVATE",
            "pushedAt": "2026-01-01T00:00:00Z",
        }
        with patch.object(github, "login", return_value="token"), patch.object(
            github, "repos", return_value=[record]
        ), patch.object(github, "remember", return_value=500), patch.object(github.time, "sleep"):
            self.assertEqual(github.main(), 1)

    def test_device_write_failures_and_unreachable_server_are_reported(self):
        calls = []

        def remember(_token, _content, key):
            calls.append(key)
            return 500

        with patch.object(device, "login", return_value="token"), patch.object(
            device, "local_summary", return_value="synthetic local"
        ), patch.object(device, "ssh", side_effect=[(False, "down"), (False, "down")]), patch.object(
            device, "remember", side_effect=remember
        ):
            self.assertEqual(device.main(), 1)
        self.assertIn("device:server", calls)


class MachineStateTests(unittest.TestCase):
    def test_all_services_down_is_a_valid_snapshot(self):
        record = machine.service_records(
            {"docker": [], "smith_acik": [], "smith_kapali": sorted(machine.SMITH_PORTS)}
        )
        self.assertIsNotNone(record)
        self.assertEqual(record[0]["acik"], [])

    def test_service_probe_failure_is_not_all_services_down(self):
        with patch.object(machine, "run_cmd", return_value=None):
            self.assertIsNone(machine.collect_services())

    def test_disk_critical_transition_changes_snapshot(self):
        below, _ = machine.disk_records(
            [{"surucu": "C:", "etiket": "", "toplam_gb": 100, "bos_gb": 11, "dolu_pct": 89}]
        )
        critical, _ = machine.disk_records(
            [{"surucu": "C:", "etiket": "", "toplam_gb": 100, "bos_gb": 9, "dolu_pct": 91}]
        )
        self.assertNotEqual(below, critical)
        self.assertFalse(below["C:"]["kritik"])
        self.assertTrue(critical["C:"]["kritik"])


class FileSystemTests(unittest.TestCase):
    def test_partial_scan_is_not_posted_or_saved(self):
        root = Mock(key="tmp")
        state = {"roots": {"tmp": {"snapshot": {"dosya": 20, "kismi": False}}}}
        with patch.object(sys, "argv", ["fs_xray_connector.py"]), patch.object(
            fs, "ROOTS", [root]
        ), patch.object(fs, "load_state", return_value=state), patch.object(
            fs, "scan_root", return_value=({"dosya": 2, "kismi": True}, [], 0.0)
        ), patch.object(fs, "login", side_effect=AssertionError("partial scan must not post")), patch.object(
            fs, "save_state", side_effect=AssertionError("partial scan must not save")
        ):
            self.assertEqual(fs.main(), 0)
        self.assertEqual(state["roots"]["tmp"]["snapshot"]["dosya"], 20)

    def test_root_dotfile_stays_dotfile_and_is_blacklisted(self):
        with tempfile.TemporaryDirectory(prefix="fs-dotfile-") as tmp:
            root = pathlib.Path(tmp)
            (root / ".env").write_text("SECRET=synthetic", encoding="utf-8")
            entries, skipped, partial = fs.walk_windows(root, float("inf"))
            self.assertFalse(partial)
            self.assertEqual(entries, [])
            self.assertTrue(any(".env" in item for item in skipped))

    def test_code_fallback_preserves_root_dotfile_name(self):
        with tempfile.TemporaryDirectory(prefix="code-dotfile-") as tmp:
            root = pathlib.Path(tmp)
            (root / ".env").write_text("SECRET=synthetic", encoding="utf-8")
            self.assertIn(".env", code.walk_files(root))

    def test_file_cap_is_enforced_inside_one_large_directory(self):
        with tempfile.TemporaryDirectory(prefix="fs-cap-") as tmp:
            root = pathlib.Path(tmp)
            for index in range(5):
                (root / f"file-{index}.txt").write_text("x", encoding="utf-8")
            with patch.object(fs, "WALK_FILE_CAP", 2):
                entries, _skipped, partial = fs.walk_windows(root, float("inf"))
            self.assertEqual(len(entries), 2)
            self.assertTrue(partial)


class ExcludeFileTests(unittest.TestCase):
    def test_bom_is_not_part_of_first_source_id(self):
        with tempfile.TemporaryDirectory(prefix="exclude-bom-") as tmp:
            path = pathlib.Path(tmp) / "exclude.txt"
            path.write_bytes(b"\xef\xbb\xbfcode:first\ncode:second\n")
            self.assertEqual(code.load_exclude(str(path)), {"code:first", "code:second"})
            self.assertEqual(obsidian.load_exclude(str(path)), {"code:first", "code:second"})


class IntelTests(unittest.TestCase):
    @staticmethod
    def _entry(day: str, name: str) -> str:
        return (
            f"<entry><title>{name}</title><published>{day}T00:00:00Z</published>"
            f"<content>&lt;p&gt;{name} tagline&lt;/p&gt;</content></entry>"
        )

    def test_signature_ignores_score_order(self):
        blocks = [("HN", [("b", "b (2)"), ("a", "a (1)")], "note")]
        self.assertEqual(intel.signature_of(blocks), {"HN": ["a", "b"]})

    def test_product_hunt_fallback_is_canonical_within_latest_day(self):
        names = ["Zulu", "Alpha", "Echo", "Bravo", "Delta", "Charlie"]
        body_a = "".join(self._entry("2026-09-30", name) for name in names)
        body_b = "".join(self._entry("2026-09-30", name) for name in reversed(names))
        body_a += self._entry("2026-09-29", "Older")
        body_b += self._entry("2026-09-29", "Older")

        def collect(body):
            with patch.object(intel, "fetch", return_value=(True, body)), patch.object(
                intel, "pacific_target_day", return_value="2099-01-01"
            ):
                return intel.collect_product_hunt()[0]

        self.assertEqual(collect(body_a), collect(body_b))
        self.assertEqual([item[0] for item in collect(body_a)], sorted(names)[: intel.TOP_N])


class ServerBoundaryTests(unittest.TestCase):
    def test_speaker_rejects_oversized_request_before_reading_pcm(self):
        request = Mock()
        request.recv.side_effect = [struct.pack("<I", 30 * speaker.RATE + 1)]
        handler = object.__new__(speaker.Handler)
        handler.request = request
        handler.handle()
        request.settimeout.assert_called_once()
        self.assertEqual(request.recv.call_count, 1)

    def test_cuda_dll_handles_live_for_module_lifetime(self):
        with tempfile.TemporaryDirectory(prefix="cuda-dll-") as tmp:
            bin_dir = pathlib.Path(tmp) / "nvidia" / "cublas" / "bin"
            bin_dir.mkdir(parents=True)
            handle = object()
            with patch("site.getsitepackages", return_value=[tmp]), patch(
                "site.getusersitepackages", return_value=str(pathlib.Path(tmp) / "user")
            ), patch.object(stt.os, "add_dll_directory", return_value=handle, create=True):
                stt._add_nvidia_dll_dirs()
            self.assertIn(handle, stt._DLL_DIRECTORY_HANDLES)

    def test_cuda_selection_is_logged_after_warmup(self):
        class FakeModel:
            def __init__(self, *_args, **kwargs):
                self.device = kwargs["device"]

            def transcribe(self, *_args, **_kwargs):
                return iter(()), None

        fake_module = types.SimpleNamespace(WhisperModel=FakeModel)
        stderr = io.StringIO()
        with patch.dict(sys.modules, faster_whisper=fake_module), contextlib.redirect_stderr(stderr):
            _model, selected = stt.load_model("synthetic")
        self.assertEqual(selected, "cuda")
        self.assertIn("CUDA", stderr.getvalue())


class SpeakerAdaptationTests(unittest.TestCase):
    def test_reference_file_lock_serializes_independent_handles(self):
        with tempfile.TemporaryDirectory(prefix="speaker-lock-") as tmp:
            directory = pathlib.Path(tmp)
            first_entered = threading.Event()
            release_first = threading.Event()
            second_entered = threading.Event()

            def first():
                with speaker._reference_file_lock(directory):
                    first_entered.set()
                    release_first.wait(1)

            def second():
                first_entered.wait(1)
                with speaker._reference_file_lock(directory):
                    second_entered.set()

            threads = [threading.Thread(target=first), threading.Thread(target=second)]
            for thread in threads:
                thread.start()
            self.assertTrue(first_entered.wait(1))
            self.assertFalse(second_entered.wait(0.1))
            release_first.set()
            for thread in threads:
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
            self.assertTrue(second_entered.is_set())

    def test_parallel_adaptation_keeps_both_prototypes(self):
        with tempfile.TemporaryDirectory(prefix="speaker-adapt-") as tmp:
            target = pathlib.Path(tmp) / "adapt.npy"
            entered = threading.Event()
            calls_lock = threading.Lock()
            calls = 0

            class FakeVoiceprint:
                @staticmethod
                def _load_matrix(path):
                    nonlocal calls
                    with calls_lock:
                        calls += 1
                        call = calls
                    if call == 1:
                        entered.wait(0.2)
                    else:
                        entered.set()
                    if not path.exists():
                        return None
                    return np.load(path)

            old_vp = speaker.VP
            speaker.VP = FakeVoiceprint()
            self.addCleanup(setattr, speaker, "VP", old_vp)
            with patch.object(speaker, "adapt_path", return_value=target):
                threads = [
                    threading.Thread(
                        target=speaker._adapt,
                        args=(np.array([1.0, float(i)], dtype=np.float32), np.array([0.7]), 2.0, 0.7, 0.48),
                    )
                    for i in (1, 2)
                ]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(timeout=2)
                    self.assertFalse(thread.is_alive())
            self.assertEqual(np.load(target).shape[0], 2)

    def test_failed_adaptation_write_preserves_previous_matrix(self):
        with tempfile.TemporaryDirectory(prefix="speaker-adapt-atomic-") as tmp:
            target = pathlib.Path(tmp) / "adapt.npy"
            expected = np.array([[1.0, 0.0]], dtype=np.float32)
            np.save(target, expected)

            def fail_save(path, _matrix):
                pathlib.Path(path).write_bytes(b"partial")
                raise OSError("disk full")

            with patch.object(speaker.np, "save", side_effect=fail_save):
                with self.assertRaises(OSError):
                    speaker._atomic_save_matrix(target, np.array([[0.0, 1.0]], dtype=np.float32))
            np.testing.assert_array_equal(np.load(target), expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
