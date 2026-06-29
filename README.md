# Valorant Overlay — Step 1: Health Bars

This is the first piece of the full VCT-style overlay: live alive/dead +
health tracking for all 10 players, read purely from screen pixels (no
memory reading, no game-process interaction — just a screenshot of your
own screen, so this won't touch Vanguard).

## Setup

```bash
npm install
npm start
```

Two windows open:
- A small **capture window** — shows what's being captured + calibration readout.
- A **transparent overlay** — this is what would sit on top of the game. Right now it just shows two rows of 5 health slots at the top-center.

## Calibration (you MUST do this — the placeholder coords in `config.json` are guesses)

The exact pixel position of Valorant's top HUD health-bar strip depends on
your resolution, aspect ratio, and in-game HUD scale setting, so it can't be
hardcoded.

1. Launch Valorant in **borderless fullscreen** (not exclusive fullscreen —
   Electron's screen capture generally can't see exclusive fullscreen apps
   on Windows).
2. Get into a match (practice range works) so the health bars are visible.
3. Run `npm start`. The capture window shows a live preview.
4. Hover your mouse over the **left edge of the leftmost ATK health bar**
   in the preview, press **C**. Note the `x:___ y:___` it logs.
5. Repeat for the right edge of the rightmost ATK bar, then the top and
   bottom of the bar's pixel row. Do the same for the DEF side.
6. Edit `config.json`:
   - `healthBars.atk.x` / `.y` = top-left corner of the ATK strip
   - `.width` = right edge x − left edge x
   - `.height` = bottom y − top y (usually tiny, like 4–8px)
   - same for `healthBars.def`
7. Restart `npm start` and watch the overlay — bars should now move when
   you take damage in-game, and slots should show dead (×) when an agent dies.

If colors look off (bar shown empty when it shouldn't be, or vice versa):
tweak `colors.atkFill` / `colors.defFill` (RGB) and `colors.emptyThreshold`
(higher = more tolerant color matching).

## What's next (build incrementally, in this order)

1. ✅ Health bars + alive/dead (this step)
2. Round timer + round win pips (OCR — small, fixed-format text, easiest OCR target)
3. Credits per player (OCR — only visible on your own scoreboard tab usually, worth deciding if you want "my UI + tab scoreboard" or just what's always on screen)
4. Agent identification per slot (icon template matching, not OCR — compare cropped icon region against saved reference images per agent)
5. KDA + ult points + round wins from the Tab scoreboard (OCR, more complex layout)
6. VCT visual skin — once data sources are solid, redesign `overlay.html` properly (logos, team colors, broadcast typography)

Each one is a separate, isolated module — say which one you want to tackle next.
