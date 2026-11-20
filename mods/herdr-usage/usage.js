// What an agent's account has used: rate limits from the provider, and today's tokens and prompts
// from its own transcripts. Ported from herdr-bridge's usage.rs. Nothing here imports Herdr, so
// `node --test` covers it; main.js does the reading and passes the text in.

/** Read an agent again after this long. */
export const CACHE_TTL = 30_000;
/** Limits older than this aren't shown: a provider that stops answering keeps its last ones only so long. */
export const STALE = 180_000;
/** Anthropic's usage endpoint answers about once every two minutes; asking more only draws 429s. */
export const CLAUDE_LIVE_TTL = 120_000;
/** Transcripts last written before this many minutes ago hold nothing from today. */
export const RECENT_MINUTES = 26 * 60;

/** `agy` starts every MCP server it's configured with, and `amp usage` is slow: read them this rarely. */
export const AGY_LIVE_TTL = 300_000;
export const AMP_LIVE_TTL = 300_000;
/** The other providers' usage endpoints: asked this rarely, since some are private and some mint a token per call. */
export const NET_TTL = 300_000;

/** The provider an agent's name or app belongs to, or null. In usage.rs's order. */
export function providerOf(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("claude") || n.includes("anthropic")) return "claude";
  if (n.includes("codex") || n.includes("openai") || n.includes("gpt")) return "codex";
  if (n === "agy" || n.includes("antigravity") || n.includes("gemini")) return "antigravity";
  if (n.includes("grok")) return "grok";
  if (n.includes("opencode")) return "opencode";
  if (n.includes("copilot") || n.includes("github")) return "copilot";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("openrouter")) return "openrouter";
  if (n.includes("deepseek")) return "deepseek";
  if (n === "amp" || n.startsWith("amp-")) return "amp";
  return null;
}

/** The most rows each provider's popup tab shows, so the popup (which can't be resized once open) is sized
 *  for every tab and never scrolls. From what each reader returns: Claude's 5-hour, weekly and extra usage;
 *  Codex's two windows and credits; Antigravity's 5-hour and weekly buckets for Gemini, and its Claude and
 *  GPT tiers as one row; OpenCode's 5-hour, weekly and monthly; Copilot's premium requests, chat
 *  and completions; OpenRouter's credit limit and balance; DeepSeek's two currencies (CNY, USD). Amp's
 *  refilling pools are open-ended: the popup shows its first two. */
export const ROWS = { claude: 3, codex: 3, antigravity: 3, grok: 1, opencode: 3, copilot: 3, cursor: 1, openrouter: 2, deepseek: 2, amp: 2 };

/** Each provider's name in the status bar and the popup. */
export const NAMES = {
  claude: "Claude", codex: "Codex", antigravity: "Antigravity", grok: "Grok", opencode: "OpenCode",
  copilot: "Copilot", cursor: "Cursor", openrouter: "OpenRouter", deepseek: "DeepSeek", amp: "Amp",
};

/** Other tools' usage files a provider's numbers may be in (ai-usagebar, Omarchy), by name. */
export const CACHE_NAMES = {
  claude: ["anthropic", "claude"],
  codex: ["openai", "codex"],
  antigravity: ["antigravity", "gemini"],
  grok: ["supergrok", "grok"],
  opencode: ["opencode-go", "opencode"],
  copilot: ["copilot", "github-copilot"],
  cursor: ["cursor"],
  openrouter: ["openrouter"],
  deepseek: ["deepseek"],
};
export const CACHE_DIRS = [".cache/ai-usagebar", ".local/state/omarchy/agents/usage", ".local/state/herdr/usage"];

/** A key file's key: `{ "key": … }`, or the file's text itself. */
export function keyFrom(text) {
  if (text == null) return null;
  const json = parse(text);
  if (json && typeof json === "object") return typeof json.key === "string" ? json.key : null;
  return text.trim() || null;
}

/** Today in UTC, as `YYYY-MM-DD`: the transcripts' timestamps are UTC. */
export const todayUtc = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const iso = (secs) => new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const parse = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

// --- Claude Code ---------------------------------------------------------------------------

