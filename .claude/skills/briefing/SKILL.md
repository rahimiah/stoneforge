---
name: briefing
description: Prepare a trading session briefing from Market Motion CLI data. Use when the user asks for /briefing, session prep, a pre-trade briefing, market briefing, or a concise snapshot of positions, news, arbitrage, funding, alerts, and trending markets.
---

# Briefing

Run a one-shot Market Motion session prep. Fetch live data, synthesize it by intelligence value, print a concise terminal summary, and write a full markdown log.

## Guardrails

- Read only. Never place trades.
- Do not add wrappers or external dependencies.
- Run the eight `motion --json` commands directly.
- Continue on partial failure. Never abort the whole workflow because one command failed.
- Do not show stack traces. Collapse failures to a short inline note.

## Fetch

Use UTC for timestamps. Create a temp workspace and capture each command separately so failures do not stop the run.

```bash
mkdir -p ~/docs/sessions
stamp="$(date -u +%Y-%m-%d-%H%M)"
human_stamp="$(date -u +'%Y-%m-%d %H:%M UTC')"
tmpdir="$(mktemp -d)"
```

Run exactly these commands:

```bash
motion hl positions --json
motion positions --json
motion orders --json
motion hl markets --json --limit 10
motion markets trending --json
motion arb scan --actionable --json
motion news trending --json
motion alerts list --json
```

For each command:

1. Save stdout to its own file in `"$tmpdir"`.
2. Save stderr to its own file in `"$tmpdir"`.
3. If the command fails, keep going and mark that dataset as unavailable with the first useful stderr line.

Suggested filenames:

- `positions.json`
- `positions-pm.json`
- `orders-pm.json`
- `hl-markets.json`
- `trending.json`
- `arbs.json`
- `news.json`
- `alerts.json`

If every command fails, print one short error line plus the final markdown-path line. Still write the markdown file with the recorded failures.

## Synthesis Order

Build the briefing in this order. Higher items win terminal space.

### 1. News x Positions

- Parse positions first. If there are no open positions, skip this section.
- Cross-reference held symbols against news `title`, `summary`, and `content`.
- Treat ticker matches case-insensitively.
- Prefer exact symbol matches such as `BTC`, `ETH`, `SOL`.
- If a position has a readable asset name, use that as a secondary match.
- Surface the highest-signal match first.

Terminal format:

```text
HEADLINE x POSITION
  BTC - Reuters | long 0.5 @ 5x | "Fed signals rate pause"
```

### 2. Arb Flags

- Use `motion arb scan --actionable --json`.
- Only surface opportunities with `spreadPct > 5`.
- Show direction as `cheap venue -> rich venue`.

Terminal format:

```text
ARB
  SpaceX IPO | polymarket 52.5c -> kalshi 92.5c | 40.0%
```

### 3. Positions

- Merge HL and Polymarket positions into one `HOLDING` section.
- Prefix each position line with `HL` or `PM`.
- For HL positions, show symbol, side, size, entry, PnL, and liquidation distance percent if available.
- For Polymarket positions, parse from the `data` array or a top-level array and use `title` or `question`, `outcome`, `size`, `avgPrice`, `currentPrice`, `pnl`, and `pnlPercent`.
- If one venue has no positions, show only the other.
- If both venues are empty, show `No open positions.`

Terminal format:

```text
HOLDING
  HL  BTC long 0.5 @ 69200 | PnL -516 (-1.5%) | liq 15.0% away
  PM  SpaceX IPO Yes 100 shares @ $0.52 | PnL +$13.00 (+25.0%)
```

### 4. Exposure

- Add an `EXPOSURE` section between `HOLDING` and `WATCH`.
- Calculate HL notional as the sum of `size * price` for HL positions.
- Calculate PM invested as the sum of `size * avgPrice` for PM positions.
- Show counts for each venue and the combined total.
- Omit this section entirely when both venues have no positions.

Terminal format:

```text
EXPOSURE
  HL $34,600 notional (1 pos) | PM $52 invested (1 pos) | total $34,652
```

In markdown, render the same data as a small table.

### 5. Funding + OI

