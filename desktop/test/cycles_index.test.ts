import assert from "node:assert/strict";
import test from "node:test";

import { textOf, withRenderer } from "./helpers/render.ts";
import type { ChartPalette } from "../src/verticals/finance/lib/backtestView.ts";
import {
  SERIES_NAME, STATE_LABEL, biasOption, extremes, gapText, simpleOption, stateOf, triggerText, turnoverOption, valueText, verdictLine,
  type CyclesMetric, type CyclesPoint, type CyclesResult,
} from "../src/verticals/finance/lib/cycles.ts";

const P: ChartPalette = {
  text: "T", grid: "G", axis: "A", strong: "S", primary: "P", benchmark: "B",
  rise: "RED", fall: "GREEN", neutral: "N", tooltipBg: "TB", tooltipText: "TT",
};
type Obj = Record<string, any>;

const pts = (values: number[], from = 1): CyclesPoint[] =>
  values.map((value, i) => ({ date: new Date(Date.UTC(2026, 0, from + i)).toISOString().slice(0, 10), value }));

const turnover = (over: Partial<CyclesMetric> = {}): CyclesMetric => ({
  id: "turnover20", label: "上证换手率 20 日均", value: 1.8, unit: "%", trigger: 0.55, direction: "lte", triggered: false,
  as_of: "2026-11-10", series: pts([1.7, 1.75, 1.8], 50), daily: pts([1.6, 1.8, 1.7, 1.9, 1.8], 46),
  formula: "换手率 = 上证指数当日成交额 ÷ 沪市流通市值;20 日均 = 最近 20 个交易日换手率的算术平均",
  source: "成交额:em_market_trend(market_amount_sh);流通市值:sse_market_overview", gaps: [], ...over,
});

const bias = (over: Partial<CyclesMetric> = {}): CyclesMetric => ({
  id: "hsi_bias250", label: "恒生指数 250 日乖离率", value: -3.52, unit: "%", trigger: -10.6, direction: "lte", triggered: false,
  as_of: "2026-11-10", series: pts([-6.08, -2.63, -3.84, -3.95, -3.52], 40), close: 24557.04, ma: 25452.14,
  formula: "乖离率 = 恒生指数收盘 ÷ 250 日收盘均线 − 1(每个交易日的均线取它自己往前 250 根)",
  source: "恒指收盘:em_southbound_flow", gaps: [], ...over,
});

const vix = (over: Partial<CyclesMetric> = {}): CyclesMetric => ({
  id: "vix_spike", label: "VIX 恐慌冲高(近 60 日收盘最高)", value: 28.18, unit: "点", trigger: 25.7, direction: "gte", triggered: true,
  as_of: "2026-11-05", series: pts([16.5, 19.2, 28.18, 22.4, 19.92], 40),
  aux: [{ label: "最新收盘", text: "19.92(2026-11-09)" }],
  formula: "近 60 个交易日 VIX 收盘最高值;冲高为底,所以取窗口最高而不是最新值",
  source: "FRED 的 VIXCLS 日序列", gaps: [], ...over,
});

const sf = (over: Partial<CyclesMetric> = {}): CyclesMetric => ({
  id: "sf_yoy_6m", label: "社融存量同比 6 个月变化", value: -0.8, unit: "百分点", trigger: 0.9, direction: "gte", triggered: false,
  as_of: "2026-09-01", series: pts([-0.6, -0.5, -0.8], 40),
  aux: [{ label: "最新", text: "7.10%(2026-09)" }, { label: "6 个月前", text: "7.90%(2026-03)" }],
  formula: "官方社融存量同比增速本月值 − 6 个月前值",
  source: "人民银行社融存量统计表", gaps: [], ...over,
});

const result = (over: Partial<CyclesResult> = {}, m1 = turnover(), m2 = bias()): CyclesResult => ({
  metrics: [m1, m2], triggered_count: 0, available_count: 2, signal: "none",
  fetched_at: "2026-11-11T10:52:13+08:00", cached: false, generated_at: "2026-11-11T02:52:13.000Z",
  gaps: [], reading: "读法:这些是长周期极端值的复核,不是预测。", ...over,
});

