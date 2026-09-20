# Product Requirements

[繁體中文](product-requirements.md)

## Product goal

Allow a user to make a polished music visualizer video with an explicit choice of server or current-device rendering:

```text
Upload audio -> Select template and render location -> Generate -> Download MP4
```

The interface should keep the number of decisions small while still allowing useful output customization.

## MVP user flow

1. Select an audio file.
2. Select one of the supported visual templates.
3. Add optional title, artist, cover/background image, and visual settings exposed by the template.
4. Choose aspect ratio, resolution, and frame rate.
5. Select Server or This Device at the bottom of the project list and check capability for that mode and output. Never fall back automatically.
6. Render in the persistent server queue with CPU/NVENC, or in a browser Worker with WebCodecs.
7. Show progress, estimated remaining time, errors, and cancellation where supported.
8. Preview the generated video and download the MP4.
9. Save the project record locally. Store client MP4s in IndexedDB when quota permits; retain server outputs by job reference. If client persistence fails, keep the new Blob downloadable only while the user remains in that project and tab.

## Supported output

- Aspect ratios: 16:9, 9:16, 1:1
- Maximum target: 4K at 60 fps
- Resolution choices are constrained by the selected aspect ratio. The current selection is capability-checked for the selected render mode and generation is disabled when that path is unavailable.
- Server mode uses CPU scene rendering and NVIDIA H.264 NVENC with AAC. This Device mode uses AudioContext, a Web Worker, WebCodecs, and an MP4 muxer; actual codec and 4K60 support depends on the browser and device.

## Templates and editor

The template catalog is a compact 2×2 grid. The media grid is also 2×2:
audio and SRT above cover and background. The left editor scrolls independently;
render progress and Generate/Cancel controls occupy a fixed bottom row outside
the scrolling body. On narrow screens the editor has a bounded height and the
preview follows beneath it.

After selecting any template, users can open its editor and adjust light/dark
mode, accent color, motion intensity, background visibility, and cover size.
Each template keeps its own settings within a project. Lyric templates also
offer text size, line spacing, and surrounding-line opacity.

### Paper Resonance / 紙上聲景

A light printed-poster composition with a warm paper field, photographic
background strip, fully contained album sleeve, bold sans-serif title, and
three flowing ink contours. Bass, midrange, and treble drive the vermilion,
graphite, and fine muted contours respectively. The scene supports all three
aspect ratios and provides composed fallbacks when either image is absent.
See [visual and motion design](paper-resonance.md).

### Quiet Editorial / 靜謐唱片誌

A user-uploaded photographic background and a stationary, fully contained album
cover form an editorial composition. Warm neutral typography, a fine sleeve
mount, and a compact frequency notation keep a clear visual hierarchy.
Landscape uses two columns; portrait and square use stacked compositions.
Background motion is slow and continuous; frequency and mount lighting respond
to smoothed audio energy. See [visual and motion design](quiet-editorial.md).

### Panorama Lyrics / 全景映像

A full-frame image stage, compact album identity, and a translucent central
lyric field. The current line settles at the center while surrounding lines
fade with distance. Light and dark modes use corresponding photographic scrims.

### Poetry Lyrics / 留白詩頁

A quiet reading page pairs serif lyrics with a full-height photographic margin.
The complete sleeve anchors the header. A restrained audio-reactive ink line
and centered time display sit below the lyrics. Ivory and charcoal modes retain
the same hierarchy across landscape, portrait, and square outputs.
Retired Geometry Lyrics records reopen as Poetry Lyrics, retaining settings and media.

Spectrum Cover and Vinyl Particle are retired. Existing records using either
identifier (or legacy Abstract Pulse) reopen as Quiet Editorial while retaining
text, images, render history, and generated output references.

### SRT behavior

Lyric templates require a valid UTF-8 SRT before export. Files are limited to
1 MiB, 5000 cues, and 1000 characters per resulting cue. Cues are sorted by
start time; simultaneous starts merge into a multiline cue. End times must be
syntactically valid SRT timestamps but do not control display or scrolling.
Before the first start no cue is active; each cue remains active until the next
start, including gaps, and the final cue remains through the end of the video.

Lines move upward from each start time, with continuous opacity changes as they
approach and leave the center. Transition duration adapts to dense starts.
Multiline/CJK content wraps and reduces size to stay inside its allocated row.
Invalid imports leave the previous subtitles intact. Removing subtitles disables
lyric export; non-lyric templates can still render without SRT.

The editor uses demonstration audio features and a silent timed lyric preview;
it does not play the uploaded song or provide a scrubber. Before SRT import it
shows labeled example lyrics. Example lyrics are never exported or persisted.
Actual exports use the imported cue starts and uploaded audio analysis.

Templates consume a stable, serializable scene configuration shared by the server worker and client render worker.

## Project records

A project record includes:

- Project name and timestamps
- Template identifier and template configuration
- Title and artist text
- Cover/background image data or a local reference, subject to browser quota
- Parsed subtitle text/start times and settings for each template
- Aspect ratio, resolution, and frame rate
- Render source, status, and error information
- Server job/output reference or client MP4 metadata and local IndexedDB reference

The original audio bytes, file metadata, absolute path, and file handle are
never part of a persisted project record. Server mode uploads current-job assets
to isolated temporary storage; This Device mode uses them only in the current
page and Worker. Reopening a project requires selecting the source audio again.

Artwork input is restricted to PNG, JPEG, and WebP. SVG is not accepted.
Oversized or inconsistent image headers and failed decodes must be rejected
before the asset reaches preview, worker, or project persistence.

When a render succeeds but its MP4 Blob cannot be saved, the current project
keeps that output in memory for immediate preview and download. It is marked
as not saved after reload and is released when the user leaves or deletes the
project, starts a new project, or replaces the output.

## Non-goals for the MVP

- User accounts and team collaboration
- Public sharing links
- Cloud project synchronization
- Word-level lyric animation
- More aspect ratios than 16:9, 9:16, and 1:1
- Guaranteed 4K60 rendering on every device
- Automatic fallback between server and client rendering
