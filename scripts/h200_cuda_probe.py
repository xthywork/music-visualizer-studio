"""Measure whether an H200 vGPU can accelerate the 4K frame stage.

This is deliberately independent from the production renderer.  It measures
the operation that matters for the proposed CUDA path: copy a static frame in
VRAM, draw a small audio-reactive overlay, and transfer one RGB frame back to
host memory for libx264.
"""

from __future__ import annotations

import argparse
import time

import numpy as np

try:
    import cupy as cp
except ImportError as error:  # pragma: no cover - exercised on the H200 host
    raise SystemExit(
        "CuPy is unavailable. Run this script with "
        "`uv run --with 'cupy-cuda12x[ctk]>=14,<15' ...`."
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
    arguments = parser.parse_args()
    if arguments.frames < 1 or arguments.width < 1 or arguments.height < 1:
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


if __name__ == "__main__":
    main()
