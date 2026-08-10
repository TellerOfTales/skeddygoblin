# Runbook

Three walkthroughs: getting it running against real Discord, getting Steam working, and
deploying. Do them in that order — each depends on the one before.

---

## 1. First run against real Discord

Nothing in this codebase has ever touched a live gateway. The 188 tests use fake
interaction objects, which is deliberate, but it means DM delivery, component round-trips
and autocomplete latency are all unexercised. **Expect to find small things here. That is
what this step is for.**

### 1.1 Create the application

1. Go to <https://discord.com/developers/applications> → **New Application**. Name it
   whatever you like; members never see it.
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_TOKEN`. It is shown once.
3. **General Information** tab → copy **Application ID**. This is `DISCORD_CLIENT_ID`.
4. **Bot** tab → leave every Privileged Gateway Intent **OFF**. The bot deliberately needs
   none of them; if you find yourself enabling one, something has gone wrong.

### 1.2 Invite it to a test server

Make a throwaway server first — do not test in the real one.

**Installation** tab → **Install Link** → _Discord Provided Link_, with scopes
`bot` and `applications.commands`, and permissions:

- Send Messages
- Embed Links
- Read Message History
- Use Application Commands

Open the generated URL, pick your test server.

Then in Discord: right-click the server → **Copy Server ID**. That is `DISCORD_GUILD_ID`.
(If you do not see it, User Settings → Advanced → Developer Mode.)

### 1.3 Configure and boot

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`. Leave
`SCHEDULER_ENABLED=false` for now — you do not want a cron DMing you mid-test.

```bash
npm install
npm run db:up        # or: docker compose up -d db
npm run migrate
npm run register     # guild-scoped, so commands appear instantly
npm run dev
```

You should see `discord client ready`. If config is wrong the process exits with a list of
every problem at once rather than one at a time.

> Re-run `npm run register` whenever you change a command's name, description or options.
> Guild commands propagate instantly; global ones take up to an hour, which is why this
> project does not use them.

### 1.4 Walk the flow

You need **two Discord accounts** — a second one on your phone is fine. One account cannot
test buzz, because self-buzz is rejected by design.

**Account A:**

| Step | Do                                                          | Expect                                                     |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | `/setup timezone:Europe/London channel:#general country:GB` | Confirmation listing timezone, channel, cutoff, storefront |
| 2    | `/availability`                                             | Ephemeral "Sent you a DM", then a DM with two buttons      |
| 3    | In the DM, tap **Can't this week**                          | Buttons vanish, no follow-up questions, no red             |
| 4    | `/availability` again → **I'm in**                          | Day picker                                                 |
| 5    | Pick Mon/Wed/Fri                                            | Window pickers, one select per day                         |
| 6    | Pick windows for Monday → **Copy Mon to all**               | All three days now show the same windows, preselected      |
| 7    | **Done ✓** → capacity → vibe → **Submit**                   | Summary saying individual answers stay private             |
| 8    | `/availability` again                                       | Resumes with your answers still ticked                     |

**Account B:** repeat steps 4–7 with overlapping windows.

**Then:**

| Step | Do                                                            | Expect                                                      |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| 9    | `/overlap`                                                    | Leaderboard. Slots only one of you can make must NOT appear |
| 10   | `/status`                                                     | Both accounts listed as answered, no Buzz buttons           |
| 11   | Third account (or have B not answer) → `/status` → **Buzz 1** | They get a DM; the button greys out                         |
| 12   | Tap **Buzz 1** again                                          | "They've already been buzzed today"                         |
| 13   | As organizer, `/overlap` → **Lock in …**                      | RSVP message with Yes/Maybe/No                              |
| 14   | Both accounts RSVP Yes → **Confirm session ✓**                | Both get a DM; counts shown, names not                      |

### 1.5 The things most likely to break first

- **"Sent you a DM" but no DM.** Your privacy settings block DMs from server members.
  Server dropdown → Privacy Settings → allow direct messages. The bot reports this
  explicitly rather than failing silently.
- **"This interaction failed."** Means the 3-second ack window was missed. Every handler
  defers immediately, so if you see this, check the logs for a slow query.
- **A button does nothing.** Look for `no handler for namespace` or `malformed custom_id`
  in the logs.
- **Commands do not appear.** You did not run `npm run register`, or `DISCORD_GUILD_ID` is
  a different server.

### 1.6 Turn the scheduler on last

Once the manual flow works, set `SCHEDULER_ENABLED=true` and `TICK_INTERVAL_MS=60000`.
To test without waiting until Monday, temporarily set the cutoff to a minute from now:

```
/setup cutoff_day:<today> cutoff_time:<HH:MM two minutes from now>
```

Watch for the roster and leaderboard posting to your announce channel exactly once.

---

## 2. Steam

Steam is not optional for this product — without it there is no shared library and no game
matching. Two credentials are needed, and they are unrelated to each other.

### 2.1 Get a Steam Web API key

