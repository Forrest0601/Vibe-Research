import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Filter, Minus, RotateCcw, SearchX, X } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { backend, ApiError } from "@/lib/backend";
import {
  MAX_LIMIT, PAGE_SIZE, STATE_META, STRATEGIES, UNIVERSES, VERDICT_TABS,
  defaultForm, formError, recomputeRow, rowsOfTab, strategyQuery,
  type CheckState, type ScreenCheck, type ScreenResult, type StrategyForm, type UniverseId,
} from "@/lib/strategy";
import { shortTime } from "@/lib/chatSources";
import { useAiPage } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";
const INPUT = "w-full min-w-0 rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-sm tabular-nums";
const CELL = "px-3 py-2 align-top text-xs tabular-nums";
const CN_CELL = "px-3 py-2 align-top whitespace-nowrap text-xs tabular-nums";

function StateIcon({ state }: { state: CheckState }) {
  const Icon = state === "met" ? Check : state === "unmet" ? X : Minus;
  return <Icon aria-hidden className="h-3 w-3 shrink-0" />;
}

function CheckCell({ c }: { c: ScreenCheck | undefined }) {
  if (!c) return <td className={cn(CELL, "text-muted-foreground")}>—</td>;
  const meta = STATE_META[c.state];
  return <td className={CELL}>
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] leading-4", meta.tone)}>
      <StateIcon state={c.state} />{meta.label}
    </span>
    <span className="mt-0.5 block whitespace-nowrap text-[11px] text-muted-foreground">{c.shown}</span>
  </td>;
}

