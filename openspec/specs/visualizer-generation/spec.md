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

The system SHALL offer Spectrum Cover, Vinyl Particle, and Abstract Pulse as selectable templates, and SHALL allow the user to provide optional title, artist, cover, or background inputs supported by the selected template.

#### Scenario: User selects a template

- **WHEN** the user selects one of the available templates
- **THEN** the system displays a preview and only the configuration fields relevant to that template

#### Scenario: User changes template configuration

- **WHEN** the user changes text or image inputs
- **THEN** the preview and the pending render configuration reflect those values without requiring a new audio upload

### Requirement: Configure output format

The system SHALL allow the user to select exactly one of the 16:9, 9:16, or 1:1 aspect ratios, a supported output resolution, and a frame rate up to 60 fps, including a 4K option when the device capability check permits it.

#### Scenario: User selects a valid output

- **WHEN** the user selects an allowed aspect ratio, resolution, and frame rate
- **THEN** the system shows the resulting dimensions and marks the project ready to render

#### Scenario: Requested output exceeds device capability

- **WHEN** the selected resolution or frame rate is not supported by the current browser or device
- **THEN** the system disables or rejects that combination and explains which lower options are available

### Requirement: Report browser rendering capability

The system SHALL check the current browser and device before rendering and SHALL identify whether the requested video and audio encoding path can produce a playable MP4.

#### Scenario: Capability check succeeds

- **WHEN** the browser supports the requested rendering and encoding combination
- **THEN** the system allows rendering and indicates that local browser rendering will be used

#### Scenario: Capability check fails

- **WHEN** the browser cannot support the requested combination
- **THEN** the system prevents an invalid render, explains the limitation, and offers compatible settings or a future server-rendering option when available

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
