"""CPU-rendered Pillow implementations of all current visualizer scenes."""

from __future__ import annotations

import math
from bisect import bisect_right
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .models import RenderConfiguration
from .scene import (
    FontBook,
    SceneAssets,
    SceneFrame,
    ServerScene,
    clock,
    draw_progress,
    fit_text,
    line_colors,
    paste_image,
    rgba,
    settings_for,
)


def load_scene_assets(cover: Path | None, background: Path | None) -> SceneAssets:
    def load(path: Path | None) -> Image.Image | None:
        if path is None or not path.is_file():
            return None
        with Image.open(path) as image:
            return image.convert("RGBA").copy()

    return SceneAssets(cover=load(cover), background=load(background))


def create_scene(
    configuration: RenderConfiguration,
    assets: SceneAssets,
    fonts: FontBook,
) -> ServerScene:
    if configuration.template_id in {"night-orbit", "dawn-spectrum"}:
        return InstrumentalScene(configuration, assets, fonts)
    if configuration.template_id == "quiet-editorial":
        return QuietEditorialScene(configuration, assets, fonts)
    if configuration.template_id == "paper-resonance":
        return PaperResonanceScene(configuration, assets, fonts)
    return LyricScene(configuration, assets, fonts)


class _BaseScene:
    def __init__(
        self,
        configuration: RenderConfiguration,
        assets: SceneAssets,
        fonts: FontBook,
    ) -> None:
        self.configuration = configuration
        self.assets = assets
        self.fonts = fonts
        self.settings = settings_for(configuration)

    def _cover(
        self,
        canvas: Image.Image,
        box: tuple[int, int, int, int],
        *,
        dark: bool,
    ) -> None:
        draw = ImageDraw.Draw(canvas, "RGBA")
        x, y, width, height = box
        draw.rectangle(
            (x, y, x + width, y + height),
            fill=rgba("#263c42" if dark else "#e1d3bc"),
        )
        if self.assets.cover is not None:
            paste_image(canvas, self.assets.cover, box, contain=True)
            return
        radius = min(width, height) * 0.29
        center = (x + width / 2, y + height / 2)
        draw.ellipse(
            (
                center[0] - radius,
                center[1] - radius,
                center[0] + radius,
                center[1] + radius,
            ),
            outline=rgba(self.settings.accent),
            width=max(1, round(width * 0.008)),
        )
        label_font = self.fonts.get(width * 0.045)
        draw.text(
            (center[0], y + height * 0.86),
            "SOUND / STILL",
            font=label_font,
            fill=rgba(self.settings.accent),
            anchor="mm",
        )

    def _time_footer(self, draw: ImageDraw.ImageDraw, frame: SceneFrame, color: str) -> None:
        short = min(frame.width, frame.height)
        margin = short * 0.075
        y = frame.height * 0.92
        draw_progress(
            draw,
            start=(margin, y),
            end_x=frame.width - margin,
            progress=frame.progress,
            color=color,
            width=max(2, round(short * 0.0025)),
        )
        draw.text(
            (frame.width / 2, frame.height * 0.96),
            f"{clock(frame.time)}  /  {clock(frame.analysis.duration)}",
            font=self.fonts.get(short * 0.018),
            fill=rgba(color, 0.7),
            anchor="mm",
        )