/** Today's tokens, prompts and latest model from Claude Code transcript lines. */
export function claudeStats(lines, today) {
  let tokens = 0, prompts = 0, model = null, modelAt = "";
  const seen = new Set();
  for (const line of lines) {
    const entry = parse(line);
    const time = entry?.timestamp ?? "";
    if (!time.startsWith(today)) continue;
    const message = entry.message ?? {};
    if (entry.type === "user") {
      // What was typed: a string, or blocks (text, a pasted image), not a tool's result.
      const c = message.content;
      if (entry.isMeta !== true && (typeof c === "string" || (Array.isArray(c) && c.length && c.every((b) => b?.type !== "tool_result")))) prompts++;
    } else if (entry.type === "assistant") {
      const id = message.id ?? "";
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const u = message.usage ?? {};
      tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      const m = message.model;
      if (typeof m === "string" && !m.startsWith("<") && (model === null || modelAt < time)) {
        model = m;
        modelAt = time;
      }
    }
  }
  return { tokens, prompts, model };
}

/** The OAuth token and plan in `~/.claude/.credentials.json`, or null. */
export function claudeLogin(text) {
  const creds = parse(text ?? "");
  const oauth = creds?.claudeAiOauth ?? creds;
  if (typeof oauth?.accessToken !== "string") return null;
  // "team" in today's logins, "claude_team" in older ones: show the plan, not the raw word.
  const raw = oauth.subscriptionType ?? oauth.rateLimitTier;
  const plan = typeof raw === "string" ? capital(raw.replace(/^claude_/, "")) || null : null;
  return { token: oauth.accessToken, plan };
}

/** Limits from Anthropic's usage endpoint, or null when it didn't answer with any (e.g. rate_limit_error). */
export function claudeLimits(resp) {
  const limits = [];
  for (const [key, label] of [["five_hour", "Session (5-hour)"], ["seven_day", "Weekly (7-day)"]]) {
    const used = resp?.[key]?.utilization;
    if (typeof used === "number") limits.push({ label, percent: used / 100, resets_at: resp[key].resets_at ?? null });
  }
  if (!limits.length && Array.isArray(resp?.limits)) {
    for (const item of resp.limits) {
      if (typeof item?.percent !== "number") continue;
      const label = String(item.kind ?? "").includes("session") ? "Session (5-hour)" : "Weekly (7-day)";
      limits.push({ label, percent: item.percent / 100, resets_at: item.resets_at ?? null });
    }
  }
  return limits.length ? limits : null;
}

/** Claude's extra usage (paying past the limits), when it's on: popup only, not the bar. Amounts come in minor
 *  units, `decimal_places` of them. */
export function claudeExtra(resp) {
  const x = resp?.extra_usage;
  if (x?.is_enabled !== true) return null;
  const places = Number.isInteger(x.decimal_places) ? x.decimal_places : 2;
  const money = (n) => `${(n / 10 ** places).toFixed(places)} ${x.currency ?? "USD"}`;
  const used = typeof x.used_credits === "number" ? x.used_credits : 0;
  const percent = typeof x.utilization === "number" ? x.utilization / 100 : x.monthly_limit > 0 ? used / x.monthly_limit : null;
  if (percent === null) return { label: "Extra usage", percent: 0, title: `${money(used)} used`, bar: false };
  return { label: "Extra usage", percent, detail: x.monthly_limit > 0 ? `${money(used)} of ${money(x.monthly_limit)}` : null, bar: false };
}

// --- Codex ---------------------------------------------------------------------------------

/** Today's tokens and prompts, the latest model and the rate limits its logs last recorded, from
 *  `{ file, line }` pairs of Codex session logs. A session's tokens are its last total of today. */
export function codexStats(entries, today) {
  let prompts = 0, model = null, modelAt = "", logLimits = null, limitsAt = "";
  const sessions = new Map();
  for (const { file, line } of entries) {
    const entry = parse(line);
    if (!entry) continue;
    const time = String(entry.timestamp ?? "");
    const p = entry.payload ?? {};
    if (entry.type === "event_msg" && p.type === "token_count") {
      const total = p.info?.total_token_usage?.total_tokens;
      if (typeof total === "number" && time.startsWith(today)) sessions.set(file, total);
      if (p.rate_limits && typeof p.rate_limits === "object" && (logLimits === null || limitsAt < time)) {
        logLimits = p.rate_limits;
        limitsAt = time;
      }
    } else if (entry.type === "event_msg" && p.type === "user_message" && time.startsWith(today)) {
      prompts++;
    } else if (entry.type === "turn_context" && typeof p.model === "string" && (model === null || modelAt < time)) {
      model = p.model;
      modelAt = time;
    }
  }
  let tokens = 0;
  for (const t of sessions.values()) tokens += t;
  return { tokens, prompts, model, logLimits };
}

