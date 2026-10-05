"""Enrollment regressions: synthetic PCM only, no microphone/model/user data.

Run directly with the sidecar venv Python, like test_speaker_karar.py.
"""

import contextlib
import io
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

import numpy as np

import speaker_server as ss
import speaker_enrollment as se


def speech(seconds=2.0, rms=0.0008):
    # Harmonics with syllable-like modulation, scaled to a known RMS.
    t = np.arange(round(seconds * se.RATE), dtype=np.float64) / se.RATE
    a = (np.sin(2 * np.pi * 200 * t) + 0.3 * np.sin(2 * np.pi * 400 * t))
    a *= 0.8 + 0.2 * np.cos(2 * np.pi * 5 * t)
    return (a * rms / np.sqrt(np.mean(a**2))).astype(np.float32)


def tone(seconds, rms):
    t = np.arange(round(seconds * se.RATE)) / se.RATE
    return (np.sqrt(2) * rms * np.sin(2 * np.pi * 200 * t)).astype(np.float32)


def fake_sd():
    sd = MagicMock()
    sd.default.device = (7, 8)
    sd.query_devices.return_value = {"name": "Synthetic input", "hostapi": 0, "index": 7}
    sd.query_hostapis.return_value = {"name": "MME"}
    return sd


class QualityTests(unittest.TestCase):
    def test_silence_including_zero_noise_floor_is_rejected(self):
        audio = np.zeros(se.RATE * 5, dtype=np.float32)
        self.assertFalse(se.assess(audio, se.noise_floor(audio)).valid)
        self.assertEqual(se.assess(audio, 0).snr, 0)

    def test_background_noise_is_rejected(self):
        rng = np.random.default_rng(31)
        floor = se.noise_floor(rng.normal(0, 0.0001, se.RATE * 2))
        self.assertFalse(se.assess(rng.normal(0, 0.0001, se.RATE * 5), floor).valid)

    def test_quiet_speech_is_valid_and_snr_is_rms_ratio(self):
        quality = se.assess(speech(), 0.0001)
        self.assertTrue(quality.valid)
        self.assertAlmostEqual(quality.snr, 8, places=3)
        self.assertAlmostEqual(quality.snr_db, 18.0618, places=3)
        self.assertAlmostEqual(quality.speech_seconds, 2.0)

    def test_duration_boundary(self):
        self.assertFalse(se.assess(tone(1.18, 0.001), 0.0001).valid)
        self.assertTrue(se.assess(tone(1.2, 0.001), 0.0001).valid)

    def test_snr_boundary(self):
        audio = tone(2, 0.0004)
        exact_rms = float(np.sqrt(np.mean(se.frame_rms(audio)**2)))
        self.assertTrue(se.assess(audio, exact_rms / 4).valid)
        self.assertFalse(se.assess(audio, exact_rms / 3.99).valid)

    def test_dc_and_nonfinite_audio_are_rejected(self):
        for value in (0.5, np.nan, np.inf):
            with np.errstate(invalid="ignore"):
                self.assertFalse(se.assess(np.full(se.RATE * 2, value), 0.0001).valid)

    def test_noise_floor_and_empty_calibration(self):
        self.assertAlmostEqual(se.noise_floor(tone(2, 0.0001)), 0.0001, places=8)
        with self.assertRaises(ValueError):
            se.noise_floor(np.empty(0))


