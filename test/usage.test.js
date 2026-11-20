import { test } from "node:test";
import assert from "node:assert/strict";
import * as u from "../mods/herdr-usage/usage.js";

const today = u.todayUtc();
const now = `${today}T10:00:00.000Z`;
const lines = (xs) => xs.map((x) => JSON.stringify(x));

test("providerOf maps agent names and apps", () => {
  assert.equal(u.providerOf("claude-code"), "claude");
  assert.equal(u.providerOf("Codex"), "codex");
  assert.equal(u.providerOf("pi"), "pi");
});

// usage.rs: claude_counts_today_once_per_message
test("claude counts today once per message", () => {
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 9999 };
  const got = u.claudeStats(lines([
    { type: "user", timestamp: now, message: { content: "hi" } },
    { type: "user", timestamp: now, message: { content: [{ type: "tool_result" }] } },
    { type: "user", timestamp: now, isMeta: true, message: { content: "meta" } },
    { type: "assistant", timestamp: now, message: { id: "a", model: "claude-opus-5-5", usage } },
    { type: "assistant", timestamp: now, message: { id: "a", model: "claude-opus-5-5", usage } },
    { type: "assistant", timestamp: "2000-01-01T00:00:00Z", message: { id: "b", usage } },
  ]), today);
  assert.deepEqual(got, { tokens: 115, prompts: 1, model: "claude-opus-5-5" });
});

test("claude login reads the plan without its prefix", () => {
  assert.deepEqual(u.claudeLogin(JSON.stringify({ claudeAiOauth: { accessToken: "t", rateLimitTier: "claude_max" } })), { token: "t", plan: "Max" });
  assert.equal(u.claudeLogin("not json"), null);
});

test("claude limits from the endpoint, none from an error", () => {
  assert.deepEqual(u.claudeLimits({ five_hour: { utilization: 42, resets_at: "2999-01-01T00:00:00+00:00" }, seven_day: { utilization: 7 } }), [
    { label: "Session (5-hour)", percent: 0.42, resets_at: "2999-01-01T00:00:00+00:00", duration_s: 18000 },
    { label: "Weekly (7-day)", percent: 0.07, resets_at: null, duration_s: 604800 },
  ]);
  assert.equal(u.claudeLimits({ type: "error", error: { type: "rate_limit_error" } }), null);
});

test("claude keeps scoped per-model weekly limits", () => {
  const limits = u.claudeLimits({ limits: [
    { kind: "session", percent: 20, resets_at: "2999-01-01T00:00:00Z" },
    { kind: "weekly_all", percent: 30, resets_at: "2999-01-01T00:00:00Z" },
    { kind: "weekly_scoped", percent: 80, resets_at: "2999-01-01T00:00:00Z", scope: { model: { display_name: "Opus" } } },
  ] });
  assert.deepEqual(limits.map((l) => [l.label, l.percent, l.duration_s]), [
    ["Session (5-hour)", 0.2, 18000], ["Weekly (7-day)", 0.3, 604800], ["Weekly · Opus", 0.8, 604800],
  ]);
  assert.equal(u.shortLabel("Weekly · Opus"), "7d Opus");
  assert.equal(u.longLabel("Weekly · Opus"), "Weekly · Opus");
});

test("claude CLI get_usage reply becomes plan and limits", () => {
  const reply = JSON.stringify({ type: "control_response", response: { subtype: "success", response: {
    subscription_type: "claude_max",
    rate_limits: { limits: [{ kind: "session", percent: 25, resets_at: "2999-01-01T00:00:00Z" }] },
  } } });
  assert.deepEqual(u.claudeCli(reply), {
    plan: "Max", limits: [{ label: "Session (5-hour)", percent: 0.25, resets_at: "2999-01-01T00:00:00Z", duration_s: 18000 }],
  });
  assert.equal(u.claudeCli('{"type":"control_response","response":{"subtype":"error"}}'), null);
});

