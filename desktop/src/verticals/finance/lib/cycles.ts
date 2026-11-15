/**
 * 周期指标(周期指标页)的取数类型与展示口径。
 *
 * 🔴 数值只在后端算(见 orchestrator/src/finance/cycles.ts),这里**不做任何指标运算** ——
 *    页面只负责把「值 / 触发线 / 离触发线多远」写清楚,算术不写两遍。图表配置也在这层,
 *    测试用假数据就能核到「触发线有没有画上去」。
 */
import type { ChartPalette } from "@/lib/backtestView";

export interface CyclesPoint {
  date: string;
  value: number;
}

export interface CyclesMetric {
  id: "turnover20" | "hsi_bias250" | "sf_yoy_6m" | "rrr_chg_250d" | "vix_spike" | "m2_gdp_gap" | "hsi_sh_rel_60d";
  label: string;
  /** 当前值;null = 这一轮没算出来 */
  value: number | null;
  unit: string;
  /** 触发线 */
  trigger: number;
  /** 触发方向:lte = 值 ≤ 触发线,gte = 值 ≥ 触发线 */
  direction: "lte" | "gte";
  /** 值 ≤(或 ≥)触发线 */
  triggered: boolean | null;
  as_of: string | null;
  /** 指标自身的序列 */
  series: CyclesPoint[];
  /** 逐日换手率(只有换手率有) */
  daily?: CyclesPoint[];
  close?: number | null;
  ma?: number | null;
  /** 辅助读数(照抄展示,不参与判定) */
  aux?: { label: string; text: string }[];
  formula: string;
  source: string;
  gaps: string[];
}

export interface CyclesResult {
  metrics: CyclesMetric[];
  triggered_count: number;
  available_count: number;
  signal: "none" | "partial" | "all";
  fetched_at: string | null;
  cached: boolean;
  generated_at: string;
  gaps: string[];
  reading: string;
}

/** 触发线的写法:lte 写「≤」,gte 写「≥」;VIX 的单位是指数点,不跟 % */
export const unitSuffix = (unit: string) => (unit === "%" ? "%" : "");

export const triggerText = (m: CyclesMetric) =>
  `${m.direction === "gte" ? "≥" : "≤"} ${m.trigger.toFixed(2).replace(/\.?0+$/, "")}${unitSuffix(m.unit)}`;

export const valueText = (v: number | null, digits = 2, unit = "%") => (v === null ? "—" : `${v.toFixed(digits)}${unitSuffix(unit)}`);

/** 状态:已触发 / 未触发 / 这一轮没算出来 —— 三种不能混着说 */
export function stateOf(m: CyclesMetric): "triggered" | "clear" | "unknown" {
  if (m.value === null || m.triggered === null) return "unknown";
  return m.triggered ? "triggered" : "clear";
}

export const STATE_LABEL: Record<ReturnType<typeof stateOf>, string> = {
  triggered: "已触发", clear: "未触发", unknown: "没算出来",
};

/**
 * 离触发线还有多远。
 * lte(触发线在下侧):已触发 = 越过多少个百分点;未触发 = 还差多少个百分点(换手率再附一个「还要降多少」)。
 * gte(触发线在上侧):方向相反,同样只报绝对距离。
 * ⚠️ 换手率是比值型(0.55% 相对 1.80% 才到),只说「差 1.25 个百分点」会把距离说小,两个都写。
 */
export function gapText(m: CyclesMetric): string {
  if (m.value === null) return "这一轮没算出来";
  const diff = m.value - m.trigger;              // lte:>0 = 还在触发线上方(没触发);gte:<0 = 还在触发线下方(没触发)
  const abs = Math.abs(diff).toFixed(2);
  if (m.triggered) return `已越过触发线 ${abs} 个百分点`;
  if (m.direction === "lte" && m.value > 0 && m.id === "turnover20") return `距触发线 ${abs} 个百分点(换手率还要再降 ${((diff / m.value) * 100).toFixed(0)}%)`;
  return `距触发线 ${abs} 个百分点`;
}

/** 一句话结论:几项触发 / 几项算出来 —— 不替用户下「底部到了没有」的判断 */
export function verdictLine(r: CyclesResult): string {
  const total = r.metrics.length;
  if (r.available_count === 0) return `核心指标 ${total} 项这一轮都没算出来,没有可看的结论`;
  const head = `${r.available_count === total ? `${total} 项` : `${r.available_count} / ${total} 项`}核心指标里有 ${r.triggered_count} 项进入触发区`;
  if (r.signal === "all") return `${head}:全部算出来的指标都在触发区`;
  if (r.signal === "partial") return `${head}:还没到「全部触发」`;
  return `${head}:一项都没触发`;
}

