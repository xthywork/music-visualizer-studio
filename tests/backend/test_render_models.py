import pytest
from pydantic import ValidationError

from app.render_jobs.models import JobState, RenderConfiguration, RenderJobResponse


TEMPLATES = (
    "quiet-editorial",
    "paper-resonance",
    "panorama-lyrics",
    "poetry-lyrics",
    "night-orbit",
    "dawn-spectrum",
)


def valid_configuration(template_id: str = "night-orbit") -> dict:
    return {
        "schemaVersion": 1,
        "templateId": template_id,
        "text": {"title": "Song", "artist": "Artist"},
        "lyrics": [{"start": 0.0, "text": "Line"}] if "lyrics" in template_id else [],
        "templateSettings": {
            template_id: {
                "theme": "dark",
                "accent": "#8bbab8",
                "motion": 1.0,
                "lineCount": 3,
            }
        },
        "output": {
            "aspectRatio": "16:9",
            "width": 1920,
            "height": 1080,
            "frameRate": 60,
        },
    }


@pytest.mark.parametrize("template_id", TEMPLATES)
def test_current_templates_round_trip_with_camel_case_contract(template_id: str) -> None:
    config = RenderConfiguration.model_validate(valid_configuration(template_id))

    encoded = config.model_dump(mode="json", by_alias=True)

    assert RenderConfiguration.model_validate(encoded) == config
    assert encoded["templateId"] == template_id
    assert encoded["output"]["frameRate"] == 60


def test_unknown_fields_and_unknown_templates_are_rejected() -> None:
    config = valid_configuration()
    config["unknown"] = True
    with pytest.raises(ValidationError):
        RenderConfiguration.model_validate(config)

    config = valid_configuration()
    config["templateId"] = "abstract-pulse"
    with pytest.raises(ValidationError):
        RenderConfiguration.model_validate(config)


def test_output_dimensions_must_match_aspect_ratio_preset() -> None:
    config = valid_configuration()
    config["output"]["width"] = 1080
    with pytest.raises(ValidationError, match="supported preset"):
        RenderConfiguration.model_validate(config)


def test_lyric_templates_require_cues() -> None:
    config = valid_configuration("poetry-lyrics")
    config["lyrics"] = []
    with pytest.raises(ValidationError, match="subtitle cue"):
        RenderConfiguration.model_validate(config)


def test_job_response_rejects_inconsistent_types() -> None:
    with pytest.raises(ValidationError):
        RenderJobResponse.model_validate(
            {
                "id": "job",
                "state": JobState.QUEUED,
                "progress": "0.5",
                "frame": 0,
                "totalFrames": 10,
                "createdAt": "2026-09-19T00:00:00Z",
                "updatedAt": "2026-09-19T00:00:00Z",
            }
        )