class InstrumentalScene(_BaseScene):
    def render(self, frame: SceneFrame) -> Image.Image:
        if self.configuration.template_id == "night-orbit":
            return self._night_orbit(frame)
        return self._dawn_spectrum(frame)

    def _night_orbit(self, frame: SceneFrame) -> Image.Image:
        width, height = frame.width, frame.height
        short = min(width, height)
        landscape = width > height * 1.15
        dark = self.settings.theme == "dark"
        ground = "#101f29" if dark else "#e4ece8"
        ink = "#e4eeeb" if dark else "#283e42"
        canvas = Image.new("RGBA", (width, height), ground)
        if self.assets.background is not None:
            paste_image(
                canvas,
                self.assets.background,
                (0, 0, width, height),
                zoom=self.settings.image_zoom,
                pan_x=self.settings.image_x,
                pan_y=self.settings.image_y,
                opacity=self.settings.background * 0.5,
            )
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.rectangle((0, 0, width, height), fill=rgba(ground, 0.76))
        center_x = width * (0.31 if landscape else 0.5)
        center_y = height * (0.48 if landscape else 0.35)
        radius = short * 0.25
        draw.ellipse(
            (center_x - radius * 0.84, center_y - radius * 0.84, center_x + radius * 0.84, center_y + radius * 0.84),
            fill=rgba("#142b36" if dark else "#d3dfd8"),
        )
        row = frame.analysis.frame_index_at(frame.time)
        spectrum = frame.analysis.temporal_spectrum[row]
        for layer in (1, 0):
            points: list[tuple[float, float]] = []
            for index in range(241):
                angle = index / 240 * math.tau - math.pi / 2
                band = spectrum[min(spectrum.size - 1, round(index / 240 * (spectrum.size - 1)))]
                breathing = 1 + 0.08 * math.sin(frame.time * 0.65 * self.settings.motion + angle * 3 + layer)
                current = radius * (1 + layer * 0.11) + short * 0.032 * float(band) * self.settings.motion * breathing * (0.6 if layer else 1)
                points.append((center_x + math.cos(angle) * current, center_y + math.sin(angle) * current))
            draw.line(
                points,
                fill=rgba(self.settings.accent, 0.3 if layer else 0.9),
                width=max(1, round(short * (0.0015 if layer else 0.003))),
                joint="curve",
            )
        cover = round(short * 0.285 * self.settings.cover_scale)
        cover_x = round(center_x - cover / 2 + width * self.settings.cover_x / 100)
        cover_y = round(center_y - cover / 2 + height * self.settings.cover_y / 100)
        self._cover(canvas, (cover_x, cover_y, cover, cover), dark=dark)
        draw = ImageDraw.Draw(canvas, "RGBA")
        text_x = width * (0.64 if landscape else 0.5)
        text_y = height * (0.40 if landscape else 0.70)
        anchor = "lm" if landscape else "mm"
        maximum = width - text_x - short * 0.075 if landscape else width - short * 0.15
        draw.text((text_x, text_y - short * 0.06), "NIGHT / FREQUENCY", font=self.fonts.get(short * 0.016), fill=rgba(self.settings.accent), anchor=anchor)
        title_font = self.fonts.get(short * 0.043)
        draw.text((text_x, text_y), fit_text(draw, self.configuration.text.title, title_font, maximum), font=title_font, fill=rgba(ink), anchor=anchor)
        artist_font = self.fonts.get(short * 0.021)
        draw.text((text_x, text_y + short * 0.05), fit_text(draw, self.configuration.text.artist or "Unknown Artist", artist_font, maximum), font=artist_font, fill=rgba(ink, 0.62), anchor=anchor)
        self._time_footer(draw, frame, self.settings.accent)
        return canvas.convert("RGB")

    def _dawn_spectrum(self, frame: SceneFrame) -> Image.Image:
        width, height = frame.width, frame.height
        short = min(width, height)
        dark = self.settings.theme == "dark"
        ground = "#24272a" if dark else "#f3eee4"
        ink = "#e4eeeb" if dark else "#283e42"
        canvas = Image.new("RGBA", (width, height), ground)
        photo = (0, round(height * 0.13), width, round(height * 0.34))
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.rectangle((photo[0], photo[1], photo[0] + photo[2], photo[1] + photo[3]), fill=rgba("#45544c" if dark else "#c0c8b4"))
        paste_image(canvas, self.assets.background, photo, zoom=self.settings.image_zoom, pan_x=self.settings.image_x, pan_y=self.settings.image_y, opacity=self.settings.background)
        margin = short * 0.075
        cover = round(short * 0.28 * self.settings.cover_scale)
        x = round(margin + width * self.settings.cover_x / 100)
        y = round(height * 0.43 - cover * 0.25 + height * self.settings.cover_y / 100)
        self._cover(canvas, (x, y, cover, cover), dark=dark)
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.text((margin, height * 0.075), "DAWN / SOUNDSCAPE", font=self.fonts.get(short * 0.016), fill=rgba(self.settings.accent), anchor="lm")
        text_x = margin + short * 0.33
        maximum = width - text_x - margin
        title_font = self.fonts.get(short * 0.042)
        draw.text((text_x, height * 0.54), fit_text(draw, self.configuration.text.title, title_font, maximum), font=title_font, fill=rgba(ink), anchor="lm")
        artist_font = self.fonts.get(short * 0.021)
        draw.text((text_x, height * 0.59), fit_text(draw, self.configuration.text.artist or "Unknown Artist", artist_font, maximum), font=artist_font, fill=rgba(ink, 0.6), anchor="lm")
        row = frame.analysis.frame_index_at(frame.time)
        spectrum = frame.analysis.temporal_spectrum[row]
        baseline = height * 0.78
        wave_width = width - margin * 2
        for side, alpha in ((-1, 0.95), (1, 0.3)):
            points = []
            for index in range(241):
                unit = index / 240
                band = float(spectrum[min(spectrum.size - 1, round(unit * (spectrum.size - 1)))])
                envelope = math.sin(unit * math.pi) ** 1.5
                carrier = 0.35 + 0.65 * math.sin(unit * math.pi * 12 - frame.time * 0.55 * self.settings.motion) ** 2
                points.append((margin + wave_width * unit, baseline + side * short * 0.052 * band * self.settings.motion * envelope * carrier))
            draw.line(points, fill=rgba(self.settings.accent, alpha), width=max(1, round(short * 0.0028)), joint="curve")
        self._time_footer(draw, frame, self.settings.accent)
        return canvas.convert("RGB")


