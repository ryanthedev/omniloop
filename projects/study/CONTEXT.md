## Study project

This loop turns media (reels, videos, podcasts) into study kits: a slide deck and a randomized practice test,
published on upublish under the `ryan` address and listed on the root page Recall Room, `ryan.upubli.sh/recall-room/`.
Use the `study` skill for the whole job; it holds the owner's test format, which is fixed.

- **Outputs:** `study/` in this loop folder (`ingest/`, `site/`, `entry.json`). Never `/tmp`.
- **Never** use the owner's main Instagram account, overwrite an existing kit's slug, or build from guesses when a
  fetch fails.
