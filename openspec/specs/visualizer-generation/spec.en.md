# Visualizer Generation Specification

## Purpose

Provides a focused workflow for turning a supported audio track and a visual template into a previewable, downloadable MP4 music visualizer with predictable output options.

## Requirements

### Requirement: Accept supported audio input

The system SHALL allow a user to select an MP3, WAV, or M4A audio file for a visualization project, and SHALL reject unsupported formats or files longer than 10 minutes with an actionable message before rendering begins.

#### Scenario: Valid audio is selected

- **WHEN** the user selects a supported audio file no longer than 10 minutes
- **THEN** the system shows the file as ready and allows template configuration to continue

#### Scenario: Unsupported or oversized audio is selected

- **WHEN** the user selects an unsupported format or an audio file longer than 10 minutes
- **THEN** the system rejects it, explains the constraint, and does not start rendering

### Requirement: Select and configure a visual template

The system SHALL offer Quiet Editorial (靜謐唱片誌), Paper Resonance (紙上聲景), Panorama Lyrics (全景映像), and Poetry Lyrics (留白詩頁) in a compact 2×2 grid. Each template SHALL expose an editor with light/dark mode, accent, motion, background visibility, and cover size. Lyric templates SHALL additionally expose font size, line spacing, and surrounding-line opacity.

#### Scenario: User selects a template

- **WHEN** the user selects one of the available templates
- **THEN** the system displays a preview and only the configuration fields relevant to that template

#### Scenario: User changes template configuration

- **WHEN** the user changes text or image inputs
- **THEN** the preview and the pending render configuration reflect those values without requiring a new audio upload

#### Scenario: User supplies both images to Quiet Editorial

- **WHEN** the user selects Quiet Editorial and provides a cover and background image
- **THEN** the template displays the complete cover without distorting its proportions, uses the background as a full-frame cropped image, and adapts the composition to the selected aspect ratio
- **AND** the cover and typography remain stationary while restrained background motion and smoothed audio-reactive frequency marks provide animation
- **AND** the editor identifies its synthetic motion preview as a demonstration, while exported MP4 frames use the uploaded audio's analysis

#### Scenario: User selects Paper Resonance

- **WHEN** the user selects Paper Resonance and optionally provides cover and background images
- **THEN** the template composes a warm paper poster with a proportionally cropped photographic strip, a complete stationary album sleeve, and a bold title block adapted to the selected aspect ratio
- **AND** three flowing ink contours respond to low, mid, and high audio energy while remaining clear of the title and progress line
- **AND** missing images receive designed fallback artwork, and the demonstration preview is distinguished from the audio-driven MP4 export

### Requirement: Provide a scrollable editor with fixed render controls

The system SHALL arrange import controls and templates in compact 2×2 grids and keep render progress and Generate/Cancel controls outside the scrolling settings body.

#### Scenario: User customizes artwork placement and wave styling

- **WHEN** the user opens a template editor
- **THEN** every template offers cover X/Y displacement percentages and motion strength from 0 to 5
- **AND** Paper Resonance and Poetry Lyrics offer right-aligned photographic region width, crop zoom and X/Y pan, 1–8 wave lines, and curated palette selections
- **AND** settings persist independently per template and are used identically by preview and MP4 rendering
- **AND** Panorama Lyrics uses a spectrum approximately half the frame width

#### Scenario: User scrolls the editor

- **WHEN** editor settings exceed the available height
- **THEN** the settings body scrolls while render progress and Generate/Cancel remain in a separate fixed bottom row
- **AND** import controls form a 2×2 grid: audio/SRT above cover/background

### Requirement: Render start-timed scrolling subtitles

The system SHALL accept validated UTF-8 SRT up to 1 MiB and 5000 cues for lyric templates, sort cues by start time, merge simultaneous starts, and ignore end times when selecting or scrolling lyrics. The latest-started cue SHALL remain active until the next start, including gaps and the final cue. Text SHALL scroll upward toward the center and fade continuously with distance from the center.

#### Scenario: User imports confirmed subtitles

- **WHEN** a valid SRT is imported
- **THEN** the lyric preview uses its start times, while MP4 export uses the same cue timing with actual audio analysis
- **AND** the preview remains silent, with no audio playback or scrubber

#### Scenario: Subtitle timing has a gap or overlap

- **WHEN** a cue's end time passes or overlaps another cue
- **THEN** only the next cue's start changes the active lyric; the end timestamp does not clear it

#### Scenario: No subtitle file is available

- **WHEN** a lyric template has no imported cues
- **THEN** preview may show explicitly labeled example lyrics, but UI and worker reject lyric export until real subtitles are provided

#### Scenario: Replacement subtitles are invalid or stale

- **WHEN** a replacement is invalid, or its read finishes after project navigation or subtitle removal
- **THEN** invalid imports preserve previous valid cues, and stale reads do not mutate the current workspace

### Requirement: Configure output format

The system SHALL allow the user to select exactly one of the 16:9, 9:16, or 1:1 aspect ratios, a 720p, 1080p, or 4K output preset, and either 30 or 60 fps. The device capability check SHALL determine whether the selected combination can render.

#### Scenario: User selects a valid output

- **WHEN** the user selects an allowed aspect ratio, resolution, and frame rate
- **THEN** the system shows the resulting dimensions and capability status and enables rendering when a valid source audio selection is also ready

#### Scenario: Requested output exceeds device capability

- **WHEN** the selected resolution or frame rate is not supported by the current browser or device
- **THEN** the system disables rendering for that selection and explains that its encoding path is unsupported

### Requirement: Report browser rendering capability

The system SHALL check the current browser and device before rendering and SHALL identify whether the requested video and audio encoding path can produce a playable MP4.

#### Scenario: Capability check succeeds

- **WHEN** the browser supports the requested rendering and encoding combination
- **THEN** the system allows rendering and indicates that local browser rendering will be used

#### Scenario: Capability check fails

- **WHEN** the browser cannot support the requested combination
- **THEN** the system prevents an invalid render and explains the missing playable MP4 codec or muxing capability so the user can select another preset or browser

### Requirement: Render without blocking the interface

The system SHALL render in a background execution context and SHALL expose queued, rendering, completed, cancelled, and failed states with progress information where measurable.

#### Scenario: Render completes

- **WHEN** the user starts a valid render and the render finishes successfully
- **THEN** the system marks it completed, makes a playable MP4 available for preview, and enables download

#### Scenario: User cancels a render

- **WHEN** the user cancels an in-progress render
- **THEN** the system stops the render, marks it cancelled, releases temporary render resources, and preserves the project configuration

#### Scenario: Render fails

- **WHEN** a decoding, encoding, muxing, memory, or device error prevents completion
- **THEN** the system marks the render failed, presents a useful error, and does not present a partial file as a completed MP4

### Requirement: Produce a downloadable MP4

The system SHALL combine the rendered video and the source audio into a playable MP4 whose dimensions, aspect ratio, frame rate, and duration match the selected project configuration within normal encoder tolerances.

#### Scenario: User downloads a completed output

- **WHEN** a completed render is available and the user selects Download
- **THEN** the system downloads the generated MP4 without requiring the source audio to be uploaded again

#### Scenario: Output metadata is inspected

- **WHEN** a completed MP4 is previewed or downloaded
- **THEN** its media metadata identifies the selected dimensions, frame rate, and audio/video tracks
