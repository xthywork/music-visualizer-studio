from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from app.render_jobs.validation import MediaValidationError, MediaValidator


def audio_probe(duration: str = "12.5"):
    return lambda _path: {
        "streams": [{"codec_type": "audio", "codec_name": "mp3"}],
        "format": {"duration": duration},
    }


def test_audio_requires_supported_name_mime_stream_and_duration(tmp_path: Path) -> None:
    source = tmp_path / "audio.bin"
    source.write_bytes(b"fixture")
    validator = MediaValidator(probe=audio_probe())

    metadata = validator.validate_audio(
        source, original_filename="song.mp3", content_type="audio/mpeg"
    )

    assert metadata.duration == 12.5
    with pytest.raises(MediaValidationError):
        validator.validate_audio(source, original_filename="song.svg", content_type="audio/mpeg")
    with pytest.raises(MediaValidationError):
        validator.validate_audio(source, original_filename="song.mp3", content_type="text/html")


def test_audio_rejects_missing_stream_and_excess_duration(tmp_path: Path) -> None:
    source = tmp_path / "audio.bin"
    source.write_bytes(b"fixture")
    with pytest.raises(MediaValidationError, match="音訊軌"):
        MediaValidator(probe=lambda _path: {"streams": [], "format": {"duration": "1"}}).validate_audio(
            source, original_filename="song.wav", content_type="audio/wav"
        )
    with pytest.raises(MediaValidationError, match="10 分鐘"):
        MediaValidator(probe=audio_probe("601")).validate_audio(
            source, original_filename="song.m4a", content_type="audio/mp4"
        )


def make_image(path: Path, image_format: str = "PNG", size: tuple[int, int] = (32, 24)) -> None:
    image = Image.new("RGB", size, "red")
    image.save(path, format=image_format)


def test_image_requires_matching_png_jpeg_or_webp_content(tmp_path: Path) -> None:
    source = tmp_path / "image.bin"
    make_image(source)
    validator = MediaValidator()

    metadata = validator.validate_image(source, content_type="image/png")

    assert (metadata.width, metadata.height, metadata.format) == (32, 24, "PNG")
    with pytest.raises(MediaValidationError, match="MIME"):
        validator.validate_image(source, content_type="image/jpeg")
    with pytest.raises(MediaValidationError, match="僅支援"):
        validator.validate_image(source, content_type="image/svg+xml")


def test_image_rejects_dimensions_before_full_use(tmp_path: Path) -> None:
    source = tmp_path / "image.bin"
    make_image(source, size=(100, 100))

    with pytest.raises(MediaValidationError, match="尺寸過大"):
        MediaValidator(max_image_width=50, max_image_height=50, max_image_pixels=2_500).validate_image(
            source, content_type="image/png"
        )


def test_corrupt_image_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "image.bin"
    source.write_bytes(BytesIO(b"not-an-image").getvalue())
    with pytest.raises(MediaValidationError, match="無法解碼"):
        MediaValidator().validate_image(source, content_type="image/png")


def test_valid_utf8_srt_is_accepted_and_invalid_text_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "subtitles.srt"
    source.write_text(
        "1\n00:00:00,000 --> 00:00:02,000\n第一行\n\n2\n00:00:02,000 --> 00:00:04,000\n第二行\n",
        encoding="utf-8",
    )
    assert MediaValidator.validate_subtitles(source) == 2

    source.write_text("not srt", encoding="utf-8")
    with pytest.raises(MediaValidationError):
        MediaValidator.validate_subtitles(source)
