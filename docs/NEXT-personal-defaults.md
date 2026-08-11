# Next: personal availability that spans servers

Decided, not yet built. A spec to execute.

## The ask

Let someone fill in their availability **once**, in the DM with Skeddy, and have it apply to
every server they share with the bot — rather than answering the same questions in three
guilds. Slash commands should work inside the DM, not only in a server.

## Why this is not just "run /availability in a DM"

`/availability` is guild-scoped by construction: every write is keyed to a `group_id`, and
`resolveActor` needs a `discordGuildId` to find one. In a DM there is no guild. So the
feature is not "allow the command in DMs" — it is **a second, group-less thing to store**,
plus a rule for projecting it onto groups.

## Data model

Additive. Nothing week-scoped, because a default is not about a week.

```sql
CREATE TABLE user_default_slot (
  user_id     bigint NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  "window"    availability_window NOT NULL,        -- note the quoting, as everywhere
  PRIMARY KEY (user_id, day_of_week, "window")
);

ALTER TABLE app_user ADD COLUMN default_capacity smallint NULL CHECK (default_capacity BETWEEN 1 AND 4);
ALTER TABLE app_user ADD COLUMN default_vibes text[] NOT NULL DEFAULT '{}';
ALTER TABLE app_user ADD COLUMN auto_apply_defaults boolean NOT NULL DEFAULT false;
```

`auto_apply_defaults` is the difference between "a template I apply when I feel like it" and
"stop asking me, just say yes" — and it is what actually saves the two minutes.

## Behaviour

**In a DM, `/availability`** edits the personal default using the _same_ `singlePromptView`,
with a header saying these are defaults rather than this week, and a button row of
`[Save defaults] [Apply to my servers] [Auto-apply every week: on/off]`.

**In a server, `/availability`** is unchanged, except the single prompt gains a
`[Use my defaults]` button when the member has any — one tap to prefill days, windows,
capacity and vibes into the draft, still requiring Submit.

**Applying** writes a normal `weekly_response` + `availability_slot` + `vibe_tag` for the
current week in each group the user is a member of, through the existing `submit()`. It must
**skip any group where they already have a response this week** — an explicit answer always
beats a template, and silently overwriting one would be the worst possible bug here.

**Auto-apply** hooks into `runWeeklyPrompt`: before DMing someone, if they have
`auto_apply_defaults` and a non-empty default, submit for them and skip the DM. They stay
able to change it — a submitted response is editable by running `/availability` again.

## Making commands work in a DM

`setDMPermission(false)` → `true` on `/availability` only. Leave `/status`, `/overlap`,
`/setup` and `/propose` guild-only: they are inherently about one group, and a DM has no way
to say which.

Note discord.js marks `setDMPermission` deprecated in favour of `setContexts` /
`setIntegrationTypes`. Either works today; if you switch, do all commands at once so the
registration payload stays consistent.

## The ambiguity that needs a decision

Timezone. Default slots are day+window labels with no zone, and every group renders windows
as **group-local** (see `domain/week.ts` — this is forced by the no-timestamps rule, not a
preference). So "Wednesday evening" applied to two groups in different timezones means two
different real times.

For a friend group in one country this is a non-issue. It only bites cross-timezone, and the
honest fix is to say so in the copy — "defaults apply as each server's local Wednesday
evening" — rather than to invent a conversion the data model cannot support.

## Tests to write

- Applying skips groups where an explicit response already exists (the important one).
- Applying to zero groups is a clear message, not a crash.
- Auto-apply during `runWeeklyPrompt` submits and suppresses the DM, exactly once per week.
- The privacy sweep still passes: defaults are per-user data and must never appear in any
  group-scoped view. `listDefaultSlotsForSelf` naming, per the repository convention.
