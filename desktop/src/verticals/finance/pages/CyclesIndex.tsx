import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, Repeat } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { GlassCard } from "@/components/ui/GlassCard";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import { backend, ApiError } from "@/lib/backend";
import {
  SERIES_NAME, STATE_LABEL, biasOption, extremes, gapText, simpleOption, stateOf, triggerText, turnoverOption, valueText, verdictLine,
  type CyclesMetric, type CyclesResult,
} from "@/lib/cycles";
import { useAiPage } from "../../../core/ai/pageContext";
import { cn } from "@/lib/utils";

const BTN = "inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";

/** 状态药丸:已触发用警示色,未触发保持中性 —— 不拿红绿表达"好坏",触发只是极端值,不是买卖信号 */
function StatePill({ m }: { m: CyclesMetric }) {
  const s = stateOf(m);
  return <span className={cn(
    "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] leading-4",
    s === "triggered" ? "border-warning/50 bg-warning/10 text-warning" : "border-border/60 text-muted-foreground",
  )}>{STATE_LABEL[s]}</span>;
}

/** 一个指标的卡:值 → 触发线 → 距离 → 曲线 → 口径。口径和距离是这张卡的重点,不能只放大数字 */
function MetricCard({ m }: { m: CyclesMetric }) {
  const palette = usePalette();
  const option = useMemo(() => (
    m.id === "turnover20" ? turnoverOption(m, palette)
      : m.id === "hsi_bias250" ? biasOption(m, palette)
        : simpleOption(m, palette, SERIES_NAME[m.id])
  ), [m, palette]);
  const ext = useMemo(() => extremes(m.series), [m.series]);
  const isTurnover = m.id === "turnover20";
  const isBias = m.id === "hsi_bias250";
  return <GlassCard>
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold">{m.label}</h2>
      <StatePill m={m} />
      {m.as_of && <span className="ml-auto text-[11px] text-muted-foreground">数据日 {m.as_of}</span>}
    </div>

    <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
      <span className={cn("text-3xl font-semibold tabular-nums", stateOf(m) === "triggered" ? "text-warning" : "text-foreground")}>
        {valueText(m.value, 2, m.unit)}
      </span>
      <span className="pb-1 text-xs text-muted-foreground">触发线 {triggerText(m)}</span>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">{gapText(m)}</p>

    {isTurnover
      ? <p className="mt-1 text-[11px] text-muted-foreground/80">细线 = 逐日换手率,粗线 = 20 日均;虚线是触发线</p>
      : isBias
        ? <p className="mt-1 text-[11px] text-muted-foreground/80">
            恒指收盘 {m.close?.toLocaleString("zh-CN")} 点 · 250 日均线 {m.ma?.toLocaleString("zh-CN")} 点
            {ext.low ? ` · 窗口内最低 ${ext.low.value.toFixed(2)}%(${ext.low.date})` : ""}
          </p>
        : m.aux && m.aux.length > 0
          ? <p className="mt-1 text-[11px] text-muted-foreground/80">{m.aux.map((a) => `${a.label} ${a.text}`).join(" · ")}</p>
          : null}

    <div className="mt-2">
      {option
        ? <EChart option={option} height={190} />
        : <p className="py-10 text-center text-xs text-muted-foreground">这一项这一轮没有可画的序列</p>}
    </div>

    <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{m.formula}</p>
    <p className="text-[11px] leading-5 text-muted-foreground/70">{m.source}</p>
    {m.gaps.length > 0 && <ul className="mt-1 space-y-0.5 text-[11px] leading-5 text-muted-foreground/70">
      {m.gaps.map((g) => <li key={g}>· {g}</li>)}
    </ul>}
  </GlassCard>;
}

/** 数据到了以后的整屏(拆出来是为了界面测试能直接渲染它) */
export function CyclesPanel({ data }: { data: CyclesResult }) {
  return <div className="space-y-4">
    <GlassCard className={cn(data.signal === "none" ? "" : "border-warning/40")}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Repeat className="h-4 w-4 text-primary" />模型核心指标触发情况</h2>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {data.fetched_at ? `${data.fetched_at.slice(0, 16).replace("T", " ")} 取` : "取数时刻未知"}{data.cached ? "(缓存)" : ""}
        </span>
      </div>
      <p className="mt-2 text-lg font-semibold">{verdictLine(data)}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{data.reading}</p>
      {data.gaps.length > 0 && <ul className="mt-2 space-y-0.5 text-[11px] leading-5 text-warning">
        {data.gaps.map((g) => <li key={g}>· {g}</li>)}
      </ul>}
    </GlassCard>

    <div className="grid gap-4 lg:grid-cols-2">
      {data.metrics.map((m) => <MetricCard key={m.id} m={m} />)}
    </div>
  </div>;
}

export function CyclesIndex() {
  const [data, setData] = useState<CyclesResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await backend.cycles({ refresh });
      if (my === seq.current) { setData(r); setError(""); }
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(false); }, [load]);

  useAiPage({
    key: "cycles-index",
    title: "周期指标",
    context: data
      ? `A 股熊市底部模型的 ${data.metrics.length} 项核心指标(${data.fetched_at?.slice(0, 10) ?? "取数日未知"} 取):\n`
        + data.metrics.map((m) => `${m.label}:${valueText(m.value, 2, m.unit)}(数据日 ${m.as_of ?? "未知"}),触发线 ${triggerText(m)},${STATE_LABEL[stateOf(m)]},${gapText(m)};口径:${m.formula}`).join("\n")
        + `\n合计:${verdictLine(data)}`
        + (data.gaps.length ? `\n没算出来的:${data.gaps.join(";")}` : "")
      : "周期指标:还没取到。",
    suggestions: ["这几项指标离触发线还有多远", "VIX 这一项的口径为什么取窗口最高而不是最新值", "换手率这个口径是怎么算的,可靠吗"],
  });

  return <div>
    <PageHeader
      title="周期指标"
      subtitle="用长周期极端值复核「A 股是不是已经在熊市底部区域」。接入模型的七项核心指标:上证换手率 20 日均、恒指 250 日乖离率、社融同比 6 个月变化、准备金率 250 日变化、VIX 冲高、M2−GDP 增速差、恒指相对上证 60 日强弱。怎么算、用哪天的数据、离触发线还有多远都写在卡片里 —— 这一页做的是复核,不是预测。"
      actions={<button type="button" onClick={() => void load(true)} disabled={loading} className={BTN}>
        <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />{loading ? "取数中…" : "重新取数"}
      </button>}
    />

    {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</p>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">正在取数…行情、上交所概况、恒指、社融 / M2 / 准备金率 / GDP / VIX 来自多个端点,第一次要十几秒。</p>}

    {data && <CyclesPanel data={data} />}

    {data && data.available_count === 0 && <GlassCard className="mt-4 border-warning/40">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-warning" />这一轮全部指标都没算出来</h2>
      <p className="text-xs text-muted-foreground">上游端点没回数据时不会拿旧值顶上。稍后点「重新取数」再试。</p>
    </GlassCard>}

    <Disclaimer />
  </div>;
}