/** The token and account in `~/.codex/auth.json`, or null. */
export function codexLogin(text) {
  const t = parse(text ?? "")?.tokens;
  return typeof t?.access_token === "string" ? { token: t.access_token, account: t.account_id ?? "" } : null;
}

/** Codex's usage endpoint's answer as its plan and its windows in the shape its logs record, or null. */
export function codexLive(resp) {
  const rl = resp?.rate_limit;
  if (!rl || typeof rl !== "object") return null;
  const window = (w) => ({
    used_percent: w?.used_percent,
    window_minutes: typeof w?.limit_window_seconds === "number" ? Math.floor(w.limit_window_seconds / 60) : undefined,
    resets_at: w?.reset_at,
  });
  const plan = typeof resp.plan_type === "string" ? capital(resp.plan_type) : null;
  return { plan, windows: { primary: window(rl.primary_window), secondary: window(rl.secondary_window) }, credits: resp.credits ?? null, reset: codexReset(resp) };
}

/** Codex's credits (from its usage endpoint or its logs), when it has any: popup only, not the bar. */
export function codexCredits(c) {
  if (c?.has_credits !== true) return null;
  return { label: "Credits", percent: 0, title: c.unlimited === true ? "Unlimited" : `${c.balance ?? 0} left`, bar: false };
}

/** Codex's windows as limits. */
export function codexLimits(windows, now = Date.now()) {
  const limits = [];
  for (const key of ["primary", "secondary"]) {
    const w = windows?.[key];
    if (typeof w?.used_percent !== "number") continue;
    const m = w.window_minutes;
    const label = m === 10080 ? "Weekly (7-day)" : m === 43200 ? "Monthly" : typeof m !== "number" ? "Rate limit"
      : m % 60 === 0 ? `${m / 60}-hour window` : `${m}-minute window`;
    const resets_at = typeof w.resets_at === "number" ? iso(w.resets_at)
      : typeof w.resets_in_seconds === "number" ? iso(Math.floor(now / 1000) + w.resets_in_seconds) : null;
    limits.push({ label, percent: w.used_percent / 100, resets_at });
  }
  return limits;
}

/** Claude's or Codex's limits from another tool's usage file. */
export function claudeCache(json) {
  if (!json) return null;
  const limits = (Array.isArray(json.limits) ? json.limits : []).map((l) =>
    l.label ? l : { ...l, label: String(l.kind ?? "").includes("session") ? "Session (5-hour)" : "Weekly (7-day)" });
  return { plan: json.tierLabel ?? json.tier_label ?? null, limits };
}
export const codexCache = (json) => json && { plan: json.tierLabel ?? json.plan_type ?? null, limits: Array.isArray(json.limits) ? json.limits : [] };

// --- Antigravity / Gemini CLI --------------------------------------------------------------

/** The model a `Model Selection` change in an Antigravity prompt switched to, or null. */
export function antigravityModel(content) {
  const pos = String(content ?? "").indexOf("Model Selection` from ");
  if (pos < 0) return null;
  const rest = content.slice(pos + 22);
  const to = rest.indexOf(" to ");
  if (to < 0) return null;
  const after = rest.slice(to + 4);
  const end = [". No need", "</", "\n"].map((s) => after.indexOf(s)).find((i) => i >= 0);
  const m = (end === undefined ? after : after.slice(0, end)).trim().replace(/\.+$/, "");
  return m || null;
}

