/**
 * 周期指标:用长周期极端值复核「A 股是不是已经进入熊市底部区域」。
 *
 * 🔴 这里**不是预测**,也不给买卖建议:模型只给了一条触发线,本视图做的是**口径可复算的复核** ——
 *    每个指标怎么算、用的是哪一天的数据、离触发线还有多远,全部随数据一起下发到页面。
 * 🔴 取数只用登记端点,不做任何"凭印象补数":
 *    上证指数成交额 → `em_market_trend`(逐日 `market_amount_sh`,元);
 *    沪市流通市值 → `sse_market_overview`(上交所每日概况,沪市合计一行,亿元;换手率也是交易所同表原值);
 *    恒生指数收盘 → `em_southbound_flow`(港股通每个交易日都带 `hsi_close`;tx_kline 只认 A 股代码,港股走不了);
 *    上证收盘 → `tx_kline`(sh000001,detail 逐根;同时提供 A 股 250 个交易日的日历);
 *    社融存量同比 → `pboc_social_financing_stock`(官方增速,当年 + 上一年两张表);
 *    M2 余额 → `pboc_money_supply`(当年 + 上一年,同比自算,官方口径调整时与公布值有出入);
 *    存款准备金率 → `em_macro_rrr`(东财,历次调整事件);
 *    GDP 累计同比 → `em_macro_gdp`(东财,现价累计);
 *    VIX 收盘 → `fred_us_macro`(FRED 的 VIXCLS 日序列,detail 逐观测点)。
 *
 * 目前接入的七项核心指标(触发线由用户在 2026-11-11 给定,不是本产品自己推出来的):
 *   ① 上证换手率 20 日均 ≤ 0.55%(2026-11-12 按用户要求从「A 股换手率」改成上证单市场口径)
 *   ② 恒生指数 250 日乖离率 ≤ −10.6%
 *   ③ 社融存量同比 6 个月变化 ≥ +0.9 个百分点
 *   ④ 大型存款类准备金率 250 个交易日变化 ≤ −1.5 个百分点
 *   ⑤ VIX 近 60 个交易日收盘最高 ≥ 25.7(冲高为底,所以取窗口最高而不是最新值)
 *   ⑥ M2 同比 − GDP 现价累计同比 ≥ +8.0 个百分点
 *   ⑦ 恒指 60 日涨幅 − 上证 60 日涨幅 ≥ +14.6 个百分点
 */
import { fetchEndpoint, ServiceError, type ServiceContext } from "../service.ts";

/** 触发线(模型口径,单位见各项)。改这里就等于改模型的判定标准,别在页面里另写一份。 */
export const TURNOVER_TRIGGER = 0.55;
export const HSI_BIAS_TRIGGER = -10.6;
export const SF_YOY_TRIGGER = 0.9;
export const RRR_TRIGGER = -1.5;
export const VIX_TRIGGER = 25.7;
export const M2_GAP_TRIGGER = 8.0;
export const HSI_SH_TRIGGER = 14.6;
export const TURNOVER_WINDOW = 20;
export const HSI_MA_WINDOW = 250;
export const SF_CHANGE_WINDOW = 6;
export const RRR_WINDOW = 250;
export const VIX_WINDOW = 60;
export const REL_WINDOW = 60;

/** 盘中成交额还会变:缓存最多用 10 分钟(和异动接近度同一档) */
const MAX_AGE_MS = 10 * 60 * 1000;
/** 南向资金要 250 个交易日以上才能算 250 日均线,多取 150 天做缓冲(港股休市日不返回) */
const SOUTHBOUND_PAGE = 420;

export interface Point {
  date: string;
  value: number;
}

