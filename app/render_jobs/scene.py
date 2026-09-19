"""Shared primitives and protocol for the CPU raster scene renderer."""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from PIL import Image, ImageColor, ImageDraw, ImageFont

from .audio import AudioAnalysis
from .models import RenderConfiguration, TemplateSettings


PALETTES: dict[str, tuple[str, ...]] = {
    "custom": (),
    "earth": ("#b96046", "#87966a", "#bda87e"),
    "coast": ("#649ca8", "#8aabc2", "#c0b49b"),
    "plum": ("#ac7897", "#8b87b3", "#caa590"),
    "forest": ("#789c84", "#ba9c58", "#9ca895"),
    "rose": ("#c38383", "#92959b", "#b7a39b"),
}


@dataclass(frozen=True, slots=True)
class SceneSettings:
    theme: str
    accent: str
    motion: float = 1
    background: float = 1
    cover_scale: float = 1
    cover_x: float = 0
    cover_y: float = 0
    image_width: float = 100
    image_zoom: float = 1
    image_x: float = 0
    image_y: float = 0
    line_count: int = 1
    palette: str = "custom"
    lyric_size: float = 1
    line_gap: float = 1.8
    fade: float = 0.4


def default_settings(template_id: str) -> SceneSettings:
    if template_id == "night-orbit":
        return SceneSettings(theme="dark", accent="#8bbab8")
    if template_id == "dawn-spectrum":
        return SceneSettings(theme="light", accent="#b77956")
    if template_id == "paper-resonance":
        return SceneSettings(theme="light", accent="#b84330", line_count=3)
    if template_id == "poetry-lyrics":
        return SceneSettings(theme="light", accent="#8b735b", image_width=24)
    return SceneSettings(theme="dark", accent="#c9b99c")


def settings_for(configuration: RenderConfiguration) -> SceneSettings:
    base = default_settings(configuration.template_id)
    override: TemplateSettings | None = configuration.template_settings.get(
        configuration.template_id
    )
    if override is None:
        return base
    changes = {
        field: value
        for field, value in override.model_dump().items()
        if value is not None
    }
    return replace(base, **changes)


@dataclass(slots=True)
class SceneAssets:
    cover: Image.Image | None = None
    background: Image.Image | None = None


@dataclass(frozen=True, slots=True)
class SceneFrame:
    time: float
    frame: int
    total_frames: int
    width: int
    height: int
    analysis: AudioAnalysis

    @property
    def progress(self) -> float:
        return self.frame / max(1, self.total_frames - 1)


class ServerScene(Protocol):
    def render(self, frame: SceneFrame) -> Image.Image: ...


class FontBook:
    """Loads one explicit font file for reproducible sizing within a deployment."""

    _CANDIDATES = (
        Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    )

    def __init__(self, font_path: Path | None = None) -> None:
        candidates = (font_path,) if font_path else self._CANDIDATES
        self.path = next(
            (candidate for candidate in candidates if candidate is not None and candidate.is_file()),
            None,
        )
        if self.path is None:
            raise FileNotFoundError(
                "No render font is available; configure VISUALIZER_FONT_PATH."
            )
        self._cache: dict[int, ImageFont.FreeTypeFont] = {}

    def get(self, size: float) -> ImageFont.FreeTypeFont:
        rounded = max(8, int(round(size)))
        if rounded not in self._cache:
            self._cache[rounded] = ImageFont.truetype(str(self.path), rounded)
        return self._cache[rounded]


@dataclass(frozen=True, slots=True)
class ImagePlacement:
    source: tuple[float, float, float, float]
    destination: tuple[int, int, int, int]


def calculate_placement(
    image_size: tuple[int, int],
    destination: tuple[int, int, int, int],
    *,
    contain: bool,
    zoom: float = 1,
    pan_x: float = 0,
    pan_y: float = 0,
) -> ImagePlacement:
    image_width, image_height = image_size
    x, y, width, height = destination
    if min(image_width, image_height, width, height) <= 0:
        raise ValueError("image and destination dimensions must be positive")
    if contain:
        scale = min(width / image_width, height / image_height)
        drawn_width = max(1, round(image_width * scale))
        drawn_height = max(1, round(image_height * scale))
        return ImagePlacement(
            source=(0, 0, image_width, image_height),
            destination=(
                x + (width - drawn_width) // 2,
                y + (height - drawn_height) // 2,
                drawn_width,
                drawn_height,
            ),
        )
    scale = max(width / image_width, height / image_height) * max(1, zoom) * 1.04
    crop_width = min(float(image_width), width / scale)
    crop_height = min(float(image_height), height / scale)
    normalized_x = min(1.0, max(0.0, 0.5 - pan_x / 200))
    normalized_y = min(1.0, max(0.0, 0.5 - pan_y / 200))
    left = (image_width - crop_width) * normalized_x
    top = (image_height - crop_height) * normalized_y
    return ImagePlacement(
        source=(left, top, left + crop_width, top + crop_height),
        destination=destination,
    )


def paste_image(
    canvas: Image.Image,
    source: Image.Image | None,
    destination: tuple[int, int, int, int],
    *,
    contain: bool = False,
    zoom: float = 1,
    pan_x: float = 0,
    pan_y: float = 0,
    opacity: float = 1,
) -> None:
    if source is None:
        return
    placement = calculate_placement(
        source.size,
        destination,
        contain=contain,
        zoom=zoom,
        pan_x=pan_x,
        pan_y=pan_y,
    )
    cropped = source.crop(tuple(round(value) for value in placement.source))
    resized = cropped.resize(
        (placement.destination[2], placement.destination[3]), Image.Resampling.LANCZOS
    ).convert("RGBA")
    if opacity < 1:
        alpha = resized.getchannel("A").point(lambda value: round(value * max(0, min(1, opacity))))
        resized.putalpha(alpha)
    canvas.alpha_composite(resized, (placement.destination[0], placement.destination[1]))


def rgba(color: str, alpha: float = 1) -> tuple[int, int, int, int]:
    red, green, blue = ImageColor.getrgb(color)
    return red, green, blue, round(255 * min(1, max(0, alpha)))


def line_colors(settings: SceneSettings) -> tuple[str, ...]:
    palette = PALETTES.get(settings.palette, ())
    if palette:
        return palette
    return (
        settings.accent,
        "#bbc8bc" if settings.theme == "dark" else "#444b44",
        "#8b8a7b",
    )


def fit_text(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.FreeTypeFont,
    max_width: float,
) -> str:
    value = text or "Untitled"
    if draw.textlength(value, font=font) <= max_width:
        return value
    characters = list(value)
    while characters and draw.textlength("".join(characters) + "…", font=font) > max_width:
        characters.pop()
    return "".join(characters) + "…"


def draw_progress(
    draw: ImageDraw.ImageDraw,
    *,
    start: tuple[float, float],
    end_x: float,
    progress: float,
    color: str,
    width: int,
) -> None:
    draw.line((start[0], start[1], end_x, start[1]), fill=rgba(color, 0.25), width=width)
    current = start[0] + (end_x - start[0]) * min(1, max(0, progress))
    draw.line((start[0], start[1], current, start[1]), fill=rgba(color), width=width)


def clock(seconds: float) -> str:
    whole = max(0, int(math.floor(seconds)))
    return f"{whole // 60:02d}:{whole % 60:02d}"
