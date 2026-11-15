/**
 * 策略选股:在候选池的范围里,按固定策略逐只核对。首版策略 PB-ROE。
 *
 * 🔴 只排除、不排名:每只、每个条件写明 满足 / 不满足 / 缺数据;结果按代码排列,
 *    不打分,不给买卖建议。「全部满足」只表示过了使用者自己设的那几条。
 * 🔴 合理 PB = (ROE − g)/(r − g)。由清洁盈余 + 戈登增长推得:维持增速 g 必须留存,
 *    分红是 B·(ROE − g),分子里要减掉 g;写成 ROE/(r − g) 相当于「一边增长一边把盈利全分掉」。
 *    ROE 代入每只自己的实测值,r 与 g 是使用者给的模型参数,都不参与过滤之外的判断。
 * 🔴 测算值是给定假设下的算术结果,不是估值结论;页面不得写成「便宜」或「该买」。
 * 🔴 财报逐只取,取不到一律记「缺数据」并写进 gaps,不拿 0 或旧值冒充:
 *    实测 ROE = TTM 归母净利润 / 期末归母净资产(流量 ÷ 期末存量,未年化,结果里写明口径);
 *    商誉占比 = 商誉 / 所有者权益合计;权益乘数 = 资产总计 / 所有者权益合计;
 *    营收同比 = 最新累计营收 / 上年同期累计营收 − 1。
 *
 * 来源(都是已登记端点,不新增数据源):
 *   范围:台账里的自选 / 持仓;中证 / 国证官网指数成分文件(index_constituents)。
 *   当前 PB:腾讯批量行情(tx_quotes_batch),每次 50 只。
 *   财报:fetch_financials(新浪财务摘要,YTD 累计)、sina_balance_sheet(新浪资产负债表,期末时点)。
 */
import { fetchEndpoint, ledgerList, ledgerSnapshot, ServiceError, type ServiceContext } from "../service.ts";
import { isCnFundOrBond } from "./events.ts";
import { heldFromLedger } from "./holdings.ts";
import { failedNote, pool, quoteCodeOf } from "./schedule.ts";
import {
  INDEX_UNIVERSES, QUOTE_CHUNK, UNIVERSES, indexMembers, isStName, quoteRows, type QuoteRow,
} from "./candidates.ts";

export { UNIVERSES } from "./candidates.ts";

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

interface Ev { field?: string; value?: unknown; period?: string; note?: string; record_key?: string; raw_ref?: string }
interface Env { status?: string; evidence?: Ev[]; reason?: string; extra?: { stale?: unknown } }

/** 财报逐只取很慢,单次最多核对这么多只;超出部分不取数、不进结果,写进 gaps */
export const DEFAULT_LIMIT = 300;
export const MAX_LIMIT = 2000;
const CONCURRENCY = 4;
const DEFAULT_R_PCT = 10;
const DEFAULT_G_PCT = 3;
const DEFAULT_GOODWILL_PCT = 30;
const DEFAULT_LEVERAGE = 3;
const DEFAULT_REVENUE_PCT = 0;

const evsOf = (env: unknown): Ev[] => (env && typeof env === "object" && Array.isArray((env as Env).evidence) ? (env as Env).evidence! : []);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const tidyName = (s: string): string => s.replace(/[\s　]+/g, "");

export interface Range { min: number | null; max: number | null }

function parseBound(raw: string | undefined, what: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || Math.abs(v) > 1e9) throw new ServiceError("bad_query", `${what}不是合法数字:${raw.slice(0, 20)}`);
  return v;
}

/** 查询串 → 区间。下限大于上限直接报错,不悄悄对调 */
export function parseRange(query: Record<string, string>, key: string, label: string): Range {
  const min = parseBound(query[`${key}_min`], `${label}下限`);
  const max = parseBound(query[`${key}_max`], `${label}上限`);
  if (min !== null && max !== null && min > max) throw new ServiceError("bad_query", `${label}的下限 ${min} 大于上限 ${max}`);
  return { min, max };
}

/** 百分数输入 → 小数。空串用默认值;返回的是小数 */
export function parsePct(raw: string | undefined, what: string, defPct: number): number {
  if (raw === undefined || raw.trim() === "") return defPct / 100;
  const v = Number(raw);
  if (!Number.isFinite(v) || Math.abs(v) > 1e6) throw new ServiceError("bad_query", `${what}不是合法数字:${raw.slice(0, 20)}`);
  return v / 100;
}