test("触发线写法:用户给的两条线,一位小数不带多余 0;gte 方向写「≥」,VIX 是指数点不跟 %", () => {
  assert.equal(triggerText(turnover()), "≤ 0.55%");
  assert.equal(triggerText(bias()), "≤ -10.6%");
  assert.equal(triggerText(vix()), "≥ 25.7", "单位「点」不带 % 后缀");
  assert.equal(triggerText(sf()), "≥ 0.9", "「百分点」不带 % 后缀");
  assert.equal(valueText(1.8), "1.80%");
  assert.equal(valueText(null), "—");
  assert.equal(valueText(28.18, 2, "点"), "28.18");
});

test("gte 方向的距离:已触发写「越过」,未触发写「距触发线」", () => {
  assert.equal(gapText(vix()), "已越过触发线 2.48 个百分点");
  assert.equal(gapText(vix({ value: 19.92, triggered: false })), "距触发线 5.78 个百分点");
  assert.equal(gapText(sf()), "距触发线 1.70 个百分点");
});

test("状态与距离:未触发写「还差多少」+ 换手率附「还要再降多少」;触发写「越过多少」", () => {
  assert.deepEqual([stateOf(turnover()), stateOf(turnover({ triggered: true })), stateOf(turnover({ value: null }))],
    ["clear", "triggered", "unknown"]);
  assert.equal(gapText(turnover()), "距触发线 1.25 个百分点(换手率还要再降 69%)");
  assert.equal(gapText(bias()), "距触发线 7.08 个百分点");
  assert.equal(gapText(turnover({ triggered: true, value: 0.5 })), "已越过触发线 0.05 个百分点");
  assert.equal(gapText(turnover({ value: null })), "这一轮没算出来");
  assert.deepEqual([STATE_LABEL.clear, STATE_LABEL.triggered, STATE_LABEL.unknown], ["未触发", "已触发", "没算出来"]);
});

test("一句话结论只报触发数,不下「底部到了」的判断", () => {
  assert.equal(verdictLine(result()), "2 项核心指标里有 0 项进入触发区:一项都没触发");
  assert.equal(verdictLine(result({ signal: "partial", triggered_count: 1 }, turnover({ triggered: true, value: 0.4 }))),
    "2 项核心指标里有 1 项进入触发区:还没到「全部触发」");
  assert.equal(verdictLine(result({ available_count: 0, signal: "none" }, turnover({ value: null }), bias({ value: null }))),
    "核心指标 2 项这一轮都没算出来,没有可看的结论");
});

test("极值:窗口内最低 / 最高按整段序列取,不只看最后一根", () => {
  const e = extremes(bias().series);
  assert.deepEqual([e.low!.value, e.high!.value], [-6.08, -2.63]);
  assert.deepEqual(extremes([]), { low: null, high: null });
});

test("换手率图:逐日 + 20 日均两条线,触发线 0.55 画成 markLine;x 轴前段均线补空", () => {
  const o = turnoverOption(turnover(), P) as Obj;
  assert.equal((o as Obj).xAxis.data.length, 5);
  const s = o.series as Obj[];
  assert.deepEqual(s.map((x) => x.name), ["逐日换手率", "20 日均"]);
  assert.deepEqual((s[1]!.data as Obj[]).slice(0, 2), [null, null]);
  assert.deepEqual(s[1]!.markLine.data[0].yAxis, 0.55);
  assert.match(String(s[1]!.markLine.data[0].label.formatter), /触发线/);
  assert.equal(turnoverOption(turnover({ daily: [] }), P), null, "没有逐日序列就不画");
});

test("恒指图:乖离率曲线 + 触发线 -10.6", () => {
  const o = biasOption(bias(), P) as Obj;
  const s = o.series as Obj[];
  assert.equal(s.length, 1);
  assert.deepEqual(s[0]!.markLine.data[0].yAxis, -10.6);
  assert.equal(biasOption(bias({ series: [] }), P), null);
});