export interface CyclesMetric {
  id: "turnover20" | "hsi_bias250" | "sf_yoy_6m" | "rrr_chg_250d" | "vix_spike" | "m2_gdp_gap" | "hsi_sh_rel_60d";
  label: string;
  /** 当前值(单位见 unit) */
  value: number | null;
  unit: string;
  /** 触发线 */
  trigger: number;
  /** 触发方向:lte = 值 ≤ 触发线(跌出来的底),gte = 值 ≥ 触发线(涨/冲出来的底) */
  direction: "lte" | "gte";
  /** 值 ≤(或 ≥)触发线 */
  triggered: boolean | null;
  /** 值对应的交易日 / 观测期 */
  as_of: string | null;
  /** 指标自身序列,画线用 */
  series: Point[];
  /** 只有换手率有:逐日换手率(未平滑),用来对照 20 日均 */
  daily?: Point[];
  /** 只有恒指乖离有:最新收盘与 250 日均线(点) */
  close?: number | null;
  ma?: number | null;
  /** 辅助读数(照抄展示,不参与判定) */
  aux?: { label: string; text: string }[];
  /** 这一项怎么算的(页面照抄,不许改写成别的意思) */
  formula: string;
  source: string;
  gaps: string[];
}

export interface CyclesResult {
  metrics: CyclesMetric[];
  /** 已触发的指标数 / 能算出来的指标数 */
  triggered_count: number;
  available_count: number;
  /** none = 一项都没触发;partial = 触发了但不是全部;all = 全部触发 */
  signal: "none" | "partial" | "all";
  fetched_at: string | null;
  cached: boolean;
  generated_at: string;
  gaps: string[];
  /**
   * 读法:指标进过触发区不等于底部到了,也不等于之后不会再跌 ——
   * 这条文字由后端给,页面照抄,别只写在提示词里。
   */
  reading: string;
}

export const CYCLES_READING =
  "读法:这些是长周期极端值的复核,不是预测。指标进入触发区,历史上常出现在熊市底部附近,但触发之后指数仍可能继续下跌、"
  + "也可能长时间不触发;模型要求全部核心指标同时触发才算「底部信号」,没算出来的指标这一轮不参与判定。不构成任何买卖建议。";

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface Ev { field?: unknown; value?: unknown; as_of?: unknown; period?: unknown; record_key?: unknown }
interface Env { status?: unknown; evidence?: unknown; extra?: Record<string, unknown> }

function evidenceOf(env: unknown): Ev[] {
  const evs = env && typeof env === "object" ? (env as Env).evidence : undefined;
  return Array.isArray(evs) ? (evs as Ev[]) : [];
}

/** 按 as_of 升序、同日只留第一条(源按日期倒序返回,先出现的才是最新的那条) */
export function pointsOf(evs: Ev[], field: string): Point[] {
  const by = new Map<string, number>();
  for (const e of evs) {
    if (e.field !== field) continue;
    const date = isDate(e.as_of) ? e.as_of : "";
    const v = numOf(e.value);
    if (!date || v === null) continue;
    if (!by.has(date)) by.set(date, v);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, value]) => ({ date, value }));
}

/** 简单移动平均:前 window-1 个点没有均线,不返回(不拿不足窗的均值冒充) */
export function movingAverage(points: Point[], window: number): Point[] {
  if (window < 1 || points.length < window) return [];
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i]!.value;
    if (i >= window) sum -= points[i - window]!.value;
    if (i >= window - 1) out.push({ date: points[i]!.date, value: sum / window });
  }
  return out;
}

/**
 * 逐日换手率 = 当日**上证指数成交额** ÷ 沪市流通市值;20 日均 = 最近 20 个交易日换手率的算术平均。
 * 分母只有一个(取最近一个交易日的沪市合计流通市值):逐日流通市值没有登记端点(上交所每日概况一次只查一天),
 * 这一项误差与市值漂移同阶,页面必须一起写出来 —— 不能把换算结果说得比它实际精确。
 */
export function turnoverSeries(amounts: Point[], floatMcap: number | null): { daily: Point[]; ma: Point[] } {
  if (floatMcap === null || !(floatMcap > 0)) return { daily: [], ma: [] };
  const daily = amounts.map((a) => ({ date: a.date, value: round((a.value / floatMcap) * 100, 4) }));
  return { daily, ma: movingAverage(daily, TURNOVER_WINDOW).map((p) => ({ ...p, value: round(p.value, 4) })) };
}

/**
 * 乖离率 = 收盘 ÷ 250 日收盘均线 − 1(按 % 记)。均线是**滚动**的:每个交易日的均线都取它自己往前 250 根,
 * 不是拿一条固定的均线去套整段历史。
 */
