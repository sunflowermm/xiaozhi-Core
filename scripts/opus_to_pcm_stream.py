#!/usr/bin/env python3
"""
设备上行 Opus → PCM：stdin 读 [2B LE 长度][Opus 帧]，解码后 stdout 写 [2B LE 长度][PCM]。
与 xiaozhi-esp32 设备上行一致（通常 16k/1ch/60ms）。供 tasker ASR 子进程调用。
依赖: opuslib_next；Windows 需 PyOgg 或 libopus。
用法: python opus_to_pcm_stream.py [sample_rate]
      默认 sample_rate=16000
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

CHANNELS = 1
FRAME_MS = 60


def main():
    sample_rate = int(sys.argv[1]) if len(sys.argv) > 1 else 16000
    samples_per_frame = sample_rate * FRAME_MS // 1000

    try:
        from opuslib_next import Decoder
    except ImportError:
        sys.stderr.write("opus_to_pcm_stream: need opuslib_next (and PyOgg/libopus on Windows)\n")
        sys.exit(1)

    decoder = Decoder(sample_rate, CHANNELS)

    def read_exact(n):
        buf = bytearray()
        while len(buf) < n:
            chunk = sys.stdin.buffer.read(n - len(buf))
            if not chunk:
                return None
            buf.extend(chunk)
        return bytes(buf)

    try:
        while True:
            len_buf = read_exact(2)
            if not len_buf or len(len_buf) < 2:
                break
            (opus_len,) = struct.unpack("<H", len_buf)
            if opus_len == 0:
                break
            opus_data = read_exact(opus_len)
            if not opus_data or len(opus_data) != opus_len:
                break
            try:
                pcm = decoder.decode(opus_data, samples_per_frame)
            except Exception:
                pcm = b""
            if not pcm:
                pcm = b"\x00" * (samples_per_frame * CHANNELS * 2)
            sys.stdout.buffer.write(struct.pack("<H", min(len(pcm), 0xFFFF)))
            sys.stdout.buffer.write(pcm[:0xFFFF])
            sys.stdout.buffer.flush()
    except BrokenPipeError:
        pass
    except Exception as e:
        sys.stderr.write(f"opus_to_pcm_stream: {e}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
