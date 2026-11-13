---
name: study
description: >-
  Turn one reel, video or podcast into a study kit published on upublish: a skimmable slide deck plus a randomized
  practice test that can't be memorized, listed on the owner's study root page. Use when given an Instagram, YouTube,
  TikTok, X or podcast link with "study", "make slides", "turn this into a deck", "test me on this", or when working in
  a loop that carries the study project. Not for clipping video (youtube-short, bjj-match-clips) or plain transcripts.
---

# Study kit

The owner reads and skims much faster than they listen. Each source becomes three pages: a landing page, a slide
deck, and a test. Paths below are relative to this project, two folders above this file (`<project>`).

**Where things go:** everything for one source lives in the loop folder, `~/loops/<loop id>/study/`:
`ingest/` (media, transcript, frames), `site/` (what gets published), and `entry.json` (its line on the root page).
Never work in `/tmp`: it gets wiped.

## 1. Ingest

- **Video (Instagram, YouTube, TikTok, X):** follow the `sdd` plugin's `video-ingest` skill, with `ingest/` as its
  artifact folder: preflight first, then fetch, then whisper and frames in parallel, then fusion into `fused.json`.
  Short clips get 12-20 frames.
- **Podcast or other audio:** fetch with `yt-dlp -x --audio-format wav -o 'ingest/%(id)s.%(ext)s' <url>`, then
  transcribe with `mlx_whisper`. Skip frames and fusion. A long episode is fine; the deck just grows (see 2).
- **Instagram:** anonymous `yt-dlp` with `--sleep-requests 2` has worked. Never use the owner's main account. A burner
  cookies file is fine if one is already set up.
- **Fetch fails** (login wall, rate limit): stop and report the exact error text. Never build from guesses about
  what the source says.

## 2. The deck: `site/slides.html`

- **Actually beautiful, not a template:** a visual theme that fits the topic, strong type, one idea per slide.
  Each kit has its own look; share it across all three pages through `site/style.css`.
- **Coverage:** everything the source teaches, in order, with a title slide and a recap slide. About 8-15 slides for
  a short clip; for a long video or podcast, about one slide per distinct idea, grouped into sections.
- **Source links:** for YouTube and podcasts, put the timestamp on each slide and link it to that moment.
- **Controls:** arrow keys, click and swipe, a progress indicator, and it must look good on a phone held upright,
  because the owner opens these from WhatsApp.
- **Grounding:** every claim comes from what the source says or shows.
- **About the ideas, not the medium:** the owner cares about the principles, not the reel or video they came from.
  Never write "reel", "video", "clip", "podcast" or "episode" on any page ("the reel says", "Watch the reel"); credit
  the creator by handle and link the original as "Original ↗". `study-check` fails a page that does, unless
  `meta.mediaWords` names a very good reason (a kit about making podcasts, say).
- **Markup the checks rely on:** each slide is one `<section class="slide">` (no nested sections), in order, and
  `slides.html#N` opens slide N (1-based). The test's questions are matched to slides by that order.

## 3. The test: the owner's format, which is fixed

The owner learns from the slides, not the source, and wants tests that help them win so they remember more. Copy,
never edit, `<project>/kit/quiz.js` (the engine) and `<project>/kit/test.html` (the page) into `site/`. Only the
`<head>` above `<style>` in `test.html` may change (the deck's fonts, theme color and icon). Write the questions in
`site/bank.js`:

```js
globalThis.QUIZ = {
  meta: { title: "…", slug: "…", per: 10, headline: "A question that fits the topic?",
          source: "<url>", verdicts: ["100%", "80%+", "50%+", "below 50%"],  // first-try score, in the topic's voice
          slides: ["<headline of slide 1>", "…"] },  // one per slide, in order, each copied from its slide
  bank: [ /* items: see the top of quiz.js for the two types */ ],
};
```

- **Questions come only from the slides.** Each item names its `slide` (1-based) and an `anchor`: words copied from
  that slide. If a fact is worth testing but isn't on a slide, put it on a slide first. Never ask what "the reel" or
  "the video" said: the owner may not have watched it.
- **Exactly two answers.** `pick`: the right answer plus one wrong answer drawn from `wrongs` (2+). `tf`: a
  statement answered True or False. No fill-in, no "which is NOT", no four-way choices.
- **Every item can be reworded:** `pick` needs 2+ `prompts` (and may give `answers[]`, several wordings of the right
  answer); `tf` needs 3+ statements with at least one true and one false. A missed question comes back two
  questions later in the same round with new wording and a new wrong answer, until it's answered right.
- **Randomized every round:** which questions (a bank of 30+, 10 per round), their order, wording and wrong answer.
- **Cover the deck:** every content slide gets at least one question.
- **Every item has a one-line `explain`,** shown after each answer next to a link to its slide.
- **What the page does with it:** a hint button shows "Slide N: <headline>"; after each answer it links to
  `slides.html#N`; the round is kept in `sessionStorage`, so a trip to the slides and back resumes it; the win screen
  shows the first-try score, the best, and the slides to revisit. The deck must open the slide named in its URL hash.
- **`style.css` must define** `--pad --bg-2 --line --pass --fail --run --muted --text --display --mono` and the
  classes `.btn .kicker .dot .topbar .home`, because the shared test page uses them.

## 4. The landing page: `site/index.html`

The topic, a credit with a link to the original, and two big buttons, Slides and Test. Add a small link back to the
root page (see 6).

## 5. Verify before publishing

Both must pass:

```sh
node <project>/bin/study-check.mjs ~/loops/<id>/study/site   # format, two answers, every question on its slide, retries
node <project>/bin/study-smoke.mjs ~/loops/<id>/study/site   # headless Chrome: deck, a round with a miss, resume, slide links
```

## 6. Publish (upublish, address `ryan`)

**Not logged in** (a token or refresh error from any upublish tool): run `omniloop needs-you`, report the exact
error, and stop. Logging in is the owner's job.

1. **The kit:** call `list` on `ryan` first. Pick a short slug from the topic; if it exists, pick another. Never
   overwrite an existing kit. Publish `site/` with that slug, public. Fetch the live URLs and confirm they load.
2. **Its entry:** write `~/loops/<id>/study/entry.json`:
   `{title, slug, url, source, kind ("reel"|"youtube"|"podcast"|"tiktok"|"x"), creator, date (YYYY-MM-DD), slides, questions, summary}`.
3. **The root page:** `node <project>/bin/study-index.mjs ~/loops/.study-root` then publish that folder to the root slug
   in `<project>/project.json` (`publish.root`). This is the one site you may republish over: it is rebuilt from every
   loop's entry, so nothing is lost. Before the first publish there, check `list`: if that slug exists and its
   page isn't this study index, stop and ask the owner.
4. **Memory:** one engram entry per source: the URL, the kit URL, and the main claims, so a later loop can tell the
   owner they've seen it before. Search engram for the URL first; don't duplicate.

## Report

The live URLs (landing, slides, test), the topic in a line or two, the slide count, bank size and per-round count,
how many slides have questions, and anything that failed or that you weren't sure about.