// usage.rs: codex_reports_its_rate_limits
test("codex reports its rate limits", () => {
  const got = u.codexStats(lines([
    { timestamp: now, type: "turn_context", payload: { model: "gpt-5" } },
    { timestamp: now, type: "event_msg", payload: { type: "user_message" } },
    { timestamp: now, type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { total_tokens: 1234 } },
      rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 1_800_000_000 },
                     secondary: { used_percent: 7, window_minutes: 10080 } } } },
  ]).map((line) => ({ file: "a.jsonl", line })), today);
  assert.equal(got.tokens, 1234);
  assert.equal(got.prompts, 1);
  assert.equal(got.model, "gpt-5");
  assert.deepEqual(u.codexLimits(got.logLimits), [
    { label: "5-hour window", percent: 0.42, resets_at: "2027-01-15T08:00:00Z", duration_s: 18000 },
    { label: "Weekly (7-day)", percent: 0.07, resets_at: null, duration_s: 604800 },
  ]);
});

test("codex keeps its per-model limit groups", () => {
  const limits = u.codexLimits({
    codex: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1_800_000_000 } },
    "gpt-5-codex": { limit_name: "GPT-5 Codex", primary: { used_percent: 40, window_minutes: 10080 } },
  });
  assert.deepEqual(limits.map((l) => [l.label, l.percent]), [
    ["5-hour window", 0.1], ["Weekly · GPT-5 Codex", 0.4],
  ]);
});

test("codex app-server RPC reply becomes plan and per-model windows", () => {
  const reply = JSON.stringify({ jsonrpc: "2.0", id: 2, result: {
    rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
    rateLimitsByLimitId: {
      codex: { limitId: "codex", planType: "plus", primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_800_000_000 } },
      other: { limitId: "other", limitName: "Other", primary: { usedPercent: 20, windowDurationMins: 10080 } },
    },
    rateLimitResetCredits: { availableCount: 2 },
  } });
  const r = u.codexRpc(reply);
  assert.equal(r.plan, "Plus");
  assert.deepEqual(r.reset, { count: 2 });
  assert.deepEqual(u.codexLimits(r.windows).map((l) => [l.label, l.percent]), [
    ["5-hour window", 0.5], ["Weekly · Other", 0.2],
  ]);
  const snapshot = JSON.stringify({ snapshot: { payload: { rate_limits: { limit_id: "codex", plan_type: "pro",
    primary: { used_percent: 12, window_minutes: 300 } } } } });
  assert.deepEqual(u.codexLimits(u.codexRpc(snapshot).windows).map((l) => l.percent), [0.12]);
});

test("codex sums each session's last total", () => {
  const tc = (total) => JSON.stringify({ timestamp: now, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total } } } });
  const got = u.codexStats([{ file: "a", line: tc(10) }, { file: "a", line: tc(30) }, { file: "b", line: tc(5) }], today);
  assert.equal(got.tokens, 35);
});

test("codex live answer becomes windows", () => {
  const live = u.codexLive({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 18000, reset_at: 1_800_000_000 } } });
  assert.equal(live.plan, "Plus");
  assert.deepEqual(u.codexLimits(live.windows), [{ label: "5-hour window", percent: 0.5, resets_at: "2027-01-15T08:00:00Z", duration_s: 18000 }]);
  assert.equal(u.codexLive({ detail: "Unauthorized" }), null);
});

// usage.rs: claudes_limits_outlive_a_refused_read
test("a refused read keeps the last limits, marked stale when old", () => {
  const limits = [{ label: "Session (5-hour)", percent: 0.25, resets_at: "2999-01-01T00:00:00+00:00" }];
  const t = 1_000_000;
  const old = { at: t, usage: { tier_label: null, limits, today_tokens: 1, today_prompts: 1 }, limitsAt: t };
  const merged = u.merge(old, { tier_label: null, limits: [], today_tokens: 2, today_prompts: 2 }, t + 60_000);
  assert.equal(merged.limitsAt, t);
  assert.equal(merged.usage.today_tokens, 2);
  assert.equal(u.shown(merged, "claude", t + 60_000).limits.length, 1);
  const later = merged.at + u.STALE + 1;
  assert.equal(u.shown(merged, "claude", later).stale, true);
  assert.equal(u.shown(merged, "codex", later).limits.length, 1);
});

test("a limit whose window has reset is shown as expired, never as 0%", () => {
  const entry = { at: Date.now(), limitsAt: Date.now(), usage: { limits: [{ label: "x", percent: 0.5, resets_at: "2000-01-01T00:00:00Z" }] } };
  const limits = u.shown(entry, "claude").limits;
  assert.equal(limits.length, 1);
  assert.equal(limits[0].expired, true);
  assert.equal(u.highestPercent(limits), null);
});

