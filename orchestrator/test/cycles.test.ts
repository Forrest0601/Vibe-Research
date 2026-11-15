import assert from "node:assert/strict";
import { test } from "node:test";

import "../src/finance/register_tasks.ts";
import { listViews } from "../src/views.ts";
import {
  amountsOf, biasSeries, cyclesIndex, CYCLES_READING, HSI_BIAS_TRIGGER, HSI_MA_WINDOW,
  isTriggered, m2GdpGap, m2Yoy, M2_GAP_TRIGGER, monthPoints, monthShift, movingAverage,
  quarterEndMonth, relativeStrength, REL_WINDOW, rollingReturn, RRR_TRIGGER, RRR_WINDOW,
  rrrChange, SF_CHANGE_WINDOW, SF_YOY_TRIGGER, sfYoyChange, shFloatMcapOf, TURNOVER_TRIGGER, TURNOVER_WINDOW,
  turnoverSeries, VIX_TRIGGER, VIX_WINDOW, windowMax, type Point,
} from "../src/finance/cycles.ts";

const p = (date: string, value: number): Point => ({ date, value });
/** 第 i 天(2026-01-01 起;测试只关心顺序与数量,不关心真实交易日历) */
const dateAt = (i: number) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
const dates = (n: number, from = 1) => Array.from({ length: n }, (_, i) => dateAt(from + i - 1));

test("触发线与触发判定:只有「值 ≤ 触发线」这一条规则,没算出来就是 null", () => {
  assert.equal(TURNOVER_TRIGGER, 0.55);
  assert.equal(HSI_BIAS_TRIGGER, -10.6);
  assert.deepEqual([0.55, 0.549, 1.8].map((v) => isTriggered(v, 0.55)), [true, true, false]);
  assert.deepEqual([-10.6, -11.44, -3.52].map((v) => isTriggered(v, -10.6)), [true, true, false]);
  assert.equal(isTriggered(null, 0.55), null);
});

test("触发方向 gte:值 ≥ 触发线才算(VIX / 增速差 / 恒指强弱都是冲上去为底)", () => {
  assert.equal(SF_YOY_TRIGGER, 0.9);
  assert.equal(RRR_TRIGGER, -1.5);
  assert.equal(VIX_TRIGGER, 25.7);
  assert.equal(M2_GAP_TRIGGER, 8.0);
  assert.deepEqual([25.7, 25.71, 19.9].map((v) => isTriggered(v, 25.7, "gte")), [true, true, false]);
  assert.deepEqual([-1.5, -2.0, 0].map((v) => isTriggered(v, -1.5)), [true, true, false], "lte 方向不受影响");
  assert.equal(isTriggered(null, 25.7, "gte"), null);
});

test("月度序列:宏观证据的期间在 period(YYYY-MM),同月只留第一条,坐标取当月 1 日", () => {
  const ev = (field: string, period: string, value: number) => ({ field, period, value, as_of: "2026-11-11", record_key: period });
  const evs = [
    ev("social_financing_stock_yoy", "2026-10", 7.0),
    ev("social_financing_stock_yoy", "2026-09", 7.1),
    ev("social_financing_stock_yoy", "2026-09", 9.9), // 同月重复:取先出现的那条
    ev("other_field", "2026-09", 1),
    ev("social_financing_stock_yoy", "2026-9", 8), // 格式不对的期间不要
  ];
  const pts = monthPoints(evs, "social_financing_stock_yoy");
  assert.deepEqual(pts, [{ date: "2026-09-01", value: 7.1 }, { date: "2026-10-01", value: 7.0 }]);
});

test("月份平移:跨年也对", () => {
  assert.equal(monthShift("2026-10", -6), "2026-04");
  assert.equal(monthShift("2026-03", -6), "2025-09");
  assert.equal(monthShift("2026-01", -1), "2025-12");
});

