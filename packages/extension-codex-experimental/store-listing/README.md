# Chrome Web Store media

Generate the final listing media from the packaged extension and the approved Loom Direction 08
mark:

```sh
pnpm chrome:store:media
```

The command writes and validates:

- `promo-small-440x280.png` — required small promotional image;
- `screenshot-options-1280x800.png` — required screenshot of the actual packaged options page; and
- `media-manifest.json` — exact dimensions, SHA-256 digests, and provenance.

The media files are uploaded separately in the Chrome Web Store Developer Dashboard. They must not
be added to the extension ZIP. Re-run the command after any visible options-page or brand change and
review both images at full size before uploading.