class QuietEditorialScene(_BaseScene):
    def __init__(
        self,
        configuration: RenderConfiguration,
        assets: SceneAssets,
        fonts: FontBook,
    ) -> None:
        super().__init__(configuration, assets, fonts)
        self._static_canvases: dict[tuple[int, int], Image.Image] = {}

    def render(self, frame: SceneFrame) -> Image.Image:
        width, height = frame.width, frame.height
        short = min(width, height)
        landscape = width > height * 1.15
        portrait = height > width * 1.15
        dark = self.settings.theme == "dark"
        ground = "#222723" if dark else "#eee8dd"
        ink = "#eee8dd" if dark else "#282d29"
        muted = "#b9b2a7" if dark else "#575e55"
        margin = width * (0.065 if landscape else 0.09)
        size = round(short * (0.57 if landscape else 0.76 if portrait else 0.46) * self.settings.cover_scale)
        x = round((width * 0.105 if landscape else (width - size) / 2) + width * self.settings.cover_x / 100)
        y = round((height * 0.225 if landscape else height * 0.205 if portrait else height * 0.165) + height * self.settings.cover_y / 100)
        mount = max(3, round(short * 0.012))
        text_x = width * 0.56 if landscape else (width - size) / 2 - mount
        text_width = width - margin - text_x if landscape else size + mount * 2
        text_y = height * (0.35 if landscape else 0.72 if portrait else 0.70)
        cache_key = (width, height)
        static_canvas = self._static_canvases.get(cache_key)
        if static_canvas is None:
            canvas = Image.new("RGBA", (width, height), ground)
            paste_image(canvas, self.assets.background, (0, 0, width, height), zoom=max(1.05, self.settings.image_zoom), pan_x=self.settings.image_x, pan_y=self.settings.image_y, opacity=self.settings.background)
            draw = ImageDraw.Draw(canvas, "RGBA")
            draw.rectangle((0, 0, width, height), fill=rgba("#0e1312" if dark else "#f9f6ec", 0.48 if dark else 0.68))
            draw.text((margin, height * 0.075), "NOW PLAYING", font=self.fonts.get(short * 0.014), fill=rgba(ink), anchor="lm")
            draw.line((margin, height * 0.11, width - margin, height * 0.11), fill=rgba(ink, 0.25), width=max(1, round(short / 800)))
            draw.rectangle((x - mount, y - mount, x + size + mount, y + size + mount), fill=rgba("#ccc3b2"), outline=rgba("#000000", 0.25), width=mount)
            self._cover(canvas, (x, y, size, size), dark=dark)
            draw = ImageDraw.Draw(canvas, "RGBA")
            title_font = self.fonts.get(short * (0.063 if landscape else 0.055 if portrait else 0.042))
            title = fit_text(draw, self.configuration.text.title, title_font, text_width)
            draw.text((text_x, text_y), title, font=title_font, fill=rgba(ink), anchor="lm")
            artist_font = self.fonts.get(short * 0.020)
            draw.text((text_x, text_y + short * 0.06), fit_text(draw, self.configuration.text.artist or "Unknown Artist", artist_font, text_width), font=artist_font, fill=rgba(muted), anchor="lm")
            self._static_canvases[cache_key] = canvas.copy()
        else:
            canvas = static_canvas.copy()
        draw = ImageDraw.Draw(canvas, "RGBA")
        row = frame.analysis.frame_index_at(frame.time)
        spectrum = frame.analysis.temporal_spectrum[row]
        bars = 64
        baseline = height * (0.70 if landscape else 0.87)
        maximum_height = short * 0.095
        for index in range(bars):
            energy = float(spectrum[min(spectrum.size - 1, index)])
            bar_height = short * 0.002 + maximum_height * min(1, energy * self.settings.motion)
            bar_x = text_x + index * text_width * 0.88 / bars
            draw.rectangle((bar_x, baseline - bar_height, bar_x + max(1, short * 0.0023), baseline), fill=rgba(self.settings.accent, 0.9))
        self._time_footer(draw, frame, self.settings.accent)
        return canvas.convert("RGB")