export function StrategyScreen() {
  const [form, setForm] = useState<StrategyForm>(defaultForm);
  const [data, setData] = useState<ScreenResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<CheckState>("met");
  const [shownCount, setShownCount] = useState(PAGE_SIZE);
  /** 行内改过的 r/g(百分数字符串)。只影响这一行的展示,不回后端、不重跑范围 */
  const [overrides, setOverrides] = useState<Record<string, { r: string; g: string }>>({});
  const seq = useRef(0);

  const update = (next: StrategyForm) => setForm(next);
  const setRange = (key: "pb" | "roe", side: "min" | "max", v: string) =>
    update({ ...form, [key]: { ...form[key], [side]: v } });
  const setOverride = (symbol: string, side: "r" | "g", v: string) =>
    setOverrides((old) => ({ ...old, [symbol]: { r: old[symbol]?.r ?? String(Math.round((data?.strategy.r ?? 0.1) * 100)), g: old[symbol]?.g ?? String(Math.round((data?.strategy.g ?? 0.03) * 100)), [side]: v } }));

  const run = useCallback(async () => {
    const bad = formError(form);
    if (bad) { setError(bad); return; }
    const my = ++seq.current;
    setLoading(true);
    setError("");
    setOverrides({});
    try {
      const r = await backend.strategyScreen(strategyQuery(form));
      if (my !== seq.current) return;
      setData(r);
      setShownCount(PAGE_SIZE);
      setTab(VERDICT_TABS.find((t) => r.counts[t.key] > 0)?.key ?? "met");
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [form]);

  /** 分组按后端返回的原始结果;行内重算只换这一行的测算值,行始终留在原来的组里 */
  const rows = useMemo(() => {
    if (!data) return [];
    return rowsOfTab(data.rows, tab).map((r) => {
      const ov = overrides[r.symbol];
      if (!ov) return r;
      const rp = Number(ov.r), gp = Number(ov.g);
      if (!Number.isFinite(rp) || !Number.isFinite(gp)) return r;
      return recomputeRow(r, rp, gp);
    });
  }, [data, tab, overrides]);
  const shown = rows.slice(0, shownCount);

  useAiPage({
    key: "strategy_screen",
    title: "策略选股",
    context: data
      ? `策略选股(${data.strategy.label}):只排除、不排名,按代码排列。范围 ${data.universe.label} 共 ${data.universe.size} 只`
        + `${data.universe.total > data.universe.size ? `(范围内共 ${data.universe.total} 只,本次上限 ${data.universe.limit} 只)` : ""},来源 ${data.universe.source}。\n`
        + `策略公式 ${data.strategy.formula},r=${(data.strategy.r * 100).toFixed(2)}%,g=${(data.strategy.g * 100).toFixed(2)}%;ROE 口径:${data.strategy.roe_basis}。\n`
        + `条件:${data.conditions.map((c) => c.label).join(";")}\n`
        + `全部满足 ${data.counts.met} 只,有缺数据 ${data.counts.missing} 只,有不满足 ${data.counts.unmet} 只。\n`
        + (["met", "missing"] as const).map((k) => {
          const list = rowsOfTab(data.rows, k).slice(0, 80);
          return list.length ? `${k === "met" ? "全部满足" : "有缺数据"}${list.length < data.counts[k] ? "(前 80 只)" : ""}:\n`
            + list.map((r) => `${r.symbol} ${r.name}:当前PB=${r.pb === null ? "缺" : r.pb.toFixed(2)},实测ROE=${r.roe === null ? "缺" : (r.roe * 100).toFixed(2) + "%"},测算合理PB=${r.fair_pb === null ? "不可算" : r.fair_pb.toFixed(2)}`).join("\n") : "";
        }).filter(Boolean).join("\n")
        + (data.gaps.length ? `\n没取到的:${data.gaps.join(";")}` : "")
      : "策略选股:还没有核对结果。",
    suggestions: ["哪一条条件排除的最多", "缺数据的几只分别缺什么"],
  });

  const rDefault = data ? String(Number((data.strategy.r * 100).toFixed(4))) : "10";
  const gDefault = data ? String(Number((data.strategy.g * 100).toFixed(4))) : "3";

  return <div>
    <PageHeader title="策略选股"
      subtitle="先选策略、再选范围:按固定策略逐只核对,每一条都写明满足、不满足还是缺数据。只排除、不排名,不打分、不给买卖建议。测算值是给定假设下的算术结果,不是估值结论。" />

    <GlassCard className="mb-5">
      <form onSubmit={(e) => { e.preventDefault(); if (!loading) void run(); }} className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1.5">
            <span className="block text-xs text-muted-foreground">策略</span>
            <select value={form.strategy} onChange={(e) => update({ ...form, strategy: e.target.value as StrategyForm["strategy"] })}
              aria-label="筛选策略" className="rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
              {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="block text-xs text-muted-foreground">范围</span>
            <select value={form.universe} onChange={(e) => update({ ...form, universe: e.target.value as UniverseId })}
              aria-label="筛选范围" className="rounded-lg border border-border bg-background/60 px-3 py-2 text-sm">
              {UNIVERSES.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className="block text-xs text-muted-foreground">取数上限(只)</span>
            <input type="number" min={1} max={MAX_LIMIT} step={1} value={form.limit} aria-label="取数上限"
              onChange={(e) => update({ ...form, limit: e.target.value })} className={cn(INPUT, "w-28")} />
          </label>
          <p className="max-w-md pb-2 text-[11px] leading-5 text-muted-foreground">财报要逐只取,范围越大越慢;超过上限的不取数、不进结果,会写在下面「没取到的」里。范围与候选池一致。</p>
        </div>

        <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-xs text-muted-foreground">当前 PB(倍)</legend>
            <div className="flex items-center gap-2">
              <input type="text" inputMode="decimal" aria-label="当前 PB 下限" placeholder="不限" value={form.pb.min} onChange={(e) => setRange("pb", "min", e.target.value)} className={INPUT} />
              <span className="shrink-0 text-xs text-muted-foreground">到</span>
              <input type="text" inputMode="decimal" aria-label="当前 PB 上限" placeholder="不限" value={form.pb.max} onChange={(e) => setRange("pb", "max", e.target.value)} className={INPUT} />
            </div>
          </fieldset>
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-xs text-muted-foreground">实测 ROE(%)</legend>
            <div className="flex items-center gap-2">
              <input type="text" inputMode="decimal" aria-label="实测 ROE 下限" placeholder="不限" value={form.roe.min} onChange={(e) => setRange("roe", "min", e.target.value)} className={INPUT} />
              <span className="shrink-0 text-xs text-muted-foreground">到</span>
              <input type="text" inputMode="decimal" aria-label="实测 ROE 上限" placeholder="不限" value={form.roe.max} onChange={(e) => setRange("roe", "max", e.target.value)} className={INPUT} />
            </div>
          </fieldset>
          <fieldset className="min-w-0">
            <legend className="mb-1.5 text-xs text-muted-foreground">模型参数(只用于公式,不参与过滤)</legend>
            <div className="flex items-center gap-2">
              <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">r
                <input type="text" inputMode="decimal" aria-label="风险折现率 r(百分数)" value={form.r} onChange={(e) => update({ ...form, r: e.target.value })} className={INPUT} />
              </label>
              <label className="flex min-w-0 flex-1 items-center gap-1 text-xs text-muted-foreground">g
                <input type="text" inputMode="decimal" aria-label="永续增长率 g(百分数)" value={form.g} onChange={(e) => update({ ...form, g: e.target.value })} className={INPUT} />
              </label>
            </div>
          </fieldset>
        </div>

        <div className="space-y-2 border-t border-border/40 pt-3">
          <p className="text-xs text-muted-foreground">可选排除项(勾上才启用;阈值可改)</p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.exclGoodwill} onChange={(e) => update({ ...form, exclGoodwill: e.target.checked })} />剔高商誉
              <input type="text" inputMode="decimal" aria-label="商誉占净资产上限(百分数)" disabled={!form.exclGoodwill} value={form.goodwillMax} onChange={(e) => update({ ...form, goodwillMax: e.target.value })} className={cn(INPUT, "w-20")} /><span className="text-xs text-muted-foreground">%</span>
            </label>
            <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.exclLeverage} onChange={(e) => update({ ...form, exclLeverage: e.target.checked })} />剔高权益乘数
              <input type="text" inputMode="decimal" aria-label="权益乘数上限(倍)" disabled={!form.exclLeverage} value={form.leverageMax} onChange={(e) => update({ ...form, leverageMax: e.target.value })} className={cn(INPUT, "w-20")} /><span className="text-xs text-muted-foreground">倍</span>
            </label>
            <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.exclRevenue} onChange={(e) => update({ ...form, exclRevenue: e.target.checked })} />营收增速 &gt;
              <input type="text" inputMode="decimal" aria-label="营收增速下限(百分数)" disabled={!form.exclRevenue} value={form.revenueMin} onChange={(e) => update({ ...form, revenueMin: e.target.value })} className={cn(INPUT, "w-20")} /><span className="text-xs text-muted-foreground">%</span>
            </label>
            <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.excludeSt} onChange={(e) => update({ ...form, excludeSt: e.target.checked })} />排除 ST / *ST / 退市整理</label>
            <button type="submit" disabled={loading}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-primary/15 px-4 py-2 text-sm font-medium text-primary ring-1 ring-primary/30 hover:bg-primary/25 disabled:opacity-50">
              <Filter className="h-4 w-4" />{loading ? "核对中…" : "开始核对"}
            </button>
          </div>
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">两头都可以只填一头;区间包含边界。没取到的值单独算「缺数据」,既不算满足也不算不满足。行内改 r / g 只重算那一行,不会重跑整个范围。</p>
      </form>
    </GlassCard>

    {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
    {loading && !data && <p role="status" className="mb-4 text-sm text-muted-foreground">正在逐只取财报和行情…范围大的时候可能要几分钟。</p>}

    {data && <div className="space-y-5">
      <GlassCard>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {VERDICT_TABS.map((t) => <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => { setTab(t.key); setShownCount(PAGE_SIZE); }}
            className={cn("rounded-full border px-3 py-1 text-xs", tab === t.key ? "border-primary/50 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground")}>
            {t.label} {data.counts[t.key]}
          </button>)}
        </div>
        <p className="mb-1 text-xs text-muted-foreground">
          {data.universe.label} 本次核对 {data.universe.size} 只{data.universe.total > data.universe.size ? `(范围内共 ${data.universe.total} 只)` : ""}
          {data.universe.as_of ? `(成分文件日期 ${data.universe.as_of})` : ""};行情 {data.quotes.source}{data.quotes.fetched_at ? `,取于 ${shortTime(data.quotes.fetched_at)}(北京时间)` : ""}。
        </p>
        <p className="mb-1 text-xs text-muted-foreground">{data.strategy.label}:{data.strategy.formula},r={(data.strategy.r * 100).toFixed(2)}%,g={(data.strategy.g * 100).toFixed(2)}%。ROE 口径:{data.strategy.roe_basis}。</p>
        <p className="mb-4 text-xs text-muted-foreground">按代码排列,不排名。「全部满足」只说明过了你设的这几条,不是选股结论;测算合理 PB 是模型假设值,不是估值判断。</p>

        {rows.length === 0
          ? <p className="py-6 text-center text-sm text-muted-foreground">这一组没有。{data.gaps.length ? "下面有没取到的,请一并看。" : ""}</p>
          : <div className="-mx-2 overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-normal">代码</th>
                  <th scope="col" className="px-3 py-2 font-normal">简称</th>
                  <th scope="col" className="px-3 py-2 font-normal">当前 PB</th>
                  <th scope="col" className="px-3 py-2 font-normal">实测 ROE</th>
                  <th scope="col" className="px-3 py-2 font-normal">测算合理 PB</th>
                  {data.conditions.map((c) => <th key={c.id} scope="col" className="px-3 py-2 font-normal">{c.label}</th>)}
                  <th scope="col" className="px-3 py-2 font-normal">只改这一行的 r / g(%)</th>
                  <th scope="col" className="px-3 py-2 font-normal"><span className="sr-only">去研究</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const ov = overrides[r.symbol];
                  return <tr key={r.symbol} className="border-b border-border/30 last:border-0">
                    <td className="px-3 py-2 align-top font-mono text-xs">{r.symbol}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">{r.name || "—"}</td>
                    <td className={CN_CELL}>{r.pb === null ? "缺数据" : `${r.pb.toFixed(2)} 倍`}</td>
                    <td className={CN_CELL}>{r.roe === null ? "缺数据" : `${(r.roe * 100).toFixed(2)}%`}</td>
                    <td className={CN_CELL}>{r.fair_pb === null ? "模型不可算" : `${r.fair_pb.toFixed(2)} 倍`}</td>
                    {data.conditions.map((c) => <CheckCell key={c.id} c={r.checks.find((x) => x.id === c.id)} />)}
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-1">
                        <input type="text" inputMode="decimal" aria-label={`${r.symbol} 的风险折现率 r`} value={ov?.r ?? rDefault}
                          onChange={(e) => setOverride(r.symbol, "r", e.target.value)} className={cn(INPUT, "w-16 px-1.5 py-1 text-xs")} />
                        <input type="text" inputMode="decimal" aria-label={`${r.symbol} 的永续增长率 g`} value={ov?.g ?? gDefault}
                          onChange={(e) => setOverride(r.symbol, "g", e.target.value)} className={cn(INPUT, "w-16 px-1.5 py-1 text-xs")} />
                        {r.adjusted && <button type="button" title="用回统一参数" aria-label={`${r.symbol} 用回统一参数`}
                          onClick={() => setOverrides((old) => { const next = { ...old }; delete next[r.symbol]; return next; })}
                          className="rounded-md border border-border/60 p-1 text-muted-foreground hover:text-foreground"><RotateCcw className="h-3 w-3" /></button>}
                      </div>
                      {r.adjusted && <span className="mt-1 block whitespace-nowrap text-[11px] text-muted-foreground">已按本次调整重算,这一行仍然展示</span>}
                    </td>
                    <td className="px-3 py-2 align-top"><Link to={`/research?symbol=${encodeURIComponent(r.symbol)}`} className="whitespace-nowrap text-xs text-primary hover:underline">去研究</Link></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>}
        {rows.length > shown.length && <div className="mt-3 text-center">
          <button type="button" onClick={() => setShownCount((n) => n + PAGE_SIZE)} className={BTN}>再显示 {Math.min(PAGE_SIZE, rows.length - shown.length)} 只(这一组共 {rows.length} 只)</button>
        </div>}
      </GlassCard>

      <GlassCard>
        <h2 className="mb-2 text-sm font-semibold">条件、公式和来源</h2>
        <p className="mb-2 text-xs text-muted-foreground">{data.strategy.formula}。分子减去 g 是因为维持增速必须留存,不能把盈利全部分掉;r、g 是你给的模型参数,不是筛选条件。</p>
        <p className="mb-2 text-xs text-muted-foreground">财报:{data.financials.source}。{data.financials.note}</p>
        <ul className="space-y-1 text-xs text-muted-foreground">{data.conditions.map((c) => <li key={c.id}>{c.label}:{c.source}</li>)}</ul>
      </GlassCard>

      {data.gaps.length > 0 && <GlassCard>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><SearchX className="h-4 w-4 text-muted-foreground" />没取到的({data.gaps.length})</h2>
        <p className="mb-2 text-[11px] text-muted-foreground">没取到的不算「不满足」,也不代表真的不符合。</p>
        <ul className="space-y-1 text-xs text-muted-foreground">{data.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
      </GlassCard>}
    </div>}
  </div>;
}