/**
 * 合理 PB = (ROE − g)/(r − g)。三者都是小数。
 * r ≤ g、ROE ≤ g、结果非有限或 ≤ 0 都返回 null —— 交给调用方记「缺数据」,不渲染成数字。
 * 前端 lib/strategy.ts 有同名同式函数,测试会交叉核对同一组输入的结果。
 */
export function fairPb(roe: number, r: number, g: number): number | null {
  if (![roe, r, g].every((x) => Number.isFinite(x))) return null;
  const d = r - g;
  if (d <= 0 || roe <= g) return null;
  const v = (roe - g) / d;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export interface FinPoint { period: string; value: number | null }

/** 信封里按 field 取序列(按报告期升序)。同 field 同 period 只留最后一条 */
export function seriesOf(env: unknown, field: string): FinPoint[] {
  const by = new Map<string, number | null>();
  for (const e of evsOf(env)) {
    if (e.field !== field || !e.period) continue;
    by.set(e.period, numOf(e.value));
  }
  return [...by.entries()].map(([period, value]) => ({ period, value })).sort((a, b) => a.period.localeCompare(b.period));
}

/** 最新一期的期末时点值(资产负债表用) */
export function latestOf(env: unknown, field: string): { value: number; period: string } | null {
  const got = seriesOf(env, field).filter((p) => p.value !== null);
  const last = got[got.length - 1];
  return last && last.value !== null ? { value: last.value, period: last.period } : null;
}

const prevYearPeriod = (p: string): string => `${Number(p.slice(0, 4)) - 1}${p.slice(4)}`;

/**
 * A 股 YTD 累计值 → TTM:年报本身就是全年;否则 本期累计 + 上年年报 − 上年同期累计。
 * 缺任一期返回 null(不拿三季凑一年)。
 */
export function ttmFromYtd(series: FinPoint[], end: string): number | null {
  const by = new Map(series.map((p) => [p.period, p.value]));
  const cur = by.get(end);
  if (cur === undefined || cur === null) return null;
  if (end.endsWith("-12-31")) return cur;
  const full = by.get(`${Number(end.slice(0, 4)) - 1}-12-31`);
  const same = by.get(prevYearPeriod(end));
  if (full === undefined || full === null || same === undefined || same === null) return null;
  return cur + full - same;
}

/** 最新累计营收相对上年同期的增速(小数)。基期 ≤ 0 或缺失返回 null */
export function revenueGrowth(series: FinPoint[]): { value: number; period: string } | null {
  const got = series.filter((p) => p.value !== null);
  const last = got[got.length - 1];
  if (!last || last.value === null) return null;
  const base = got.find((p) => p.period === prevYearPeriod(last.period))?.value;
  if (base === undefined || base === null || base <= 0) return null;
  return { value: last.value / base - 1, period: last.period };
}

/** 同单位两数之比;分母 ≤ 0 或缺失返回 null(与 calc.ratio 的 not_meaningful 一致) */
export function safeRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  const v = numerator / denominator;
  return Number.isFinite(v) ? v : null;
}

export interface FinData {
  roe: number | null;
  roe_period: string | null;
  goodwill_ratio: number | null;
  leverage: number | null;
  revenue_growth: number | null;
  revenue_period: string | null;
  missingGoodwill: boolean;
}

/** 从两个财报信封算出一只需要的所有量。任一取不到就留 null,由 checkRow 记缺数据 */
export function financialsOf(fin: unknown, bal: unknown): FinData {
  const profit = seriesOf(fin, "net_profit_parent_cum");
  const profitEnd = [...profit].reverse().find((p) => p.value !== null)?.period ?? "";
  const ttm = profitEnd ? ttmFromYtd(profit, profitEnd) : null;
  const equityParent = latestOf(bal, "equity_parent");
  const equityTotal = latestOf(bal, "total_equity");
  const roe = safeRatio(ttm, equityParent?.value ?? null) ?? safeRatio(ttm, equityTotal?.value ?? null);
  const goodwill = latestOf(bal, "goodwill");
  const assets = latestOf(bal, "total_assets");
  const rev = revenueGrowth(seriesOf(fin, "revenue_cum"));
  const hasGoodwillField = evsOf(bal).some((e) => e.field === "goodwill");
  return {
    roe,
    roe_period: roe === null ? null : (equityParent?.period ?? equityTotal?.period ?? profitEnd),
    goodwill_ratio: goodwill ? safeRatio(goodwill.value, equityTotal?.value ?? null) : null,
    leverage: assets ? safeRatio(assets.value, equityTotal?.value ?? null) : null,
    revenue_growth: rev?.value ?? null,
    revenue_period: rev?.period ?? null,
    missingGoodwill: !hasGoodwillField,
  };
}