/** 序列的极值(画图时标一下窗口内最低/最高,避免只看最后一根) */
export function extremes(series: CyclesPoint[]): { low: CyclesPoint | null; high: CyclesPoint | null } {
  if (!series.length) return { low: null, high: null };
  let low = series[0]!;
  let high = series[0]!;
  for (const p of series) {
    if (p.value < low.value) low = p;
    if (p.value > high.value) high = p;
  }
  return { low, high };
}

const pctAxis = (palette: ChartPalette, suffix = "%") => ({
  type: "value" as const, scale: true,
  axisLabel: { color: palette.text, fontSize: 10, formatter: (v: number) => `${v}${suffix}` },
  splitLine: { lineStyle: { color: palette.grid } },
});

const axisTip = (palette: ChartPalette, suffix = "%") => ({
  trigger: "axis" as const, backgroundColor: palette.tooltipBg, textStyle: { color: palette.tooltipText },
  valueFormatter: (v: unknown) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(2)}${suffix}`),
});

/** 触发线统一画成红色虚线:它是一条「极端值警戒线」,不是红涨绿跌里的涨跌色 */
function triggerMarkLine(m: CyclesMetric, palette: ChartPalette) {
  return {
    symbol: "none", silent: true,
    data: [{
      yAxis: m.trigger,
      lineStyle: { color: palette.rise, type: "dashed" },
      label: { formatter: `触发线 ${triggerText(m)}`, color: palette.rise, fontSize: 10, position: "insideEndTop" },
    }],
  };
}

const dateAxis = (dates: string[], palette: ChartPalette) => ({
  type: "category" as const, data: dates,
  axisLabel: { color: palette.text, fontSize: 10 }, axisLine: { lineStyle: { color: palette.axis } },
});

/** 换手率图:逐日换手率(细线)+ 20 日均(主线)+ 触发线。x 轴用逐日序列,均线往前补空 */
export function turnoverOption(m: CyclesMetric, palette: ChartPalette) {
  const daily = m.daily ?? [];
  if (!daily.length) return null;
  const offset = Math.max(0, daily.length - m.series.length);
  return {
    grid: { left: 44, right: 12, top: 16, bottom: 26 },
    tooltip: axisTip(palette),
    xAxis: dateAxis(daily.map((p) => p.date.slice(5)), palette),
    yAxis: pctAxis(palette),
    series: [
      {
        name: "逐日换手率", type: "line", showSymbol: false,
        data: daily.map((p) => p.value), lineStyle: { color: palette.benchmark, width: 1 }, itemStyle: { color: palette.benchmark },
      },
      {
        name: "20 日均", type: "line", showSymbol: false,
        data: [...Array<null>(offset).fill(null), ...m.series.map((p) => p.value)],
        lineStyle: { color: palette.primary, width: 2 }, itemStyle: { color: palette.primary },
        markLine: triggerMarkLine(m, palette),
      },
    ],
  };
}

/** 恒指图:乖离率曲线(每个交易日的均线取它自己往前 250 根)+ 触发线 */
export function biasOption(m: CyclesMetric, palette: ChartPalette) {
  if (!m.series.length) return null;
  return simpleOption(m, palette, "250 日乖离率");
}

/** 通用单序列折线:乖离率 / 社融 6 月变化 / 准备金率 / VIX / M2-GDP 差 / 恒指相对强弱 都长一个样 */
export function simpleOption(m: CyclesMetric, palette: ChartPalette, name: string) {
  if (!m.series.length) return null;
  const suffix = unitSuffix(m.unit);
  return {
    grid: { left: 44, right: 12, top: 16, bottom: 26 },
    tooltip: axisTip(palette, suffix),
    xAxis: dateAxis(m.series.map((p) => p.date.slice(5)), palette),
    yAxis: pctAxis(palette, suffix),
    series: [{
      name, type: "line", showSymbol: false,
      data: m.series.map((p) => p.value),
      lineStyle: { color: palette.primary, width: 2 }, itemStyle: { color: palette.primary },
      markLine: triggerMarkLine(m, palette),
    }],
  };
}

/** 序列名(图例 / tooltip 用,和后端 label 保持一致的意思) */
export const SERIES_NAME: Record<CyclesMetric["id"], string> = {
  turnover20: "20 日均换手率",
  hsi_bias250: "250 日乖离率",
  sf_yoy_6m: "社融同比 6 个月变化",
  rrr_chg_250d: "准备金率(大型)",
  vix_spike: "VIX 收盘",
  m2_gdp_gap: "M2 − GDP 增速差",
  hsi_sh_rel_60d: "恒指 − 上证 60 日强弱",
};