test("社融同比 6 个月变化:本月同比 − 6 个月前同比;缺月就断,不硬凑", () => {
  const months = ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
  const vals = [8.0, 8.0, 8.0, 8.0, 8.0, 7.9, 7.8, 7.7, 7.6, 7.5, 7.3, 7.1];
  const yoy = months.map((m, i) => p(`${m}-01`, vals[i]!));
  const series = sfYoyChange(yoy);
  // 2026-03 缺 2025-09 对不上?在:8.0 → 7.9。2026-02 缺,所以只有存在「6 个月前」的月份才进序列
  const byMonth = new Map(series.map((s) => [s.date.slice(0, 7), s.value]));
  assert.equal(byMonth.get("2026-09"), -0.8, "7.1 − 7.9(2026-03);6 个月按日历月,不是错 6 个点");
  assert.equal(byMonth.get("2026-07"), -0.5, "7.5 − 8.0(2026-01)");
  assert.equal(byMonth.get("2026-08"), undefined, "6 个月前(2026-02)缺月的月份不算");
  assert.equal(series.length, 6);
});

test("准备金率 250 日变化:事件步进,取边界日之前最近的一次调整", () => {
  const events = [p("2023-09-15", 10.5), p("2024-02-05", 10.0), p("2024-09-27", 9.5), p("2025-05-15", 9.0)];
  // 交易日历整体挪到 2024-08 起:边界日落在 2024-02 与 2024-09 两次调整之间 → 取 2024-02-05 的 10.0
  const tradeDates = Array.from({ length: RRR_WINDOW }, (_, i) => dateAt(i - 500));
  const r = rrrChange(events, tradeDates);
  assert.equal(r.rateNow, 9.0);
  assert.equal(r.rateThen, 10.0);
  assert.equal(r.value, -1);
  // 交易日不够 250 就算不出来
  assert.equal(rrrChange(events, tradeDates.slice(0, 100)).value, null);
  // 边界日之前没有任何调整记录也算不出来(日历整体挪到 2012 年前后)
  const earlyDates = Array.from({ length: RRR_WINDOW }, (_, i) => dateAt(i - 5000));
  const r2 = rrrChange(events, earlyDates);
  assert.equal(r2.value, null);
  assert.equal(r2.rateThen, null);
});

test("窗口最高:VIX 冲高取近 60 个观测的最高;不满窗不给", () => {
  const pts = Array.from({ length: VIX_WINDOW - 1 }, (_, i) => p(dateAt(i), 15 + (i % 5)));
  assert.equal(windowMax(pts, VIX_WINDOW).max, null);
  const full = [...pts, p(dateAt(VIX_WINDOW - 1), 28.18)];
  const { max } = windowMax(full, VIX_WINDOW);
  assert.equal(max!.value, 28.18);
  assert.equal(max!.date, dateAt(VIX_WINDOW - 1));
});

test("M2 同比:本月 ÷ 去年同月 − 1;去年同月缺失就跳过", () => {
  // 2025-01 起按月排 18 个月:2025 年 300+i(300..311),2026 年 312+i(312..317)
  const balances = Array.from({ length: 18 }, (_, i) => p(new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 10), 300 + i));
  const yoy = m2Yoy(balances);
  assert.equal(yoy.length, 6, "只有 2026 年的 6 个月有去年同月");
  assert.equal(yoy[0]!.value, 4, "312 ÷ 300 − 1 = 4%");
  assert.equal(yoy[0]!.date, "2026-01-01");
  assert.equal(yoy[5]!.value, Math.round((317 / 305 - 1) * 100 * 100) / 100);
});

test("季度末月份:M2−GDP 差按 GDP 累计期的季度末对齐 M2 同比", () => {
  assert.equal(quarterEndMonth("2026年第1-3季度"), "2026-09");
  assert.equal(quarterEndMonth("2026年第1季度"), "2026-03");
  assert.equal(quarterEndMonth("2026年第1-4季度"), "2026-12");
  assert.equal(quarterEndMonth("格式坏了"), null);
  const m2yoy = [p("2026-09-01", 7.2), p("2026-06-01", 7.0)];
  const gdp = [{ period: "2026年第1-3季度", yoy: 4.6 }, { period: "2026年第1-2季度", yoy: 4.7 }, { period: "2025年第1-4季度", yoy: 5.0 }];
  const series = m2GdpGap(m2yoy, gdp);
  assert.deepEqual(series, [
    { date: "2026-09-01", value: 2.6 },
    { date: "2026-06-01", value: 2.3 },
  ], "按 gdp 入参顺序输出;2025-Q4 没有对得上的 M2 同比,跳过(视图侧会先按季度升序排好)");
});