test("short labels for the status bar", () => {
  assert.deepEqual(["Session (5-hour)", "Weekly (7-day)", "Monthly", "5-hour window", "90-minute window", "Gemini Pro"].map(u.shortLabel),
    ["5h", "7d", "30d", "5h", "90m", "Gemini Pro"]);
});

test("formatting as herdr-mobile does", () => {
  assert.equal(u.formatTokens(1234), "1.2k");
  assert.equal(u.formatTokens(999), "999");
  assert.equal(u.resetsIn(new Date(Date.now() + (2 * 60 + 13) * 60_000 + 30_000).toISOString()), "in 2h 13m");
  assert.equal(u.tone(0.95), "blocked");
  assert.equal(u.tone(0.8), "working");
  assert.equal(u.tone(0.1), "done");
  assert.equal(u.highestPercent([{ percent: 0.2 }, { percent: 0.6 }]), 0.6);
});

test("providerOf covers every agent usage.rs did", () => {
  assert.deepEqual(["agy", "gemini", "grok", "opencode", "github-copilot", "cursor-agent", "openrouter", "deepseek", "amp", "amp-x", "ample"].map(u.providerOf),
    ["antigravity", "antigravity", "grok", "opencode", "copilot", "cursor", "openrouter", "deepseek", "amp", "amp", null]);
});

// usage.rs: antigravity_counts_today_and_parses_model, antigravity_model_change_from_existing_model, gemini_cli_chat_sessions
test("antigravity counts today and reads the model switched to", () => {
  const n = `${today}T10:00:00Z`;
  const brain = lines([
    { type: "USER_INPUT", created_at: n, content: "hello\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.7 Flash (High).\n</USER_SETTINGS_CHANGE>" },
    { type: "PLANNER_RESPONSE", created_at: n, input_tokens: 100, cache_read_tokens: 50, output_tokens: 25 },
    { type: "USER_INPUT", created_at: "2000-01-01T00:00:00Z", content: "old" },
    { type: "PLANNER_RESPONSE", created_at: "2000-01-01T00:00:00Z", input_tokens: 999 },
  ]);
  assert.deepEqual(u.antigravityStats(brain, [], today), { tokens: 175, prompts: 1, model: "Gemini 3.7 Flash (High)" });
  assert.equal(u.antigravityModel("x `Model Selection` from Gemini 3.7 Flash (High) to Claude 3.7 Sonnet (Thinking).\n</U>"), "Claude 3.7 Sonnet (Thinking)");
  const chats = lines([{ type: "user", timestamp: n }, { type: "gemini", timestamp: n, model: "gemini-2.5-pro", tokens: { input: 200, output: 100, thoughts: 50 } }]);
  assert.deepEqual(u.antigravityStats([], chats, today), { tokens: 350, prompts: 1, model: "gemini-2.5-pro" });
});

// usage.rs: antigravity_tags_secondary_tiers_but_keeps_them
test("antigravity keeps its Claude and GPT tiers out of the headline", () => {
  assert.equal(u.antigravityIsSecondary("Gemini Models Session"), false);
  assert.equal(u.antigravityIsSecondary("OpenAI Codex 5h"), true);
  const limits = u.tagPrimary([{ label: "Session (5-hour)", percent: 0.4 }, { label: "Claude Models Session", percent: 1 }]);
  assert.deepEqual(limits.map((l) => l.primary), [true, false]);
  assert.equal(u.highestPercent(limits), 0.4);
  const probe = u.antigravityProbe({ command: { data: { groups: [
    { name: "Gemini Models", buckets: [{ window: "weekly", remaining_fraction: 0.7 }, { window: "5h", remaining_fraction: 0.25, reset_time: "2999-01-01T00:00:00Z" }] },
    { name: "Claude Models", buckets: [{ name: "Session", remaining_fraction: 0 }] },
  ] } } });
  assert.deepEqual(probe, [
    { label: "Session (5-hour)", percent: 0.75, resets_at: "2999-01-01T00:00:00Z", duration_s: 18000, primary: true },
    { label: "Weekly (7-day)", percent: 0.3, resets_at: null, duration_s: 604800, primary: true },
    { label: "Claude Models Session", percent: 1, resets_at: null, primary: false },
  ]);
});