/** Today's tokens, prompts and model from Antigravity CLI brain transcripts and Gemini CLI chats. */
export function antigravityStats(brainLines, geminiLines, today) {
  let tokens = 0, prompts = 0, model = null, modelAt = "";
  const pick = (m, time) => {
    if (m && (model === null || modelAt < time)) {
      model = m;
      modelAt = time;
    }
  };
  for (const line of brainLines) {
    const step = parse(line);
    const time = step?.created_at ?? "";
    if (!time.startsWith(today)) continue;
    if (step.type === "USER_INPUT") {
      prompts++;
      pick(antigravityModel(step.content), time);
    }
    tokens += (step.input_tokens ?? 0) + (step.output_tokens ?? 0) + (step.cache_read_tokens ?? 0);
  }
  for (const line of geminiLines) {
    const entry = parse(line);
    const time = entry?.timestamp ?? "";
    if (!time.startsWith(today)) continue;
    if (entry.type === "user") prompts++;
    else if (entry.type === "gemini") {
      const t = entry.tokens ?? {};
      tokens += (t.input ?? 0) + (t.output ?? 0) + (t.thoughts ?? 0);
      pick(typeof entry.model === "string" ? entry.model : null, time);
    }
  }
  return { tokens, prompts, model };
}

/** A non-Gemini Antigravity bucket (the Claude / GPT tiers sharing the plan): listed, never the headline. */
export const antigravityIsSecondary = (text) => ["claude", "anthropic", "gpt", "openai", "codex"].some((m) => String(text).toLowerCase().includes(m));

/** Limits from `agy -p /usage --output-format json`: the 5-hour bucket before the weekly one. */
export function antigravityProbe(data) {
  const limits = [];
  for (const g of data?.command?.data?.groups ?? []) {
    const group = g?.name ?? "";
    const order = (b) => (b?.window === "5h" ? 0 : b?.window === "weekly" ? 1 : 2);
    for (const b of [...(g?.buckets ?? [])].sort((a, b) => order(a) - order(b))) {
      const used = Math.min(Math.max(1 - (b.remaining_fraction ?? 1), 0), 1);
      const name = b.name ?? "Limit";
      const label = group === "Gemini Models"
        ? b.window === "5h" ? "Session (5-hour)" : b.window === "weekly" ? "Weekly (7-day)" : name
        : group ? `${group} ${name}` : name;
      limits.push({ label, percent: Math.round(used * 100) / 100, resets_at: b.reset_time ?? null, primary: !antigravityIsSecondary(`${group} ${name}`) });
    }
  }
  return limits;
}

/** Backfills `primary` on limits that lack it (another tool's usage file), from their label. */
export const tagPrimary = (limits) => limits.map((l) => ("primary" in l ? l : { ...l, primary: !antigravityIsSecondary(l.label ?? "") }));

// --- Grok ----------------------------------------------------------------------------------

/** Today's tokens, prompts and model from Grok's `updates.jsonl` turn_completed lines. */
export function grokStats(lines, today) {
  let tokens = 0, prompts = 0, model = null, modelAt = "";
  for (const line of lines) {
    const entry = parse(line);
    const time = entry?.timestamp ?? "";
    if (!time.startsWith(today)) continue;
    const usage = (entry.params?.update ?? entry).usage;
    if (!usage || typeof usage !== "object") continue;
    prompts++;
    tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    for (const name of Object.keys(usage.modelUsage ?? {})) {
      if (model === null || modelAt < time) {
        model = name;
        modelAt = time;
      }
    }
  }
  return { tokens, prompts, model };
}

/** Grok's OAuth login in `~/.grok/auth.json`: never an API key, which the billing endpoint doesn't take. */
export function grokLogin(text) {
  const map = parse(text ?? "");
  if (!map || typeof map !== "object") return null;
  const entry = Object.values(map).find((e) => ["oidc", "oauth", ""].includes(e?.auth_mode ?? ""));
  const key = entry?.key;
  if (typeof key !== "string" || !key || key.startsWith("sk-") || key.startsWith("xai-")) return null;
  return { key, userId: entry.user_id ?? "" };
}

/** Grok's billing endpoint's answer as its plan and weekly limit. */
export function grokBilling(resp) {
  if (!resp || typeof resp !== "object") return null;
  const limits = typeof resp.creditUsagePercent === "number"
    ? [{ label: "Weekly SuperGrok Limit", percent: resp.creditUsagePercent / 100, resets_at: resp.currentPeriod?.end ?? resp.billingPeriodEnd ?? null }]
    : [];
  return { plan: resp.plan ?? resp.tier ?? null, limits };
}

