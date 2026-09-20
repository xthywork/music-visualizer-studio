"""Bounded, ordered multi-process scene frame rendering."""

from __future__ import annotations

import multiprocessing
from concurrent.futures import Future, ProcessPoolExecutor, TimeoutError
from dataclasses import dataclass
from itertools import chain
from multiprocessing.shared_memory import SharedMemory
from types import TracebackType
from typing import Callable, Iterator

from .audio import AudioAnalysis
from .encoder import RenderCancelled
from .scene import SceneFrame, ServerScene


@dataclass(frozen=True, slots=True)
class FramePlan:
    total_frames: int
    width: int
    height: int
    frame_rate: int
    mode: str = "RGB"


@dataclass(frozen=True, slots=True)
class _FrameWorkerContext:
    scene: ServerScene
    analysis: AudioAnalysis
    plan: FramePlan
    shared_memory: SharedMemory
    slot_size: int


_FRAME_CONTEXT: _FrameWorkerContext | None = None


def _render_frame(frame_number: int, slot: int) -> int:
    context = _FRAME_CONTEXT
    if context is None:  # pragma: no cover - protects a broken process bootstrap
        raise RuntimeError("parallel frame worker was not initialized")
    plan = context.plan
    image = context.scene.render(
        SceneFrame(
            time=frame_number / plan.frame_rate,
            frame=frame_number,
            total_frames=plan.total_frames,
            width=plan.width,
            height=plan.height,
            analysis=context.analysis,
        )
    )
    if image.mode != plan.mode or image.size != (plan.width, plan.height):
        raise ValueError("scene returned a frame with the wrong mode or dimensions")
    payload = image.tobytes()
    if len(payload) != context.slot_size:
        raise ValueError("scene returned a frame with the wrong byte length")
    start = slot * context.slot_size
    context.shared_memory.buf[start : start + context.slot_size] = payload
    return slot


class ParallelFrameSource:
    """Render independent frames concurrently while yielding them in order.

    The production target is Linux. ``fork`` lets children share immutable
    scene assets and NumPy analysis pages copy-on-write rather than serializing
    large source images into every process. Exactly ``workers`` futures remain
    in flight, bounding completed raw-frame payloads to the worker count.
    """

    def __init__(
        self,
        scene: ServerScene,
        analysis: AudioAnalysis,
        plan: FramePlan,
        *,
        workers: int,
        cancelled: Callable[[], bool],
        result_poll_seconds: float = 0.1,
    ) -> None:
        if workers < 1:
            raise ValueError("frame worker count must be positive")
        self.scene = scene
        self.analysis = analysis
        self.plan = plan
        self.workers = workers
        self.cancelled = cancelled
        self.result_poll_seconds = result_poll_seconds
        self.context: _FrameWorkerContext | None = None
        self.shared_memory: SharedMemory | None = None
        self.executor: ProcessPoolExecutor | None = None
        self.futures: dict[int, Future[int]] = {}
        self.iterator: Iterator[memoryview] | None = None

    def __enter__(self) -> ParallelFrameSource:
        global _FRAME_CONTEXT
        if _FRAME_CONTEXT is not None:
            raise RuntimeError("a parallel frame source is already active")
        if "fork" not in multiprocessing.get_all_start_methods():
            raise RuntimeError("parallel server rendering requires a platform with fork support")
        channels = 4 if self.plan.mode == "RGBA" else 3
        slot_size = self.plan.width * self.plan.height * channels
        self.shared_memory = SharedMemory(create=True, size=slot_size * self.workers)
        self.context = _FrameWorkerContext(
            self.scene,
            self.analysis,
            self.plan,
            self.shared_memory,
            slot_size,
        )
        _FRAME_CONTEXT = self.context
        try:
            self.executor = ProcessPoolExecutor(
                max_workers=self.workers,
                mp_context=multiprocessing.get_context("fork"),
            )
        except BaseException:
            _FRAME_CONTEXT = None
            self.shared_memory.close()
            self.shared_memory.unlink()
            self.shared_memory = None
            self.context = None
            raise
        return self

    def __exit__(
        self,
        _exception_type: type[BaseException] | None,
        _exception: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        global _FRAME_CONTEXT
        try:
            if self.iterator is not None:
                close = getattr(self.iterator, "close", None)
                if close is not None:
                    close()
                self.iterator = None
            for future in self.futures.values():
                future.cancel()
            self.futures.clear()
            if self.executor is not None:
                self.executor.shutdown(wait=True, cancel_futures=True)
                self.executor = None
        finally:
            _FRAME_CONTEXT = None
            self.context = None
            if self.shared_memory is not None:
                self.shared_memory.close()
                self.shared_memory.unlink()
                self.shared_memory = None

    def __iter__(self) -> Iterator[memoryview]:
        if self.iterator is not None:
            raise RuntimeError("parallel frame source can only be iterated once")
        self.iterator = self._iterate()
        return self.iterator

    def _iterate(self) -> Iterator[memoryview]:
        executor = self.executor
        context = self.context
        shared_memory = self.shared_memory
        if executor is None or context is None or shared_memory is None:
            raise RuntimeError("parallel frame source must be used as a context manager")
        total = context.plan.total_frames
        next_to_submit = 0
        while next_to_submit < min(total, self.workers):
            slot = next_to_submit % self.workers
            self.futures[next_to_submit] = executor.submit(
                _render_frame, next_to_submit, slot
            )
            next_to_submit += 1

        for frame_number in range(total):
            future = self.futures[frame_number]
            while True:
                if self.cancelled():
                    raise RenderCancelled("Render cancellation was requested.")
                try:
                    slot = future.result(timeout=self.result_poll_seconds)
                    break
                except TimeoutError:
                    continue
            del self.futures[frame_number]
            start = slot * context.slot_size
            view = shared_memory.buf[start : start + context.slot_size]
            try:
                yield view
            finally:
                view.release()
            if next_to_submit < total:
                next_slot = next_to_submit % self.workers
                self.futures[next_to_submit] = executor.submit(
                    _render_frame, next_to_submit, next_slot
                )
                next_to_submit += 1

    def prime(self) -> Iterator[memoryview]:
        """Start every fork worker before the caller opens an encoder pipe.

        ``ProcessPoolExecutor`` launches all fork workers on its first submit.
        Consuming the first frame here therefore guarantees that a subsequently
        spawned FFmpeg process cannot have its stdin descriptor inherited by a
        frame child. The returned iterator still contains every frame in order.
        """

        iterator = iter(self)
        first = next(iterator)
        return chain((first,), iterator)
