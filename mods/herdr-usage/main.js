// herdr-usage: for each account the running agents use, the share of each quota left, in the
// status bar ("Claude 5h 75% · 7d 19%"), and a popup with each limit, when it resets, and today's
// tokens and prompts. As herdr-mobile showed them through herdr-bridge; this reads the same
// sources itself. The logic is in usage.js.
//
// Roles: no props, the status bar groups; { sheet: <provider> }, the popup a group opens, with a tab per
// provider: the running ones, then dimmed, the other installed agents', read only when their tab is picked.
// Shared state, so every copy and every restart sees one cache and one throttle per slow source:
//   herdr-usage.v1          { [provider]: { at, usage, limitsAt } }
//   herdr-usage.live.v1     { [source]: { at, value } }   (every online source, agy and amp: asked rarely)
//   herdr-usage.reading.v1  { [provider]: startedAt }
//   herdr-usage.ran.v1      { [provider]: when an agent of it was last seen running }, to order the tabs

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, knownAgents, exec, home, readTextFile, shared, setShared, settings, theme, openOverlay, props, checking, run as runCommand } from "herdr";
import * as u from "./usage.js";

const KEY = "herdr-usage.v1";
const LIVE = "herdr-usage.live.v1";
const READING = "herdr-usage.reading.v1";
const RAN = "herdr-usage.ran.v1";
/** A read that started this long ago and never finished (the mod reloaded mid-read) no longer blocks. */
const READ_TIMEOUT = 60_000;

// Today's lines only, and of those only what's counted: a day of Claude transcripts is megabytes of tool output.
const CLAUDE_LINES = `find "$1" -maxdepth 4 -type f -name '*.jsonl' -mmin -${u.RECENT_MINUTES} -exec grep -h -F -- "$2" {} + 2>/dev/null | grep -E '"type":"(user|assistant)"' | grep -v '"type":"tool_result"'`;
// With its file name: a Codex session's tokens are its last total. Its limits may be from before today.
const CODEX_LINES = `find "$1" -maxdepth 4 -type f -name '*.jsonl' -mmin -${u.RECENT_MINUTES} -exec grep -H -E '"(token_count|user_message|turn_context)"' {} + 2>/dev/null`;
// $1 a folder, $2 the files' name, $3 what a line must hold.
const LINES = `find "$1" -maxdepth 6 -type f -name "$2" -mmin -${u.RECENT_MINUTES} -exec grep -h -F -- "$3" {} + 2>/dev/null`;
// The newest of the given files, if written in the last 3 minutes (usage.rs's STALE): a tool no longer
// running leaves its last numbers behind.
const NEWEST = `f=$(ls -t -- "$@" 2>/dev/null | head -n 1); [ -n "$f" ] && [ -n "$(find "$f" -maxdepth 0 -type f -mmin -3)" ] && cat -- "$f"`;

// The provider of an agent: Herdr's `app` for it, else its program's key or name.
const provider = (a) => [a?.app, a?.program?.key, a?.program?.name].map(u.providerOf).find(Boolean) ?? null;
const read = (path) => readTextFile(path).catch(() => null);
const H = (path) => `${home()}/${path}`;
const run = (cmd, args, timeout = 20_000, cwd) => exec(cmd, args, { timeout, cwd }).then((r) => (r.code === 0 ? r.stdout : null)).catch(() => null);
// sh's own exit code isn't the point here (grep finding nothing is 1): only what it printed.
const lines = (script, args) => exec("sh", ["-c", script, "herdr-usage", ...args], { timeout: 20_000 })
  .then((r) => r.stdout.split("\n").filter(Boolean)).catch(() => []);
const env = async (name) => (await run("sh", ["-c", 'printf %s "$(printenv "$1")"', "herdr-usage", name])) || null;
const getJson = async (url, headers) => {
  try {
    const r = await fetch(url, { headers });
    return await r.json();
  } catch {
    return null;
  }
};
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Another tool's usage file for this provider, when one is fresh. */
async function cached(p) {
  const paths = u.CACHE_DIRS.flatMap((dir) => u.CACHE_NAMES[p].flatMap((n) => [H(`${dir}/${n}/usage.json`), H(`${dir}/${n}.json`)]));
  return parseJson((await lines(NEWEST, paths)).join("\n"));
}

/** A slow or rate-limited source's last answer, read again only after `ttl`. What it keeps is shared, and
 *  shared state persists and every mod can read it: parsed numbers only, never a token. */