/** The plan Grok's settings cache names. */
export const grokTier = (text) => parse(parse(text ?? "")?.payload ?? "")?.settings?.subscription_tier_display ?? null;

/** Grok's plan and limits from another tool's usage file. */
export function grokCache(json) {
  if (!json) return null;
  const snap = json.snapshot;
  const limits = Array.isArray(json.limits) ? json.limits
    : typeof snap?.percent === "number" ? [{ label: "Weekly SuperGrok Limit", percent: snap.percent / 100, resets_at: snap.reset_at ?? null }] : [];
  return { plan: json.tierLabel ?? snap?.plan ?? null, limits };
}

// --- OpenCode Go ---------------------------------------------------------------------------

/** Today's prompts, tokens and cost from OpenCode's database: sqlite3's `prompts|tokens|cost` line for each of
 *  its message tables (v2's session_message, v1's message). Tokens as Claude's are counted: input, output,
 *  reasoning and cache writes. */
export function opencodeStats(...outputs) {
  let prompts = 0, tokens = 0, cost = 0;
  for (const out of outputs) {
    const [p, t, c] = String(out ?? "").trim().split("|").map(Number);
    if (Number.isFinite(p)) prompts += p;
    if (Number.isFinite(t)) tokens += t;
    if (Number.isFinite(c)) cost += c;
  }
  return { prompts, tokens, cost };
}

/** OpenCode Go's key: OpenCode v2's active credential (sqlite3's output), else the older auth file. */
export function opencodeKey(dbOut, authText) {
  const key = parse(dbOut ?? "")?.key;
  return typeof key === "string" ? key : parse(authText ?? "")?.["opencode-go"]?.key ?? null;
}

/** The three windows of `GET /zen/go/v1/usage`: a rolling 5-hour, a weekly and a monthly budget. A window the
 *  provider calls `rate-limited` says so on its row. */
export function opencodeLimits(usage) {
  return [["rolling", "5-hour"], ["weekly", "Weekly"], ["monthly", "Monthly"]].flatMap(([key, label]) => {
    const w = usage?.[key];
    if (typeof w?.percent !== "number") return [];
    return [{ label, percent: w.percent / 100, resets_at: w.resetsAt ?? null, ...(w.status && w.status !== "ok" && { status: w.status }) }];
  });
}

// --- Copilot, Cursor, OpenRouter, DeepSeek -------------------------------------------------

/** A GitHub token: Copilot's hosts.json, gh's hosts.yml, `gh auth token`, or $GITHUB_TOKEN. */
export function copilotToken(hostsJson, ghHostsYml, ghToken, env) {
  const t = parse(hostsJson ?? "")?.["github.com"]?.oauth_token;
  if (typeof t === "string") return t;
  for (const line of String(ghHostsYml ?? "").split("\n")) {
    const m = /^\s*oauth_token:\s*(\S+)/.exec(line);
    if (m) return m[1];
  }
  return String(ghToken ?? "").trim() || String(env ?? "").trim() || null;
}

/** Copilot's plan and quotas from `copilot_internal/user`: premium requests, and chat and completions where
 *  the plan limits them (Free). An unlimited quota isn't a limit, nor one the plan doesn't include (Free's
 *  premium requests: `entitlement` 0, `has_quota` false). */
export function copilotUser(resp) {
  if (!resp || typeof resp !== "object" || (!resp.copilot_plan && !resp.quota_snapshots)) return null;
  const resets_at = resp.quota_reset_date_utc ?? resp.quota_reset_date ?? null;
  const limits = [["premium_interactions", "Premium requests"], ["chat", "Chat"], ["completions", "Completions"]].flatMap(([key, label]) => {
    const q = resp.quota_snapshots?.[key];
    if (!q || q.unlimited === true || q.has_quota === false || q.entitlement === 0 || typeof q.percent_remaining !== "number") return [];
    const detail = q.entitlement > 0 && typeof q.remaining === "number" ? `${Math.round(q.remaining)} of ${q.entitlement}` : null;
    return [{ label, percent: Math.min(Math.max(1 - q.percent_remaining / 100, 0), 1), resets_at, detail }];
  });
  // The sku says Free ("free_limited_copilot") where the plan says "individual".
  const plan = /free/.test(resp.access_type_sku ?? "") ? "free" : resp.copilot_plan;
  return { plan: typeof plan === "string" ? `Copilot ${capital(plan)}` : "Copilot", limits };
}
// --- Limit resets (Claude, Codex) ----------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "22 Oct", in UTC as the agents' days are: by hand, since Herdr's runtime has no Intl. */
const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** The usage-limit resets Claude offers (its "one usage-limit reset" campaigns), with how many are left and
 *  the earliest expiry, or null. Anthropic keeps them under a codename, `cedar_ember`, one grant per campaign. */
