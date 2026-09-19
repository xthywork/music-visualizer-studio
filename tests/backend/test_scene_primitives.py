from pathlib import Path

import pytest
from PIL import Image

from app.render_jobs.models import RenderConfiguration
from app.render_jobs.scene import (
    FontBook,
    calculate_placement,
    paste_image,
    settings_for,
)


@pytest.mark.parametrize(
    ("destination", "expected_size"),
    (
        ((0, 0, 1600, 900), (1600, 900)),
        ((0, 0, 900, 1600), (900, 1600)),
        ((0, 0, 1000, 1000), (1000, 1000)),
    ),
)
def test_cover_placement_fills_every_aspect_ratio(destination, expected_size) -> None:
    placement = calculate_placement(
        (1200, 800), destination, contain=False, zoom=1.2, pan_x=20, pan_y=-20
    )
    assert placement.destination[2:] == expected_size
    left, top, right, bottom = placement.source
    assert 0 <= left < right <= 1200
    assert 0 <= top < bottom <= 800


def test_contain_placement_preserves_full_source() -> None:
    placement = calculate_placement((1200, 600), (0, 0, 500, 500), contain=True)
    assert placement.source == (0, 0, 1200, 600)
    assert placement.destination == (0, 125, 500, 250)


def test_paste_image_respects_destination_bounds() -> None:
    canvas = Image.new("RGBA", (100, 100), "black")
    source = Image.new("RGBA", (200, 100), "red")
    paste_image(canvas, source, (25, 25, 50, 50), contain=False)
    assert canvas.getpixel((50, 50))[:3] == (255, 0, 0)
    assert canvas.getpixel((10, 10))[:3] == (0, 0, 0)


def test_explicit_font_loads_and_is_cached() -> None:
    path = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    if not path.is_file():
        pytest.skip("test font is unavailable")
    fonts = FontBook(path)
    assert fonts.get(24) is fonts.get(24)


def test_scene_settings_merge_only_selected_template() -> None:
    config = RenderConfiguration.model_validate(
        {
            "schemaVersion": 1,
            "templateId": "paper-resonance",
            "text": {"title": "Song", "artist": "Artist"},
            "templateSettings": {
                "paper-resonance": {"motion": 3.0, "lineCount": 5},
                "night-orbit": {"motion": 2.0},
            },
            "output": {
                "aspectRatio": "1:1",
                "width": 720,
                "height": 720,
                "frameRate": 30,
            },
        }
    )
    settings = settings_for(config)
    assert settings.motion == 3
    assert settings.line_count == 5
    assert settings.accent == "#b84330"
