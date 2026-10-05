"""WLK /asr WS protokol kesif istemcisi: 16k mono s16 WAV'i gercek-zamanli
hizda akitir, gelen HER mesaji zaman damgasiyla basar. Amac: sema + kelime
gecikmesi olcumu (Rust istemcisini yazmadan once ampirik dogrulama).
Kullanim: python test_wlk_client.py dosya.wav [--url ws://127.0.0.1:8000/asr]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
import wave

import websockets


async def run(path: str, url: str) -> None:
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1, "16k mono bekleniyor"
        pcm = w.readframes(w.getnframes())
    dur = len(pcm) / 2 / 16000
    print(f"[test] {dur:.2f}s ses akitilacak: {path}")

    t0 = time.time()
    async with websockets.connect(f"{url}?language=tr", max_size=None) as ws:
        async def sender() -> None:
            step = 16000 * 2 // 10  # 100 ms
            for i in range(0, len(pcm), step):
                await ws.send(pcm[i : i + step])
                await asyncio.sleep(0.1)
            print(f"[test] T+{time.time()-t0:.2f}s ses bitti; sessizlik akiyor")
            silence = b"\x00" * step
            for _ in range(30):
                await ws.send(silence)
                await asyncio.sleep(0.1)

        send_task = asyncio.create_task(sender())
        try:
            while True:
                msg = await asyncio.wait_for(ws.recv(), timeout=8)
                d = json.loads(msg)
                compact = json.dumps(d, ensure_ascii=False)
                print(f"T+{time.time()-t0:5.2f}s {compact[:260]}")
                if d.get("type") == "ready_to_stop":
                    break
        except asyncio.TimeoutError:
            print("[test] 8sn mesaj gelmedi; bitiriliyor")
        finally:
            send_task.cancel()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--url", default="ws://127.0.0.1:8000/asr")
    args = ap.parse_args()
    asyncio.run(run(args.wav, args.url))


if __name__ == "__main__":
    main()
