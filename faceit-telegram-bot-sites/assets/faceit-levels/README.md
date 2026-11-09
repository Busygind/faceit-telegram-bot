# FACEIT skill level badges

Original level 1–10 PNG badges from the [official FACEIT CS2 Elo article](https://support.faceit.com/hc/en-us/articles/10525200579740-FACEIT-CS2-Elo-and-skill-levels), retrieved on 2026-10-16.

- The PNG bytes are preserved unchanged from FACEIT's official article attachments.
- Each badge is 38 × 38 pixels with an RGBA color model and a transparent outer background.
- Numbers are rasterized in the original artwork; no runtime fonts or remote image requests are required.
- Exact source URLs, dimensions and SHA-256 digests are recorded in `manifest.json`.
- FACEIT trademarks and artwork remain the property of their owners; these files are not claimed as original or openly licensed artwork.

## Rebuild the portable atlas

Run these commands from the local source checkout `faceit-telegram-bot`:

```sh
node scripts/prepare-level-badges.mjs
node scripts/prepare-level-badges.mjs --check
node scripts/render-demo.mjs
node --test tests/level-badges.test.js tests/card.test.js
```

The offline build tool requires only Node builtins. It verifies each original PNG against the manifest, decodes PNG8/RGBA filters, and scales once from 38 × 38 to 88 × 88 using premultiplied-alpha bilinear interpolation. It generates `tgcloud/lib/faceit-levels.js` with RGBA pixel runs; no network request, filesystem access, PNG decoding or resizing happens at bot runtime. Up to ten lazily decoded images occupy 309,760 bytes of pixel memory per process. A serverless cold start initializes its own cache.

The Sites checkout uses identical generated `bot/core/faceit-levels.js` and `bot/core/card.js`; rebuild in the local source checkout, then mirror those modules. Change the report-cache renderer scope whenever artwork or layout changes so Telegram cannot reuse obsolete report photos. Regenerated Dark demo PNGs are the visual regression artifacts.