test("恒指相对上证 60 日强弱:各按自己市场的 60 个交易日算涨幅,同一天都有值才相减", () => {
  const flat = dates(REL_WINDOW + 3).map((d) => p(d, 100));
  // 恒指最后一天涨 10%:60 日涨幅 = 10;上证横盘 = 0
  const hsi = [...flat.slice(0, -1), p(flat[flat.length - 1]!.date, 110)];
  const rel = relativeStrength(hsi, flat);
  assert.equal(rel.length, 3);
  assert.equal(rel[rel.length - 1]!.value, 10);
  // 上证缺最后一天:那天的强弱不算
  const shShort = flat.slice(0, -1);
  const rel2 = relativeStrength(hsi, shShort);
  assert.equal(rel2.length, 2);
});

test("均线:窗口不满不返回;滑动窗口按「自己往前 window 根」取均值", () => {
  const pts = [1, 2, 3, 4, 5].map((v, i) => p(dateAt(i), v));
  assert.deepEqual(movingAverage(pts, 6), []);
  const ma3 = movingAverage(pts, 3);
  assert.equal(ma3.length, 3);
  assert.deepEqual(ma3.map((x) => x.value), [2, 3, 4]);
  assert.equal(ma3[2]!.date, pts[4]!.date);
});

test("恒指 250 日乖离率:恒定价格序列的乖离是 0;单边下跌把乖离压到负", () => {
  const flat = dates(HSI_MA_WINDOW).map((d) => p(d, 25000));
  const b0 = biasSeries(flat);
  assert.equal(b0.series.length, 1);
  assert.equal(b0.series[0]!.value, 0);
  // 最后一天 24557.04、其余 249 天都是 25000:均线 = (249×25000 + 24557.04) ÷ 250
  const closes = [...flat.slice(1), p(dateAt(HSI_MA_WINDOW), 24557.04)];
  const b1 = biasSeries(closes);
  const ma = (249 * 25000 + 24557.04) / 250;
  assert.equal(b1.series[0]!.value, Math.round(((24557.04 / ma - 1) * 100) * 100) / 100);
  assert.ok(b1.ma[0]!.value > 0);
  assert.deepEqual(biasSeries(closes.slice(0, HSI_MA_WINDOW - 1)).series, [], "不够 250 根不给乖离");
});

test("换手率:成交额 ÷ 流通市值;流通市值反推不出来就整个不返回,不拿 0 顶上", () => {
  const amounts = [1000, 2000, 3000, 4000].map((v, i) => p(dateAt(i), v * 1e8));
  const { daily } = turnoverSeries(amounts, 40 * 1e12);
  assert.deepEqual(daily.map((x) => x.value), [0.25, 0.5, 0.75, 1]);
  assert.deepEqual(turnoverSeries(amounts, null), { daily: [], ma: [] });
  assert.deepEqual(turnoverSeries(amounts, 0), { daily: [], ma: [] });
});

test("换手率 20 日均:少一天都不算,不给「19 日均」冒充", () => {
  const amounts = Array.from({ length: TURNOVER_WINDOW - 1 }, (_, i) => p(dateAt(i), 1000 * 1e9));
  assert.deepEqual(turnoverSeries(amounts, 40 * 1e12).ma, []);
  const full = Array.from({ length: TURNOVER_WINDOW }, (_, i) => p(dateAt(i), 1000 * 1e9));
  const { ma } = turnoverSeries(full, 40 * 1e12);
  assert.deepEqual(ma.map((x) => x.value), [2.5]);
});

test("盘中没收完的那根成交额不进序列:信封里有 ma20_prior 就剔掉最后一根", () => {
  const ev = (field: string, as_of: string, value: number) => ({ field, as_of, value, record_key: `amount|${as_of}` });
  const amounts = [1, 2, 3, 4].map((v, i) => ev("market_amount_total", dateAt(i), v * 1e12));
  const closed = amountsOf(amounts);
  assert.equal(closed.amounts.length, 4);
  assert.equal(closed.openBar, false);
  // 今天这根只跑了半天:信封里带着「不含今天的 20 日均」(ma20_prior)就是信号
  const intraday = [...amounts, ev("market_amount_ma20_prior", dateAt(2), 2 * 1e12)];
  const open = amountsOf(intraday);
  assert.equal(open.openBar, true);
  assert.deepEqual(open.amounts.map((x) => x.date), dateAt(0) && [dateAt(0), dateAt(1), dateAt(2)]);
});