// usage.rs: grok_parses_sessions_and_settings, grok_parses_cache
test("grok reads sessions, settings, billing and another tool's file", () => {
  const got = u.grokStats(lines([{ timestamp: `${today}T10:00:00Z`, params: { update: { sessionUpdate: "turn_completed",
    usage: { inputTokens: 100, outputTokens: 50, modelUsage: { "grok-4.6": {} } } } } }]), today);
  assert.deepEqual(got, { tokens: 150, prompts: 1, model: "grok-4.6" });
  assert.equal(u.grokTier(JSON.stringify({ payload: JSON.stringify({ settings: { subscription_tier_display: "SuperGrok Pro" } }) })), "SuperGrok Pro");
  assert.deepEqual(u.grokCache({ snapshot: { plan: "SuperGrok", percent: 80, reset_at: "2026-10-15T15:00:00Z" } }),
    { plan: "SuperGrok", limits: [{ label: "Weekly SuperGrok Limit", percent: 0.8, resets_at: "2026-10-15T15:00:00Z" }] });
  assert.equal(u.grokLogin(JSON.stringify({ a: { auth_mode: "api_key", key: "xai-1" } })), null);
  assert.deepEqual(u.grokLogin(JSON.stringify({ a: { auth_mode: "oidc", key: "k", user_id: "u" } })), { key: "k", userId: "u" });
  assert.deepEqual(u.grokBilling({ plan: "SuperGrok", creditUsagePercent: 25, billingPeriodEnd: "2999-01-01T00:00:00Z" }).limits[0].percent, 0.25);
});

// usage.rs: opencode_parses_windows
test("opencode reads its three windows and its key", () => {
  const limits = u.opencodeLimits({
    rolling: { percent: 35, resetsAt: "2026-10-15T00:00:00Z" }, weekly: { percent: 14, resetsAt: "2026-10-18T00:00:00Z" }, monthly: { percent: 100, resetsAt: "2026-11-01T00:00:00Z" },
  });
  assert.deepEqual(limits.map((l) => [l.label, l.percent]), [["5-hour", 0.35], ["Weekly", 0.14], ["Monthly", 1]]);
  assert.deepEqual(limits.map((l) => u.shortLabel(l.label)), ["5h", "7d", "30d"]);
  assert.equal(u.opencodeKey('{"key":"db"}', '{"opencode-go":{"key":"file"}}'), "db");
  assert.equal(u.opencodeKey(null, '{"opencode-go":{"key":"file"}}'), "file");
});

// usage.rs: copilot_parses_cache, cursor_parses_cache, openrouter_parses_cache, deepseek_parses_cache
test("copilot, cursor, openrouter and deepseek", () => {
  assert.equal(u.copilotToken(null, "github.com:\n    oauth_token: gho_x\n", "", ""), "gho_x");
  assert.deepEqual(u.copilotUser({
    copilot_plan: "individual", quota_reset_date: "2026-12-01",
    quota_snapshots: {
      premium_interactions: { entitlement: 300, remaining: 75, percent_remaining: 25, unlimited: false },
      chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
    },
  }), { plan: "Copilot Individual", limits: [{ label: "Premium requests", percent: 0.75, resets_at: "2026-12-01", detail: "75 of 300" }] });
  assert.equal(u.copilotUser({ message: "Bad credentials" }), null);
  // Free: premium requests not included; chat and completions limited.
  assert.deepEqual(u.copilotUser({
    copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
    quota_snapshots: {
      premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false, has_quota: false },
      chat: { entitlement: 200, remaining: 150, percent_remaining: 75, unlimited: false, has_quota: true },
    },
  }), { plan: "Copilot Free", limits: [{ label: "Chat", percent: 0.25, resets_at: "2026-12-01T00:00:00.000Z", detail: "150 of 200" }] });
  assert.deepEqual(u.noSessionToken([{ label: "Session Token", percent: 0 }, { label: "Premium", percent: 0.5 }]), [{ label: "Premium", percent: 0.5 }]);
  assert.deepEqual(u.genericCache({ tierLabel: "Copilot Business", limits: [{ label: "Session Token", percent: 0 }] }, "sku").plan, "Copilot Business");
  assert.deepEqual(u.cursorParse({ membershipType: "pro", fastRequests: { numRequests: 45, maxRequestUsage: 100 }, startOfMonth: "2026-11-01T00:00:00Z" }),
    { plan: "Cursor Pro", limits: [{ label: "Fast Requests", percent: 0.45, resets_at: "2026-11-01T00:00:00Z" }] });
  assert.equal(u.cursorToken(null, '{"token":"c"}'), "c");
  assert.deepEqual(u.openrouterParse({ data: { label: "sk-or-v1-0e6...", usage: 12, limit: 100, usage_daily: 1.5 } }),
    { plan: "OpenRouter", limits: [{ label: "Credit Limit", percent: 0.12, detail: "$12.00 of $100.00" }], cost: 1.5 });
  assert.deepEqual(u.openrouterParse({ data: { usage: 3, limit: null } }, { data: { total_credits: 20, total_usage: 7.25 } }).limits,
    [{ label: "Balance", percent: 0, title: "$12.75" }]);
  assert.equal(u.keyFrom("sk-or-123\n"), "sk-or-123");
  assert.equal(u.keyFrom('{"other":1}'), null);
  assert.deepEqual(u.deepseekParse({ balance_infos: [{ currency: "USD", total_balance: "50.00", granted_balance: "10.00", topped_up_balance: "40.00" }] }),
    { plan: "DeepSeek API", limits: [{ label: "Balance (USD)", percent: 0, title: "50.00 USD", detail: "10.00 granted · 40.00 paid" }] });
});