export function biasSeries(closes: Point[], window = HSI_MA_WINDOW): { series: Point[]; ma: Point[] } {
  const ma = movingAverage(closes, window);
  if (!ma.length) return { series: [], ma: [] };
  const start = closes.length - ma.length;
  const series = ma.map((m, i) => ({ date: m.date, value: round((closes[start + i]!.value / m.value - 1) * 100, 2) }));
  return { series, ma };
}

/** 触发判定只有一条规则:lte = 值 ≤ 触发线;gte = 值 ≥ 触发线(两类底的极端方向不同) */
export function isTriggered(value: number | null, trigger: number, direction: "lte" | "gte" = "lte"): boolean | null {
  return value === null ? null : direction === "lte" ? value <= trigger : value >= trigger;
}

const f2 = (v: number) => round(v, 2).toFixed(2);

/** 月度序列:宏观证据的 as_of 是取数日,真正的期间在 period(YYYY-MM) → 以「当月 1 日」当坐标 */
export function monthPoints(evs: Ev[], field: string): Point[] {
  const by = new Map<string, number>();
  for (const e of evs) {
    if (e.field !== field) continue;
    const p = typeof e.period === "string" ? e.period : "";
    if (!/^\d{4}-\d{2}$/.test(p)) continue;
    const v = numOf(e.value);
    if (v === null || by.has(p)) continue;
    by.set(p, v);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, value]) => ({ date: `${month}-01`, value }));
}

/** 月份平移:"2026-10" 往前 6 个月 → "2026-04"(跨年也对) */
export function monthShift(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** 社融存量同比的 N 个月变化:同一张表口径里,本月同比 − N 个月前同比(个月按日历月,缺月就不算) */
export function sfYoyChange(yoy: Point[], window = SF_CHANGE_WINDOW): Point[] {
  const by = new Map(yoy.map((p) => [p.date.slice(0, 7), p.value]));
  const out: Point[] = [];
  for (const p of yoy) {
    const month = p.date.slice(0, 7);
    const prev = by.get(monthShift(month, -window));
    if (prev !== undefined) out.push({ date: `${month}-01`, value: round(p.value - prev, 2) });
  }
  return out;
}

/** 准备金率是事件序列:现值 − 250 个交易日前的现值(交易日历来自上证日线)。boundary 交易日之前没有调整记录就算不出来 */
export function rrrChange(events: Point[], tradeDates: string[], window = RRR_WINDOW): { value: number | null; boundary: string | null; rateNow: number | null; rateThen: number | null; series: Point[] } {
  const series = [...events].sort((a, b) => a.date.localeCompare(b.date));
  if (!series.length || tradeDates.length < window) return { value: null, boundary: null, rateNow: null, rateThen: null, series };
  const boundary = tradeDates[tradeDates.length - window]!;
  const now = series[series.length - 1]!;
  const then = [...series].reverse().find((e) => e.date <= boundary);
  if (!then) return { value: null, boundary, rateNow: now.value, rateThen: null, series };
  return { value: round(now.value - then.value, 2), boundary, rateNow: now.value, rateThen: then.value, series };
}

/** 窗口最高:「冲高为底」类指标取近 window 个观测的最高值(不满窗不给,不拿短窗冒充) */
export function windowMax(points: Point[], window: number): { max: Point | null; series: Point[] } {
  if (points.length < window) return { max: null, series: points };
  const slice = points.slice(-window);
  return { max: slice.reduce((m, p) => (p.value > m.value ? p : m), slice[0]!), series: points };
}

/** M2 同比:本月余额 ÷ 去年同月余额 − 1(官方口径调整时与公布值有出入,误差写进口径) */
export function m2Yoy(balances: Point[]): Point[] {
  const by = new Map(balances.map((p) => [p.date.slice(0, 7), p.value]));
  const out: Point[] = [];
  for (const p of balances) {
    const month = p.date.slice(0, 7);
    const prev = by.get(monthShift(month, -12));
    if (prev !== undefined && prev > 0) out.push({ date: `${month}-01`, value: round((p.value / prev - 1) * 100, 2) });
  }
  return out;
}

/** 「2026年第1-3季度」→ 该季度末所在月 "2026-09";解析不了返回 null */
export function quarterEndMonth(period: string): string | null {
  const m = /^(\d{4})年第(?:\d+-)?(\d+)季度$/.exec(period);
  return m ? `${m[1]}-${String(Number(m[2]) * 3).padStart(2, "0")}` : null;
}

/** M2 − GDP 增速差序列:每个 GDP 累计期,用该季度末月份的 M2 同比减 GDP 累计同比;M2 缺月就跳过那一期 */
export function m2GdpGap(m2yoy: Point[], gdp: { period: string; yoy: number | null }[]): Point[] {
  const by = new Map(m2yoy.map((p) => [p.date.slice(0, 7), p.value]));
  const out: Point[] = [];
  for (const g of gdp) {
    const month = quarterEndMonth(g.period);
    const m2 = month ? by.get(month) : undefined;
    if (m2 !== undefined && g.yoy !== null) out.push({ date: `${month}-01`, value: round(m2 - g.yoy, 2) });
  }
  return out;
}

/** 滚动 N 日涨幅(%),按各自市场的交易日算 */
export function rollingReturn(closes: Point[], window: number): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = window; i < closes.length; i++) out.set(closes[i]!.date, round((closes[i]!.value / closes[i - window]!.value - 1) * 100, 2));
  return out;
}