async function live(name, ttl, readIt) {
  const e = shared(LIVE)?.[name];
  if (e && Date.now() - e.at < ttl) return e.value;
  // Stamped before asking: a request that never answers (fetch has no timeout) holds this source for one
  // `ttl`, instead of piling up a new one every read.
  setShared(LIVE, { ...shared(LIVE), [name]: { at: Date.now(), value: e?.value ?? null } });
  const value = (await readIt()) || null;
  setShared(LIVE, { ...shared(LIVE), [name]: { at: Date.now(), value } });
  return value;
}

async function readClaude() {
  const today = u.todayUtc();
  // Anthropic answers about one read every two minutes: its last answer stands until then.
  const l = await live("claude", u.CLAUDE_LIVE_TTL, async () => {
    const login = u.claudeLogin(await read(H(".claude/.credentials.json")));
    const resp = login && await getJson("https://api.anthropic.com/api/oauth/usage", {
      Authorization: `Bearer ${login.token}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    });
    // Null when it refused: the cached limits stand. Extra usage after the windows, when it's on.
    const limits = u.claudeLimits(resp);
    return { plan: login?.plan ?? null, limits: limits && [...limits, ...[u.claudeExtra(resp)].filter(Boolean)] };
  });
  const c = l?.limits ? null : u.claudeCache(await cached("claude"));
  const s = u.claudeStats(await lines(CLAUDE_LINES, [H(".claude/projects"), today]), today);
  return u.usage({ plan: l?.plan ?? c?.plan, model: s.model, limits: l?.limits ?? c?.limits ?? [], tokens: s.tokens, prompts: s.prompts });
}

async function readCodex() {
  const entries = (await lines(CODEX_LINES, [H(".codex/sessions")])).flatMap((l) => {
    const i = l.indexOf(":{");
    return i < 0 ? [] : [{ file: l.slice(0, i), line: l.slice(i + 1) }];
  });
  const s = u.codexStats(entries, u.todayUtc());
  // Its windows as the usage endpoint gives them now, else as its logs last recorded them.
  const l = await live("codex", u.NET_TTL, async () => {
    const login = u.codexLogin(await read(H(".codex/auth.json")));
    return login && u.codexLive(await getJson("https://chatgpt.com/backend-api/wham/usage", {
      Authorization: `Bearer ${login.token}`,
      "ChatGPT-Account-Id": login.account,
      "User-Agent": "codex_cli_rs",
      Accept: "application/json",
    }));
  });
  let plan = l?.plan ?? null;
  let limits = u.codexLimits(l?.windows ?? s.logLimits ?? {});
  if (!limits.length) {
    const c = u.codexCache(await cached("codex"));
    plan = plan ?? c?.plan ?? null;
    limits = c?.limits ?? [];
  }
  const credits = u.codexCredits(l?.credits ?? s.logLimits?.credits);
  if (credits) limits = [...limits, credits];
  return u.usage({ plan, model: s.model, limits, tokens: s.tokens, prompts: s.prompts });
}

async function readAntigravity() {
  const today = u.todayUtc();
  const s = u.antigravityStats(
    await lines(LINES, [H(".gemini/antigravity-cli/brain"), "transcript.jsonl", today]),
    await lines(LINES, [H(".gemini/tmp"), "*.jsonl", today]),
    today,
  );
  // `agy` starts every MCP server it's configured with: hundreds of MB and seconds of CPU. From `/`, so no
  // project's MCP servers or instructions load with it.
  let limits = await live("agy", u.AGY_LIVE_TTL, async () =>
    u.antigravityProbe(parseJson(await run("agy", ["-p", "/usage", "--output-format", "json"], 120_000, "/"))));
  if (!limits?.length) limits = (await cached("antigravity"))?.limits ?? [];
  limits = u.tagPrimary(limits);
  if (!s.tokens && !s.prompts && !limits.length) return null;
  return u.usage({ plan: s.model ?? "Gemini 3.7 Flash", limits, tokens: s.tokens, prompts: s.prompts });
}

async function readGrok() {
  const today = u.todayUtc();
  const s = u.grokStats(await lines(LINES, [H(".grok/sessions"), "updates.jsonl", "turn_completed"]), today);
  const billing = await live("grok", u.NET_TTL, async () => {
    const login = u.grokLogin(await read(H(".grok/auth.json")));
    return login && u.grokBilling(await getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      Authorization: `Bearer ${login.key}`,
      "x-xai-token-auth": "xai-grok-cli",
      "x-userid": login.userId,
    }));
  });
  let plan = billing?.plan ?? u.grokTier(await read(H(".grok/settings_cache.json")));
  let limits = billing?.limits ?? [];
  if (!limits.length) {
    const c = u.grokCache(await cached("grok"));
    plan = plan ?? c?.plan ?? null;
    limits = c?.limits ?? [];
  }
  if (!s.tokens && !s.prompts && !limits.length && !plan && !s.model) return null;
  return u.usage({ plan: plan ?? s.model ?? "Grok", limits, tokens: s.tokens, prompts: s.prompts });
}

async function readOpencode() {
  let limits = await live("opencode", u.NET_TTL, async () => {
    // Read-only: sqlite3 would otherwise create an empty database where OpenCode has none.
    const key = u.opencodeKey(
      await run("sqlite3", ["-readonly", H(".local/share/opencode/opencode.db"), "select value from credential where integration_id='opencode-go' and active=1 limit 1;"]),
      await read(H(".local/share/opencode/auth.json")),
    );
    return key && u.opencodeLimits((await getJson("https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${key}` }))?.usage);
  }) ?? [];
  // ai-usagebar keeps this same reply, under `response`, for its own display.
  if (!limits.length) {
    const c = await cached("opencode");
    limits = u.opencodeLimits(c?.response?.usage ?? c?.usage);
  }
  // Today's prompts, tokens and cost from its database, both message tables (v2 and v1); read-only, as above.
  const since = Date.parse(`${u.todayUtc()}T00:00:00Z`);
  const db = H(".local/share/opencode/opencode.db");
  const tokens = (j) => `coalesce(json_extract(${j},'$.tokens.input'),0)+coalesce(json_extract(${j},'$.tokens.output'),0)+coalesce(json_extract(${j},'$.tokens.reasoning'),0)+coalesce(json_extract(${j},'$.tokens.cache.write'),0)`;
  const s = u.opencodeStats(
    await run("sqlite3", ["-readonly", db, `select coalesce(sum(type='user'),0), coalesce(sum(case when type='assistant' then ${tokens("data")} end),0), coalesce(sum(case when type='assistant' then json_extract(data,'$.cost') end),0) from session_message where time_created >= ${since};`]),
    await run("sqlite3", ["-readonly", db, `select coalesce(sum(json_extract(data,'$.role')='user'),0), coalesce(sum(case when json_extract(data,'$.role')='assistant' then ${tokens("data")} end),0), coalesce(sum(case when json_extract(data,'$.role')='assistant' then json_extract(data,'$.cost') end),0) from message where time_created >= ${since};`]),
  );
  if (!limits.length && !s.prompts && !s.tokens) return null;
  return u.usage({ plan: "OpenCode Go", limits, tokens: s.tokens, prompts: s.prompts, cost: s.cost });
}