export function claudeReset(resp, now = Date.now()) {
  const grants = resp?.cedar_ember?.grants;
  if (!Array.isArray(grants)) return null;
  const live = grants.filter((g) => typeof g?.resets_left === "number" && g.resets_left > 0
    && (!g.ends_at || Date.parse(g.ends_at) > now));
  if (!live.length) return null;
  const ends = live.map((g) => Date.parse(g.ends_at)).filter(Number.isFinite);
  return { count: live.reduce((n, g) => n + g.resets_left, 0), until: ends.length ? new Date(Math.min(...ends)).toISOString() : null };
}

/** The manual rate-limit resets Codex has left (`rate_limit_reset_credits`), or null. */
export function codexReset(resp) {
  const n = resp?.rate_limit_reset_credits?.available_count;
  return typeof n === "number" && n > 0 ? { count: n } : null;
}

/** A reset line for the popup: "1 limit reset available · expires 22 Oct", or null. */
export function resetNote(reset) {
  if (!reset?.count) return null;
  const until = reset.until && day(reset.until);
  return `${reset.count} limit reset${reset.count === 1 ? "" : "s"} available${until ? ` · expires ${until}` : ""}`;
}

/** Another tool's usage file may list the token's expiry, which usage.rs called a "Session Token" limit: not a quota. */
export const noSessionToken = (limits) => (limits ?? []).filter((l) => l.label !== "Session Token");

/** Cursor's token from its auth files' texts. */
export function cursorToken(...texts) {
  for (const text of texts) {
    const v = parse(text ?? "");
    const t = v?.accessToken ?? v?.token;
    if (typeof t === "string") return t;
  }
  return null;
}

const MEMBERSHIPS = { pro: "Cursor Pro", business: "Cursor Business", hobby: "Cursor Hobby" };
/** Cursor's usage endpoint's answer: its plan, and its fast requests this month. */
export function cursorParse(resp) {
  const m = resp?.membershipType ?? resp?.plan;
  const plan = typeof m === "string" ? MEMBERSHIPS[m.toLowerCase()] ?? m : null;
  const fast = resp?.fastRequests ?? resp?.gpt4Usage;
  const limits = typeof fast?.numRequests === "number" && fast.maxRequestUsage > 0
    ? [{ label: "Fast Requests", percent: Math.min(Math.max(fast.numRequests / fast.maxRequestUsage, 0), 1), resets_at: resp.startOfMonth ?? null }]
    : [];
  return { plan, limits };
}

/** OpenRouter's key endpoint's answer (its credit limit, today's spend) and `/credits` (the balance). */
export function openrouterParse(resp, credits) {
  const data = resp?.data;
  if (!data) return null;
  const used = data.usage ?? 0;
  const limits = data.limit > 0 ? [{ label: "Credit Limit", percent: Math.min(Math.max(used / data.limit, 0), 1), detail: `$${used.toFixed(2)} of $${data.limit.toFixed(2)}` }]
    : data.is_free_tier === true ? [{ label: "Free Tier", percent: 0 }] : [];
  // The account's balance (`/credits`): for pay-as-you-go, the money left is the limit.
  const c = credits?.data;
  if (typeof c?.total_credits === "number" && typeof c.total_usage === "number") {
    limits.push({ label: "Balance", percent: 0, title: `$${(c.total_credits - c.total_usage).toFixed(2)}` });
  }
  // Not the key's `label`: it's often the key itself, shortened ("sk-or-v1-0e6…").
  return { plan: "OpenRouter", limits, cost: typeof data.usage_daily === "number" ? data.usage_daily : null,
    ...(typeof data.usage_weekly === "number" && { week: data.usage_weekly }),
    ...(typeof data.usage_monthly === "number" && { month: data.usage_monthly }) };
}