1. You need a Steam account with **Steam Guard enabled** and at least one purchase
   (Valve blocks limited accounts from issuing keys).
2. Go to <https://steamcommunity.com/dev/apikey>.
3. **Domain Name**: the domain you will host on, e.g. `skeddy.example.com`. It is not
   verified and not enforced — put your real one anyway.
4. Agree and register. Copy the key into `STEAM_API_KEY`.

This key is used **only** for `GetOwnedGames`. Treat it like a password: it is rate-limited
per key, and Valve will revoke it if it leaks. It is registered in the secret-redaction
list so it cannot appear in logs.

### 2.2 Get a public HTTPS URL

Steam's sign-in is **OpenID 2.0**, which means Steam redirects the user's _browser_ back to
you. That requires a publicly reachable HTTPS URL — localhost will not work.

**For testing**, use a tunnel:

```bash
npx untun@latest tunnel http://localhost:8080
# or: cloudflared tunnel --url http://localhost:8080
```

Copy the `https://…` it prints into `PUBLIC_BASE_URL`. No trailing slash — the config
strips one if you leave it.

**For production**, this is just your deployed hostname.

```
STEAM_API_KEY=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
PUBLIC_BASE_URL=https://skeddy.example.com
HTTP_PORT=8080
```

Restart. You should see `steam callback server listening`. With either variable missing,
Steam features stay completely dormant and `/link-steam` says so plainly.

### 2.3 Link an account

1. `/link-steam` → **Sign in through Steam** → sign in.
2. You land on a plain page saying how many games synced.

If it says **"Linked, but your library is hidden"**: Steam → Profile → Edit Profile →
Privacy Settings → set **Game details** to _Public_. ("My profile" being public is not
enough — game details is a separate setting.) Then run `/link-steam` again.

### 2.4 Verify matching

Get at least **two** members linked — the k-anonymity floor means a game only one person
owns is never shown.

```
/games                    → shared games, ranked by this week's vibe, priced in your currency
/games include_solo:true  → includes single-player titles
/propose game:<type here> → autocompletes from the shared library
```

Metadata fills in over the following minutes: the scheduler refreshes app details in
batches, deliberately slowly, because the Steam Store endpoint allows roughly 200 requests
per 5 minutes and getting blocked is worse than being late. Prices and genres appear as
that catches up.

### 2.5 Currency

`/setup country:GB` sets the Steam storefront. It decides both the price _and_ the
currency symbol, because Steam prices regionally — a UK group asking for US prices gets a
misleading number. Default is `US`.

---

## 3. Deploy

### 3.1 What you need

- One always-on Node 18+ host
- A managed Postgres
- A stable HTTPS hostname (for the Steam callback)

**Run exactly one instance.** The scheduler is in-process. Correctness does not _depend_ on
that — every scheduled job claims its run via `job_run`, whose primary key is the lock, and
a second process fails to take a session advisory lock and logs that it is serving
interactions only. But steady-state should be one.

### 3.2 Environment

```
NODE_ENV=production
DISCORD_TOKEN=…
DISCORD_CLIENT_ID=…
DISCORD_GUILD_ID=…
DATABASE_URL=postgres://…
DATABASE_SSL=true            # nearly every managed Postgres requires this
SCHEDULER_ENABLED=true
AUTO_REGISTER_COMMANDS=false # register deliberately, not on every restart
STEAM_API_KEY=…
PUBLIC_BASE_URL=https://…
HTTP_PORT=8080
LOG_LEVEL=info
```

`NODE_ENV=production` stops dotenv loading a `.env` file — configuration comes from the
environment.

### 3.3 Build and run

```bash
npm ci
npm run build
node dist/index.js
```

Migrations run automatically at boot, guarded by an advisory lock, so a restart is safe.
Point health checks at `GET /healthz` (only served when Steam is configured; otherwise use
a process check).

### 3.4 Fly.io, concretely

```bash
fly launch --no-deploy
fly postgres create && fly postgres attach <db-name>
fly secrets set DISCORD_TOKEN=… DISCORD_CLIENT_ID=… DISCORD_GUILD_ID=… \
                STEAM_API_KEY=… PUBLIC_BASE_URL=https://<app>.fly.dev
fly deploy
fly scale count 1     # one instance
```

In `fly.toml`, set `internal_port = 8080` and — importantly —
`auto_stop_machines = false`, or the scheduler sleeps and the weekly prompt never fires.

Railway and Render work the same way: one instance, `npm run build` then
`node dist/index.js`, and turn off any scale-to-zero.

### 3.5 After deploying

```bash
npm run register     # once, against production credentials
```

Then re-run the section 1.4 walkthrough in the real server. First real Monday, check the
logs for `weekly prompt sent` with a plausible count.

### 3.6 Backups

`weekly_response`, `availability_slot` and `vibe_tag` are the only data that would hurt to
lose, and only for the current week. Whatever your provider's default backup is, that is
almost certainly enough.