async function readCopilot() {
  let { plan, limits } = (await live("copilot", u.NET_TTL, async () => {
    const token = u.copilotToken(
      await read(H(".config/github-copilot/hosts.json")),
      await read(H(".config/gh/hosts.yml")),
      await run("gh", ["auth", "token"]),
      await env("GITHUB_TOKEN"),
    );
    // Its plan and quotas, as the Copilot extension reads them.
    const ask = (scheme) => getJson("https://api.github.com/copilot_internal/user", {
      Authorization: `${scheme} ${token}`,
      Accept: "application/json",
      "Editor-Version": "vscode/1.90.0",
      "User-Agent": "GitHubCopilot/1.190.0",
    }).then(u.copilotUser);
    return token && ((await ask("token")) ?? (await ask("Bearer")));
  })) ?? { plan: null, limits: [] };
  if (!plan) ({ plan, limits } = u.genericCache(await cached("copilot"), "sku") ?? { plan, limits });
  limits = u.noSessionToken(limits);
  return plan || limits.length ? u.usage({ plan: plan ?? "Copilot", limits }) : null;
}

async function readCursor() {
  let { plan, limits } = (await live("cursor", u.NET_TTL, async () => {
    const token = u.cursorToken(await read(H(".cursor/auth.json")), await read(H(".cursor/credentials.json")));
    const auth = { Authorization: `Bearer ${token}` };
    return token && u.cursorParse((await getJson("https://authenticator.cursor.sh/api/usage", auth)) ?? (await getJson("https://api2.cursor.sh/auth/stripe", auth)));
  })) ?? { plan: null, limits: [] };
  if (!limits.length && !plan) ({ plan, limits } = u.genericCache(await cached("cursor"), "membershipType") ?? { plan, limits });
  return plan || limits.length ? u.usage({ plan: plan ?? "Cursor", limits }) : null;
}