class PaperResonanceScene(_BaseScene):
    def render(self, frame: SceneFrame) -> Image.Image:
        width, height = frame.width, frame.height
        short = min(width, height)
        landscape = width > height * 1.15
        portrait = height > width * 1.15
        dark = self.settings.theme == "dark"
        paper = "#20272b" if dark else "#eee8dc"
        ink = "#eee8dc" if dark else "#282b29"
        canvas = Image.new("RGBA", (width, height), paper)
        draw = ImageDraw.Draw(canvas, "RGBA")
        for index in range(240):
            x = ((index * 137.508 + 19) % 997) / 997 * width
            y = ((index * 251.137 + 53) % 991) / 991 * height
            radius = max(1, round(short * 0.0007))
            draw.rectangle((x, y, x + radius, y + radius), fill=rgba("#513f29", 0.08))
        margin = width * 0.065
        draw.text((margin, height * 0.075), "SOUND / STUDY", font=self.fonts.get(short * 0.023), fill=rgba(ink), anchor="lm")
        draw.rectangle((margin, height * 0.102, margin + width * 0.052, height * 0.108), fill=rgba(self.settings.accent))
        image_height = height * (0.31 if landscape else 0.28 if portrait else 0.24)
        image_width = (width - margin * 2) * self.settings.image_width / 100
        image_box = (round(width - margin - image_width), round(height * 0.14), round(image_width), round(image_height))
        draw.rectangle((image_box[0], image_box[1], image_box[0] + image_box[2], image_box[1] + image_box[3]), fill=rgba("#bcb9a7"))
        paste_image(canvas, self.assets.background, image_box, zoom=self.settings.image_zoom, pan_x=self.settings.image_x, pan_y=self.settings.image_y, opacity=self.settings.background)
        cover = round(short * (0.39 if landscape else 0.64 if portrait else 0.36) * self.settings.cover_scale)
        cover_x = round(((width - cover) / 2 if portrait else margin + width * 0.025) + width * self.settings.cover_x / 100)
        cover_y = round(height * (0.255 if landscape else 0.23 if portrait else 0.24) + height * self.settings.cover_y / 100)
        mount = max(3, round(short * 0.011))
        draw.rectangle((cover_x - mount, cover_y - mount, cover_x + cover + mount, cover_y + cover + mount), fill=rgba("#faf5eb"), outline=rgba("#2b2217", 0.18), width=mount)
        self._cover(canvas, (cover_x, cover_y, cover, cover), dark=dark)
        draw = ImageDraw.Draw(canvas, "RGBA")
        text_x = width * 0.43 if landscape else margin if portrait else width * 0.51
        text_width = width - margin - text_x
        title_y = height * (0.54 if landscape else 0.65 if portrait else 0.47)
        title_font = self.fonts.get(short * (0.071 if landscape else 0.063 if portrait else 0.048))
        draw.text((text_x, title_y), fit_text(draw, self.configuration.text.title, title_font, text_width), font=title_font, fill=rgba(ink), anchor="lm")
        artist_font = self.fonts.get(short * 0.023)
        draw.text((text_x, title_y + short * 0.065), fit_text(draw, self.configuration.text.artist or "Unknown Artist", artist_font, text_width), font=artist_font, fill=rgba(ink, 0.65), anchor="lm")
        levels = frame.analysis.values_at(frame.time)[1:]
        colors = line_colors(self.settings)
        wave_y = height * (0.825 if portrait else 0.80)
        wave_width = width - margin * 2
        for layer in reversed(range(self.settings.line_count)):
            level = levels[layer % 3]
            amplitude = short * 0.08 * min(1, level * self.settings.motion) / (1 + layer * 0.18)
            points = []
            for index in range(201):
                unit = index / 200
                envelope = math.sin(math.pi * unit) ** 1.3
                carrier = 0.7 * math.sin(unit * math.pi * (7 + layer * 4) - frame.time * (0.85 + layer * 0.17)) + 0.3 * math.sin(unit * math.pi * (15 + layer * 3) + frame.time * 0.31 + layer)
                points.append((margin + wave_width * unit, wave_y + amplitude * envelope * carrier))
            draw.line(points, fill=rgba(colors[layer % len(colors)]), width=max(1, round(short * (0.0045 if layer == 0 else 0.002))), joint="curve")
        self._time_footer(draw, frame, self.settings.accent)
        return canvas.convert("RGB")


