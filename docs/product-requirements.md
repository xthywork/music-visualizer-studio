# Product Requirements

## Product goal

Allow a user to make a polished music visualizer video with four actions:

```text
Upload audio -> Select template -> Generate -> Download MP4
```

The interface should keep the number of decisions small while still allowing useful output customization.

## MVP user flow

1. Select an audio file.
2. Select one of the supported visual templates.
3. Add optional title, artist, cover/background image, and visual settings exposed by the template.
4. Choose aspect ratio, resolution, and frame rate.
5. Run a capability check for the current browser and device.
6. Render in a background browser worker.
7. Show progress, estimated remaining time, errors, and cancellation where supported.
8. Preview the generated video and download the MP4.
9. Save the project record and generated MP4 in local browser storage. If MP4 persistence fails, keep the newly generated Blob downloadable for the lifetime of the current tab.

## Supported output

- Aspect ratios: 16:9, 9:16, 1:1
- Maximum target: 4K at 60 fps
- Resolution choices should be constrained by the selected aspect ratio and detected device capabilities.
- MP4 should use broadly playable video and audio codecs when available.

## Initial templates

### Spectrum Cover

Cover art or a background image with a clean audio spectrum or waveform. It is the default low-complexity template.

### Vinyl Particle

A rotating record with a center image and reactive particle accents.

Templates should consume a stable, serializable scene configuration so the same project can eventually be rendered by a server worker.

## Project records

A project record includes:

- Project name and timestamps
- Template identifier and template configuration
- Title and artist text
- Cover/background image data or a local reference, subject to browser quota
- Aspect ratio, resolution, and frame rate
- Render status and error information
- Generated MP4 metadata and local reference

The original audio bytes, file metadata, absolute path, and file handle are
never part of a persisted project record. Reopening a project requires selecting
the source audio again.

Artwork input is restricted to PNG, JPEG, and WebP. SVG is not accepted.
Oversized or inconsistent image headers and failed decodes must be rejected
before the asset reaches preview, worker, or project persistence.

## Non-goals for the MVP

- User accounts and team collaboration
- Public sharing links
- Cloud project synchronization
- Word-level lyric animation
- More aspect ratios than 16:9, 9:16, and 1:1
- Guaranteed 4K60 rendering on every device
