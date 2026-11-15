/**
 * 策略选股的界面数据(后端见 orchestrator/src/finance/strategy_screen.ts)。
 * 只排除、不排名:每只、每个条件写明 满足 / 不满足 / 缺数据,结果按代码排列。
 * 合理 PB 是给定 r、g 假设下的算术结果,不是估值结论。
 */
export type CheckState = "met" | "unmet" | "missing";

export interface ScreenCheck { id: string; state: CheckState; value: number | null; shown: string }
export interface ScreenRow {
  symbol: string;
  name: string;
  verdict: CheckState;
  checks: ScreenCheck[];
  pb: number | null;
  roe: number | null;
  fair_pb: number | null;
  r: number;
  g: number;
  roe_period: string | null;
  adjusted: boolean;
}
export interface ScreenCondition { id: string; label: string; source: string }
export interface ScreenResult {
  universe: { id: string; label: string; size: number; as_of: string | null; source: string; limit: number; total: number };
  strategy: { id: string; label: string; formula: string; r: number; g: number; roe_basis: string };
  quotes: { source: string; fetched_at: string | null };
  financials: { source: string; note: string };
  conditions: ScreenCondition[];
  rows: ScreenRow[];
  counts: Record<CheckState, number>;
  generated_at: string;
  gaps: string[];
}

/** 和后端 UNIVERSES 同序同名(后端测试逐项核对) */
export const UNIVERSES = [
  { id: "watch", label: "我的自选" },
  { id: "position", label: "我的持仓" },
  { id: "hs300", label: "沪深300" },
  { id: "a500", label: "中证A500" },
  { id: "zz500", label: "中证500" },
  { id: "zz1000", label: "中证1000" },
  { id: "zz2000", label: "中证2000" },
  { id: "sz50", label: "上证50" },
  { id: "kc50", label: "科创50" },
  { id: "cyb", label: "创业板指" },
] as const;
export type UniverseId = (typeof UNIVERSES)[number]["id"];

/** 首版只有一条策略;以后加策略只加这里的条目和后端对应的分支 */
export const STRATEGIES = [
  { id: "pb_roe", label: "PB-ROE", detail: "合理 PB = (ROE − g)/(r − g),筛出当前 PB 低于测算值的" },
] as const;
export type StrategyId = (typeof STRATEGIES)[number]["id"];

export const MAX_LIMIT = 2000;

export interface StrategyForm {
  strategy: StrategyId;
  universe: UniverseId;
  pb: { min: string; max: string };
  roe: { min: string; max: string };
  r: string;
  g: string;
  excludeSt: boolean;
  exclGoodwill: boolean;
  goodwillMax: string;
  exclLeverage: boolean;
  leverageMax: string;
  exclRevenue: boolean;
  revenueMin: string;
  limit: string;
}

export const defaultForm = (): StrategyForm => ({
  strategy: "pb_roe", universe: "watch",
  pb: { min: "", max: "" }, roe: { min: "", max: "" },
  r: "10", g: "3", excludeSt: true,
  exclGoodwill: false, goodwillMax: "30",
  exclLeverage: false, leverageMax: "3",
  exclRevenue: false, revenueMin: "0",
  limit: "300",
});

const LIMIT_NUM = 1e9;

/** 提交前核一遍(后端也会核);返回空串表示可以提交 */
export function formError(f: StrategyForm): string {
  const num = (raw: string, what: string): string => {
    if (raw.trim() === "") return "";
    const v = Number(raw.trim());
    return !Number.isFinite(v) || Math.abs(v) > LIMIT_NUM ? `${what}不是合法数字` : "";
  };
  const range = (r: { min: string; max: string }, label: string): string => {
    const bad = num(r.min, `${label} 下限`) || num(r.max, `${label} 上限`);
    if (bad) return bad;
    if (r.min.trim() && r.max.trim() && Number(r.min.trim()) > Number(r.max.trim())) return `${label} 的下限大于上限`;
    return "";
  };
  const bad = range(f.pb, "当前 PB") || range(f.roe, "实测 ROE")
    || num(f.r, "风险折现率") || num(f.g, "永续增长率")
    || (f.exclGoodwill ? num(f.goodwillMax, "商誉占比上限") : "")
    || (f.exclLeverage ? num(f.leverageMax, "权益乘数上限") : "")
    || (f.exclRevenue ? num(f.revenueMin, "营收增速下限") : "")
    || num(f.limit, "取数上限");
  if (bad) return bad;
  if (f.r.trim() && f.g.trim() && Number(f.r.trim()) <= Number(f.g.trim())) return "风险折现率必须大于永续增长率,否则公式无意义";
  const lim = Number(f.limit.trim() || "300");
  if (!Number.isInteger(lim) || lim < 1 || lim > MAX_LIMIT) return `取数上限要在 1 到 ${MAX_LIMIT} 之间`;
  if (f.exclGoodwill && f.goodwillMax.trim() && Number(f.goodwillMax.trim()) < 0) return "商誉占比上限不能是负数";
  if (f.exclLeverage && f.leverageMax.trim() && Number(f.leverageMax.trim()) <= 0) return "权益乘数上限要大于 0";
  // 策略自带的「当前 PB < 测算合理 PB」恒在,只填 r/g 也能核对
  return "";
}