def lyric_scroll(cues, time: float) -> tuple[int, float]:
    starts = [cue.start for cue in cues]
    index = bisect_right(starts, time) - 1
    if index < 0:
        return index, -1.0
    previous_gap = cues[index].start - cues[index - 1].start if index else 1
    next_gap = cues[index + 1].start - cues[index].start if index + 1 < len(cues) else 1
    duration = min(0.45, previous_gap * 0.45, next_gap * 0.45)
    progress = min(1, max(0, (time - cues[index].start) / max(0.001, duration)))
    return index, index - 1 + (1 - (1 - progress) ** 3)


class LyricScene(_BaseScene):
    def render(self, frame: SceneFrame) -> Image.Image:
        if self.configuration.template_id == "panorama-lyrics":
            return self._panorama(frame)
        return self._poetry(frame)

    def _draw_lyrics(
        self,
        draw: ImageDraw.ImageDraw,
        frame: SceneFrame,
        box: tuple[float, float, float, float],
        color: str,
        font_size: float,
    ) -> None:
        cues = self.configuration.lyrics
        index, position = lyric_scroll(cues, frame.time)
        x, y, width, height = box
        center = y + height / 2
        stride = height * 0.25 * self.settings.line_gap / 1.8
        font = self.fonts.get(font_size * self.settings.lyric_size)
        for cue_index in range(max(0, index - 3), min(len(cues), index + 4)):
            line_y = center + (cue_index - position) * stride
            distance = abs(line_y - center) / (height / 2)
            if distance >= 1.2:
                continue
            relative = abs(cue_index - position)
            alpha = (self.settings.fade * math.exp(-relative * 0.52) + (1 - self.settings.fade) * math.exp(-relative * relative * 5)) * min(1, max(0, (1 - distance) / 0.28))
            text = fit_text(draw, cues[cue_index].text.replace("\n", " / "), font, width * 0.94)
            draw.text((x + width / 2, line_y), text, font=font, fill=rgba(color, alpha), anchor="mm")

    def _panorama(self, frame: SceneFrame) -> Image.Image:
        width, height = frame.width, frame.height
        short = min(width, height)
        dark = self.settings.theme == "dark"
        ink = "#f4f0e9" if dark else "#222630"
        canvas = Image.new("RGBA", (width, height), "#151b29" if dark else "#e8e7e2")
        paste_image(canvas, self.assets.background, (0, 0, width, height), zoom=self.settings.image_zoom, pan_x=self.settings.image_x, pan_y=self.settings.image_y, opacity=self.settings.background)
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.rectangle((0, 0, width, height), fill=rgba("#071017" if dark else "#faf6ea", 0.62 if dark else 0.75))
        cover = round(short * 0.13 * self.settings.cover_scale)
        cover_x = round(width * 0.085 + width * self.settings.cover_x / 100)
        cover_y = round(height * 0.085 + height * self.settings.cover_y / 100)
        self._cover(canvas, (cover_x, cover_y, cover, cover), dark=dark)
        draw = ImageDraw.Draw(canvas, "RGBA")
        title_font = self.fonts.get(short * 0.031)
        draw.text((cover_x + cover + short * 0.035, cover_y + cover * 0.40), fit_text(draw, self.configuration.text.title, title_font, width * 0.65), font=title_font, fill=rgba(ink), anchor="lm")
        artist_font = self.fonts.get(short * 0.019)
        draw.text((cover_x + cover + short * 0.035, cover_y + cover * 0.72), fit_text(draw, self.configuration.text.artist or "Unknown Artist", artist_font, width * 0.65), font=artist_font, fill=rgba(ink, 0.65), anchor="lm")
        self._draw_lyrics(draw, frame, (width * 0.12, height * 0.27, width * 0.76, height * 0.55), ink, short * 0.044)
        row = frame.analysis.frame_index_at(frame.time)
        spectrum = frame.analysis.temporal_spectrum[row]
        for index in range(50):
            value = float(spectrum[index % spectrum.size])
            bar_height = short * (0.002 + 0.025 * value * self.settings.motion)
            x = width * 0.25 + index * width * 0.5 / 50
            draw.rectangle((x, height * 0.9 - bar_height, x + max(1, short * 0.0018), height * 0.9), fill=rgba(self.settings.accent))
        self._time_footer(draw, frame, self.settings.accent)
        return canvas.convert("RGB")

    def _poetry(self, frame: SceneFrame) -> Image.Image:
        width, height = frame.width, frame.height
        short = min(width, height)
        portrait = height > width * 1.15
        dark = self.settings.theme == "dark"
        ink = "#f4f0e9" if dark else "#222630"
        canvas = Image.new("RGBA", (width, height), "#202423" if dark else "#f1ede4")
        page = width * (1 - min(60, self.settings.image_width) / 100 * (0.75 if portrait else 1))
        image_box = (round(page), 0, width - round(page), height)
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.rectangle((image_box[0], 0, width, height), fill=rgba("#3f4d47" if dark else "#b5b9a7"))
        paste_image(canvas, self.assets.background, image_box, zoom=self.settings.image_zoom, pan_x=self.settings.image_x, pan_y=self.settings.image_y, opacity=self.settings.background)
        margin = short * 0.075
        draw.text((margin, height * 0.07), "LYRIC / NOTES", font=self.fonts.get(short * 0.014), fill=rgba(self.settings.accent), anchor="lm")
        cover = round(short * 0.14 * self.settings.cover_scale)
        cover_x = round(margin + width * self.settings.cover_x / 100)
        cover_y = round(height * 0.13 + height * self.settings.cover_y / 100)
        self._cover(canvas, (cover_x, cover_y, cover, cover), dark=dark)
        draw = ImageDraw.Draw(canvas, "RGBA")
        text_x = cover_x + cover + short * 0.03
        text_width = max(short * 0.1, page - margin - text_x)
        title_font = self.fonts.get(short * 0.035)
        draw.text((text_x, cover_y + cover * 0.44), fit_text(draw, self.configuration.text.title, title_font, text_width), font=title_font, fill=rgba(ink), anchor="lm")
        artist_font = self.fonts.get(short * 0.019)
        draw.text((text_x, cover_y + cover * 0.75), fit_text(draw, self.configuration.text.artist or "Unknown Artist", artist_font, text_width), font=artist_font, fill=rgba(ink, 0.6), anchor="lm")
        self._draw_lyrics(draw, frame, (margin, height * 0.33, page - margin * 2, height * 0.48), ink, short * 0.045)
        colors = line_colors(self.settings)
        low = frame.analysis.values_at(frame.time)[1]
        for layer in reversed(range(self.settings.line_count)):
            points = []
            for index in range(101):
                unit = index / 100
                envelope = math.sin(unit * math.pi) ** 2
                wave = math.sin(unit * math.pi * (8 + layer * 2) - frame.time * 0.7 * self.settings.motion + layer * 0.6)
                points.append((margin + unit * (page - margin * 2), height * 0.87 + wave * envelope * short * 0.014 * min(1, low * self.settings.motion) / (1 + layer * 0.16)))
            draw.line(points, fill=rgba(colors[layer % len(colors)]), width=max(1, round(short * (0.0025 if layer == 0 else 0.0016))), joint="curve")
        self._time_footer(draw, frame, self.settings.accent)
        return canvas.convert("RGB")