- Use `hl markets`.
- Surface outlier funding rates, especially `abs(fundingRate) > 0.0001` (0.01%).
- Also note notable OI or momentum context from `hl markets` or `trending`.
- Keep this section compact.

Terminal format:

```text
WATCH
  PEPE funding 0.025% | BTC OI heavy | SOL trend cooling
```

### 6. Alerts

- Show alerts only when any exist.
- Omit the section when empty.

### 7. Remaining Context

- Use trending movers, new markets, and secondary news only in the markdown file unless there is spare line budget.

## Terminal Output Rules

- Target 10 lines, hard cap 15 lines.
- Start with:

```text
SESSION PREP  YYYY-MM-DD HH:MM UTC
```

- Omit empty sections completely.
- Use this priority for limited space:
  1. `HEADLINE x POSITION`
  2. `ARB`
  3. `HOLDING`
  4. `EXPOSURE`
  5. `WATCH`
  6. `ALERTS`
- End with:

```text
Full briefing -> ~/docs/sessions/YYYY-MM-DD-HHMM.md
```

- If all sources fail:

```text
SESSION PREP  YYYY-MM-DD HH:MM UTC
Data unavailable: positions (...), pm positions (...), pm orders (...), hl markets (...), trending (...), arbs (...), news (...), alerts (...)
Full briefing -> ~/docs/sessions/YYYY-MM-DD-HHMM.md
```

## Markdown Output

Write `~/docs/sessions/YYYY-MM-DD-HHMM.md`.

Use this structure:

```markdown
# Session Briefing - YYYY-MM-DD HH:MM UTC

## Status
- positions: ok | unavailable (...)
- pm positions: ok | unavailable (...)
- pm orders: ok | unavailable (...)
- hl markets: ok | unavailable (...)
- trending: ok | unavailable (...)
- arbs: ok | unavailable (...)
- news: ok | unavailable (...)
- alerts: ok | unavailable (...)

## Summary
[Paste the same compact findings shown in terminal, but without the line-limit pressure.]

## Positions
[Merged HL and PM position details, or `No open positions.` / unavailable.]

## Exposure
[Small table with HL notional, PM invested, counts, and total. Omit entirely when both venues are empty.]

## News x Positions
[Cross-referenced matches, then unmatched high-signal headlines.]

## Arbitrage
[All actionable arbs with spreadPct > 5.]

## Open Orders
| Market | Side | Size | Price | Status |
|--------|------|------|-------|--------|
| SpaceX IPO Yes | Buy | 50 | $0.55 | Open |

[Include this section only when `motion orders --json` returns open Polymarket orders. Omit it when empty or unavailable.]

## HL Markets
[Key markets with price, 24h change, open interest, funding, leverage.]

## Trending
[Trending and new markets worth monitoring.]

## News
[Headline list with source and published time.]

## Alerts
[Alert list, None, or unavailable.]
```

## Parsing Notes

- Expect some commands to return objects under `data`, some under top-level keys like `markets`, `trending`, or `mispricings`.
- Infer the real array from the returned JSON instead of assuming one schema for every command.
- Use the most specific field available:
  - positions: symbol, side, size, entry, leverage, pnl, liquidation price
  - pm positions: commonly under `data` array. Use: title, question, outcome, size, avgPrice, currentPrice, pnl, pnlPercent
  - pm orders: commonly under `data.orders` array. Use: market title, side, size, price, status
  - hl markets: `price`, `priceChange24h`, `openInterest`, `fundingRate`, `maxLeverage`
  - arbs: `outcomeLabel`, `minVenue`, `maxVenue`, `spreadPct`
  - news: `title`, `summary`, `content`, `sourceAuthor`, `publishedAt`
  - alerts: arrays commonly live under `data.alerts`

## Quality Bar

- Finish in under roughly 10 seconds when the CLI is responsive.
- Prefer the most decision-useful facts over exhaustive listing.
- Keep wording terse and trader-facing.
- If a field is missing, omit it instead of inventing it.
- If the user wants setup or execution guidance after the briefing, switch to the `trading-system` skill.
