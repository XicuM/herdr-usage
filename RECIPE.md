# Herdr Usage

How much quota is left on each AI account your running agents use, at the right end of Herdr's status bar: the agent's icon, then each window's share left ("5h 62% · 7d 17%"), coloured as it runs out. Click a provider for a popup with each limit, when it resets, paid credit past the limits, and today's tokens, prompts and spend, with a tab for every installed agent's account. It covers Claude, Codex, Antigravity/Gemini, Grok, OpenCode Go, Copilot, Cursor, OpenRouter, DeepSeek and Amp, and reads their usage itself, with no server or companion app.

![Herdr Usage](preview.png)

## What you see

- **The status bar's right end**, after Herdr's own status (`workspace-status`): a 1px `border` divider, then one group per provider of the agents running now, in the agents' order. Several agents on one account share one group.
  - It's drawn as part of the bar: `chrome` background, 1px `border` top edge, 11.8px `muted` text, 8px padding either side of the groups. The block is exactly as wide as its groups, so no gap opens beside them; with no agents running it is empty, without the divider.
  - A group is 22px tall, 6px padding, 6px gaps, 6px apart from the next, rounded 5px, `hover` background on hover, pointer cursor. It shows the agent's icon at 13px (a one-colour glyph in `muted`, or the picture as is), or the provider's name in `foreground` when the agent has no icon.
  - Then each main limit (not extra usage or credits, which are in the popup only), as a short label and the share **left**, semibold: "5h 62%", "7d 17%", "30d 80%" ("5h" for 5-hour windows, "7d" for weekly, "30d" for monthly, "45m"/"3h" for other windows, otherwise the label as given), separated by a `dim` "·". The share is coloured by how much is used: `done` (green) below 75% used, `working` (amber) from 75%, `blocked` (red) from 90%.
  - A balance with no limit (DeepSeek, OpenRouter pay-as-you-go) shows its amount instead, in `foreground` ("Balance (USD) 4.20 USD", "Balance $12.75"). A provider known but with no limit yet shows a `dim` "–".
  - Tooltip: "Claude: quota left; click for details".
