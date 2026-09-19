# Paper Resonance / 紙上聲景

Template ID: `paper-resonance`.

## Visual direction

A modern printed music poster: warm ivory stock, vermilion ink, dark graphite
type, a photographic strip, and an overlapping album sleeve. Bold sans-serif
headlines and broad flowing contours give this template its own hierarchy and
rhythm. The user's two images are the main visual materials.

The uploaded background fills an inset horizontal strip with proportional crop
fitting and a slight warm tint. The sleeve overlaps its lower edge on a pale
paper mount; contain fitting preserves the entire image even for rectangular
artwork. The sleeve remains stationary. If either image is missing, folded-paper
shapes and a simple printed sleeve provide an intentional fallback.

Landscape uses an offset sleeve with a large headline beside it. Portrait
centers the sleeve above a broad title block. Square retains a compact
side-by-side sleeve/title arrangement. Titles support Chinese and Latin text,
wrap to two lines, and ellipsize overflow; artist text fits one line.

The upper “SOUND / STUDY” masthead, a red registration rule, and lower progress
line form a consistent print vocabulary. Time labels use semibold monospace
type centered on the timeline endpoints. Paper flecks are fixed, low-opacity
texture, not moving particles. The template requires no external fonts or
bundled bitmap artwork.

## Motion

Three nested ink contours have distinct roles: a vermilion bass contour, a
graphite midrange contour, and a finer treble echo. They share a baseline and
taper at both ends, keeping the composition stable while the middle flows.
The curves are illustrative energy-driven forms, not literal PCM oscillograms.

Audio features are interpolated between analysis rows and averaged over seven
weighted samples spanning 200 ms. The already smoothed audio envelopes control
curve height. Detected beats accent the contours gently; finite interpolation
and absolute timestamps keep frames deterministic across seeking and frame
rates. Silence flattens the lines. Amplitude is bounded by the typography above
and the progress line below.

Only the source crop moves inside the fixed photographic strip, over 47/61-second
horizontal/vertical periods. A 4% overscan keeps every crop within image bounds.
There is no cover bouncing, glow, RGB separation, flashing, or rapid camera motion.

The editor identifies its synthetic motion loop as a demonstration. MP4 export
uses the uploaded audio's actual analysis through the same scene factory and
worker rendering pipeline.

## Verification

Unit checks cover stationary, undistorted sleeves; bounded moving background
crops in all ratios; deterministic contours; silence response; typography
clearance; template registration; and persistence of both image references.
Browser checks use synthetic artwork and a short WAV to export, download,
and reopen all three ratios at 720p/30 fps and 16:9 at 4K/30 fps.