/** 恒指相对上证的 60 日强弱 = 恒指 60 日涨幅 − 上证 60 日涨幅;两个市场同一天都有值才进序列 */
export function relativeStrength(hsi: Point[], sh: Point[], window = REL_WINDOW): Point[] {
  const a = rollingReturn(hsi, window);
  const b = rollingReturn(sh, window);
  const out: Point[] = [];
  for (const [date, ra] of [...a.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const rb = b.get(date);
    if (rb !== undefined) out.push({ date, value: round(ra - rb, 2) });
  }
  return out;
}

export interface AmountsRead { amounts: Point[]; openBar: boolean }

/**
 * 成交额序列(默认两市合计;换手率用 `market_amount_sh` 取上证自己那一份)。盘中的最后一根没收完,
 * 参与 20 日均会把均值压低 —— 信封里出现 `market_amount_ma20_prior`(= 不含今天那根的均值)就说明
 * 最后一根是今天且还没收完,把它剔掉。
 */
export function amountsOf(evs: Ev[], field = "market_amount_total"): AmountsRead {
  const amounts = pointsOf(evs, field);
  const openBar = amounts.length > 0 && evs.some((e) => e.field === "market_amount_ma20_prior");
  return { amounts: openBar ? amounts.slice(0, -1) : amounts, openBar };
}

/**
 * 沪市流通市值(元)。上交所每日概况按产品行给(01 主板 A 股 / 02 B 股 / 03 科创板 / 17 合计),
 * 优先用合计行;只有分板块时才加总(含 B 股,和上证综指「沪市全部股票」的口径对齐)。
 * 🔴 源单位是亿元,这里换成元 —— 成交额证据是元,单位不统一会把换手率算错 1 亿倍。
 */
export function shFloatMcapOf(evs: Ev[]): { value: number | null; date: string | null } {
  const rows = evs.filter((e) => e.field === "sse_float_market_value");
  const total = numOf(rows.find((e) => e.record_key === "sse|17")?.value);
  const parts = rows.filter((e) => e.record_key !== "sse|17");
  const sum = parts.reduce((acc, e) => acc + (numOf(e.value) ?? 0), 0);
  const yi = total ?? (parts.length ? sum : null);
  const date = rows.map((e) => e.as_of).find(isDate) ?? null;
  return { value: yi === null || !(yi > 0) ? null : yi * 1e8, date };
}

export async function cyclesIndex(
  ctx: ServiceContext,
  query: Record<string, string>,
  signal: AbortSignal,
  now = new Date(),
): Promise<CyclesResult> {
  if (query.refresh !== undefined && query.refresh !== "1") throw new ServiceError("bad_query", "refresh 只能是 1");
  const consistency = query.refresh === "1"
    ? { mode: "fresh" as const }
    : { mode: "prefer_cache" as const, max_age_ms: MAX_AGE_MS };
  const gaps: string[] = [];
  const fetchedAt: string[] = [];
  let cached = false;

  const pull = async (endpoint: string, args?: Record<string, unknown>, symbol?: string) => {
    try {
      const r = await fetchEndpoint(ctx, { endpoint, symbol, args, consistency, signal });
      fetchedAt.push(r.fetched_at);
      cached ||= r.cached;
      const env = r.envelope as Env;
      if (env?.status === "failed") {
        const why = typeof (env as { reason?: unknown }).reason === "string" ? String((env as { reason?: unknown }).reason) : "上游没回数据";
        gaps.push(`${endpoint} 没取到:${why.slice(0, 80)}`);
        return null;
      }
      return env;
    } catch (e) {
      if (signal.aborted) throw e;
      gaps.push(`${endpoint} 没取到:${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
      return null;
    }
  };

  const year = now.getFullYear();
  /** 中国时区(UTC+8)的今天;盘中的最后一根 K 线还没定,别让它混进 60 日涨幅和交易日历 */
  const cn = new Date(now.getTime() + 8 * 3600 * 1000);
  const cnToday = cn.toISOString().slice(0, 10);
  const cnIntraday = cn.getUTCHours() < 16 || (cn.getUTCHours() === 16 && cn.getUTCMinutes() < 5);
  const dropLiveBar = (points: Point[]): Point[] => (cnIntraday ? points.filter((p) => p.date < cnToday) : points);

  const [trend, sse, south, sfCur, sfPrev, moneyCur, moneyPrev, rrrEnv, gdpEnv, vixEnv, shK] = await Promise.all([
    pull("em_market_trend", { days: 120 }),
    pull("sse_market_overview", {}),
    pull("em_southbound_flow", { channel: "all", page_size: SOUTHBOUND_PAGE }),
    pull("pboc_social_financing_stock", { year }),
    pull("pboc_social_financing_stock", { year: year - 1 }),
    pull("pboc_money_supply", { year }),
    pull("pboc_money_supply", { year: year - 1 }),
    pull("em_macro_rrr", { limit: 100 }),
    pull("em_macro_gdp", { limit: 40 }),
    pull("fred_us_macro", { series: "VIXCLS", start: `${year - 1}-01-01`, detail: true }),
    pull("tx_kline", { count: 270, detail: true }, "sh000001"),
  ]);

  // ── ① 上证换手率 20 日均 ──
  const turnoverGaps: string[] = [];
  const turnoverSource = "成交额:上证指数逐日成交额(em_market_trend 的 market_amount_sh);流通市值:上交所每日概况(sse_market_overview,沪市合计)";
  let turnover: CyclesMetric = {
    id: "turnover20", label: "上证换手率 20 日均", value: null, unit: "%", trigger: TURNOVER_TRIGGER, direction: "lte", triggered: null,
    as_of: null, series: [], daily: [],
    formula: "换手率 = 上证指数当日成交额 ÷ 沪市流通市值;20 日均 = 最近 20 个交易日换手率的算术平均",
    source: turnoverSource, gaps: turnoverGaps,
  };
  let shFloatMcap: number | null = null;
  let sseDate: string | null = null;
  if (trend) {
    const mcap = shFloatMcapOf(evidenceOf(sse));
    shFloatMcap = mcap.value;
    sseDate = mcap.date;
    const { amounts, openBar } = amountsOf(evidenceOf(trend), "market_amount_sh");
    if (openBar) turnoverGaps.push("今天这一根成交额还没收完,没算进序列(均值取到上一个交易日)");
    const { daily, ma } = turnoverSeries(amounts, shFloatMcap);
    if (!daily.length) {
      turnoverGaps.push(sse
        ? "沪市流通市值没取到(上交所每日概况缺沪市合计行),换手率没算"
        : "上交所每日概况没取到,拿不到沪市流通市值,换手率没算");
    } else if (!ma.length) {
      turnoverGaps.push(`成交额只有 ${daily.length} 个交易日,不够 ${TURNOVER_WINDOW} 日均线`);
    } else {
      const last = ma[ma.length - 1]!;
      turnover = {
        ...turnover, value: round(last.value, 2), as_of: last.date, series: ma, daily,
        triggered: isTriggered(round(last.value, 2), TURNOVER_TRIGGER),
      };
    }
    if (shFloatMcap !== null) {
      turnover.formula += `;分母取 ${sseDate ?? "最近一个交易日"} 的沪市流通市值约 ${(shFloatMcap / 1e12).toFixed(1)} 万亿元`
        + "(上交所每日概况的沪市合计),逐日市值漂移没有还原";
    }
  }
  if (!trend) turnoverGaps.push("成交额没取到,换手率这一项这一轮算不出来");

  // ── ② 恒指 250 日乖离率 ──
  const biasGaps: string[] = [];
  let bias: CyclesMetric = {
    id: "hsi_bias250", label: "恒生指数 250 日乖离率", value: null, unit: "%", trigger: HSI_BIAS_TRIGGER, direction: "lte", triggered: null,
    as_of: null, series: [], close: null, ma: null,
    formula: "乖离率 = 恒生指数收盘 ÷ 250 日收盘均线 − 1(每个交易日的均线取它自己往前 250 根)",
    source: "恒指收盘:东财南向资金每日成交里的恒指点位(em_southbound_flow)", gaps: biasGaps,
  };
  if (south) {
    const closes = pointsOf(evidenceOf(south), "hsi_close");
    const { series, ma } = biasSeries(closes);
    if (!series.length) {
      biasGaps.push(`恒指收盘只有 ${closes.length} 个交易日,不够 ${HSI_MA_WINDOW} 日均线`);
    } else {
      const last = series[series.length - 1]!;
      const lastMa = ma[ma.length - 1]!;
      bias = {
        ...bias, value: last.value, as_of: last.date, series,
        close: round(closes[closes.length - 1]!.value, 2), ma: round(lastMa.value, 2),
        triggered: isTriggered(last.value, HSI_BIAS_TRIGGER),
      };
      const low = series.reduce((m, p) => (p.value < m.value ? p : m), series[0]!);
      biasGaps.push(`窗口内最低 ${f2(low.value)}%(${low.date},序列起于 ${series[0]!.date})`);
    }
  } else {
    biasGaps.push("恒指收盘没取到(南向资金端点这一轮没回),乖离率算不出来");
  }

  // ── ③ 社融存量同比 6 个月变化 ──
  const sfGaps: string[] = [];
  let sf: CyclesMetric = {
    id: "sf_yoy_6m", label: "社融存量同比 6 个月变化", value: null, unit: "百分点", trigger: SF_YOY_TRIGGER, direction: "gte", triggered: null,
    as_of: null, series: [], gaps: sfGaps,
    formula: "官方社融存量同比增速(人民银行存量统计表)本月值 − 6 个月前值;6 个月按日历月",
    source: "人民银行社融存量统计表(pboc_social_financing_stock,当年 + 上一年)",
  };
  if (sfCur && sfPrev) {
    const yoy = [...monthPoints(evidenceOf(sfPrev), "social_financing_stock_yoy"), ...monthPoints(evidenceOf(sfCur), "social_financing_stock_yoy")];
    const series = sfYoyChange(yoy);
    if (!series.length) {
      sfGaps.push(`同比序列只有 ${yoy.length} 个月,不足 ${SF_CHANGE_WINDOW + 1} 个月,6 个月变化算不出来`);
    } else {
      const last = series[series.length - 1]!;
      sf = {
        ...sf, value: last.value, as_of: last.date, series,
        triggered: isTriggered(last.value, SF_YOY_TRIGGER, "gte"),
        aux: [
          { label: "最新", text: `${f2(yoy[yoy.length - 1]!.value)}%(${yoy[yoy.length - 1]!.date.slice(0, 7)})` },
          { label: "6 个月前", text: `${f2(yoy[yoy.length - 1 - SF_CHANGE_WINDOW]!.value)}%(${yoy[yoy.length - 1 - SF_CHANGE_WINDOW]!.date.slice(0, 7)})` },
        ],
      };
    }
  } else {
    sfGaps.push("社融存量表没取到(当年或上一年),这一项算不出来");
  }

  // ── ④ 大型存款类准备金率 250 个交易日变化 ──
  const rrrGaps: string[] = [];
  let rrr: CyclesMetric = {
    id: "rrr_chg_250d", label: "存款准备金率 250 日变化(大型)", value: null, unit: "百分点", trigger: RRR_TRIGGER, direction: "lte", triggered: null,
    as_of: null, series: [], gaps: rrrGaps,
    formula: "大型存款类金融机构现行准备金率 − 250 个交易日前的现行准备金率(准备金率按调整事件步进,交易日历取自上证日线)",
    source: "东财 datacenter 存款准备金率调整表(em_macro_rrr);上证日线(tx_kline)",
  };
  const shCloses = shK ? dropLiveBar(pointsOf(evidenceOf(shK), "kline_close")) : [];
  if (rrrEnv && shCloses.length >= RRR_WINDOW) {
    const events = pointsOf(evidenceOf(rrrEnv), "rrr_rate_big");
    const { value, boundary, rateNow, rateThen, series } = rrrChange(events, shCloses.map((p) => p.date));
    if (value === null || rateThen === null || rateNow === null) {
      rrrGaps.push(`调整事件只有 ${events.length} 次、或 ${boundary} 之前没有记录,250 日变化算不出来`);
    } else {
      rrr = {
        ...rrr, value, as_of: series[series.length - 1]!.date, series,
        triggered: isTriggered(value, RRR_TRIGGER, "lte"),
        aux: [
          { label: "现行", text: `${f2(rateNow)}%(生效 ${series[series.length - 1]!.date})` },
          { label: `${RRR_WINDOW} 个交易日前`, text: `${f2(rateThen)}%(截至 ${boundary})` },
        ],
      };
    }
  } else {
    rrrGaps.push(rrrEnv
      ? `上证日线只有 ${shCloses.length} 根,凑不齐 ${RRR_WINDOW} 个交易日的日历`
      : "准备金率调整表没取到,这一项算不出来");
  }

  // ── ⑤ VIX 冲高(近 60 个交易日收盘最高) ──
  const vixGaps: string[] = [];
  let vix: CyclesMetric = {
    id: "vix_spike", label: "VIX 恐慌冲高(近 60 日收盘最高)", value: null, unit: "点", trigger: VIX_TRIGGER, direction: "gte", triggered: null,
    as_of: null, series: [], gaps: vixGaps,
    formula: `近 ${VIX_WINDOW} 个交易日 VIX 收盘最高值;冲高为底,所以取窗口最高而不是最新值(最新值在辅助读数里)`,
    source: "FRED 的 VIXCLS 日序列(fred_us_macro)",
  };
  if (vixEnv) {
    const closes = pointsOf(evidenceOf(vixEnv), "us_vix_close");
    const { max, series } = windowMax(closes, VIX_WINDOW);
    if (!max) {
      vixGaps.push(`VIX 收盘只有 ${closes.length} 个观测,不足 ${VIX_WINDOW} 日窗口`);
    } else {
      const latest = closes[closes.length - 1]!;
      vix = {
        ...vix, value: round(max.value, 2), as_of: max.date, series,
        triggered: isTriggered(round(max.value, 2), VIX_TRIGGER, "gte"),
        aux: [{ label: "最新收盘", text: `${f2(latest.value)}(${latest.date})` }],
      };
    }
  } else {
    vixGaps.push("VIX 序列没取到(FRED 这一轮没回),这一项算不出来");
  }

  // ── ⑥ M2 同比 − GDP 现价累计同比 ──
  const gapGaps: string[] = [];
  let gap: CyclesMetric = {
    id: "m2_gdp_gap", label: "M2 同比 − GDP 累计同比", value: null, unit: "百分点", trigger: M2_GAP_TRIGGER, direction: "gte", triggered: null,
    as_of: null, series: [], gaps: gapGaps,
    formula: "M2 同比(月末余额 ÷ 去年同月余额 − 1,自算)− GDP 现价累计同比(统计局口径);增速差越宽越接近底",
    source: "人民银行货币供应量表(pboc_money_supply,当年 + 上一年);东财 GDP 季度累计(em_macro_gdp)",
  };
  if (moneyCur && moneyPrev && gdpEnv) {
    const m2yoy = m2Yoy([...monthPoints(evidenceOf(moneyPrev), "m2_balance"), ...monthPoints(evidenceOf(moneyCur), "m2_balance")]);
    const gdpRows = evidenceOf(gdpEnv)
      .filter((e) => e.field === "gdp_cum_yoy" && typeof e.period === "string")
      .map((e) => ({ period: e.period as string, yoy: numOf(e.value) }))
      .filter((r, i, arr) => arr.findIndex((x) => x.period === r.period) === i)
      .sort((a, b) => (quarterEndMonth(a.period) ?? "").localeCompare(quarterEndMonth(b.period) ?? ""));
    const series = m2GdpGap(m2yoy, gdpRows);
    if (!series.length) {
      gapGaps.push(`M2 同比只有 ${m2yoy.length} 个月(需要去年同月起)或 GDP 同比缺失,增速差算不出来`);
    } else {
      const last = series[series.length - 1]!;
      const lastM2 = m2yoy[m2yoy.length - 1]!;
      const lastGdp = gdpRows[gdpRows.length - 1]!;
      gap = {
        ...gap, value: last.value, as_of: last.date, series,
        triggered: isTriggered(last.value, M2_GAP_TRIGGER, "gte"),
        aux: [
          { label: "M2 同比", text: `${f2(lastM2.value)}%(${lastM2.date.slice(0, 7)})` },
          { label: "GDP 累计同比", text: `${f2(lastGdp.yoy!)}%(${lastGdp.period})` },
        ],
      };
      gapGaps.push("M2 同比由余额自算,官方口径调整时与公布值有出入");
    }
  } else {
    gapGaps.push("货币供应量表或 GDP 表没取到,这一项算不出来");
  }

  // ── ⑦ 恒指 60 日涨幅 − 上证 60 日涨幅 ──
  const relGaps: string[] = [];
  let rel: CyclesMetric = {
    id: "hsi_sh_rel_60d", label: "恒指相对上证 60 日强弱", value: null, unit: "百分点", trigger: HSI_SH_TRIGGER, direction: "gte", triggered: null,
    as_of: null, series: [], gaps: relGaps,
    formula: `恒生指数 ${REL_WINDOW} 日涨幅 − 上证指数 ${REL_WINDOW} 日涨幅(各按自己市场的交易日);恒指走强为底`,
    source: "恒指收盘:南向资金每日成交(em_southbound_flow);上证日线:腾讯 K 线(tx_kline)",
  };
  const hsiCloses = south ? dropLiveBar(pointsOf(evidenceOf(south), "hsi_close")) : [];
  if (hsiCloses.length > REL_WINDOW && shCloses.length > REL_WINDOW) {
    const series = relativeStrength(hsiCloses, shCloses);
    if (!series.length) {
      relGaps.push(`两个指数的重叠交易日只有 ${series.length} 天,60 日强弱算不出来`);
    } else {
      const last = series[series.length - 1]!;
      const hsiRet = rollingReturn(hsiCloses, REL_WINDOW).get(last.date)!;
      const shRet = rollingReturn(shCloses, REL_WINDOW).get(last.date)!;
      rel = {
        ...rel, value: last.value, as_of: last.date, series,
        triggered: isTriggered(last.value, HSI_SH_TRIGGER, "gte"),
        aux: [
          { label: "恒指 60 日", text: `${f2(hsiRet)}%` },
          { label: "上证 60 日", text: `${f2(shRet)}%` },
        ],
      };
    }
  } else {
    relGaps.push(`恒指收盘 ${hsiCloses.length} 根 / 上证收盘 ${shCloses.length} 根,都不够 ${REL_WINDOW} 日涨幅`);
  }

  const metrics = [turnover, bias, sf, rrr, vix, gap, rel];
  const available = metrics.filter((m) => m.value !== null);
  const triggered = available.filter((m) => m.triggered === true);
  const stage: CyclesResult["signal"] = triggered.length === 0 ? "none" : triggered.length === available.length ? "all" : "partial";
  if (available.length < metrics.length) gaps.push(`${metrics.length} 项里有 ${metrics.length - available.length} 项这一轮没算出来,结论只能按算出来的那几项看`);

  return {
    metrics,
    triggered_count: triggered.length,
    available_count: available.length,
    signal: stage,
    fetched_at: fetchedAt.length ? fetchedAt.sort()[fetchedAt.length - 1]! : null,
    cached,
    generated_at: now.toISOString(),
    gaps,
    reading: CYCLES_READING,
  };
}
