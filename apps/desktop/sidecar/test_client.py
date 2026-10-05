"""stt_server icin test istemcisi: 16k mono s16 WAV gonderir, metni ve
gecikmeyi yazar. Kullanim: python test_client.py dosya.wav [--port 8123]
"""

from __future__ import annotations

import argparse
import json
import socket
import struct
import time
import wave

import unittest
import threading
import types
import sys
from unittest.mock import patch

import stt_server


def main() -> None:
    import numpy as np
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--port", type=int, default=8123)
    args = ap.parse_args()

    with wave.open(args.wav, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1, "16k mono bekleniyor"
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    audio = (pcm.astype(np.float32) / 32768.0).copy()

    t0 = time.time()
    with socket.create_connection(("127.0.0.1", args.port), timeout=60) as s:
        s.sendall(struct.pack("<I", len(audio)) + audio.tobytes())
        (n,) = struct.unpack("<I", _read_exact(s, 4))
        resp = json.loads(_read_exact(s, n).decode("utf-8"))
    total_ms = int((time.time() - t0) * 1000)

    print(f"ses={len(audio)/16000:.2f}s decode={resp['ms']}ms toplam={total_ms}ms device={resp['device']}")
    print(f"metin: {resp['text']}")


def _read_exact(sock, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        c = sock.recv(n - len(buf))
        if not c:
            raise ConnectionError("kapandi")
        buf += c
    return buf


class ModelLifecycleTests(unittest.TestCase):
    def tearDown(self):
        stt_server.MODEL = None

    def test_lazy_load_reuse_and_idle_release(self):
        class Segment:
            text = "Smith ekranimda ne var"

        class Model:
            def transcribe(self, audio, **kwargs):
                return iter([Segment()]), None

        stt_server.MODEL = None
        with patch.object(stt_server, "load_model", return_value=(Model(), "cuda")) as load:
            self.assertEqual(load.call_count, 0)
            self.assertEqual(stt_server.transcribe_local([]), (Segment.text, "cuda"))
            stt_server.transcribe_local([])
            self.assertEqual(load.call_count, 1)
            stt_server.release_idle_model(stt_server.LAST_REQUEST + 599)
            self.assertIsNotNone(stt_server.MODEL)
            stt_server.release_idle_model(stt_server.LAST_REQUEST + 600)
            self.assertIsNone(stt_server.MODEL)
            stt_server.transcribe_local([])
            self.assertEqual(load.call_count, 2)

    def test_warmup_loads_once_without_decoding_and_preserves_idle_timer(self):
        model = unittest.mock.Mock()
        stt_server.MODEL = None
        with patch.object(stt_server, "load_model", return_value=(model, "cuda")) as load:
            self.assertEqual(stt_server.transcribe_local(None), ("", "cuda"))
            stt_server.transcribe_local(None)
            self.assertEqual(load.call_count, 1)
            model.transcribe.assert_not_called()
            self.assertGreater(stt_server.LAST_REQUEST, 0)
            stt_server.release_idle_model(stt_server.LAST_REQUEST + 599)
            self.assertIsNotNone(stt_server.MODEL)

    def test_keepalive_prevents_idle_release_until_requests_stop(self):
        model = unittest.mock.Mock()
        stt_server.MODEL = None
        with patch.object(stt_server, "load_model", return_value=(model, "cuda")) as load:
            for now in (1000, 1300, 1600, 1900):
                with patch.object(stt_server.time, "monotonic", return_value=now):
                    stt_server.transcribe_local(None)
                stt_server.release_idle_model(now + 299)
                self.assertIs(stt_server.MODEL, model)
            self.assertEqual(load.call_count, 1)
            model.transcribe.assert_not_called()
            stt_server.release_idle_model(2499)
            self.assertIs(stt_server.MODEL, model)
            stt_server.release_idle_model(2500)
            self.assertIsNone(stt_server.MODEL)

    def test_active_request_cannot_be_unloaded(self):
        stt_server.MODEL = object()
        with stt_server.MODEL_LOCK:
            stt_server.release_idle_model(stt_server.LAST_REQUEST + 601)
            self.assertIsNotNone(stt_server.MODEL)

    def test_load_failure_is_not_success(self):
        stt_server.MODEL = None
        with patch.object(stt_server, "load_model", side_effect=FileNotFoundError("local cache")):
            with self.assertRaises(FileNotFoundError):
                stt_server.transcribe_local([])
        self.assertIsNone(stt_server.MODEL)


class ProtocolTests(unittest.TestCase):
    def request(self, header, raw=b""):
        fake_numpy = types.SimpleNamespace(frombuffer=lambda data, dtype: [0.0] * (len(data) // 4), float32=float)
        with patch.dict(sys.modules, {"numpy": fake_numpy}):
            with stt_server.Server(("127.0.0.1", 0), stt_server.Handler) as server:
                worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
                worker.start()
                try:
                    with socket.create_connection(server.server_address, timeout=2) as client:
                        client.sendall(struct.pack("<I", header) + raw)
                        n, = struct.unpack("<I", _read_exact(client, 4))
                        return json.loads(_read_exact(client, n))
                finally:
                    server.shutdown()
                    worker.join()

    def test_local_flag_never_calls_cloud(self):
        with patch.object(stt_server, "ENGINE", "deepgram"), patch.object(stt_server, "transcribe_deepgram") as cloud:
            with patch.object(stt_server, "transcribe_local", return_value=("Smith", "cuda")):
                reply = self.request(0x80000001, struct.pack("<f", 0.1))
            self.assertEqual(reply["device"], "cuda")
            self.assertEqual(reply["text"], "Smith")
            cloud.assert_not_called()

    def test_warmup_control_is_local_and_has_no_audio(self):
        with patch.object(stt_server, "ENGINE", "deepgram"), patch.object(stt_server, "transcribe_deepgram") as cloud:
            with patch.object(stt_server, "transcribe_local", return_value=("", "cuda")) as local:
                reply = self.request(0x80000000)
            local.assert_called_once_with(None)
            self.assertTrue(reply["ready"])
            self.assertEqual(reply["text"], "")
            cloud.assert_not_called()

    def test_warmup_error_does_not_report_ready(self):
        with patch.object(stt_server, "transcribe_local", side_effect=FileNotFoundError("cache")):
            reply = self.request(0x80000000)
        self.assertIn("error", reply)
        self.assertNotIn("ready", reply)

    def test_legacy_request_still_works(self):
        with patch.object(stt_server, "ENGINE", "local"), patch.object(stt_server, "transcribe_local", return_value=("Smith", "cpu")):
            self.assertEqual(self.request(1, struct.pack("<f", 0.1))["text"], "Smith")

    def test_bad_size_is_rejected_before_decode(self):
        with patch.object(stt_server, "transcribe_local") as local:
            self.assertIn("error", self.request(0))
            self.assertIn("error", self.request(0x80000000 | (30 * 16000 + 1)))
            local.assert_not_called()

    def test_missing_local_cache_returns_error_without_cloud(self):
        with patch.object(stt_server, "ENGINE", "deepgram"), patch.object(stt_server, "transcribe_deepgram") as cloud:
            with patch.object(stt_server, "transcribe_local", side_effect=FileNotFoundError("cache")):
                self.assertIn("error", self.request(0x80000001, struct.pack("<f", 0.1)))
            cloud.assert_not_called()

    def test_model_constructor_is_offline_on_gpu_and_cpu(self):
        constructor = unittest.mock.Mock(side_effect=RuntimeError("local cache missing"))
        with patch.dict(sys.modules, {"faster_whisper": types.SimpleNamespace(WhisperModel=constructor)}):
            with self.assertRaises(RuntimeError):
                stt_server.load_model("missing-local-model")
        self.assertEqual(constructor.call_count, 2)
        self.assertTrue(all(c.kwargs["local_files_only"] for c in constructor.call_args_list))


if __name__ == "__main__":
    main()