test("换手率改上证口径:分子取 market_amount_sh,不拿两市合计冒充", () => {
  const ev = (field: string, as_of: string, value: number) => ({ field, as_of, value, record_key: `${field}|${as_of}` });
  const rows = [
    ev("market_amount_total", dateAt(0), 15000 * 1e8),
    ev("market_amount_sh", dateAt(0), 6700 * 1e8),
    ev("market_amount_sz", dateAt(0), 8300 * 1e8),
  ];
  assert.deepEqual(amountsOf(rows, "market_amount_sh").amounts.map((x) => x.value), [6700 * 1e8]);
  assert.deepEqual(amountsOf(rows).amounts.map((x) => x.value), [15000 * 1e8], "默认还是两市合计");
});

test("沪市流通市值:优先用合计行(17);没有合计才把板块行加总;亿元换元,别差 1 亿倍", () => {
  const row = (code: string, yi: number) => ({ field: "sse_float_market_value", value: yi, as_of: "2026-11-11", record_key: `sse|${code}` });
  // 合计行 579481.82 亿元 = 57.9 万亿元,直接可用
  const total = shFloatMcapOf([row("01", 485092.18), row("03", 93672.84), row("17", 579481.82)]);
  assert.ok(Math.abs(total.value! - 579481.82 * 1e8) < 1e6);
  assert.equal(total.date, "2026-11-11");
  // 只有板块行时加总(01 + 02 + 03,含 B 股,和上证综指口径对齐)
  const summed = shFloatMcapOf([row("01", 485092.18), row("02", 716.79), row("03", 93672.84)]);
  assert.ok(Math.abs(summed.value! - (485092.18 + 716.79 + 93672.84) * 1e8) < 1e6);
  // 一行都没有:不拿 0 顶上
  assert.deepEqual(shFloatMcapOf([{ field: "sse_trade_amount", value: 7376.36, as_of: "2026-11-11" }]), { value: null, date: null });
});

test("上证换手率与交易所同表口径对得上:579481.82 亿流通市值 + 7361.5 亿成交额 ≈ 1.27%", () => {
  // 上交所每日概况 2026-11-11:沪市合计流通市值 579481.82 亿元、成交额 7376.36 亿元、交易所给的流通口径换手率 1.2729%
  const mcap = 579481.82 * 1e8;
  const { daily } = turnoverSeries([p("2026-11-11", 7361.5 * 1e8)], mcap);
  assert.equal(Math.round(daily[0]!.value * 100) / 100, 1.27);
  const official = 7376.36 / 579481.82 * 100;
  assert.ok(Math.abs(official - 1.2729) < 0.01, "交易所原值 = 成交额 ÷ 流通市值");
});

test("视图已注册,读法护栏由后端随数据下发", () => {
  assert.ok(listViews().some((v) => v.id === "cycles"));
  assert.match(CYCLES_READING, /不是预测/);
  assert.match(CYCLES_READING, /不构成任何买卖建议/);
});

test("视图:两个端点都失败时如实报缺口,不编数值", async () => {
  // repoRoot 指向一个没有取数脚本的位置 → fetchEndpoint 会抛错,走 gaps 分支
  const ctx = { repoRoot: "/nonexistent", dataRoot: "/tmp/vr-cycles-test", python: "python3", node: process.execPath };
  const r = await cyclesIndex(ctx, {}, new AbortController().signal);
  assert.equal(r.available_count, 0);
  assert.equal(r.triggered_count, 0);
  assert.equal(r.signal, "none");
  assert.ok(r.gaps.length >= 2, JSON.stringify(r.gaps));
  for (const m of r.metrics) {
    assert.equal(m.value, null);
    assert.equal(m.triggered, null);
    assert.ok(m.gaps.length > 0, `${m.id} 没算出来要写原因`);
  }
});