export interface ScreenOptions {
  pb: Range;
  roe: Range;                  // 小数
  r: number;
  g: number;
  excludeSt: boolean;
  exclGoodwill: boolean;
  goodwillMax: number;         // 小数
  exclLeverage: boolean;
  leverageMax: number;         // 倍
  exclRevenue: boolean;
  revenueMin: number;          // 小数
}

const fmt = (v: number, digits = 2): string => v.toFixed(digits);
const pctText = (v: number): string => `${fmt(v * 100)}%`;
const met = (id: string, value: number | null, shown: string): ScreenCheck => ({ id, state: "met", value, shown });
const unmet = (id: string, value: number | null, shown: string): ScreenCheck => ({ id, state: "unmet", value, shown });
const missing = (id: string, shown: string): ScreenCheck => ({ id, state: "missing", value: null, shown });

/** 一只的全部条件 → 每条的状态。纯函数,测试直接导入 */
export function checkRow(q: QuoteRow | undefined, f: FinData | undefined, o: ScreenOptions): ScreenCheck[] {
  const checks: ScreenCheck[] = [];
  const pb = q?.fields.pb ?? null;

  if (o.pb.min !== null || o.pb.max !== null) {
    if (pb === null || pb <= 0) checks.push(missing("pb_range", q ? "来源没给" : "没取到"));
    else {
      const ok = (o.pb.min === null || pb >= o.pb.min) && (o.pb.max === null || pb <= o.pb.max);
      checks.push((ok ? met : unmet)("pb_range", pb, `${fmt(pb)} 倍`));
    }
  }
  if (o.roe.min !== null || o.roe.max !== null) {
    const roe = f?.roe ?? null;
    if (roe === null) checks.push(missing("roe_range", f ? "财报没取全" : "没取到"));
    else {
      const ok = (o.roe.min === null || roe >= o.roe.min) && (o.roe.max === null || roe <= o.roe.max);
      checks.push((ok ? met : unmet)("roe_range", roe, pctText(roe)));
    }
  }

  // 模型这条:ROE 用实测值;fairPb 返回 null 一律记缺数据,不当成「不满足」
  const fair = f?.roe != null ? fairPb(f.roe, o.r, o.g) : null;
  if (fair === null || pb === null || pb <= 0) {
    checks.push(missing("fair_pb", fair === null ? "模型不可算(ROE ≤ g 或没取到)" : "当前 PB 没取到"));
  } else {
    checks.push((pb < fair ? met : unmet)("fair_pb", fair, `合理 PB ${fmt(fair)} 倍,当前 ${fmt(pb)} 倍`));
  }

  if (o.exclGoodwill) {
    const v = f?.goodwill_ratio ?? null;
    if (v === null) checks.push(missing("goodwill", f?.missingGoodwill ? "来源没给商誉科目" : "财报没取全"));
    else checks.push((v <= o.goodwillMax ? met : unmet)("goodwill", v, `${pctText(v)}(上限 ${pctText(o.goodwillMax)})`));
  }
  if (o.exclLeverage) {
    const v = f?.leverage ?? null;
    if (v === null) checks.push(missing("leverage", "财报没取全"));
    else checks.push((v <= o.leverageMax ? met : unmet)("leverage", v, `${fmt(v)} 倍(上限 ${fmt(o.leverageMax, 1)} 倍)`));
  }
  if (o.exclRevenue) {
    const v = f?.revenue_growth ?? null;
    if (v === null) checks.push(missing("revenue", "财报没取全"));
    else checks.push((v > o.revenueMin ? met : unmet)("revenue", v, `${pctText(v)}(要求 > ${pctText(o.revenueMin)})`));
  }
  if (o.excludeSt) {
    const name = q?.name ?? "";
    if (!name) checks.push(missing("st", "没取到简称"));
    else checks.push((isStName(name) ? unmet : met)("st", null, isStName(name) ? `简称是「${tidyName(name)}」` : "不是 ST"));
  }
  return checks;
}

