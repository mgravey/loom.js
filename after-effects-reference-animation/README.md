# Reference weave After Effects animation

This standalone After Effects builder was created from scratch for the supplied square reference. It
does not import SVGs, PNGs, project files, or code from the repository's other animation builders.

## Create the composition

1. Open Adobe After Effects and any project.
2. Choose **File → Scripts → Run Script File…**.
3. Select `weave-reference-animation.jsx` from this folder.
4. Preview the generated `Reference_Weave_Draw` composition.

The script creates a 1254 × 1254, 60 fps, four-second composition with separate shape layers for
every branch and color seam. Constant-width Bézier strokes use overlapping Trim Paths timings, and
each endpoint ring starts drawing only after its incoming line arrives.

The composition has no background layer. Enable **Toggle Transparency Grid** in the After Effects
Composition viewer to see its transparent alpha area.

## Shadows and adjustments

Each branch and ring contains near and far low-opacity shadow strokes. They remain portable across
Lottie renderers because the script does not use Drop Shadow or Blur effects. The `CONFIG` object
contains the thread width, colors, ring dimensions, shadow opacity, and shadow offsets. All
generated layers remain editable after the script runs.

## Export from After Effects

1. Open Bodymovin or the LottieFiles After Effects extension.
2. Select only the generated `Reference_Weave_Draw` composition.
3. Export to JSON with raster assets disabled.
4. Verify transparency and crossings in the target Lottie renderer.

## Ready-to-use exports

| File                                                                   | Purpose                                             |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| [`exports/loom-js-logo.json`](./exports/loom-js-logo.json)             | Animated Lottie asset for webpages and applications |
| [`exports/loom-js-logo-static.svg`](./exports/loom-js-logo-static.svg) | Transparent final-frame vector for a static logo    |

Both exports are 1254 × 1254 and contain no background. The Lottie file is self-contained and has no
external image assets.

Copy the `exports` directory into the public/static asset directory of the target website. A typical
static-logo element is:

```html
<img src="/assets/loom-js-logo-static.svg" alt="Loom.js" width="160" height="160" />
```

With `lottie-web` installed, the animated asset can be loaded as follows:

```js
import lottie from 'lottie-web';

lottie.loadAnimation({
  container: document.querySelector('#loom-logo'),
  renderer: 'svg',
  loop: false,
  autoplay: true,
  path: '/assets/loom-js-logo.json',
});
```
