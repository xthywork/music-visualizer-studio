# Quiet Editorial / 靜謐唱片誌

Template ID: `quiet-editorial`. A composed listening-room aesthetic: the sleeve
is the primary subject, the photograph establishes atmosphere, and motion is a
small expression of the music. Both user-uploaded images participate directly.

## Composition

- Landscape: framed sleeve on the left, a two-line serif title and smaller artist
  on the right, with compact frequency marks underneath.
- Portrait: larger sleeve above the title; generous space separates the artwork,
  typography, and frequency marks.
- Square: compact stacked composition with a smaller sleeve and title size.
- A fine top rule and “NOW PLAYING” label introduce the composition. The lower
  rule records actual track progress, with elapsed and total time.

The background fills the frame using centered cover cropping. Directional dark
scrims retain its original palette while supporting warm ivory text. The sleeve
uses contain fitting, preserving the complete image and its proportions even
for a non-square upload. A warm paper mount and contact shadow separate it from
the photograph. No color extraction, external images, fonts, or network calls
are required. Missing images have designed neutral fallbacks.

## Motion

The background travels at most 0.8% of frame width and 0.6% of frame height,
with 41/59-second horizontal/vertical periods. Its 53-second scale cycle ranges
from 1.043 to 1.067; overscan prevents exposed edges throughout the motion.
The different periods avoid a conspicuous short repeating loop.

The sleeve and typography remain stationary. Low-frequency energy subtly
changes the mount's upper-edge illumination. Sixty-four narrow frequency marks
span 88% of the text column and normally reach at most 9.5% of the short edge, with a
1.35-power response curve that lowers quiet passages and expands the contrast
between low and high strokes. A 2× reactive gain makes ordinary motion more
pronounced, bounded at full scale before the accent boost to preserve its
headroom and prevent collisions with text. Available
space below the artist credit bounds the height for long titles in compact
layouts. Detected accents add up to 50% to the reactive height, with a 55 ms
eased attack and 345 ms release. Layout reserves the full accent range below
the artist credit; square sleeves are slightly smaller and portrait frequency
marks sit lower to make room. The marks settle to a small baseline in silence.
The progress rule is slightly heavier than the
other editorial rules so it remains legible at preview sizes.
Frequency strokes and editorial rules have heavier weights. The two time labels
use larger semibold monospace type, each centered on its timeline endpoint and
vertically centered in a fixed-height row below the timeline. The timeline sits
at 92.5% of frame height, with the time labels moving as part of the same group.
Square frequency marks retain a gap above the raised timeline.
There are no particles, additive glows, flashes, or rhythmic camera punches.

Audio features use nine weighted samples over the preceding 267 ms, with
interpolation between analysis rows. The finite, timestamp-based filter gives
the same frame on seeking and at different output frame rates; it does not
depend on the previous render call. Peak response lags a transient by roughly
130 ms, producing a soft attack and release rather than a sudden jump.

The editor remains an animated demonstration, using synthetic looping audio
features; it is not a live audition of the uploaded song. Background time stays
continuous across demo loops. MP4 export uses the uploaded track's actual
time-aligned analysis and duration through the existing worker pipeline.

## Integration

The existing project schema stores the new template identifier and both image
references. Retired template identifiers migrate to this template on read,
without removing their images, text, or generated outputs. Its default theme is
dark; the template editor also supports a light palette and appearance controls.
Preview and export use the same scene factory. Canvas 2D keeps the scene usable
in the browser worker without introducing a new graphics backend.

Verification covers image fit and stationary sleeve geometry, silence/energy
response, project serialization, and browser MP4 export/reopening with both
images in all three aspect ratios at 720p/30 fps and a short 16:9 4K/30 fps
export. Browser checks use synthetic artwork so
they do not require private user assets.