export const verdictOf = (checks: ScreenCheck[]): CheckState =>
  checks.some((c) => c.state === "unmet") ? "unmet" : checks.some((c) => c.state === "missing") ? "missing" : "met";

const uniqSorted = (list: { symbol: string; name: string }[]) => {
  const by = new Map<string, { symbol: string; name: string }>();
  for (const m of list) if (by.has(m.symbol) === false) by.set(m.symbol, m);
  return [...by.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
};

function labelOf(o: ScreenOptions, key: string): string {
  const r = key === "pb" ? o.pb : o.roe;
  const unit = key === "pb" ? " 倍" : "%";
  const fmtBound = (v: number) => key === "pb" ? fmt(v) : fmt(v * 100);
  if (r.min !== null && r.max !== null) return `${key === "pb" ? "当前 PB" : "实测 ROE"} ${fmtBound(r.min)}–${fmtBound(r.max)}${unit}`;
  if (r.min !== null) return `${key === "pb" ? "当前 PB" : "实测 ROE"} ≥ ${fmtBound(r.min)}${unit}`;
  return `${key === "pb" ? "当前 PB" : "实测 ROE"} ≤ ${fmtBound(r.max!)}${unit}`;
}

export async function strategyScreen(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal, now = new Date()): Promise<ScreenResult> {
  const uid = query.universe ?? "watch";
  const uni = UNIVERSES.find((u) => u.id === uid);
  if (!uni) throw new ServiceError("bad_query", `没有这个范围:${uid.slice(0, 20)}`);
  if (query.strategy && query.strategy !== "pb_roe") throw new ServiceError("bad_query", `还没有这个策略:${query.strategy.slice(0, 20)}`);

  // ROE 范围在界面上按百分数填,比较对象是小数形式的实测 ROE,这里统一换成小数
  const roeRange = parseRange(query, "roe", "实测 ROE");
  const o: ScreenOptions = {
    pb: parseRange(query, "pb", "当前 PB"),
    roe: { min: roeRange.min === null ? null : roeRange.min / 100, max: roeRange.max === null ? null : roeRange.max / 100 },
    r: parsePct(query.r, "风险折现率", DEFAULT_R_PCT),
    g: parsePct(query.g, "永续增长率", DEFAULT_G_PCT),
    excludeSt: query.exclude_st !== "0",
    exclGoodwill: query.excl_goodwill === "1",
    goodwillMax: parsePct(query.goodwill_max, "商誉占比上限", DEFAULT_GOODWILL_PCT),
    exclLeverage: query.excl_leverage === "1",
    leverageMax: parseBound(query.leverage_max, "权益乘数上限") ?? DEFAULT_LEVERAGE,
    exclRevenue: query.excl_revenue === "1",
    revenueMin: parsePct(query.revenue_min, "营收增速下限", DEFAULT_REVENUE_PCT),
  };
  if (o.r <= o.g) throw new ServiceError("bad_query", "风险折现率必须大于永续增长率,否则 (r − g) ≤ 0,公式无意义");
  // 策略自带的「当前 PB < 测算合理 PB」恒在,所以只给 r/g 也能核对,不再要求额外条件
  if (o.goodwillMax < 0 || o.leverageMax <= 0) throw new ServiceError("bad_query", "排除项的阈值不合法");
  const limitRaw = Number(query.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitRaw) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitRaw))) : DEFAULT_LIMIT;

  const gaps: string[] = [];

  // ── 范围(与候选池同一套来源) ──
  let members: { symbol: string; name: string }[] = [];
  let asOf: string | null = null;
  let uniSource = "我的台账";
  const idx = INDEX_UNIVERSES.find((u) => u.id === uid);
  if (idx) {
    uniSource = `${idx.provider === "csi" ? "中证" : "国证"}指数官网成分文件`;
    let env: Env | undefined;
    let outDir = "";
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "index_constituents", symbol: idx.code, args: { provider: idx.provider }, signal });
      env = r.envelope as Env;
      outDir = r.out_dir;
    } catch (e) {
      if (signal.aborted) throw e;
      env = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
    }
    if (!env || env.status === "failed") gaps.push(`${idx.label}成分没取到${failedNote(env) ? `(${failedNote(env)})` : ""}`);
    else {
      const got = indexMembers(ctx, env, outDir);
      members = got.members;
      asOf = got.as_of;
      if (!got.full) gaps.push(`${idx.label}成分全表没读到,只核对了来源列出的前 ${got.members.length} 只${got.total ? `(共 ${got.total} 只)` : ""}`);
      else if (got.total !== null && got.total !== got.members.length) gaps.push(`${idx.label}成分文件写的是 ${got.total} 只,读到 ${got.members.length} 只`);
    }
  } else {
    const listed = uid === "position"
      ? (() => { const s = ledgerSnapshot(ctx); return heldFromLedger(s.records, s.issues); })()
      : (ledgerList(ctx)[uid] ?? []).map((r) => ({ symbol: str(r.symbol), name: str(r.name) }));
    const all = uniqSorted(listed.filter((m) => m.symbol));
    const funds = all.filter((m) => /^\d{6}$/.test(m.symbol) && isCnFundOrBond(m.symbol));
    const other = all.filter((m) => !/^\d{6}$/.test(m.symbol));
    members = all.filter((m) => /^\d{6}$/.test(m.symbol) && !isCnFundOrBond(m.symbol));
    if (funds.length) gaps.push(`基金 / 债券 ${funds.length} 只:没有财报口径的 ROE,没核对`);
    if (other.length) gaps.push(`港股 / 美股 ${other.length} 只:策略选股暂只支持 A 股,没核对`);
  }
  members = uniqSorted(members);
  const total = members.length;
  if (total > limit) {
    gaps.push(`${uni.label}共 ${total} 只,财报要逐只取,本次只核对按代码排列的前 ${limit} 只;其余 ${total - limit} 只没取数、没进结果。要全看就把取数上限调大(最多 ${MAX_LIMIT})`);
    members = members.slice(0, limit);
  }

  // ── 当前 PB:批量行情,每次 50 只 ──
  const quotes = new Map<string, QuoteRow>();
  const quoteFailed: string[] = [];
  const fetchedAt: string[] = [];
  const chunks: { symbol: string; name: string }[][] = [];
  for (let i = 0; i < members.length; i += QUOTE_CHUNK) chunks.push(members.slice(i, i + QUOTE_CHUNK));
  const reasons = new Set<string>();
  await pool(chunks, CONCURRENCY, async (chunk) => {
    let env: Env | undefined;
    try {
      const r = await fetchEndpoint(ctx, { endpoint: "tx_quotes_batch", args: { codes: chunk.map((m) => quoteCodeOf(m.symbol)) }, consistency: { mode: "fresh" }, signal });
      env = r.envelope as Env;
      if (env?.status !== "failed") fetchedAt.push(r.fetched_at);
    } catch (e) {
      if (signal.aborted) throw e;
      env = { status: "failed", reason: e instanceof Error ? e.message : String(e) };
    }
    if (!env || env.status === "failed") {
      quoteFailed.push(...chunk.map((m) => m.symbol));
      if (failedNote(env)) reasons.add(failedNote(env));
      return;
    }
    for (const [sym, q] of quoteRows(env)) quotes.set(sym, q);
  });
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  if (quoteFailed.length) gaps.push(`腾讯行情没取到 ${quoteFailed.length} 只${reasons.size ? `(${[...reasons].join(";")})` : ""}`);
  const noQuote = members.filter((m) => !quotes.has(m.symbol) && !quoteFailed.includes(m.symbol));
  if (noQuote.length) gaps.push(`腾讯行情没有返回 ${noQuote.length} 只:${noQuote.slice(0, 8).map((m) => m.symbol).join("、")}${noQuote.length > 8 ? " 等" : ""}(代码可能已变更)`);

  // ── 财报:逐只两个端点,失败的那只照常进结果、记缺数据 ──
  const fins = new Map<string, FinData>();
  const finFailed: string[] = [];
  let noGoodwill = 0;
  await pool(members, CONCURRENCY, async (m) => {
    let fin: unknown;
    let bal: unknown;
    try {
      const [a, b] = await Promise.all([
        fetchEndpoint(ctx, { endpoint: "fetch_financials", symbol: m.symbol, signal }),
        fetchEndpoint(ctx, { endpoint: "sina_balance_sheet", symbol: m.symbol, signal }),
      ]);
      fin = a.envelope;
      bal = b.envelope;
      if ((fin as Env)?.status === "failed" || (bal as Env)?.status === "failed") throw new Error(failedNote(fin) || failedNote(bal) || "财报端点失败");
    } catch (e) {
      if (signal.aborted) throw e;
      finFailed.push(m.symbol);
      return;
    }
    const f = financialsOf(fin, bal);
    if (f.missingGoodwill) noGoodwill += 1;
    fins.set(m.symbol, f);
  });
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  if (finFailed.length) gaps.push(`财报没取到 ${finFailed.length} 只:${finFailed.slice(0, 8).map((s) => s).join("、")}${finFailed.length > 8 ? " 等" : ""};这些标的的财报类条件记为缺数据`);
  if (o.exclGoodwill && noGoodwill) gaps.push(`${noGoodwill} 只的资产负债表来源没给「商誉」科目,这一条记为缺数据,没有当成 0、也没有当成满足`);

  const conditions: ScreenCondition[] = [];
  if (o.pb.min !== null || o.pb.max !== null) conditions.push({ id: "pb_range", label: labelOf(o, "pb"), source: "腾讯行情 当前 PB" });
  if (o.roe.min !== null || o.roe.max !== null) conditions.push({ id: "roe_range", label: labelOf(o, "roe"), source: "新浪财报 TTM 归母净利润 / 期末归母净资产" });
  conditions.push({ id: "fair_pb", label: `当前 PB < 测算合理 PB = (ROE − g)/(r − g),r=${pctText(o.r)},g=${pctText(o.g)}`, source: "模型测算值,ROE 用每只实测值" });
  if (o.exclGoodwill) conditions.push({ id: "goodwill", label: `商誉 / 净资产 ≤ ${pctText(o.goodwillMax)}`, source: "新浪资产负债表" });
  if (o.exclLeverage) conditions.push({ id: "leverage", label: `权益乘数 ≤ ${fmt(o.leverageMax, 1)} 倍`, source: "新浪资产负债表 资产总计 / 所有者权益合计" });
  if (o.exclRevenue) conditions.push({ id: "revenue", label: `营收同比 > ${pctText(o.revenueMin)}`, source: "新浪财务摘要 最新累计营收 vs 上年同期" });
  if (o.excludeSt) conditions.push({ id: "st", label: "排除 ST / *ST / 退市整理", source: "腾讯行情里的证券简称" });

  const rows: ScreenRow[] = members.map((m) => {
    const q = quotes.get(m.symbol);
    const f = fins.get(m.symbol);
    const checks = checkRow(q, f, o);
    const pb = q?.fields.pb ?? null;
    const fair = f?.roe != null ? fairPb(f.roe, o.r, o.g) : null;
    return {
      symbol: m.symbol, name: q?.name ? tidyName(q.name) : m.name, verdict: verdictOf(checks), checks,
      pb: pb !== null && pb > 0 ? pb : null, roe: f?.roe ?? null, fair_pb: fair,
      r: o.r, g: o.g, roe_period: f?.roe_period ?? null, adjusted: false,
    };
  });
  const counts: Record<CheckState, number> = { met: 0, unmet: 0, missing: 0 };
  for (const r of rows) counts[r.verdict] += 1;
  fetchedAt.sort();
  return {
    universe: { id: uni.id, label: uni.label, size: members.length, as_of: asOf, source: uniSource, limit, total },
    strategy: {
      id: "pb_roe", label: "PB-ROE", formula: "合理 PB = (ROE − g) / (r − g)",
      r: o.r, g: o.g,
      roe_basis: "每只的实测 ROE = TTM 归母净利润 / 期末归母净资产(流量 ÷ 期末存量,未年化)",
    },
    quotes: { source: "腾讯行情", fetched_at: fetchedAt[0] ?? null },
    financials: { source: "新浪财务摘要 + 新浪资产负债表", note: "逐只取数;取不到的科目记为缺数据" },
    conditions, rows, counts, generated_at: now.toISOString(), gaps,
  };
}
