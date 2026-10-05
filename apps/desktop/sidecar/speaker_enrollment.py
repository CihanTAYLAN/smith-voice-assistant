"""Enrollment-only energy gate and streaming capture (no model dependency)."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math

import numpy as np

RATE = 16_000
FRAME = 320  # 20 ms; stable even with quiet headset microphones.
NOISE_SECONDS = 2.0
WAIT_SECONDS = 6.0
REC_SECONDS = 5.0  # Includes the pre-roll.
PRE_SECONDS = 0.3
MIN_SPEECH_SECONDS = 1.2
MIN_SNR = 4.0  # RMS amplitude ratio, equivalent to 12.04 dB.
RMS_FLOOR = 1e-5  # Digital silence/roundoff guard, not a microphone level gate.
ONSET_FRAMES = 3  # Ignore isolated clicks shorter than 60 ms.


def frame_rms(audio: np.ndarray) -> np.ndarray:
    frames = np.asarray(audio, dtype=np.float64).reshape(-1)
    frames = frames[: frames.size // FRAME * FRAME].reshape(-1, FRAME)
    # DC offset is not speech energy.
    frames = frames - frames.mean(axis=1, keepdims=True)
    return np.sqrt(np.mean(frames**2, axis=1))


def noise_floor(audio: np.ndarray) -> float:
    levels = frame_rms(audio)
    if not levels.size or not np.isfinite(levels).all():
        raise ValueError("gurultu olcumu bos veya gecersiz")
    # A high percentile avoids treating normal background fluctuations as speech.
    return max(RMS_FLOOR, float(np.percentile(levels, 90)))


@dataclass(frozen=True)
class Quality:
    speech_seconds: float
    speech_rms: float
    snr: float
    valid: bool

    @property
    def snr_db(self) -> float:
        return 20 * math.log10(self.snr) if self.snr > 0 else -math.inf


def assess(audio: np.ndarray, floor: float) -> Quality:
    levels = frame_rms(audio)
    if not np.isfinite(levels).all():
        return Quality(0.0, 0.0, 0.0, False)
    baseline = max(RMS_FLOOR, floor)
    # The activity gate is lower than the acceptance SNR so quiet syllables
    # count, while a long weak recording still fails the final SNR check.
    active = levels[levels >= 2 * baseline]
    seconds = active.size * FRAME / RATE
    rms = float(np.sqrt(np.mean(active**2))) if active.size else 0.0
    snr = rms / baseline
    return Quality(seconds, rms, snr, seconds >= MIN_SPEECH_SECONDS and snr >= MIN_SNR)


class Capture:
    """Sample-clock state machine, shared by live capture and synthetic tests."""

    def __init__(self, floor: float):
        self.floor = max(RMS_FLOOR, floor)
        self.waited = 0
        self.streak = 0
        self.started = False
        self.done = False
        self.frames: list[np.ndarray] = []
        self.pre = deque(maxlen=round(PRE_SECONDS * RATE / FRAME) + ONSET_FRAMES)

    def feed(self, frame: np.ndarray) -> float:
        frame = np.asarray(frame, dtype=np.float32).reshape(-1).copy()
        if frame.size != FRAME or not np.isfinite(frame).all():
            raise ValueError("gecersiz ses cercevesi")
        level = float(frame_rms(frame)[0])
        if self.done:
            return level
        if self.started:
            self.frames.append(frame)
        else:
            self.waited += FRAME
            self.pre.append(frame)
            self.streak = self.streak + 1 if level >= 2 * self.floor else 0
            if self.streak >= ONSET_FRAMES:
                self.started = True
                self.frames = list(self.pre)
            elif self.waited >= round(WAIT_SECONDS * RATE):
                self.done = True
        if len(self.frames) * FRAME >= round(REC_SECONDS * RATE):
            self.done = True
        return level

    @property
    def remaining(self) -> float:
        if self.started:
            return max(0.0, REC_SECONDS - len(self.frames) * FRAME / RATE)
        return max(0.0, WAIT_SECONDS - self.waited / RATE)

    def audio(self) -> np.ndarray:
        return np.concatenate(self.frames) if self.frames else np.empty(0, dtype=np.float32)


def progress(level: float, floor: float, label: str, remaining: float) -> None:
    # Relative logarithmic scale keeps a quiet microphone visible without gain.
    bars = min(20, max(0, round(5 * math.log2(1 + level / max(floor, RMS_FLOOR)))))
    line = f"    [{'#' * bars}{'.' * (20 - bars)}] {label} | kalan {remaining:.1f} sn"
    print("\r" + line.ljust(100), end="", flush=True)


def read_frame(stream) -> np.ndarray:
    audio, overflow = stream.read(FRAME)
    if overflow:
        raise ValueError("mikrofon tamponu tasti; eksik ses kabul edilmedi")
    frame = np.asarray(audio, dtype=np.float32).reshape(-1)
    if frame.size != FRAME or not np.isfinite(frame).all():
        raise ValueError("gecersiz ses cercevesi")
    return frame


def calibrate(sd, device) -> float:
    frames = []
    count = round(NOISE_SECONDS * RATE / FRAME)
    try:
        with sd.InputStream(device=device, samplerate=RATE, channels=1, dtype="float32",
                            blocksize=FRAME) as stream:
            for i in range(count):
                frame = read_frame(stream)
                frames.append(frame)
                if i % 5 == 0:
                    progress(float(frame_rms(frame)[0]), RMS_FLOOR, "sessizlik olcumu",
                             NOISE_SECONDS - (i + 1) * FRAME / RATE)
    finally:
        print()
    return noise_floor(np.concatenate(frames))


def record(sd, device, floor: float) -> np.ndarray:
    capture = Capture(floor)
    try:
        with sd.InputStream(device=device, samplerate=RATE, channels=1, dtype="float32",
                            blocksize=FRAME) as stream:
            i = 0
            while not capture.done:
                started = capture.started
                level = capture.feed(read_frame(stream))
                if i % 5 == 0 or capture.done or started != capture.started:
                    label = "konusma algilandi / kayit" if capture.started else "ses bekleniyor"
                    progress(level, floor, label, capture.remaining)
                i += 1
    finally:
        print()
    return capture.audio()


def take_sample(sd, device, floor: float, prompt: str) -> tuple[np.ndarray, Quality] | None:
    for attempt in range(1, 4):
        input(f'    Deneme {attempt}/3. ENTER\'a bas, sonra oku: "{prompt}" ')
        try:
            audio = record(sd, device, floor)
        except ValueError as exc:
            print(f"    Deneme {attempt}/3: GECERSIZ ({exc})")
            continue
        quality = assess(audio, floor)
        status = "GECERLI" if quality.valid else "GECERSIZ"
        print(f"    Deneme {attempt}/3: {status} | konusma {quality.speech_seconds:.2f} sn"
              f" | rms {quality.speech_rms:.6f} | SNR {quality.snr:.2f}x ({quality.snr_db:.1f} dB)")
        if quality.valid:
            return audio, quality
        print("    En az 1.2 sn konusma ve gurultu tabaninin 4 kati RMS gerekli.")
    print("[speaker] Kayit DURDU: 3 gecersiz deneme. owner.npy'ye HICBIR SEY yazilmadi.")
    return None