// usage.rs: amp_parses_usage
test("amp reads its balances and today's tokens", () => {
  const got = u.ampParse("# Usage\n\nSigned in as a@b.c\n**Individual credits:** $1,208.62 remaining (set up auto-reload) - https://ampcode.com/settings\n\n" +
    "Range: 2026-11-03T00:00:00.000Z to 2026-11-04T00:00:00.000Z (end exclusive)\nTotal tokens: 2,192,014\nTotal recorded cost: $1.38\n");
  assert.deepEqual(got, { tier_label: "Individual credits: $1,208.62 left", limits: [], today_tokens: 2_192_014, today_cost: 1.38 });
  assert.deepEqual(u.ampParse("**Amp Free:** $7.50/$10 remaining (replenishes +$0.42/hour)\nTotal tokens: 0\n"),
    { tier_label: "Amp", limits: [{ label: "Amp Free", percent: 0.25 }], today_tokens: 0 });
  assert.equal(u.ampParse("Error: not signed in\n"), null);
});

test("claude extra usage, codex credits, opencode stats, today's cost, the bar's limits", () => {
  assert.equal(u.claudeExtra({ extra_usage: { is_enabled: false } }), null);
  assert.deepEqual(u.claudeExtra({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1230, utilization: 25, currency: "USD", decimal_places: 2 } }),
    { label: "Extra usage", percent: 0.25, detail: "12.30 USD of 50.00 USD", bar: false });
  assert.equal(u.codexCredits({ has_credits: false, unlimited: false, balance: "0" }), null);
  assert.deepEqual(u.codexCredits({ has_credits: true, unlimited: false, balance: "120" }), { label: "Credits", percent: 0, title: "120 left", bar: false });
  assert.deepEqual(u.opencodeStats("3|1200|0.25\n", "1|300|0", null), { prompts: 4, tokens: 1500, cost: 0.25, week_prompts: 0, week_tokens: 0, week_cost: 0 });
  assert.deepEqual(u.opencodeStats("2|100|0.1|9|900|0.9\n"), { prompts: 2, tokens: 100, cost: 0.1, week_prompts: 9, week_tokens: 900, week_cost: 0.9 });
  assert.equal(u.usage({ plan: "Pro", limits: [], cost: 0 }).today_cost, undefined);
  assert.equal(u.usage({ plan: "Pro", limits: [], cost: 2.5 }).today_cost, 2.5);
  const limits = [{ label: "5-hour", percent: 0.1 }, { label: "Extra usage", percent: 0.2, bar: false }, { label: "Other", percent: 0, primary: false }];
  assert.deepEqual(u.onBar(limits).map((l) => l.label), ["5-hour"]);
  assert.deepEqual(u.primary(limits).map((l) => l.label), ["5-hour", "Extra usage"]);
});

test("popup labels, and Antigravity's Claude and GPT tiers as one row", () => {
  assert.deepEqual(["Session (5-hour)", "5-hour", "Weekly (7-day)", "Weekly SuperGrok Limit", "Monthly", "Premium requests"].map(u.longLabel),
    ["5-hour", "5-hour", "Weekly", "Weekly", "Monthly", "Premium requests"]);
  assert.equal(u.otherModels([]), null);
  assert.deepEqual(u.otherModels([
    { label: "Claude and GPT models 5h", percent: 0.2, resets_at: "a", primary: false },
    { label: "Claude and GPT models Weekly Limit Remaining", percent: 0.1, resets_at: "b", primary: false },
  ]), { label: "Claude & GPT", percent: 0.2, resets_at: "a", detail: "5h 80% · 7d 90%" });
});