- **The popup**, flat like Herdr's own menus (280px wide; an open popup can't be resized, so it's sized for the tab that shows the most rows and never scrolls; `popover` background, 5px padding, 12.8px text). Every part has a fixed height:
  - A 24px title line, 11px `dim`: the provider's name and its plan ("Claude · Team", "Copilot Free").
  - One 36px row per limit, 8px side padding: on one line the label in `foreground` (truncated), then 11px `dim` its detail and reset ("150 of 200 · resets in 10d 4h"; "in 3d 4h", "in 12m", "in < 1m", "shortly"), and at the right "38% left" in the tone colour; under it, 5px down, a 3px bar rounded 2px, `border` track, filled to the share **used** in the tone colour. A balance or credits row has no bar: the label, its detail, and the amount in `muted`.
  - What each provider lists:
    - Claude: 5-hour, weekly; **Extra usage** when it's on ("12.30 USD of 50.00 USD", its share of the monthly cap).
    - Codex: its two windows; **Credits** when it has any ("120 left", "Unlimited").
    - Copilot: **Premium requests**, and Chat and Completions where the plan limits them (Free), each "used of entitled"; a quota the plan doesn't include or that's unlimited isn't listed.
    - OpenRouter: the key's credit limit ("$12.00 of $100.00") and the account's **Balance**.
    - DeepSeek: a balance per currency, "10.00 granted · 40.00 paid".
    - The others as on the bar.
  - Antigravity's Claude and GPT model tiers come after the main ones, under an 11px `dim` "Other models".
  - "Reading…" while a provider is read for the first time; "Not signed in, or the login expired." when it was read and nothing was found; "No rate limits recorded." when it has usage but no limits: 36px rows in `dim`.
  - When known, after a divider (1px `border`, 7px side margin, 4px above and below), a 28px line, 11px `dim`: "Today: 1.2M tokens · 51 prompts · $3.40". The spend shows where the source records it and it's above zero (OpenCode, Amp, OpenRouter; subscriptions record 0).
  - At the bottom, with more than one provider, after a divider: a row of tabs 2px apart, one per provider, icon only at 14px (the name when there's no icon), 31px tall, at least 31px wide, rounded 7px, `selected` background and `foreground` icon on the open one, `hover` and a `muted` icon on the others. The running agents' providers come first; then those of the other installed agents (Herdr's `knownAgents()`), the last run first (the bar notes each running provider in `herdr-usage.ran.v1`, at most once a minute), never-seen ones in Herdr's order, their icons at 40% opacity unless open. Tooltip: the provider's name, with "(not running)" on the dimmed ones.

## How it behaves

- Every 5s it looks at which providers the running agents use, and reads any whose numbers are over 30s old. Agent statuses (working, blocked, done, idle) don't change what it shows: only which providers are running.
- The provider's own usage endpoints are asked at most every 5 minutes, Anthropic's every 2 minutes (it refuses more often), `agy` and `amp usage` every 5 minutes. A request that never answers holds that source for one such wait. Between them the last answer stands. Today's tokens and prompts come from the agents' local transcripts on every read.
- A provider that stops answering keeps its last limits for 3 minutes, then they're dropped. Claude's limits stay until their window resets, since Anthropic's endpoint often refuses a read. A limit whose reset time has passed is dropped.
- Clicking a group opens the popup on its tab; Esc or a click outside closes it. The popup follows the same numbers live.
- Picking a tab shows it and reads that provider if its numbers are over 30s old. A dimmed (not running) provider is read only then, never in the background.
- Days are UTC, as the transcripts' timestamps are.

## Built from

- **One mod**, `mods/herdr-usage/` (`mod.json`: `{ "place": "none", "title": "Usage" }`):
  - `usage.js`: all parsing and display rules, with no Herdr imports, so `node --test` covers it (`test/usage.test.js`, `npm test`). A port of herdr-bridge's `usage.rs`.
  - `main.js`: reads the sources and draws. Roles by `props()`: none is the status bar groups; `{ sheet: "<provider>" }` is the popup (its open tab; the bar gets the installed agents from `knownAgents()` in a `cx.spawn` and maps each one's `key`, else `name`, to a provider), opened with `openOverlay({ mod: "herdr-usage", kind: "popup", width: 280, height, props: { sheet, installed } })`. `height` is 10 (padding) + 24 (title) + 36 × the most rows any of its tabs shows + 37 (today's line and its divider) + 40 (the tabs and their divider, with more than one). The rows per provider are `ROWS` in `usage.js`, from what each reader returns: Claude 3 (5-hour, weekly, extra usage), Codex 3 (two windows, credits), Antigravity 5 (5-hour and weekly for Gemini and for Claude/GPT, and the "Other models" heading), OpenCode 3, Copilot 3 (premium requests, chat, completions), OpenRouter 2 (credit limit, balance), DeepSeek 2 (CNY, USD), Amp 2, the rest 1. A tab never shows more than its `ROWS`, so nothing can overflow. `installed` is `installed` (the bar's `knownAgents()`, refreshed every minute, as `{ p, program: { icon, tint } }`) so the popup has its tabs at once.
  - Shared state (`shared`/`setShared`), so every copy and restart sees one cache: `herdr-usage.v1` (`{ [provider]: { at, usage, limitsAt } }`), `herdr-usage.live.v1` (each slow source's last parsed answer), `herdr-usage.reading.v1` (a read in progress). Only parsed numbers and plan names, never a token.
  - Sizing: the groups' `on_size_change` runs `layout.resize { id: "herdr-usage", px }`, with the width divided by `settings().zoom` (the size comes zoomed and the layout zooms px again), only when it changes by 2px or more.
  - A provider is matched from the agent's `app`, then `program.key`, then `program.name` (`agents()`).
- **The layout**: in the person's personal layout, the `status` block becomes a row `status-row` (28px) of `status` (`workspace-status`, weight 1) and a block `herdr-usage` (`{ mod: "herdr-usage" }`, any px; the mod sizes it). On one of Herdr's own layouts, `layout.clone` first.
- **Where each provider's numbers come from** (`H` is the home folder):

  | Provider | Limits | Today's tokens and prompts |
  | --- | --- | --- |
  | Claude | `H/.claude/.credentials.json` → `api.anthropic.com/api/oauth/usage` | `H/.claude/projects/**/*.jsonl` |
  | Codex | `H/.codex/auth.json` → `chatgpt.com/backend-api/wham/usage`, else its logs | `H/.codex/sessions/**/*.jsonl` |
  | Antigravity | `agy -p /usage --output-format json`, run from `/` | `H/.gemini/antigravity-cli/brain`, `H/.gemini/tmp` |
  | Grok | `H/.grok/auth.json` → `cli-chat-proxy.grok.com/v1/billing` | `H/.grok/sessions/**/updates.jsonl` |
  | OpenCode Go | key from `sqlite3 -readonly H/.local/share/opencode/opencode.db`, else `auth.json` → `opencode.ai/zen/go/v1/usage` | the same database: `user` and `assistant` rows of `session_message` (v2) and `message` (v1) since UTC midnight; tokens are input + output + reasoning + cache writes; `cost` summed |
  | Copilot | `H/.config/github-copilot/hosts.json`, `H/.config/gh/hosts.yml`, `gh auth token` or `$GITHUB_TOKEN` → `api.github.com/copilot_internal/user` (`token` scheme, else `Bearer`): `quota_snapshots`, `quota_reset_date_utc`, the plan from `access_type_sku` (Free) or `copilot_plan` | none |
  | Cursor | `H/.cursor/auth.json` or `credentials.json` → `authenticator.cursor.sh/api/usage`, else `api2.cursor.sh/auth/stripe` | none |
  | OpenRouter | `H/.config/openrouter/key.txt`, `H/.openrouter/auth.json` or `$OPENROUTER_API_KEY` → `openrouter.ai/api/v1/auth/key` (limit, `usage_daily`) and `/api/v1/credits` (balance) | spend only: `usage_daily` |
  | DeepSeek | `H/.config/deepseek/key.txt`, `H/.deepseek/auth.json` or `$DEEPSEEK_API_KEY` → `api.deepseek.com/user/balance` (`total_balance`, `granted_balance`, `topped_up_balance`) | none |
  | Amp | `amp usage --start … --end …` (credit pools, balance) | its token total and recorded cost |

  Claude's extra usage is the usage endpoint's `extra_usage` (`is_enabled`, `monthly_limit` and `used_credits` in minor units, `decimal_places`, `utilization`). Codex's credits are `credits` (`has_credits`, `unlimited`, `balance`) in its usage endpoint's answer, else in its logs' `rate_limits`.

  When a provider gives no limits, another tool's usage file is used if written in the last 3 minutes: `H/.cache/ai-usagebar`, `H/.local/state/omarchy/agents/usage` or `H/.local/state/herdr/usage`, as `<name>/usage.json` or `<name>.json`.
- **`herdr` functions**: `agents`, `knownAgents`, `exec` (`sh`, `sqlite3`, `gh`, `agy`, `amp`, `printenv`), `fetch`, `home`, `readTextFile`, `shared`, `setShared`, `settings`, `theme`, `openOverlay`, `props`, `checking`, `run("layout.resize")`.
- **Art**: none of its own; the agents' icons from Herdr's program table.

## Watch out

- **What it touches**, to tell the person before adding it: it reaches the network (the providers' own endpoints above, nothing else), runs programs (`sh`, `sqlite3`, `gh`, `agy`, `amp`), and reads the agents' login files, transcripts and other tools' usage files in the home folder. It never writes outside Herdr's shared state, and never logs or stores a token.
- Several of the endpoints are private and undocumented (Anthropic's OAuth usage, ChatGPT's `wham/usage`, `copilot_internal`, Grok's CLI proxy), and some requests name the official client (`User-Agent: codex_cli_rs`, `Editor-Version: vscode/…`, `GitHubCopilot/…`), as the tools themselves do. They can change or break without notice; using them may go against a provider's terms.
- `agy -p /usage` starts Antigravity with its MCP servers: hundreds of MB and a few seconds of CPU every 5 minutes while an Antigravity agent runs. It's run from `/` so no project's MCP servers or instructions load.
- `sqlite3` must be `-readonly`: otherwise it creates an empty `opencode.db` where OpenCode has none.
- Herdr's `fetch` has no timeout and mods have no `setTimeout`: a source is stamped before it's asked, so a hung request doesn't pile up new ones.
- Logins aren't refreshed: an expired one (Codex's often is) gives no live limits until the agent's own CLI logs in again; its logs or another tool's file may still have them.
- The block's width comes from `layout.resize`, which saves the layout; the mod resizes only on a 2px change so it doesn't save on every frame.
- No `Intl` in Herdr's runtime: numbers and times are formatted by hand.
- Amp's refilling pools are open-ended: the popup shows its first two.
- Not tried against a real account: Claude's extra usage (off on the tested account), Codex's credits, OpenRouter's limit, balance and spend, DeepSeek's balance split, Cursor. Built from the APIs' published shapes, with tests.
- Linux-tested (herdr-app 0.1.16), with Claude, OpenCode, Antigravity, Grok, Amp and Copilot Free accounts.

## Done when

- `herdr-app check mods/herdr-usage` passes, `npm test` passes, and `herdr-app status` shows no errors.
- With a Claude Code agent running, the status bar's right end shows its icon and "5h N% · 7d N%", matching what's left in `/usage` in Claude Code, with no gap beside the group, at any zoom.
- An agent of a second provider adds a second group; closing all its agents removes it.
- Clicking a group opens the popup on its tab with each limit's share left, a bar of the share used, its reset time, and today's tokens and prompts.
- The popup's tabs show the running providers, then the other installed agents' dimmed; picking a dimmed one shows "Reading…", then its numbers or "Not signed in, or the login expired."
- No tab ever scrolls or is cut off, whichever is picked.
- With OpenCode used today, its tab's last line has today's tokens and prompts.
- With Copilot Free, its tab says "Copilot Free" with Chat and Completions, and no Premium requests.
- Over 75% used turns a share amber, over 90% red.
- No token appears in `shared.json`, and with no OpenCode set up no `opencode.db` is created.
