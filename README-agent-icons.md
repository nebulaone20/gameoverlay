# Valorant Overlay — Step 4: Agent Icons (Tab Scoreboard)

This adds agent identification per player slot via template matching against
the Tab scoreboard portraits — no OCR, no memory reading. It compares
captured pixels against reference icons you crop yourself from your own
screen, so they always match your resolution, HUD scale, and the game's
current patch art.

## Setup (after your existing `npm install` / health bar setup)

No new dependencies — this reuses the same capture window and pixel-sampling
approach as the health bars.

## Step 1 — Reference icons (automatic)

No setup needed here — at every app launch, `main.js` fetches the current
agent roster from [valorant-api.com](https://valorant-api.com/v1/agents)
(no API key required) and caches one icon per agent to
`assets/agents/<name>.png`. The cache is reused for 7 days before
re-fetching, so this doesn't hit the API on every launch.

- Press **R** in the capture window to force an immediate re-fetch (e.g.
  after a new agent drops, or a patch changes icon art).
- If the API is unreachable (offline), it falls back to whatever's already
  cached on disk rather than breaking matching.
- The icon variant used is `displayIconSmall` (set in
  `src/agentDataFetcher.js` as `ICON_FIELD`) — if matching comes out poor
  once you test against real footage, try switching this to
  `killfeedPortrait` or `minimapPortrait`, which are styled a bit
  differently, then press **R** to re-fetch with the new variant.

## Step 2 — Scoreboard region (pre-calibrated, verify against your own footage)

The Tab scoreboard is a **single vertical list of 10 rows** — your 5
teammates stacked above the 5 enemies, split by a DEF/ATK divider bar in the
middle. (Not two side-by-side team columns, despite how the health-bar HUD
strip at the top of the screen is laid out — these are different UI
elements.)

`config.json`'s `agentIcons` block already ships with values measured
directly from a real 1920×1080 Tab-scoreboard screenshot:

```
x: 577, y: 357, iconWidth: 24, iconHeight: 30,
rowGap: 33.5, rowsPerTeam: 5, blockGapExtra: 61.5
```

- `x`, `y` — top-left-ish reference point for row 1's icon box (your top
  teammate).
- `rowGap` — vertical pitch between consecutive rows within one team's
  5-row block.
- `blockGapExtra` — the *additional* gap (beyond one normal `rowGap`)
  between row 5 (last teammate) and row 6 (first enemy), to account for the
  DEF/ATK divider bar sitting between the two blocks.

If you're also on 1920×1080 with default HUD scale, this should work
out of the box. If your resolution or HUD scale differs, recalibrate the
same way as the health bars:

1. Hold **Tab**, run `npm start`, hover the **center of your own (top)
   teammate's portrait**, press **C** — that's `agentIcons.x` / `.y`.
2. Hover the **center of the second teammate's portrait**, press **C** —
   the y-difference is `agentIcons.rowGap`.
3. Hover the **center of the first enemy's portrait** (row 6), press **C**
   — `blockGapExtra` = (that y) − row-1-y − 4×`rowGap` − `rowGap`.
4. Eyeball `iconWidth`/`iconHeight` from the preview (zoom in if needed).

## Step 3 — Tune matching, if needed

In `config.json` under `agentIcons`:

- `matchThreshold` — lower = stricter matching (fewer false positives, more
  "unrecognized" results). Raise it if confident agents are showing as `—`;
  lower it if two visually-similar agents (e.g. similar color palettes) get
  confused with each other.
- `histogramBuckets` — color resolution used for comparison. Higher catches
  finer color differences but is more sensitive to compression noise from
  the capture pipeline; `4` is a reasonable starting point.
- `tabOpenMinVariance` — how "UI-like" a region needs to look before the
  overlay trusts it as an open scoreboard, versus treating it as closed and
  falling back to the last known result. Raise this if the overlay
  occasionally shows a stale-looking false match while Tab is closed.

## Behavior notes

- **Latching:** the overlay keeps showing the last identified agent per slot
  even after you release Tab — it doesn't blank out. These latched tags
  render slightly faded (see `.agentTag.stale` in `overlay.html`) so you can
  tell at a glance the value might be a frame or two old, though in practice
  agent identity never changes mid-match so this is mostly cosmetic.
- **Team mapping:** the scoreboard's top/bottom blocks are *your team* vs
  *enemy team*, which is a different grouping than the health bars' atk/def
  sides (which swap at halftime). `overlay-renderer.js` currently maps
  mine→atk-slots and enemy→def-slots positionally — if your calibration
  shows your team isn't on the side you expected, swap that mapping in
  `applyAgentTeam(...)` calls inside `overlay-renderer.js`.

## What's next

1. ✅ Health bars + alive/dead
2. Round timer + round win pips (OCR)
3. Credits per player (OCR)
4. ✅ Agent identification per slot (icon template matching) — this step
5. KDA + ult points + round wins from the Tab scoreboard (OCR, more complex
   layout) — note this reuses the same scoreboard region/tab-open detection
   built here
6. VCT visual skin — once data sources are solid, redesign `overlay.html`
   properly (logos, team colors, broadcast typography)