/** An API key from its key file, else the app's environment. A JSON file without a key is none. */
async function apiKey(paths, name) {
  for (const path of paths) {
    const text = await read(H(path));
    if (text != null) return u.keyFrom(text);
  }
  return env(name);
}

async function readOpenrouter() {
  let r = await live("openrouter", u.NET_TTL, async () => {
    const key = await apiKey([".config/openrouter/key.txt", ".openrouter/auth.json"], "OPENROUTER_API_KEY");
    const auth = { Authorization: `Bearer ${key}` };
    return key && u.openrouterParse(await getJson("https://openrouter.ai/api/v1/auth/key", auth), await getJson("https://openrouter.ai/api/v1/credits", auth));
  });
  if (!r) r = u.genericCache(await cached("openrouter"));
  return r && (r.plan || r.limits.length) ? u.usage({ plan: r.plan ?? "OpenRouter", limits: r.limits, cost: r.cost }) : null;
}

async function readDeepseek() {
  let r = await live("deepseek", u.NET_TTL, async () => {
    const key = await apiKey([".config/deepseek/key.txt", ".deepseek/auth.json"], "DEEPSEEK_API_KEY");
    return key && u.deepseekParse(await getJson("https://api.deepseek.com/user/balance", { Authorization: `Bearer ${key}` }));
  });
  if (!r) r = u.genericCache(await cached("deepseek"));
  return r && (r.plan || r.limits.length) ? u.usage({ plan: r.plan ?? "DeepSeek", limits: r.limits }) : null;
}

// Amp's credit balances and today's tokens (UTC, as the other agents' days are), from `amp usage`.
async function readAmp() {
  return live("amp", u.AMP_LIVE_TTL, async () => {
    const day = new Date(`${u.todayUtc()}T00:00:00Z`);
    const next = new Date(day.getTime() + 86_400_000);
    const out = await run("amp", ["usage", "--start", day.toISOString().replace(/\.\d{3}Z$/, "Z"), "--end", next.toISOString().replace(/\.\d{3}Z$/, "Z")], 60_000);
    return u.ampParse(out);
  });
}

const READERS = {
  claude: readClaude, codex: readCodex, antigravity: readAntigravity, grok: readGrok, opencode: readOpencode,
  copilot: readCopilot, cursor: readCursor, openrouter: readOpenrouter, deepseek: readDeepseek, amp: readAmp,
};

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

/** The providers of the agents running now, in the agents' order: quotas are per account, not per agent. */
const providers = () => [...new Set(agents().map(provider).filter(Boolean))];

/** The popup's tabs: the running providers, then the other installed agents' (`installed`, { p, program }),
 *  dimmed, last run first, then in Herdr's order (most picked from its New menu). */
function tabsFor(installed) {
  const running = providers();
  const ran = shared(RAN) ?? {};
  return [
    ...running.map((p) => ({ p, program: agents().find((a) => provider(a) === p)?.program, dim: false })),
    ...installed.filter((x) => !running.includes(x.p)).sort((a, b) => (ran[b.p] ?? 0) - (ran[a.p] ?? 0)).map((x) => ({ ...x, dim: true })),
  ];
}

/** The layout block this mod sits in. It sizes it to its text, so it reads as part of the status bar. */
const BLOCK = "herdr-usage";

export default class Usage extends View {
  init(_props, cx) {
    this.sheetFor = props()?.sheet ?? null;
    if (checking()) return;
    if (this.sheetFor) return;
    // The installed agents' providers, for the popup's dimmed tabs, known before it opens so it can be sized
    // for them. Herdr checks at most once a minute.
    this.installed = [];
    const known = (cx) => cx.spawn(async () => {
      try {
        const seen = new Set();
        this.installed = (await knownAgents()).flatMap((k) => {
          const p = k.installed ? u.providerOf(k.key) ?? u.providerOf(k.name) : null;
          if (!p || seen.has(p)) return [];
          seen.add(p);
          return [{ p, program: { icon: k.icon, tint: k.tint } }];
        });
      } catch {}
    });
    known(cx);
    cx.timer.every(60_000, known);
    this.refresh(cx);
    cx.timer.every(5_000, (cx) => this.refresh(cx));
  }