/** DeepSeek's balance: shown as a `title`, since a balance has no share used. */
export function deepseekParse(resp) {
  if (!resp || typeof resp !== "object") return null;
  const limits = (resp.balance_infos ?? []).map((b) => {
    const curr = b.currency ?? "USD";
    // Granted credit is spent first and may expire; topped-up is what was paid.
    const detail = b.granted_balance != null && b.topped_up_balance != null ? `${b.granted_balance} granted · ${b.topped_up_balance} paid` : null;
    return { label: `Balance (${curr})`, percent: 0, title: `${b.total_balance ?? "0"} ${curr}`, detail };
  });
  return { plan: "DeepSeek API", limits };
}

/** Another tool's usage file for Copilot, Cursor, OpenRouter or DeepSeek: its plan under `alt`. */
export const genericCache = (json, alt) => json && { plan: json.tierLabel ?? (alt ? json[alt] : null) ?? null, limits: Array.isArray(json.limits) ? json.limits : [] };

// --- Amp -----------------------------------------------------------------------------------

/** `amp usage`'s Markdown: a `**<pool>:** $<left> remaining` line per balance (`$<left>/$<total>` for one
 *  that refills, which makes it a limit), then `Total tokens:` and `Total recorded cost:`. A balance with
 *  no total has no share, so it goes in the plan. Amp records no prompts: unknown, not zero. */
export function ampParse(text) {
  const dollars = (s) => {
    const m = /^\$([\d,.]+)$/.exec(s.trim());
    return m ? Number(m[1].replaceAll(",", "")) : null;
  };
  const limits = [], balances = [];
  let tokens = null, cost = null;
  for (const line of String(text ?? "").split("\n")) {
    const pool = /^\*\*(.+?):\*\*(.*?) remaining/.exec(line);
    if (pool) {
      const amount = pool[2].trim();
      const [left, total] = amount.split("/").map(dollars);
      if (amount.includes("/") && left != null && total > 0) limits.push({ label: pool[1], percent: Math.min(Math.max(1 - left / total, 0), 1) });
      else balances.push(`${pool[1]}: ${amount} left`);
    } else if (line.startsWith("Total tokens:")) {
      const n = Number(line.slice(13).trim().replaceAll(",", ""));
      if (Number.isFinite(n)) tokens = n;
    } else if (line.startsWith("Total recorded cost:")) {
      cost = line.slice(20).trim();
    }
  }
  if (!limits.length && !balances.length && tokens === null) return null;
  const spent = cost ? Number(cost.replace(/[$,]/g, "")) : NaN;
  return { tier_label: balances.join(" · ") || "Amp", limits, today_tokens: tokens ?? 0, ...(spent > 0 && { today_cost: spent }) };
}

// --- All -----------------------------------------------------------------------------------

/** One agent's usage, or null when there is nothing to say. Tokens and prompts only where known. */
export function usage({ plan, model, limits, tokens, prompts, cost, week, month, reset }) {
  if (!tokens && !prompts && !limits?.length && !plan && !model) return null;
  const reset_note = resetNote(reset);
  return {
    tier_label: plan ?? model ?? null,
    limits: limits ?? [],
    ...(reset_note && { reset_note }),
    ...(tokens != null && { today_tokens: tokens }),
    ...(prompts != null && { today_prompts: prompts }),
    // Dollars spent today, where the source records it and it's more than nothing (subscriptions record 0).
    ...(cost > 0 && { today_cost: cost }),
    // OpenRouter's spend this week and this month, beside today's.
    ...(week > 0 && { week_cost: week }),
    ...(month > 0 && { month_cost: month }),
  };
}

/** A new read merged with the cached entry `{ at, usage, limitsAt }`: a provider that didn't answer
 *  keeps its last limits (and when they were read). */
