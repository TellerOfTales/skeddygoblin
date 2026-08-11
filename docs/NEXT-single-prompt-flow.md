# Next: the single-prompt availability flow

Decided, not yet built. Everything below is a spec to execute, not options to weigh.

## The decision

Collapse the multi-stage weekly flow (days → paged window pickers → capacity → vibes →
submit) into **one message with Submit at the bottom**, while **preserving the ability to
set different windows per day** for anyone who needs it.

The constraint that shapes it: Discord allows **5 action rows per message**, and a select
menu occupies an entire row. That budget is the whole design.

| Row | Control                                                             |
| --- | ------------------------------------------------------------------- |
| 1   | `Which days are you around?` — multi-select, 7 options, min 0 max 7 |
| 2   | `What times suit you?` — multi-select, 6 windows, min 0 max 6       |
| 3   | `How many sessions?` — single select, 1 / 2 / 3 / 4+                |
| 4   | `Vibe` — multi-select, 8 Steam tags, min 0 max 3                    |
| 5   | `[Submit ✓]` `[Different times per day]` `[Can't this week]`        |

Rows 1 and 2 together mean **days × windows**: "Mon/Wed/Fri" plus "evenings" is evenings on
all three. That is how most people actually think about their week, and it is one screen.

**Row 5's middle button is what buys back the precision.** It opens the existing per-day
picker, seeded from the cross product, so nobody loses expressiveness — they just stop
paying for it by default.

## Implementation notes

### Draft state

`DraftState` gains one field. Do not repurpose `windows`.

```ts
export interface DraftState {
  days?: Day[];
  /** Cross-product windows from the single prompt: applies to every chosen day. */
  simpleWindows?: Window[];
  /** Per-day overrides. Once non-empty, this WINS and simpleWindows is ignored. */
  windows?: Record<string, Window[]>;
  capacity?: number;
  vibes?: VibeTag[];
}
```

The precedence rule is the whole trick: `windows` non-empty means the member went into the
per-day picker, so their explicit choices must never be overwritten by a later tap on the
row-2 select. Expansion happens once, at submit:

```
slots = windows non-empty ? flatten(windows) : days × simpleWindows
```

### Entering the per-day picker

Seed `windows` from the cross product before rendering it — `{ [day]: simpleWindows }` for
each chosen day — so the picker opens showing what they already said rather than blank.
That is also what makes the transition lossless.

### Returning from it

The per-day picker's Done button returns to the single prompt, which must now render row 2
as **disabled** with a placeholder reading `Set per day — use the button below`. Leaving it
live would let one tap silently discard per-day work.

### Submit

Enabled only when there is at least one day and at least one window (per-day or
cross-product). Capacity keeps its default of 1 if untouched — consistent with
`commitUnfinishedDrafts`, which already assumes 1.

### Things that will break if forgotten

- **Select menus do not remember selections across `update()`.** Re-render every select
  with `default: true` from the draft, in the view builder. Forgetting looks exactly like
  "the bot ate my answers".
- **`assertLegalMessage`** must pass on the new view with a maximal fixture: 5 rows, 3
  buttons in row 5, every custom_id ≤ 100 chars.
- **`test/unit/availabilityView.test.ts`** and the walkthrough narration both assume the
  staged flow and will need rewriting alongside.
- The existing per-day picker views stay — they are now reached by button rather than by
  default, and deleting them would remove the precision this whole design exists to keep.

## Why not the simpler thing

Dropping per-day windows entirely would have been one screen and less code, but it makes
"Wednesday evening but Saturday afternoon" inexpressible. Worse input means worse session
finding, which is the product's only job. The extra button is the cheapest possible way to
keep both.