  // Each running agent's provider, read again when its numbers are old; and noted as running, at most once a minute.
  refresh(cx) {
    const now = Date.now();
    const ran = shared(RAN) ?? {};
    const stale = providers().filter((p) => now - (ran[p] ?? 0) > 60_000);
    if (stale.length) setShared(RAN, { ...ran, ...Object.fromEntries(stale.map((p) => [p, now])) });
    for (const p of providers()) this.read(p, cx);
  }

  // Reads a provider when its numbers are over CACHE_TTL old and no read is under way. Rendering follows the shared state.
  read(p, cx) {
    const now = Date.now();
    if (now - (shared(KEY)?.[p]?.at ?? 0) < u.CACHE_TTL) return;
    if (now - (shared(READING)?.[p] ?? 0) < READ_TIMEOUT) return;
    setShared(READING, { ...shared(READING), [p]: now });
    cx.spawn(async () => {
      let fresh = null;
      try {
        fresh = await READERS[p]();
      } catch (e) {
        console.log(`herdr-usage: ${p}: ${e}`);
      }
      const all = shared(KEY) ?? {};
      setShared(KEY, { ...all, [p]: u.merge(all[p], fresh) });
      setShared(READING, { ...shared(READING), [p]: 0 });
    });
  }

  render() {
    const t = theme();
    if (this.sheetFor) return this.sheet(t);
    // One group per provider, "Claude 5h 75% · 7d 19%": the share left, coloured by the share used; a balance as its amount.
    const groups = providers().map((p, gi) => {
      const limits = u.onBar(u.shown(shared(KEY)?.[p], p)?.limits);
      const pic = icon(agents().find((a) => provider(a) === p)?.program, 13, t.muted);
      const parts = limits.flatMap((l, i) => {
        const used = Math.min(Math.max(l.percent, 0), 1);
        return [
          ...(i ? [div().text_color(t.dim).child("·")] : []),
          h_flex().gap(4).child(div().child(u.shortLabel(l.label)))
            .child(div().font_semibold().text_color(l.title ? t.foreground : t[u.tone(used)] ?? t.muted).child(l.title ?? `${Math.round((1 - used) * 100)}%`)),
        ];
      });
      return h_flex()
        .id(`usage-${p}`)
        .h(22)
        .px(6)
        .gap(6)
        .flex_none()
        .items_center()
        .rounded(5)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(`${u.NAMES[p]}: quota left; click for details`)
        .on_click(() => this.open(p))
        .when(gi > 0, (el) => el.ml(6))
        // The agent's icon, as herdr-mobile shows it; its name only when it has none.
        .child(pic ?? div().text_color(t.foreground).child(u.NAMES[p]))
        .when(!parts.length, (el) => el.child(div().text_color(t.dim).child("–")))
        .children(parts);
    });
    // Drawn as part of Herdr's status bar: its background, top border and text, after a divider.
    return h_flex().id("usage").size_full().items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(h_flex()
        .id("usage-groups")
        .flex_none()
        .h_full()
        .pl(8)
        .pr(8)
        .items_center()
        .when(groups.length > 0, (el) => el.border_l(1).border_color(t.border))
        .children(groups)
        .on_size_change((size, cx) => this.fit(size.width, cx)));
  }

  // The block takes the groups' width, so no gap opens beside them. Only on a real change: resizing saves the layout.
  // The size comes zoomed and the layout zooms its px again, so it's divided by the zoom.
  fit(width, cx) {
    const px = Math.ceil(width / (Number(settings().zoom) || 1));
    if (Math.abs(px - (this.width ?? 0)) < 2) return;
    this.width = px;
    runCommand("layout.resize", { id: BLOCK, px: Math.max(px, 1) });
    cx.notify();
  }

  // The popup on provider p's tab, sized for the tab that shows the most rows, so no tab scrolls or is cut off.
  // Every part has a fixed height: 5px padding twice, the 24px title, 36px rows, today's line (a 9px divider and
  // 28px) and, with several tabs, the tab row (a 9px divider and 31px).
  open(p) {
    const tabs = tabsFor(this.installed);
    const rows = Math.max(...tabs.map((x) => u.ROWS[x.p] ?? 1), u.ROWS[p] ?? 1);
    const height = 10 + 24 + 36 * rows + 37 + (tabs.length > 1 ? 40 : 0);
    openOverlay({ mod: "herdr-usage", kind: "popup", width: 280, height, props: { sheet: p, installed: this.installed } });
  }

