import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backend } from "../src/verticals/finance/lib/backend.ts";
import {
  STATE_META, STRATEGIES, VERDICT_TABS, defaultForm, fairPb, formError, recomputeRow, rowsOfTab, strategyQuery,
  type ScreenRow, type StrategyForm,
} from "../src/verticals/finance/lib/strategy.ts";

const read = (p: string) => readFileSync(new URL(`../src/verticals/finance/${p}`, import.meta.url), "utf8");
const form = (patch: Partial<StrategyForm> = {}): StrategyForm => ({ ...defaultForm(), ...patch });

const row = (): ScreenRow => ({
  symbol: "600000", name: "样本甲", verdict: "met",
  checks: [{ id: "fair_pb", state: "met", value: 0.085 / 0.07, shown: "合理 PB 1.21 倍,当前 1.00 倍" }],
  pb: 1, roe: 0.115, fair_pb: 0.085 / 0.07, r: 0.1, g: 0.03, roe_period: "2026-09-30", adjusted: false,
});

test("查询串:默认只带必要项,勾选的排除项才带上,百分数按界面值传", () => {
  assert.equal(strategyQuery(form()),
    "strategy=pb_roe&universe=watch&r=10&g=3&exclude_st=1&limit=300");
  assert.equal(strategyQuery(form({ universe: "hs300", pb: { min: "0.5", max: "2" }, roe: { min: "8", max: "25" }, excludeSt: false,
    exclGoodwill: true, exclLeverage: true, exclRevenue: true, limit: "500" })),
    "strategy=pb_roe&universe=hs300&pb_min=0.5&pb_max=2&roe_min=8&roe_max=25&r=10&g=3&exclude_st=0&excl_goodwill=1&goodwill_max=30&excl_leverage=1&leverage_max=3&excl_revenue=1&revenue_min=0&limit=500");
  assert.equal(STRATEGIES.length, 1);
  assert.equal(STRATEGIES[0].id, "pb_roe");
});

test("提交前核对:r 必须大于 g、区间合法、上限范围、阈值合法", () => {
  assert.equal(formError(form()), "");
  assert.equal(formError(form({ r: "3", g: "3" })), "风险折现率必须大于永续增长率,否则公式无意义");
  assert.equal(formError(form({ r: "2", g: "3" })), "风险折现率必须大于永续增长率,否则公式无意义");
  assert.equal(formError(form({ pb: { min: "9", max: "1" } })), "当前 PB 的下限大于上限");
  assert.equal(formError(form({ roe: { min: "abc", max: "" } })), "实测 ROE 下限不是合法数字");
  assert.equal(formError(form({ limit: "0" })), "取数上限要在 1 到 2000 之间");
  assert.equal(formError(form({ limit: "3000" })), "取数上限要在 1 到 2000 之间");
  assert.equal(formError(form({ exclGoodwill: true, goodwillMax: "-1" })), "商誉占比上限不能是负数");
  assert.equal(formError(form({ exclLeverage: true, leverageMax: "0" })), "权益乘数上限要大于 0");
  // 只给 r/g、一个过滤条件都不设也能核对:策略自带的比较恒在
  assert.equal(formError(form({ pb: { min: "", max: "" }, roe: { min: "", max: "" }, excludeSt: false })), "");
});

test("公式:数值符合 (ROE − g)/(r − g);异常域返回 null(与后端同式的交叉校验在 orchestrator 测试里)", () => {
  assert.ok(Math.abs(fairPb(0.15, 0.1, 0.03)! - 0.12 / 0.07) < 1e-12);
  assert.ok(Math.abs(fairPb(0.15, 0.1, 0)! - 1.5) < 1e-12);
  assert.ok(Math.abs(fairPb(0.08, 0.12, 0.02)! - 0.06 / 0.1) < 1e-12);
  assert.equal(fairPb(0.02, 0.1, 0.03), null, "ROE ≤ g");
  assert.equal(fairPb(0.15, 0.03, 0.03), null, "r = g");
  assert.equal(fairPb(0.1, 0.05, 0.06), null, "r < g");
});

test("行内重算:只改这一行的测算值,行仍然保留,不触发任何后端请求", async () => {
  const prev = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    const before = row();
    const after = recomputeRow(before, 12, 3);
    assert.equal(calls, 0, "重算纯前端,不回后端");
    assert.equal(after.symbol, before.symbol);
    assert.equal(after.adjusted, true);
    assert.ok(after.fair_pb !== null && Math.abs(after.fair_pb - 0.085 / 0.09) < 1e-12);
    assert.equal(after.r, 0.12);
    assert.equal(after.g, 0.03);
    assert.equal(after.checks.find((c) => c.id === "fair_pb")!.state, "unmet", "r 变大后合理 PB 降到 0.94,当前 PB 1 不再满足");
    assert.equal(after.verdict, "unmet");
    assert.equal(before.adjusted, false, "原结果不被改写");
    // 分组按后端原始结果,重算后的行依然留在原来的组里(页面「仍然展示」)
    assert.deepEqual(rowsOfTab([before], "met").map((r) => r.symbol), ["600000"]);
    const unusable = recomputeRow({ ...before, roe: 0.01 }, 10, 3);
    assert.equal(unusable.fair_pb, null, "ROE ≤ g 时模型不可算");
    assert.equal(unusable.checks.find((c) => c.id === "fair_pb")!.state, "missing");
  } finally { globalThis.fetch = prev; }
});

test("前端调用:GET /view/strategy_screen,查询串原样带上", async () => {
  const prev = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    urls.push(String(input));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await backend.strategyScreen("universe=hs300&pb_max=2&r=10&g=3");
  } finally { globalThis.fetch = prev; }
  assert.deepEqual(urls, ["/api/view/strategy_screen?universe=hs300&pb_max=2&r=10&g=3"]);
});

test("分组:先满足、再缺数据、最后不满足;状态不用红绿", () => {
  assert.deepEqual(VERDICT_TABS.map((t) => t.key), ["met", "missing", "unmet"]);
  for (const m of Object.values(STATE_META)) assert.doesNotMatch(m.tone, /red-|green-|emerald-|rose-|destructive|success/);
});

test("页面:不排名、不给建议、不缓存不自动刷新、缺数据单独列出、行内重算仍展示;导航与首页都有入口", () => {
  const src = read("pages/StrategyScreen.tsx");
  assert.match(src, /只排除、不排名,不打分、不给买卖建议/);
  assert.match(src, /按代码排列,不排名/);
  assert.match(src, /不是选股结论/);
  assert.match(src, /没取到的不算「不满足」/);
  assert.match(src, /仍然展示/);
  assert.match(src, /不会重跑整个范围/);
  assert.match(src, /测算合理 PB 是模型假设值/);
  assert.doesNotMatch(src, /localStorage|storageSet|\.sort\(/);
  assert.doesNotMatch(src, /目标价|评级|买入|卖出|推荐|得分|排行/);
  assert.match(src, /recomputeRow\(/);
  assert.match(src, /backend\.strategyScreen\(/);
  assert.match(read("lib/nav.ts"), /\{ to: "\/strategy-screen", label: "策略选股", icon: "SlidersHorizontal" \}/);
  assert.match(read("lib/homeFeatures.ts"), /to: "\/strategy-screen", title: "策略选股"/);
  assert.match(read("router.tsx"), /path: "\/strategy-screen"/);
  assert.match(read("lib/backend.ts"), /\/view\/strategy_screen\?/);
});
