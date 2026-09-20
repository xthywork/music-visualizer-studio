import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.render_jobs.audio import AudioAnalysis
from app.render_jobs.models import RenderConfiguration
from app.render_jobs.scene import FontBook, SceneAssets, SceneFrame
from app.render_jobs.scenes import create_scene, lyric_scroll


ROOT = Path(__file__).resolve().parents[2]
TEMPLATES = (
    "night-orbit",
    "dawn-spectrum",
    "quiet-editorial",
    "paper-resonance",
    "panorama-lyrics",
    "poetry-lyrics",
)
RATIOS = {
    "16:9": (320, 180),
    "9:16": (180, 320),
    "1:1": (240, 240),
}


def analysis(level: float = 0.65) -> AudioAnalysis:
    frames = 120
    bands = 64
    ramp = np.linspace(0.1, level, frames, dtype=np.float32)
    spectrum = np.outer(ramp, np.linspace(0.2, 1, bands, dtype=np.float32)).astype(np.float32)
    return AudioAnalysis(
        duration=4,
        sample_rate=48_000,
        waveform=ramp,
        spectrum=spectrum.mean(axis=0),
        beats=np.asarray([0.5, 1.5, 2.5], dtype=np.float32),
        temporal_rate=30,
        amplitude=ramp,
        low=ramp,
        mid=np.sqrt(ramp).astype(np.float32),
        high=np.square(ramp).astype(np.float32),
        temporal_spectrum=spectrum,
    )


def configuration(template_id: str, ratio: str) -> RenderConfiguration:
    preset = {
        "16:9": (1280, 720),
        "9:16": (720, 1280),
        "1:1": (720, 720),
    }[ratio]
    return RenderConfiguration.model_validate(
        {
            "schemaVersion": 1,
            "templateId": template_id,
            "text": {"title": "夜航測試 Song", "artist": "測試歌手 Artist"},
            "lyrics": [
                {"start": 0.0, "text": "第一行歌詞"},
                {"start": 1.0, "text": "Second lyric line"},
                {"start": 2.5, "text": "最後一句"},
            ] if "lyrics" in template_id else [],
            "templateSettings": {
                template_id: {
                    "motion": 1.5,
                    "lineCount": 3,
                    "imageWidth": 32 if template_id == "poetry-lyrics" else 100,
                }
            },
            "output": {
                "aspectRatio": ratio,
                "width": preset[0],
                "height": preset[1],
                "frameRate": 30,
            },
        }
    )


def font_book() -> FontBook:
    return FontBook(Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"))


def render_hash(template_id: str, ratio: str) -> str:
    width, height = RATIOS[ratio]
    cover = ImageAsset.cover()
    background = ImageAsset.background()
    scene = create_scene(
        configuration(template_id, ratio),
        SceneAssets(cover=cover, background=background),
        font_book(),
    )
    image = scene.render(
        SceneFrame(
            time=1.75,
            frame=52,
            total_frames=120,
            width=width,
            height=height,
            analysis=analysis(),
        )
    )
    return hashlib.sha256(image.tobytes()).hexdigest()


class ImageAsset:
    @staticmethod
    def cover():
        from PIL import Image, ImageDraw

        image = Image.new("RGBA", (160, 120), "#364b57")
        draw = ImageDraw.Draw(image)
        draw.ellipse((30, 10, 130, 110), fill="#d28a65")
        return image

    @staticmethod
    def background():
        from PIL import Image

        x = np.linspace(0, 1, 240, dtype=np.float32)
        y = np.linspace(0, 1, 160, dtype=np.float32)[:, None]
        pixels = np.zeros((160, 240, 4), dtype=np.uint8)
        pixels[..., 0] = (40 + x * 120).astype(np.uint8)
        pixels[..., 1] = (60 + y * 100).astype(np.uint8)
        pixels[..., 2] = 90
        pixels[..., 3] = 255
        return Image.fromarray(pixels, "RGBA")


@pytest.mark.parametrize("template_id", TEMPLATES)
@pytest.mark.parametrize("ratio", RATIOS)
def test_each_scene_renders_every_aspect_ratio(template_id: str, ratio: str) -> None:
    width, height = RATIOS[ratio]
    scene = create_scene(
        configuration(template_id, ratio),
        SceneAssets(cover=ImageAsset.cover(), background=ImageAsset.background()),
        font_book(),
    )
    image = scene.render(
        SceneFrame(
            time=1.75,
            frame=52,
            total_frames=120,
            width=width,
            height=height,
            analysis=analysis(),
        )
    )
    assert image.mode == "RGB"
    assert image.size == (width, height)
    assert image.getbbox() == (0, 0, width, height)


def test_instrumental_and_editorial_scenes_react_to_audio() -> None:
    for template_id in ("night-orbit", "dawn-spectrum", "quiet-editorial", "paper-resonance"):
        config = configuration(template_id, "16:9")
        scene = create_scene(config, SceneAssets(), font_book())
        quiet = scene.render(SceneFrame(time=1, frame=30, total_frames=120, width=320, height=180, analysis=analysis(0.05)))
        loud = scene.render(SceneFrame(time=1, frame=30, total_frames=120, width=320, height=180, analysis=analysis(1.0)))
        assert hashlib.sha256(quiet.tobytes()).digest() != hashlib.sha256(loud.tobytes()).digest()


def test_quiet_editorial_server_background_remains_visible_under_scrim() -> None:
    config = configuration("quiet-editorial", "16:9")
    frame = SceneFrame(
        time=1,
        frame=30,
        total_frames=120,
        width=320,
        height=180,
        analysis=analysis(),
    )
    without_background = create_scene(config, SceneAssets(), font_book()).render(frame)
    with_background = create_scene(
        config,
        SceneAssets(background=Image.new("RGBA", (32, 32), "#ff0000")),
        font_book(),
    ).render(frame)

    assert with_background.tobytes() != without_background.tobytes()


def test_quiet_editorial_static_cache_does_not_capture_dynamic_frame_content() -> None:
    config = configuration("quiet-editorial", "16:9")
    assets = SceneAssets(cover=ImageAsset.cover(), background=ImageAsset.background())
    cached_scene = create_scene(config, assets, font_book())
    first = SceneFrame(time=0, frame=0, total_frames=120, width=320, height=180, analysis=analysis(0.1))
    target = SceneFrame(time=2, frame=60, total_frames=120, width=320, height=180, analysis=analysis(0.9))
    cached_scene.render(first)
    cached = cached_scene.render(target)

    fresh_scene = create_scene(
        config,
        SceneAssets(cover=ImageAsset.cover(), background=ImageAsset.background()),
        font_book(),
    )
    fresh = fresh_scene.render(target)

    assert cached.tobytes() == fresh.tobytes()


def test_lyric_scroll_uses_start_only_across_gaps_and_final_cue() -> None:
    cues = configuration("panorama-lyrics", "16:9").lyrics
    assert lyric_scroll(cues, -1)[0] == -1
    assert lyric_scroll(cues, 0.8)[0] == 0
    assert lyric_scroll(cues, 2.0)[0] == 1
    assert lyric_scroll(cues, 999)[0] == 2


def test_scene_golden_hashes() -> None:
    expected = json.loads(
        (ROOT / "fixtures/render-conformance/server-scene-hashes.json").read_text(encoding="utf-8")
    )
    actual = {
        f"{template_id}:{ratio}": render_hash(template_id, ratio)
        for template_id in TEMPLATES
        for ratio in RATIOS
    }
    assert actual == expected