/** 表单 → 查询串(空的不带)。r/g/阈值都是百分数,由后端统一换成小数 */
export function strategyQuery(f: StrategyForm): string {
  const q = new URLSearchParams();
  q.set("strategy", f.strategy);
  q.set("universe", f.universe);
  if (f.pb.min.trim()) q.set("pb_min", f.pb.min.trim());
  if (f.pb.max.trim()) q.set("pb_max", f.pb.max.trim());
  if (f.roe.min.trim()) q.set("roe_min", f.roe.min.trim());
  if (f.roe.max.trim()) q.set("roe_max", f.roe.max.trim());
  q.set("r", f.r.trim() || "10");
  q.set("g", f.g.trim() || "3");
  q.set("exclude_st", f.excludeSt ? "1" : "0");
  if (f.exclGoodwill) { q.set("excl_goodwill", "1"); if (f.goodwillMax.trim()) q.set("goodwill_max", f.goodwillMax.trim()); }
  if (f.exclLeverage) { q.set("excl_leverage", "1"); if (f.leverageMax.trim()) q.set("leverage_max", f.leverageMax.trim()); }
  if (f.exclRevenue) { q.set("excl_revenue", "1"); if (f.revenueMin.trim()) q.set("revenue_min", f.revenueMin.trim()); }
  q.set("limit", f.limit.trim() || "300");
  return q.toString();
}

/**
 * 合理 PB = (ROE − g)/(r − g)。与后端 strategy_screen.fairPb 同名同式,
 * 测试会交叉核对同一组输入的结果;行内改 r/g 只调这个函数,不回后端、不重跑范围。
 * roe/r/g 都是小数;r ≤ g、ROE ≤ g 或结果非正都返回 null(页面显示「模型不可算」)。
 */
export function fairPb(roe: number, r: number, g: number): number | null {
  if (![roe, r, g].every((x) => Number.isFinite(x))) return null;
  const d = r - g;
  if (d <= 0 || roe <= g) return null;
  const v = (roe - g) / d;
  return Number.isFinite(v) && v > 0 ? v : null;
}

const fmt = (v: number): string => v.toFixed(2);

/** 单只标的按行内改过的 r/g 重算。行本身始终保留,分组仍按原来的结果,不触发任何请求 */
export function recomputeRow(row: ScreenRow, rPct: number, gPct: number): ScreenRow {
  const r = rPct / 100;
  const g = gPct / 100;
  const fair = row.roe != null ? fairPb(row.roe, r, g) : null;
  const checks = row.checks.map((c) => {
    if (c.id !== "fair_pb") return c;
    if (fair === null || row.pb === null || row.pb <= 0) {
      return { ...c, state: "missing" as const, value: null, shown: fair === null ? "模型不可算(ROE ≤ g 或 r ≤ g)" : "当前 PB 没取到" };
    }
    return {
      ...c,
      state: (row.pb < fair ? "met" : "unmet") as CheckState,
      value: fair,
      shown: `合理 PB ${fmt(fair)} 倍,当前 ${fmt(row.pb)} 倍`,
    };
  });
  const verdict: CheckState = checks.some((c) => c.state === "unmet") ? "unmet"
    : checks.some((c) => c.state === "missing") ? "missing" : "met";
  return { ...row, r, g, fair_pb: fair, checks, verdict, adjusted: true };
}

export const VERDICT_TABS: { key: CheckState; label: string }[] = [
  { key: "met", label: "全部满足" },
  { key: "missing", label: "有缺数据" },
  { key: "unmet", label: "有不满足" },
];

/** 状态的样式。不用红绿:红绿在这里表示涨跌,条件满足与否不带涨跌含义 */
export const STATE_META: Record<CheckState, { label: string; tone: string }> = {
  met: { label: "满足", tone: "border-primary/40 text-primary" },
  unmet: { label: "不满足", tone: "border-border text-muted-foreground" },
  missing: { label: "缺数据", tone: "border-warning/50 text-warning" },
};

export const rowsOfTab = (rows: ScreenRow[], tab: CheckState) => rows.filter((r) => r.verdict === tab);
export const PAGE_SIZE = 200;