test("新指标通用折线:触发线照画,VIX 的轴和提示不带 %;序列名与指标对得上", () => {
  const o = simpleOption(vix(), P, SERIES_NAME.vix_spike) as Obj;
  const s = o.series as Obj[];
  assert.equal(s.length, 1);
  assert.equal(s[0]!.name, "VIX 收盘");
  assert.deepEqual(s[0]!.markLine.data[0].yAxis, 25.7);
  assert.match(String(s[0]!.markLine.data[0].label.formatter), /≥ 25\.7/);
  assert.match(String(o.yAxis.axisLabel.formatter(19.92)), /^19\.92$/, "「点」单位的轴标签不带 %");
  assert.match(String(o.tooltip.valueFormatter(28.18)), /^28\.18$/);
  const oPct = simpleOption(sf(), P, SERIES_NAME.sf_yoy_6m) as Obj;
  assert.match(String(oPct.tooltip.valueFormatter(-0.8)), /^-0\.80$/, "「百分点」不带 %;换手率这类 % 单位才带");
  assert.equal(simpleOption(vix({ series: [] }), P, SERIES_NAME.vix_spike), null);
});

test("整屏:值、触发线、距离、口径、读法都写在页面上;没算出来的不冒充有数", () => {
  const r = result({}, turnover({ gaps: ["今天这一根成交额还没收完,没算进序列(均值取到上一个交易日)"] }), bias());
  return withRenderer(async (renderer) => {
    const { CyclesPanel } = await renderer.load("/src/verticals/finance/pages/CyclesIndex.tsx");
    const text = textOf(renderer.html(CyclesPanel, { data: r }));
    assert.match(text, /上证换手率 20 日均/);
    assert.match(text, /1\.80%.*触发线 ≤ 0\.55%/s);
    assert.match(text, /-3\.52%.*触发线 ≤ -10\.6%/s);
    assert.match(text, /距触发线 1\.25 个百分点\(换手率还要再降 69%\)/);
    assert.match(text, /未触发/);
    assert.match(text, /2 项核心指标里有 0 项进入触发区/);
    assert.match(text, /长周期极端值的复核,不是预测/);
    assert.match(text, /恒指收盘 24,557\.04 点 · 250 日均线 25,452\.14 点/);
    assert.match(text, /窗口内最低 -6\.08%\(2026-02-09\)/);
    assert.match(text, /今天这一根成交额还没收完/);
    assert.match(text, /换手率 = 上证指数当日成交额 ÷ 沪市流通市值/);
  });
});

test("整屏:gte 指标(VIX / 社融)的值、≥ 触发线、距离与辅助读数都写出来", () => {
  const r = result({}, vix(), sf());
  return withRenderer(async (renderer) => {
    const { CyclesPanel } = await renderer.load("/src/verticals/finance/pages/CyclesIndex.tsx");
    const text = textOf(renderer.html(CyclesPanel, { data: r }));
    assert.match(text, /28\.18\s*触发线 ≥ 25\.7/s);
    assert.match(text, /已触发/);
    assert.match(text, /已越过触发线 2\.48 个百分点/);
    assert.match(text, /最新收盘 19\.92\(2026-11-09\)/);
    assert.match(text, /-0\.80\s*触发线 ≥ 0\.9\s/s);
    assert.match(text, /最新 7\.10%\(2026-09\) · 6 个月前 7\.90%\(2026-03\)/);
    assert.match(text, /近 60 个交易日 VIX 收盘最高值/);
  });
});

test("整屏:两项都没算出来时,结论卡明说,卡里不显示假数字", () => {  const r = result({ available_count: 0, signal: "none", gaps: ["两项里有 2 项这一轮没算出来,结论只能按算出来的那几项看"] },
    turnover({ value: null, triggered: null, series: [], daily: [], as_of: null, gaps: ["成交额没取到,换手率这一项这一轮算不出来"] }),
    bias({ value: null, triggered: null, series: [], close: null, ma: null, as_of: null, gaps: ["恒指收盘没取到(南向资金端点这一轮没回),乖离率算不出来"] }));
  return withRenderer(async (renderer) => {
    const { CyclesPanel } = await renderer.load("/src/verticals/finance/pages/CyclesIndex.tsx");
    const text = textOf(renderer.html(CyclesPanel, { data: r }));
    assert.match(text, /核心指标 2 项这一轮都没算出来/);
    assert.match(text, /没算出来/);
    assert.match(text, /这一项这一轮没有可画的序列/);
    assert.doesNotMatch(text, /1\.80%|-3\.52%/);
  });
});
