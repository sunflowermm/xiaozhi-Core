#!/usr/bin/env python3
"""
TTS PCM → Opus 流：stdin 读 16bit LE PCM（24k/1ch），60ms/帧编码，stdout 写 [2B LE 长度][帧体]。
与 xiaozhi-esp32 设备及官方 server 协议一致（24k/1ch/60ms，裸 Opus 包）。音质与实时性由编码器与流控保证，与 Node 调子进程无关。
依赖: opuslib_next；Windows 需 PyOgg 或 libopus。
"""
import sys
import struct
import os

_script_dir = os.path.dirname(os.path.abspath(__file__))
_path_add = [_script_dir]
try:
    import importlib.util
    _spec = importlib.util.find_spec("pyogg")
    if _spec and getattr(_spec, "submodule_search_locations", None):
        _path_add.append(_spec.submodule_search_locations[0])
except Exception:
    pass
for _p in _path_add:
    if _p and _p not in os.environ.get("PATH", ""):
        os.environ["PATH"] = _p + os.pathsep + os.environ.get("PATH", "")

SAMPLE_RATE = 24000
CHANNELS = 1
FRAME_MS = 60
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_MS // 1000
FRAME_BYTES = SAMPLES_PER_FRAME * CHANNELS * 2


def main():
    try:
        from opuslib_next import Encoder
        from opuslib_next import constants
    except ImportError:
        sys.stderr.write("pcm_to_opus_stream: need opuslib_next (and PyOgg/libopus on Windows)\n")
        sys.exit(1)

    encoder = Encoder(SAMPLE_RATE, CHANNELS, constants.APPLICATION_AUDIO)
    buffer = bytearray()

    def emit_frame(opus_bytes):
        if not opus_bytes:
            return
        sys.stdout.buffer.write(struct.pack("<H", min(len(opus_bytes), 0xFFFF)))
        sys.stdout.buffer.write(opus_bytes)
        sys.stdout.buffer.flush()

    try:
        while True:
            chunk = sys.stdin.buffer.read(4096)
            if not chunk:
                break
            buffer.extend(chunk)
            while len(buffer) >= FRAME_BYTES:
                frame = bytes(buffer[:FRAME_BYTES])
                del buffer[:FRAME_BYTES]
                enc = encoder.encode(frame, SAMPLES_PER_FRAME)
                emit_frame(enc)
        if buffer:
            pad = bytes(buffer) + b"\x00" * (FRAME_BYTES - len(buffer))
            enc = encoder.encode(pad, SAMPLES_PER_FRAME)
            emit_frame(enc)
    except BrokenPipeError:
        pass
    except Exception as e:
        sys.stderr.write(f"pcm_to_opus_stream: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
