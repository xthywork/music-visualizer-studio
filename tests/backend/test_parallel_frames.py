from __future__ import annotations

import multiprocessing
import os

import numpy as np
from PIL import Image
import pytest

from app.render_jobs.audio import AudioAnalysis
from app.render_jobs.encoder import RenderCancelled
from app.render_jobs.frames import FramePlan, ParallelFrameSource
from app.render_jobs.models import RenderConfiguration
from app.render_jobs.scene import FontBook, SceneAssets, SceneFrame
from app.render_jobs.scenes import create_scene


class NumberedScene:
    def render(self, frame: SceneFrame) -> Image.Image:
        return Image.new(
            "RGB",
            (frame.width, frame.height),
            (frame.frame, frame.frame + 1, frame.frame + 2),
        )


class InvalidScene:
    def render(self, frame: SceneFrame) -> Image.Image:
        return Image.new("RGBA", (frame.width, frame.height))


def analysis() -> AudioAnalysis:
    values = np.ones(8, dtype=np.float32)
    return AudioAnalysis(
        duration=1,
        sample_rate=48_000,
        waveform=values,
        spectrum=values,
        beats=values,
        temporal_rate=8,
        amplitude=values,
        low=values,
        mid=values,
        high=values,
        temporal_spectrum=np.ones((8, 8), dtype=np.float32),
    )


@pytest.mark.skipif("fork" not in multiprocessing.get_all_start_methods(), reason="requires fork")
def test_parallel_frames_are_bounded_and_yielded_in_frame_order() -> None:
    plan = FramePlan(total_frames=8, width=4, height=3, frame_rate=8)
    with ParallelFrameSource(
        NumberedScene(), analysis(), plan, workers=4, cancelled=lambda: False
    ) as frames:
        iterator = iter(frames)
        first = next(iterator)
        assert len(frames.futures) <= 4
        payloads = [first, *iterator]

    assert len(payloads) == 8
    assert [payload[:3] for payload in payloads] == [
        bytes((frame, frame + 1, frame + 2)) for frame in range(8)
    ]


@pytest.mark.skipif("fork" not in multiprocessing.get_all_start_methods(), reason="requires fork")
def test_priming_starts_children_before_later_encoder_pipe_is_opened() -> None:
    plan = FramePlan(total_frames=8, width=4, height=3, frame_rate=8)
    with ParallelFrameSource(
        NumberedScene(), analysis(), plan, workers=4, cancelled=lambda: False
    ) as frames:
        ordered = frames.prime()
        read_descriptor, write_descriptor = os.pipe()
        try:
            os.close(write_descriptor)
            assert os.read(read_descriptor, 1) == b""
            assert len(list(ordered)) == plan.total_frames
        finally:
            os.close(read_descriptor)


@pytest.mark.skipif("fork" not in multiprocessing.get_all_start_methods(), reason="requires fork")
def test_real_scene_parallel_frames_match_sequential_render_exactly() -> None:
    configuration = RenderConfiguration.model_validate(
        {
            "schemaVersion": 1,
            "templateId": "paper-resonance",
            "text": {"title": "Parallel", "artist": "Renderer"},
            "output": {
                "aspectRatio": "16:9",
                "width": 1280,
                "height": 720,
                "frameRate": 30,
            },
        }
    )
    plan = FramePlan(total_frames=4, width=320, height=180, frame_rate=30)
    audio = analysis()
    expected_scene = create_scene(configuration, SceneAssets(), FontBook())
    expected = [
        expected_scene.render(
            SceneFrame(
                time=frame / plan.frame_rate,
                frame=frame,
                total_frames=plan.total_frames,
                width=plan.width,
                height=plan.height,
                analysis=audio,
            )
        ).tobytes()
        for frame in range(plan.total_frames)
    ]
    parallel_scene = create_scene(configuration, SceneAssets(), FontBook())

    with ParallelFrameSource(
        parallel_scene, audio, plan, workers=4, cancelled=lambda: False
    ) as frames:
        actual = list(frames)

    assert actual == expected


@pytest.mark.skipif("fork" not in multiprocessing.get_all_start_methods(), reason="requires fork")
def test_parallel_frame_error_cleans_pool_and_allows_next_render() -> None:
    plan = FramePlan(total_frames=1, width=4, height=3, frame_rate=8)
    with pytest.raises(ValueError, match="wrong mode or dimensions"):
        with ParallelFrameSource(
            InvalidScene(), analysis(), plan, workers=2, cancelled=lambda: False
        ) as frames:
            list(frames)

    with ParallelFrameSource(
        NumberedScene(), analysis(), plan, workers=2, cancelled=lambda: False
    ) as frames:
        assert len(list(frames)) == 1


@pytest.mark.skipif("fork" not in multiprocessing.get_all_start_methods(), reason="requires fork")
def test_parallel_frame_source_honours_cancellation() -> None:
    plan = FramePlan(total_frames=8, width=4, height=3, frame_rate=8)
    with pytest.raises(RenderCancelled):
        with ParallelFrameSource(
            NumberedScene(), analysis(), plan, workers=4, cancelled=lambda: True
        ) as frames:
            list(frames)
