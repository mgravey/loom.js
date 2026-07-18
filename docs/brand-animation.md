# Loom.js vector identity and Lottie animation

Direction 08 is the selected Loom.js identity. It represents three independent capability threads
being composed into a shared runtime and terminating in plugin endpoints.

The accepted transparent PNG lockups remain the visual master. The SVG lockups preserve the static
Inter Bold wordmark, while the After Effects asset contains only the colored mark. Each colored
thread uses the traced two-sided ribbon silhouette from that visual master, including its branches
and overlap regions.

## Vector assets

All SVG files have transparent backgrounds. The static vectors preserve the original mark's woven
curves and subtle thread gradients; the After Effects builder uses matching flat colors for reliable
Lottie playback.

| Asset                                                             | Use                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`loom-logo-08.svg`](./assets/brand/loom-logo-08.svg)             | Theme-adaptive master; the outlined wordmark uses CSS `currentColor` |
| [`loom-logo-08-light.svg`](./assets/brand/loom-logo-08-light.svg) | Near-black wordmark for white or light backgrounds                   |
| [`loom-logo-08-dark.svg`](./assets/brand/loom-logo-08-dark.svg)   | White wordmark for dark backgrounds                                  |
| [`loom-mark-08.svg`](./assets/brand/loom-mark-08.svg)             | Standalone three-thread symbol                                       |

The wordmark uses **Inter Bold**. Its glyphs are converted to paths in every SVG, so the vector
assets do not depend on a locally installed font. The adaptive master inherits the surrounding CSS
`color`; the explicit light and dark variants use fixed wordmark colors.

## Build the After Effects composition

The final builder is
[`scripts/after-effects/loom-logo-lottie-smooth.jsx`](../scripts/after-effects/loom-logo-lottie-smooth.jsx).
It creates one square 1254 × 1254 composition at 60 fps with a 3.2-second duration. Its vector paths
use coordinates measured from the accepted original mark:

- `Loom_Mark_Exact_Ribbons` contains only the three colored threads and endpoint rings.

The composition is transparent. Its After Effects composition background color is a preview only;
the script deliberately creates no background or text layer. The `loom.js` wordmark is not included
in the After Effects project at all.

1. Open an After Effects project.
2. Choose **File → Scripts → Run Script File…**.
3. Select `scripts/after-effects/loom-logo-lottie-smooth.jsx`.
4. Open the generated `Loom_Mark_Exact_Ribbons` composition and preview the animation.

Running the builder again is safe: it creates version-suffixed folders and compositions instead of
replacing previous work.

## Export with Bodymovin

The mark animation uses filled vector ribbons, Trim-Path vector alpha mattes, and ring strokes. The
matte strokes reveal the fixed final silhouettes, so the threads draw along their curves without
being horizontally scaled. It contains no font or text data and avoids expressions, raster effects,
3D layers, and background solids.

1. Open **Window → Extensions → Bodymovin**.
2. Select `Loom_Mark_Exact_Ribbons`.
3. Choose an export destination.
4. Render the composition to a `.json` file. The Glyphs option is unnecessary because there is no
   text layer.
5. Confirm that the exported animation is transparent in the Lottie previewer used by the target
   application.

The colored mark works over both light and dark surfaces. Pair the resulting animation with a static
wordmark in the surrounding website or application layout when needed.

## Product placement

- Use the Lottie weave for one deliberate introductory moment, such as the landing hero or trusted
  extension onboarding. Never loop it continuously.
- Use the compact optimized mark for navigation, footers, workbench headings, favicons, and other
  small browser surfaces. Prefer the SVG where its full artboard remains legible; use the cropped
  PNG export at favicon and small-icon sizes.
- Use the full light/dark lockup for brand-led documentation and presentation material.
- Preserve a static SVG or PNG fallback whenever animation is present, and honor
  `prefers-reduced-motion`.
