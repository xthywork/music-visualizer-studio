"""Measure whether an H200 vGPU can accelerate the 4K frame stage.

This is deliberately independent from the production renderer.  It measures
the operation that matters for the proposed CUDA path: copy a static frame in
VRAM, draw a small audio-reactive overlay, and transfer one RGB frame back to
host memory for libx264.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import time

import numpy as np

try:
    import cupy as cp
except ImportError as error:  # pragma: no cover - exercised on the H200 host
    raise SystemExit(
        "CuPy is unavailable. Run this script with "
        "`uv run --with 'cupy-cuda13x[ctk]>=14,<15' ...`."
    ) from error


KERNEL = cp.RawKernel(
    r"""
    extern "C" __global__
    void composite(
        const unsigned char* base,
        unsigned char* output,
        const float* energy,
        const int width,
        const int height
    ) {
        const int pixel = blockDim.x * blockIdx.x + threadIdx.x;
        const int pixels = width * height;
        if (pixel >= pixels) return;

        const int x = pixel % width;
        const int y = pixel / width;
        const int offset = pixel * 3;
        unsigned char red = base[offset];
        unsigned char green = base[offset + 1];
        unsigned char blue = base[offset + 2];

        const int start_x = width * 56 / 100;
        const int end_x = width * 94 / 100;
        const int baseline = height * 70 / 100;
        if (x >= start_x && x < end_x && y <= baseline) {
            const int relative_x = x - start_x;
            const int span = end_x - start_x;
            const int bar = min(63, relative_x * 64 / span);
            const int slot_start = bar * span / 64;
            const int slot_end = (bar + 1) * span / 64;
            const int bar_width = max(1, (slot_end - slot_start) / 3);
            const int within_slot = relative_x - slot_start;
            const int bar_height = (int)(height * 0.095f * energy[bar]);
            if (within_slot < bar_width && y >= baseline - bar_height) {
                red = 178;
                green = 121;
                blue = 78;
            }
        }

        output[offset] = red;
        output[offset + 1] = green;
        output[offset + 2] = blue;
    }
    """,
    "composite",
)


def _device_name(properties: dict) -> str:
    name = properties.get("name", "unknown")
    return name.decode() if isinstance(name, bytes) else str(name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", type=int, default=120)
    parser.add_argument("--width", type=int, default=3840)
    parser.add_argument("--height", type=int, default=2160)
    parser.add_argument("--encode", action="store_true")
    parser.add_argument("--frame-rate", type=int, default=60)
    parser.add_argument("--encoder-threads", type=int, default=24)
    parser.add_argument("--encoder-preset", default="veryfast")
    arguments = parser.parse_args()
    if min(
        arguments.frames,
        arguments.width,
        arguments.height,
        arguments.frame_rate,
        arguments.encoder_threads,
    ) < 1:
        raise SystemExit("frames, width, and height must be positive")

    device = cp.cuda.Device(0)
    device.use()
    properties = cp.cuda.runtime.getDeviceProperties(0)
    width = arguments.width
    height = arguments.height
    shape = (height, width, 3)
    frame_bytes = width * height * 3

    base = cp.empty(shape, dtype=cp.uint8)
    base[:, :, 0] = 34
    base[:, :, 1] = 39
    base[:, :, 2] = 35
    output = cp.empty_like(base)
    energy = cp.empty(64, dtype=cp.float32)
    pinned = cp.cuda.alloc_pinned_memory(frame_bytes)
    host = np.frombuffer(pinned, dtype=np.uint8, count=frame_bytes).reshape(shape)
    stream = cp.cuda.Stream(non_blocking=True)
    block_size = 256
    grid_size = (width * height + block_size - 1) // block_size

    def render(frame_number: int) -> None:
        phase = frame_number / 12
        values = 0.15 + 0.85 * np.sin(
            np.linspace(0, np.pi * 4, 64, dtype=np.float32) + phase
        ) ** 2
        with stream:
            energy.set(values, stream=stream)
            KERNEL(
                (grid_size,),
                (block_size,),
                (base, output, energy, width, height),
                stream=stream,
            )
            cp.cuda.runtime.memcpyAsync(
                host.ctypes.data,
                output.data.ptr,
                frame_bytes,
                cp.cuda.runtime.memcpyDeviceToHost,
                stream.ptr,
            )
        stream.synchronize()

    for frame_number in range(10):
        render(frame_number)

    started = time.perf_counter()
    for frame_number in range(arguments.frames):
        render(frame_number)
    elapsed = time.perf_counter() - started
    fps = arguments.frames / elapsed
    throughput = frame_bytes * arguments.frames / elapsed / 1024**3

    print(f"device={_device_name(properties)}")
    print(f"compute_capability={device.compute_capability}")
    print(f"frame={width}x{height} rgb24 ({frame_bytes / 1024**2:.2f} MiB)")
    print(f"frames={arguments.frames}")
    print(f"seconds={elapsed:.3f}")
    print(f"cuda_composite_and_download_fps={fps:.2f}")
    print(f"effective_download_gib_s={throughput:.2f}")
    print(f"host_checksum={int(host[0, 0].sum())}")

    if arguments.encode:
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            raise SystemExit("ffmpeg is not available on PATH")
        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-video_size",
            f"{width}x{height}",
            "-framerate",
            str(arguments.frame_rate),
            "-i",
            "pipe:0",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            arguments.encoder_preset,
            "-threads",
            str(arguments.encoder_threads),
            "-pix_fmt",
            "yuv420p",
            "-f",
            "null",
            "-",
        ]
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        if process.stdin is None or process.stderr is None:
            process.kill()
            raise SystemExit("failed to open FFmpeg pipes")
        encoded_started = time.perf_counter()
        try:
            for frame_number in range(arguments.frames):
                render(frame_number)
                pending = memoryview(host).cast("B")
                while pending:
                    written = process.stdin.write(pending)
                    if written is None or written <= 0:
                        raise BrokenPipeError("FFmpeg stopped reading frames")
                    pending = pending[written:]
            process.stdin.close()
            returncode = process.wait()
            diagnostic = process.stderr.read().decode(errors="replace")
        except BaseException:
            process.kill()
            process.wait()
            raise
        if returncode != 0:
            raise SystemExit(
                f"FFmpeg exited with {returncode}: {diagnostic.strip()}"
            )
        encoded_elapsed = time.perf_counter() - encoded_started
        encoded_fps = arguments.frames / encoded_elapsed
        print(f"encoder=libx264/{arguments.encoder_preset}")
        print(f"encoder_threads={arguments.encoder_threads}")
        print(f"gpu_to_libx264_seconds={encoded_elapsed:.3f}")
        print(f"gpu_to_libx264_fps={encoded_fps:.2f}")


if __name__ == "__main__":
    main()