class CaptureTests(unittest.TestCase):
    def test_six_second_timeout_without_onset(self):
        capture = se.Capture(0.0001)
        for _ in range(299):
            capture.feed(np.zeros(se.FRAME))
        self.assertFalse(capture.done)
        capture.feed(np.zeros(se.FRAME))
        self.assertTrue(capture.done)
        self.assertFalse(capture.started)
        self.assertEqual(capture.audio().size, 0)

    def test_click_does_not_trigger_start(self):
        capture = se.Capture(0.0001)
        capture.feed(tone(0.02, 0.01))
        capture.feed(np.zeros(se.FRAME))
        self.assertFalse(capture.started)

    def test_delayed_onset_preserves_preroll_and_records_five_seconds(self):
        capture = se.Capture(0.0001)
        quiet = tone(0.02, 0.00001)
        loud = tone(0.02, 0.001)
        for _ in range(200):
            capture.feed(quiet)
        for _ in range(se.ONSET_FRAMES):
            capture.feed(loud)
        self.assertTrue(capture.started)
        while not capture.done:
            capture.feed(loud)
        audio = capture.audio()
        self.assertEqual(audio.size, se.RATE * 5)
        np.testing.assert_array_equal(audio[:int(se.PRE_SECONDS * se.RATE)], np.tile(quiet, 15))
        np.testing.assert_array_equal(audio[int(se.PRE_SECONDS * se.RATE):][:se.FRAME], loud)

    def test_immediate_onset_needs_no_full_preroll(self):
        capture = se.Capture(0.0001)
        while not capture.done:
            capture.feed(tone(0.02, 0.001))
        self.assertEqual(capture.audio().size, se.RATE * 5)

    def test_stream_overflow_is_not_silently_accepted(self):
        stream = Mock()
        stream.read.return_value = (np.zeros((se.FRAME, 1)), True)
        with self.assertRaisesRegex(ValueError, "tamponu"):
            se.read_frame(stream)

    def test_stream_capture_device_feedback_and_close(self):
        sd = fake_sd()
        stream = sd.InputStream.return_value.__enter__.return_value
        stream.read.return_value = (tone(0.02, 0.001).reshape(-1, 1), False)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            audio = se.record(sd, 9, 0.0001)
        self.assertEqual(audio.size, se.RATE * 5)
        self.assertEqual(sd.InputStream.call_args.kwargs["device"], 9)
        self.assertIn("konusma algilandi", out.getvalue())
        self.assertIn("kalan 0.0 sn", out.getvalue())
        sd.InputStream.return_value.__exit__.assert_called_once()

    def test_calibration_records_exactly_two_seconds(self):
        sd = fake_sd()
        stream = sd.InputStream.return_value.__enter__.return_value
        stream.read.return_value = (tone(0.02, 0.0001).reshape(-1, 1), False)
        with contextlib.redirect_stdout(io.StringIO()):
            floor = se.calibrate(sd, 3)
        self.assertAlmostEqual(floor, 0.0001, places=8)
        self.assertEqual(stream.read.call_count * se.FRAME, se.RATE * 2)

    def test_full_stream_to_confirmation_without_hardware_or_writes(self):
        sd = fake_sd()
        quiet = tone(0.02, 0.0001)
        utterance = speech().reshape(-1, se.FRAME)
        streams = []
        # Calibration, one failed attempt, then eight samples plus the holdout.
        for frames in ([quiet] * 100, [quiet] * 300,
                       *([[quiet] * 25 + list(utterance) + [quiet] * 150] * 9)):
            stream = MagicMock()
            stream.__enter__.return_value.read.side_effect = [(f.reshape(-1, 1), False) for f in frames]
            streams.append(stream)
        sd.InputStream.side_effect = streams
        vp = Mock(dim=2, model_name="synthetic")
        vp.embed.return_value = np.array([1.0, 0.0], dtype=np.float32)
        out = io.StringIO()
        with patch.dict(sys.modules, sounddevice=sd), patch.object(
            ss, "ensure_model"
        ), patch.object(ss, "Voiceprint", return_value=vp), patch.object(
            ss, "data_dir", side_effect=AssertionError("real data access")
        ), patch.object(ss, "_save_owner") as save, patch(
            "builtins.input", return_value="h"
        ), contextlib.redirect_stdout(out):
            self.assertEqual(ss.enroll_mic(), 0)
        save.assert_not_called()
        self.assertEqual(sd.InputStream.call_count, 11)
        self.assertEqual(vp.embed.call_count, 9)
        self.assertIn("Deneme 1/3: GECERSIZ", out.getvalue())
        self.assertIn("Deneme 2/3: GECERLI", out.getvalue())
        self.assertIn("Ornek 8: SNR 8.00x", out.getvalue())
        self.assertIn("1.000 -> GECTI", out.getvalue())
        self.assertIn("owner.npy degistirilmedi", out.getvalue())


class EnrollmentTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.tmp = pathlib.Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="spk-enroll-")))
        self.stack.enter_context(patch.object(ss, "data_dir", side_effect=AssertionError("real data access")))
        for helper, name in (("owner_path", "candidate.npy"), ("owner_meta_path", "candidate.json"),
                             ("adapt_path", "adapt.npy")):
            self.stack.enter_context(patch.object(ss, helper, return_value=self.tmp / name))
        self.sd = fake_sd()
        self.stack.enter_context(patch.dict(sys.modules, sounddevice=self.sd))
        self.stack.enter_context(patch.object(se, "calibrate", return_value=0.0001))
        self.ensure = self.stack.enter_context(patch.object(ss, "ensure_model"))
        self.vp = Mock(dim=2, model_name="synthetic")
        self.vp.embed.return_value = np.array([1.0, 0.0], dtype=np.float32)
        self.stack.enter_context(patch.object(ss, "Voiceprint", return_value=self.vp))
        self.inputs = self.stack.enter_context(patch("builtins.input", return_value=""))
        self.out = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.original = b"old synthetic reference"
        (self.tmp / "candidate.npy").write_bytes(self.original)
        (self.tmp / "adapt.npy").write_bytes(b"old synthetic adaptation")

    def assert_unchanged(self):
        self.assertEqual((self.tmp / "candidate.npy").read_bytes(), self.original)
        self.assertEqual((self.tmp / "adapt.npy").read_bytes(), b"old synthetic adaptation")
        data_files = [path for path in self.tmp.iterdir() if path.name != ".reference.lock"]
        self.assertEqual(len(data_files), 2)

    def test_silent_retries_never_embed_or_save(self):
        with patch.object(se, "record", return_value=np.zeros(se.RATE * 5)) as record:
            self.assertEqual(ss.enroll_mic(), 2)
        self.assertEqual(record.call_count, 3)
        self.vp.embed.assert_not_called()
        self.ensure.assert_not_called()
        self.assert_unchanged()
        self.assertIn("3 gecersiz deneme", self.out.getvalue())
        for i in range(1, 4):
            self.assertIn(f"Deneme {i}/3: GECERSIZ", self.out.getvalue())
        self.assertNotIn("[2/8]", self.out.getvalue())

    def test_third_attempt_can_succeed_and_keeps_same_sentence(self):
        with patch.object(se, "record", side_effect=[np.zeros(se.RATE), speech(rms=0.0003), speech()]):
            result = se.take_sample(self.sd, 7, 0.0001, "Ayni cumle")
        self.assertTrue(result[1].valid)
        self.assertEqual(self.inputs.call_count, 3)
        self.assertTrue(all("Ayni cumle" in call.args[0] for call in self.inputs.call_args_list))
        self.assertIn("Deneme 2/3: GECERSIZ", self.out.getvalue())
        self.assertIn("Deneme 3/3: GECERLI", self.out.getvalue())

    def test_second_attempt_can_succeed(self):
        with patch.object(se, "record", side_effect=[np.zeros(se.RATE), speech()]) as record:
            self.assertTrue(se.take_sample(self.sd, 7, 0.0001, "Tekrar")[1].valid)
        self.assertEqual(record.call_count, 2)

    def test_invalid_holdout_never_embeds_or_writes(self):
        with patch.object(se, "record", side_effect=[speech()] * 8 + [np.zeros(se.RATE)] * 3) as record:
            self.assertEqual(ss.enroll_mic(), 2)
        self.assertEqual(record.call_count, 11)
        self.vp.embed.assert_not_called()
        self.assert_unchanged()

    def test_blank_confirmation_does_not_write_and_report_precedes_question(self):
        def answer(prompt):
            if prompt.startswith("Kaydedeyim"):
                self.assertIn("KENDI KENDINI DOGRULAMA", self.out.getvalue())
                self.assertIn("onerilen esik", self.out.getvalue())
                self.assertIn("Ornek 8: SNR", self.out.getvalue())
                self.assert_unchanged()
            return ""
        self.inputs.side_effect = answer
        with patch.object(se, "record", return_value=speech()):
            self.assertEqual(ss.enroll_mic(), 0)
        self.assert_unchanged()

    def test_explicit_refusal_does_not_write(self):
        self.inputs.return_value = "h"
        with patch.object(se, "record", return_value=speech()):
            self.assertEqual(ss.enroll_mic(), 0)
        self.assert_unchanged()

    def test_confirmation_saves_matrix_and_backs_up_old_bytes(self):
        self.inputs.side_effect = lambda prompt: "E" if prompt.startswith("Kaydedeyim") else ""
        with patch.object(se, "record", return_value=speech()):
            self.assertEqual(ss.enroll_mic(), 0)
        backups = list(self.tmp.glob("candidate.npy.bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.original)
        self.assertEqual(np.load(self.tmp / "candidate.npy").shape, (9, 2))
        self.assertFalse((self.tmp / "adapt.npy").exists())
        self.assertTrue((self.tmp / "candidate.json").exists())

    def test_backup_failure_preserves_reference_and_adaptation(self):
        with patch.object(ss.shutil, "copy2", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                ss._save_owner(self.vp, [self.vp.embed.return_value] * 2, "synthetic")
        self.assert_unchanged()

    def test_metadata_commit_failure_rolls_back_reference_and_adaptation(self):
        meta = self.tmp / "candidate.json"
        meta.write_bytes(b"old synthetic metadata")
        original_replace = pathlib.Path.replace

        def fail_metadata_replace(path, target):
            if pathlib.Path(target) == meta:
                raise OSError("metadata disk error")
            return original_replace(path, target)

        with patch.object(pathlib.Path, "replace", autospec=True, side_effect=fail_metadata_replace):
            with self.assertRaises(OSError):
                ss._save_owner(self.vp, [self.vp.embed.return_value] * 2, "synthetic")
        self.assertEqual((self.tmp / "candidate.npy").read_bytes(), self.original)
        self.assertEqual(meta.read_bytes(), b"old synthetic metadata")
        self.assertEqual((self.tmp / "adapt.npy").read_bytes(), b"old synthetic adaptation")

    def test_adaptation_reset_failure_rolls_back_owner_and_metadata(self):
        meta = self.tmp / "candidate.json"
        meta.write_bytes(b"old synthetic metadata")
        adapt = self.tmp / "adapt.npy"
        original_unlink = pathlib.Path.unlink

        def fail_adaptation_unlink(path, *args, **kwargs):
            if path == adapt:
                raise OSError("adaptation disk error")
            return original_unlink(path, *args, **kwargs)

        with patch.object(pathlib.Path, "unlink", autospec=True, side_effect=fail_adaptation_unlink):
            with self.assertRaises(OSError):
                ss._save_owner(self.vp, [self.vp.embed.return_value] * 2, "synthetic")
        self.assertEqual((self.tmp / "candidate.npy").read_bytes(), self.original)
        self.assertEqual(meta.read_bytes(), b"old synthetic metadata")
        self.assertEqual(adapt.read_bytes(), b"old synthetic adaptation")

    def test_silent_wavs_are_rejected_before_model_load(self):
        with patch.object(ss, "_read_wav", return_value=np.zeros(ss.RATE * 2)), patch.object(
            ss, "ensure_model", side_effect=AssertionError("model must not load")
        ):
            self.assertEqual(ss.enroll_from_wav(["one.wav", "two.wav"]), 2)

    def test_interrupt_or_eof_at_confirmation_preserves_files(self):
        for error in (KeyboardInterrupt, EOFError):
            def answer(prompt):
                if prompt.startswith("Kaydedeyim"):
                    raise error()
                return ""
            self.inputs.side_effect = answer
            with patch.object(se, "record", return_value=speech()), patch.object(sys, "argv", ["speaker_server.py", "--enroll"]):
                self.assertEqual(ss.main(), 130)
            self.assert_unchanged()

    def test_default_and_explicit_device_selection(self):
        with patch.object(se, "record", return_value=np.empty(0)) as record:
            ss.enroll_mic()
            self.sd.query_devices.assert_called_with(7, "input")
            self.assertEqual(record.call_args.args[1], 7)
            self.sd.query_devices.return_value["index"] = 12
            ss.enroll_mic("Headset")
            self.sd.query_devices.assert_called_with("Headset", "input")
            self.assertEqual(record.call_args.args[1], 12)
        self.assertEqual(ss._device_arg("0"), 0)
        self.assertEqual(ss._device_arg("Headset"), "Headset")

    def test_invalid_calibration_stops_before_recording(self):
        with patch.object(se, "calibrate", side_effect=ValueError("overflow")), patch.object(se, "record") as record:
            self.assertEqual(ss.enroll_mic(), 2)
        record.assert_not_called()
        self.assert_unchanged()

    def test_statistics_match_existing_threshold_formula(self):
        embs = [np.array([1.0, 0.0]), np.array([0.6, 0.8])]
        proto, meta = ss._prepare_owner(self.vp, embs, "synthetic")
        self.assertEqual(proto.shape, (3, 2))
        self.assertEqual(meta["ayni_kisi_ikili_min"], 0.6)
        self.assertEqual(meta["loo_taban"], 0.8944)
        self.assertEqual(meta["onerilen_esik"], 0.6)
        self.assert_unchanged()


if __name__ == "__main__":
    unittest.main(verbosity=2)