export function merge(old, fresh, now = Date.now()) {
  const has = (u) => Boolean(u?.limits?.length);
  if (has(fresh)) return { at: now, usage: fresh, limitsAt: now };
  if (old?.limitsAt && has(old.usage)) {
    return { at: now, usage: fresh ? { ...fresh, limits: old.usage.limits } : old.usage, limitsAt: old.limitsAt };
  }
  return { at: now, usage: fresh, limitsAt: null };
}

/** The cached usage as it may be shown now: limits read too long ago, whose window has reset since, or
 *  without a number, aren't known. Claude's stand until their windows reset, since its endpoint often refuses a read. */
export function shown(entry, provider, now = Date.now()) {
  if (!entry?.usage) return null;
  let limits = entry.usage.limits ?? [];
  if (provider !== "claude" && (!entry.limitsAt || now - entry.limitsAt >= STALE)) limits = [];
  limits = limits.filter((l) => Number.isFinite(l.percent) && !(typeof l.resets_at === "string" && Date.parse(l.resets_at) < now));
  return { ...entry.usage, limits };
}

/** The limits that make the headline: all but Antigravity's secondary tiers. */
export const primary = (limits) => (limits ?? []).filter((l) => l.primary !== false);
/** The limits on the status bar: the headline ones, but not extra usage or credits, which only matter in the popup. */
export const onBar = (limits) => primary(limits).filter((l) => l.bar !== false);

/** The highest share used among the primary limits, or null. */
export function highestPercent(limits) {
  const counted = primary(limits);
  return counted.length ? Math.max(...counted.map((l) => Math.min(Math.max(l.percent, 0), 1))) : null;
}

/** A limit's label for the status bar: "5h", "7d", "30d", or the label itself. */
export function shortLabel(label) {
  const s = String(label ?? "");
  if (/5[- ]?h(our)?\b/i.test(s)) return "5h";
  if (/weekly|7-day/i.test(s)) return "7d";
  if (/monthly/i.test(s)) return "30d";
  const m = /^(\d+)-(hour|minute) window$/.exec(s);
  return m ? `${m[1]}${m[2][0]}` : s;
}

/** A limit's label in the popup: the same words for the same window whichever provider names it
 *  ("Session (5-hour)", "5-hour" → "5-hour"; "Weekly (7-day)", "Weekly SuperGrok Limit" → "Weekly"). */
export function longLabel(label) {
  const s = String(label ?? "");
  if (/5-hour|session/i.test(s)) return "5-hour";
  if (/weekly|7-day/i.test(s)) return "Weekly";
  if (/monthly/i.test(s)) return "Monthly";
  return s;
}

/** Antigravity's Claude and GPT tiers (its secondary limits) as one row: the most used one's share and reset,
 *  and each window's share left as its detail ("5h 80% · 7d 90%"). Null when there are none. */
export function otherModels(limits) {
  if (!limits?.length) return null;
  const most = limits.reduce((a, b) => (b.percent > a.percent ? b : a));
  const left = (l) => Math.round((1 - Math.min(Math.max(l.percent, 0), 1)) * 100);
  return {
    label: "Claude & GPT",
    percent: most.percent,
    resets_at: most.resets_at ?? null,
    detail: limits.length > 1 ? limits.map((l) => `${shortLabel(l.label)} ${left(l)}%`).join(" · ") : null,
  };
}

/** The theme token for a share used: as herdr-mobile colours it. */
export const tone = (used) => (used == null ? "muted" : used >= 0.9 ? "blocked" : used >= 0.75 ? "working" : "done");

/** "in 2h 13m", as herdr-mobile says when a limit resets. */
export function resetsIn(at, now = Date.now()) {
  const ms = Date.parse(at) - now;
  if (Number.isNaN(ms)) return at;
  if (ms < 0) return "shortly";
  const mins = Math.floor(ms / 60_000), hours = Math.floor(mins / 60);
  if (hours >= 24) return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return mins % 60 ? `in ${hours}h ${mins % 60}m` : `in ${hours}h`;
  return mins > 0 ? `in ${mins}m` : "in < 1m";
}

/** 1.2k, 3.4M: by hand, since Herdr's runtime has no Intl. */
export function formatTokens(n) {
  for (const [div, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) if (n >= div) return `${(n / div).toFixed(1)}${unit}`;
  return String(n);
}