test("limit resets, OpenCode's status, OpenRouter's weekly spend", () => {
  const resp = { cedar_ember: { grants: [
    { resets_left: 1, ends_at: "2026-10-22T16:00:00+00:00" },
    { resets_left: 0, ends_at: "2027-01-01T00:00:00+00:00" },
  ] } };
  assert.deepEqual(u.claudeReset(resp, Date.parse("2026-09-30T00:00:00Z")), { count: 1, until: "2026-10-22T16:00:00.000Z" });
  assert.equal(u.claudeReset(resp, Date.parse("2026-11-01T00:00:00Z")), null);
  assert.equal(u.claudeReset(null), null);
  assert.deepEqual(u.codexReset({ rate_limit_reset_credits: { available_count: 2 } }), { count: 2 });
  assert.equal(u.codexReset({ rate_limit_reset_credits: { available_count: 0 } }), null);
  assert.equal(u.resetNote({ count: 1, until: "2026-10-22T16:00:00Z" }), "1 limit reset available · expires 22 Oct");
  assert.equal(u.resetNote({ count: 2 }), "2 limit resets available");
  assert.equal(u.resetNote(null), null);
  assert.equal(u.usage({ plan: "Team", limits: [], reset: { count: 1 } }).reset_note, "1 limit reset available");
  assert.deepEqual(u.opencodeLimits({ weekly: { percent: 14, resetsAt: "w", status: "ok" }, monthly: { percent: 100, resetsAt: "m", status: "rate-limited" } }),
    [{ label: "Weekly", percent: 0.14, resets_at: "w", duration_s: 604800 }, { label: "Monthly", percent: 1, resets_at: "m", status: "rate-limited" }]);
  const r = u.openrouterParse({ data: { usage: 1, usage_daily: 0.5, usage_weekly: 3, usage_monthly: 12 } });
  assert.deepEqual([r.cost, r.week, r.month], [0.5, 3, 12]);
  const spent = u.usage({ plan: "OpenRouter", limits: [], week: 3, month: 12 });
  assert.deepEqual([spent.week_cost, spent.month_cost], [3, 12]);
});

test("pace compares the share used with the share of the window gone", () => {
  const now = Date.parse("2026-11-20T10:00:00Z");
  const limit = { percent: 0.8, duration_s: 5 * 3600, resets_at: "2026-11-20T11:40:00Z" };
  const p = u.pace(limit, now);
  assert.equal(Math.round(p.elapsed * 100), 67);
  assert.equal(Math.round(p.left * 100), 33);
  assert.equal(p.verdict, "ahead");
  assert.match(u.paceText(limit, now), /33% of the window left/);
  assert.equal(u.pace({ percent: 0.1, label: "Monthly", resets_at: "2026-12-01T00:00:00Z" }, now), null);
  assert.equal(u.durationOf({ label: "Weekly · Opus" }), 604800);
});

test("Pi tokens and prompts come from its own messages, today and over 7 days", () => {
  const day = "2026-11-20";
  const week = "2026-11-17";
  const lines = [
    { type: "message", timestamp: `${day}T10:00:00.000Z`, message: { role: "user" } },
    { type: "message", timestamp: `${day}T10:00:02.000Z`, message: { role: "assistant", model: "demo-model", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 } } },
    { type: "message", timestamp: `${week}T09:00:00.000Z`, message: { role: "assistant", usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", timestamp: "2026-11-01T09:00:00.000Z", message: { role: "assistant", usage: { totalTokens: 999 } } },
  ].map((x) => JSON.stringify(x));
  assert.deepEqual(u.piStats(lines, day, Date.parse(`${week}T00:00:00Z`)),
    { today_tokens: 18, today_prompts: 1, week_tokens: 138, week_prompts: 1, model: "demo-model" });
  assert.deepEqual(u.usage({ plan: "Pi", limits: [], tokens: 18, prompts: 1, week_tokens: 138, week_prompts: 1, spend: true }),
    { tier_label: "Pi", limits: [], today_tokens: 18, today_prompts: 1, week_tokens: 138, week_prompts: 1, spend: true });
});
