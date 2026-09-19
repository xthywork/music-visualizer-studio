import json
from pathlib import Path

import pytest

from app.render_jobs.models import OUTPUT_DIMENSIONS
from app.render_jobs.scene import calculate_placement, default_settings
from app.render_jobs.scenes import lyric_scroll


ROOT = Path(__file__).resolve().parents[2]


def fixture() -> dict:
    return json.loads(
        (ROOT / "fixtures/render-conformance/domain.json").read_text(encoding="utf-8")
    )


def test_backend_domain_matches_shared_conformance_fixture() -> None:
    data = fixture()
    assert set(data["templateIds"]) == {
        "quiet-editorial",
        "paper-resonance",
        "panorama-lyrics",
        "poetry-lyrics",
        "night-orbit",
        "dawn-spectrum",
    }
    for output in data["outputs"]:
        key = (output["aspectRatio"], output["resolution"])
        assert OUTPUT_DIMENSIONS[key] == (output["width"], output["height"])
    for template_id, expected in data["defaults"].items():
        settings = default_settings(template_id)
        assert settings.theme == expected["theme"]
        assert settings.accent == expected["accent"]
        assert settings.line_count == expected["lineCount"]


def test_backend_lyrics_and_placement_match_shared_fixture() -> None:
    data = fixture()
    cues = [type("Cue", (), cue) for cue in data["lyrics"]["cues"]]
    for query in data["lyrics"]["queries"]:
        assert lyric_scroll(cues, query["time"])[0] == query["active"]
    placement_data = data["placement"]
    source = placement_data["source"]
    destination = placement_data["destination"]
    placement = calculate_placement(
        (source["width"], source["height"]),
        (destination["x"], destination["y"], destination["width"], destination["height"]),
        contain=False,
        zoom=placement_data["zoom"],
        pan_x=placement_data["panX"],
        pan_y=placement_data["panY"],
    )
    assert list(placement.source) == pytest.approx(placement_data["expectedSource"])