  sheet(t) {
    const p = this.sheetFor;
    const entry = shared(KEY)?.[p];
    const us = u.shown(entry, p);
    const tabs = tabsFor(props()?.installed ?? []);
    // Primary limits first, then Antigravity's Claude and GPT tiers as one row. No more than its ROWS, which the
    // popup was sized for.
    const other = u.otherModels((us?.limits ?? []).filter((l) => l.primary === false));
    const limits = [...u.primary(us?.limits).slice(0, (u.ROWS[p] ?? 1) - (other ? 1 : 0)), ...(other ? [other] : [])];
    const note = (text) => h_flex().h(36).px(8).items_center().text_color(t.dim).child(div().min_w(0).truncate().child(text));
    const divider = () => div().mx(7).my(4).h(1).flex_none().bg(t.border);
    // A limit, 36px: its label, its detail ("12 of 300") and when it resets, and the share left, on one line; a
    // 3px bar of the share left under it, draining as it's used. A balance (a `title`, no share) is the line alone.
    const row = (l) => {
      const used = Math.min(Math.max(l.percent, 0), 1);
      const color = t[u.tone(used)] ?? t.muted;
      const detail = [l.detail, l.resets_at && `resets ${u.resetsIn(l.resets_at)}`].filter(Boolean).join(" · ");
      const line = h_flex().gap(8).items_center()
        .child(div().min_w(0).truncate().text_color(t.foreground).child(u.longLabel(l.label)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail))
        .child(l.title
          ? div().flex_none().text_color(t.muted).child(l.title)
          // "62% left": the share in its colour, the word small and dim, so it reads plainly in little room.
          : h_flex().flex_none().gap(3).items_baseline()
            .child(div().text_color(color).child(`${Math.round((1 - used) * 100)}%`))
            .child(div().text_size(11).text_color(t.dim).child("left")));
      return v_flex().h(36).px(8).gap(5).justify_center().flex_none().child(line)
        .when(!l.title, (el) => el.child(div().w_full().h(3).rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(color).w(`${Math.round((1 - used) * 100)}%`))));
    };
    const today = [
      us?.today_tokens != null && `${u.formatTokens(us.today_tokens)} tokens`,
      us?.today_prompts != null && `${us.today_prompts} prompts`,
      us?.today_cost > 0 && `$${us.today_cost.toFixed(2)}`,
    ].filter(Boolean);
    return v_flex()
      .size_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      // The provider and its plan, as Herdr's popups title themselves.
      .child(h_flex().h(24).px(8).gap(8).items_center().flex_none()
        .child(div().text_size(11).text_color(t.dim).child(u.NAMES[p] ?? p))
        .when(Boolean(us?.tier_label), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`· ${us.tier_label}`))))
      .child(v_flex().flex_1().min_h(0)
        .when(!entry, (el) => el.child(note("Reading…")))
        .when(Boolean(entry) && !us, (el) => el.child(note("Not signed in, or the login expired.")))
        .when(Boolean(us) && !limits.length, (el) => el.child(note("No rate limits recorded.")))
        .children(limits.map(row))
        .when(today.length > 0, (el) => el.child(divider()).child(h_flex().px(8).h(28).items_center().text_size(11).text_color(t.dim).child(`Today: ${today.join(" · ")}`))))
      // One tab per provider, at the bottom: the running ones, then the other installed agents', dimmed.
      .when(tabs.length > 1, (el) => el.child(divider()).child(h_flex().gap(2).flex_none()
        .children(tabs.map((x) => h_flex()
          .id(`tab-${x.p}`)
          .h(31)
          .min_w(31)
          .px(8)
          .justify_center()
          .items_center()
          .rounded(7)
          .when(x.p === p, (el) => el.bg(t.selected))
          .when(x.p !== p, (el) => el.hover((s) => s.bg(t.hover)))
          .tooltip(x.dim ? `${u.NAMES[x.p]} (not running)` : u.NAMES[x.p])
          .on_click((_e, cx) => {
            this.sheetFor = x.p;
            this.read(x.p, cx);
            cx.notify();
          })
          .child(div().when(x.dim && x.p !== p, (el) => el.opacity(0.4))
            .child(icon(x.program, 14, x.p === p ? t.foreground : t.muted) ?? div().text_size(11).text_color(t.muted).child(u.NAMES[x.p])))))));
  }
}
