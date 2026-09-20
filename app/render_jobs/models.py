"""Versioned API and persistence models for server render jobs."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def _to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.title() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        extra="forbid",
        strict=True,
    )


TemplateId = Literal[
    "quiet-editorial",
    "paper-resonance",
    "panorama-lyrics",
    "poetry-lyrics",
    "night-orbit",
    "dawn-spectrum",
]
AspectRatio = Literal["16:9", "9:16", "1:1"]
Theme = Literal["light", "dark"]


class TextConfiguration(ApiModel):
    title: str = Field(max_length=300)
    artist: str = Field(max_length=300)


class LyricCue(ApiModel):
    start: float = Field(ge=0, le=600)
    text: str = Field(min_length=1, max_length=4_000)


class TemplateSettings(ApiModel):
    theme: Theme | None = None
    accent: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    motion: float | None = Field(default=None, ge=0, le=5)
    background: float | None = Field(default=None, ge=0.2, le=1)
    cover_scale: float | None = Field(default=None, ge=0.65, le=1)
    cover_x: float | None = Field(default=None, ge=-50, le=50)
    cover_y: float | None = Field(default=None, ge=-50, le=50)
    image_width: float | None = Field(default=None, ge=10, le=100)
    image_zoom: float | None = Field(default=None, ge=1, le=3)
    image_x: float | None = Field(default=None, ge=-100, le=100)
    image_y: float | None = Field(default=None, ge=-100, le=100)
    line_count: int | None = Field(default=None, ge=1, le=8)
    palette: Literal["custom", "earth", "coast", "plum", "forest", "rose"] | None = None
    lyric_size: float | None = Field(default=None, ge=0.8, le=1.3)
    line_gap: float | None = Field(default=None, ge=1.5, le=2.3)
    fade: float | None = Field(default=None, ge=0.15, le=0.65)


OUTPUT_DIMENSIONS: dict[tuple[AspectRatio, str], tuple[int, int]] = {
    ("16:9", "720p"): (1280, 720),
    ("16:9", "1080p"): (1920, 1080),
    ("16:9", "4k"): (3840, 2160),
    ("9:16", "720p"): (720, 1280),
    ("9:16", "1080p"): (1080, 1920),
    ("9:16", "4k"): (2160, 3840),
    ("1:1", "720p"): (720, 720),
    ("1:1", "1080p"): (1080, 1080),
    ("1:1", "4k"): (2160, 2160),
}


class OutputConfiguration(ApiModel):
    aspect_ratio: AspectRatio
    width: int = Field(gt=0, le=3840)
    height: int = Field(gt=0, le=3840)
    frame_rate: Literal[30, 60]

    @model_validator(mode="after")
    def validate_preset(self) -> "OutputConfiguration":
        allowed = {
            dimensions
            for (ratio, _resolution), dimensions in OUTPUT_DIMENSIONS.items()
            if ratio == self.aspect_ratio
        }
        if (self.width, self.height) not in allowed:
            raise ValueError("output dimensions do not match a supported preset")
        return self


class RenderConfiguration(ApiModel):
    schema_version: Literal[1]
    template_id: TemplateId
    text: TextConfiguration
    lyrics: Annotated[list[LyricCue], Field(max_length=5_000)] = Field(
        default_factory=list
    )
    template_settings: dict[TemplateId, TemplateSettings] = Field(default_factory=dict)
    output: OutputConfiguration

    @model_validator(mode="after")
    def validate_template_requirements(self) -> "RenderConfiguration":
        lyric_template = self.template_id in {"panorama-lyrics", "poetry-lyrics"}
        if lyric_template and not self.lyrics:
            raise ValueError("lyric templates require at least one subtitle cue")
        return self


class AgentRenderRequest(ApiModel):
    """Compact server-only request shape intended for programmatic callers."""

    template: TemplateId
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(default="", max_length=300)
    aspect_ratio: AspectRatio = "16:9"
    resolution: Literal["720p", "1080p", "4k"] = "1080p"
    frame_rate: Literal[30, 60] = 30
    lyrics: Annotated[list[LyricCue], Field(max_length=5_000)] = Field(default_factory=list)
    template_settings: dict[TemplateId, TemplateSettings] = Field(default_factory=dict)

    def render_configuration(self) -> RenderConfiguration:
        width, height = OUTPUT_DIMENSIONS[(self.aspect_ratio, self.resolution)]
        return RenderConfiguration(
            schema_version=1,
            template_id=self.template,
            text=TextConfiguration(title=self.title, artist=self.artist),
            lyrics=self.lyrics,
            template_settings=self.template_settings,
            output=OutputConfiguration(
                aspect_ratio=self.aspect_ratio,
                width=width,
                height=height,
                frame_rate=self.frame_rate,
            ),
        )


class JobState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


TERMINAL_JOB_STATES = frozenset(
    {JobState.COMPLETED, JobState.CANCELLED, JobState.FAILED, JobState.INTERRUPTED}
)


class JobErrorCode(StrEnum):
    INVALID_REQUEST = "invalid_request"
    INVALID_AUDIO = "invalid_audio"
    INVALID_IMAGE = "invalid_image"
    INVALID_SUBTITLES = "invalid_subtitles"
    CAPACITY_EXCEEDED = "capacity_exceeded"
    WORKER_UNAVAILABLE = "worker_unavailable"
    DECODE_FAILED = "decode_failed"
    RENDER_FAILED = "render_failed"
    ENCODE_FAILED = "encode_failed"
    STORAGE_FAILED = "storage_failed"
    OUTPUT_UNAVAILABLE = "output_unavailable"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


class JobError(ApiModel):
    code: JobErrorCode
    message: str = Field(min_length=1, max_length=1_000)


class RenderJobResponse(ApiModel):
    schema_version: Literal[1] = 1
    id: str
    state: JobState
    progress: float = Field(ge=0, le=1)
    frame: int = Field(ge=0)
    total_frames: int = Field(ge=0)
    eta_seconds: float | None = Field(default=None, ge=0)
    output_available: bool = False
    output_url: str | None = None
    error: JobError | None = None
    created_at: datetime
    updated_at: datetime


class AgentRenderResponse(ApiModel):
    """Job response with stable links for a non-browser agent client."""

    schema_version: Literal[1] = 1
    render_mode: Literal["server"] = "server"
    job: RenderJobResponse
    status_url: str
    cancel_url: str
    output_url: str
    delete_url: str


class RenderCapabilitiesResponse(ApiModel):
    schema_version: Literal[1] = 1
    ready: bool
    video_codec: Literal["h264_nvenc"] = "h264_nvenc"
    audio_codec: Literal["aac"] = "aac"
    container: Literal["video/mp4"] = "video/mp4"
    pixel_format: Literal["yuv420p"] = "yuv420p"
    max_concurrency: Literal[1] = 1
    reason: str | None = None
