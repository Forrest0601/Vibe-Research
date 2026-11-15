import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "../src/finance/register.ts";
import "../src/finance/register_tasks.ts";
import { complianceGate } from "../src/gate.ts";
import { detectPython } from "../src/init.ts";
import { ServiceError, type ServiceContext } from "../src/service.ts";
import { listViews } from "../src/views.ts";
import {
  DEFAULT_LIMIT, checkRow, fairPb, financialsOf, latestOf, parsePct, parseRange,
  revenueGrowth, safeRatio, seriesOf, strategyScreen, ttmFromYtd, UNIVERSES, verdictOf,
  type ScreenOptions,
} from "../src/finance/strategy_screen.ts";
import { UNIVERSES as UI_UNIVERSES, fairPb as uiFairPb } from "../../desktop/src/verticals/finance/lib/strategy.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PY = process.env.VRA_PYTHON ?? detectPython(REPO) ?? detectPython(path.join(REPO, "..")) ?? "python3";
const bad = (e: unknown) => e instanceof ServiceError && e.code === "bad_query";

const OPTS: ScreenOptions = {
  pb: { min: 0, max: 2 }, roe: { min: 0.05, max: 0.3 }, r: 0.1, g: 0.03,
  excludeSt: true, exclGoodwill: false, goodwillMax: 0.3,
  exclLeverage: false, leverageMax: 3, exclRevenue: false, revenueMin: 0,
};

test("公式:(ROE − g)/(r − g),不写成 ROE/(r − g);异常域一律返回 null", () => {
  assert.ok(Math.abs(fairPb(0.15, 0.1, 0.03)! - 0.12 / 0.07) < 1e-12);
  assert.ok(Math.abs(fairPb(0.15, 0.1, 0)! - 1.5) < 1e-12);
  assert.equal(fairPb(0.15, 0.03, 0.03), null, "r = g 分母为 0");
  assert.equal(fairPb(0.15, 0.02, 0.03), null, "r < g");
  assert.equal(fairPb(0.02, 0.1, 0.03), null, "ROE ≤ g,合理 PB 非正");
  assert.equal(fairPb(Number.NaN, 0.1, 0.03), null);
  assert.equal(fairPb(0.15, Number.POSITIVE_INFINITY, 0.03), null);
});

test("前后端同一个公式:多组输入结果一致", () => {
  for (const [roe, r, g] of [[0.15, 0.1, 0.03], [0.08, 0.12, 0.02], [0.3, 0.09, 0.01], [0.02, 0.1, 0.03], [0.1, 0.05, 0.06]] as const) {
    assert.equal(uiFairPb(roe, r, g), fairPb(roe, r, g), `${roe}/${r}/${g}`);
  }
});

test("查询串:区间、百分数转小数、下限大于上限报错", () => {
  assert.deepEqual(parseRange({ pb_min: "0.5", pb_max: "2" }, "pb", "当前 PB"), { min: 0.5, max: 2 });
  assert.deepEqual(parseRange({}, "pb", "当前 PB"), { min: null, max: null });
  assert.equal(parsePct(undefined, "r", 10), 0.1);
  assert.equal(parsePct("3.5", "g", 3), 0.035);
  assert.throws(() => parseRange({ pb_min: "3", pb_max: "1" }, "pb", "当前 PB"), bad);
  assert.throws(() => parsePct("abc", "r", 10), bad);
});

test("财报换算:YTD 累计 → TTM,营收同比,同单位比率,分母非正不算", () => {
  const profit: { period: string; value: number | null }[] = [
    { period: "2025-09-30", value: 75 }, { period: "2025-12-31", value: 100 }, { period: "2026-09-30", value: 90 },
  ];
  assert.equal(ttmFromYtd(profit, "2026-09-30"), 115, "本期累计 + 上年年报 − 上年同期累计");
  assert.equal(ttmFromYtd(profit, "2025-12-31"), 100, "年报本身就是全年");
  assert.equal(ttmFromYtd([{ period: "2026-09-30", value: 90 }], "2026-09-30"), null, "缺上年年报不拿三季凑一年");
  assert.ok(Math.abs(revenueGrowth([{ period: "2025-09-30", value: 1000 }, { period: "2026-09-30", value: 1100 }])!.value - 0.1) < 1e-12);
  assert.equal(revenueGrowth([{ period: "2025-09-30", value: 0 }, { period: "2026-09-30", value: 1100 }]), null);
  assert.equal(safeRatio(100, 1000), 0.1);
  assert.equal(safeRatio(100, 0), null);
  assert.equal(safeRatio(null, 1000), null);
});

test("financialsOf:实测 ROE 用财报口径,商誉科目缺失要如实标记", () => {
  const fin = { evidence: [
    { field: "net_profit_parent_cum", period: "2025-09-30", value: 75 },
    { field: "net_profit_parent_cum", period: "2025-12-31", value: 100 },
    { field: "net_profit_parent_cum", period: "2026-09-30", value: 90 },
    { field: "revenue_cum", period: "2025-09-30", value: 1000 },
    { field: "revenue_cum", period: "2026-09-30", value: 1100 },
  ] };
  const bal = { evidence: [
    { field: "equity_parent", period: "2026-09-30", value: 1000 },
    { field: "total_equity", period: "2026-09-30", value: 1000 },
    { field: "total_assets", period: "2026-09-30", value: 2500 },
    { field: "goodwill", period: "2026-09-30", value: 100 },
  ] };
  const f = financialsOf(fin, bal);
  assert.equal(f.roe, 0.115);
  assert.equal(f.roe_period, "2026-09-30");
  assert.equal(f.goodwill_ratio, 0.1);
  assert.equal(f.leverage, 2.5);
  assert.ok(f.revenue_growth !== null && Math.abs(f.revenue_growth - 0.1) < 1e-12);
  assert.equal(f.missingGoodwill, false);
  const f2 = financialsOf(fin, { evidence: bal.evidence.filter((e) => e.field !== "goodwill") });
  assert.equal(f2.missingGoodwill, true);
  assert.equal(f2.goodwill_ratio, null);
  assert.equal(latestOf(bal, "total_assets")!.value, 2500);
  assert.equal(seriesOf(fin, "revenue_cum").length, 2);
});

test("checkRow:三态、模型不可算记缺数据、三项排除、ST", () => {
  const q = { name: "样本A", fields: { pb: 1 }, halted: false };
  const f = { roe: 0.115, roe_period: "2026-09-30", goodwill_ratio: 0.1, leverage: 2.5, revenue_growth: 0.1, revenue_period: "2026-09-30", missingGoodwill: false };
  const ok = checkRow(q, f, OPTS);
  assert.equal(verdictOf(ok), "met");
  assert.ok(ok.find((c) => c.id === "fair_pb")!.value! > 1, "合理 PB 约 1.21,当前 PB 1 应满足");

  const under = checkRow(q, f, { ...OPTS, r: 0.2, g: 0.03 });
  assert.equal(under.find((c) => c.id === "fair_pb")!.state, "unmet", "r−g 变大后合理 PB 变小");

  const noFin = checkRow(q, undefined, OPTS);
  assert.equal(verdictOf(noFin), "missing");
  assert.equal(noFin.find((c) => c.id === "fair_pb")!.state, "missing", "没取到 ROE 不算不满足");

  const loss = checkRow(q, { ...f, roe: -0.2 }, OPTS);
  assert.equal(loss.find((c) => c.id === "fair_pb")!.state, "missing", "亏损股模型不可算");

  const excl = { ...OPTS, exclGoodwill: true, exclLeverage: true, exclRevenue: true };
  assert.equal(verdictOf(checkRow(q, { ...f, goodwill_ratio: 0.5 }, excl)), "unmet", "商誉超阈值排除");
  assert.equal(verdictOf(checkRow(q, { ...f, leverage: 4 }, excl)), "unmet", "权益乘数超阈值排除");
  assert.equal(verdictOf(checkRow(q, { ...f, revenue_growth: -0.1 }, excl)), "unmet", "营收负增长排除");
  assert.equal(verdictOf(checkRow(q, { ...f, goodwill_ratio: null }, excl)), "missing", "商誉缺数据单独成组");
  const st = { ...q, name: "*ST样本" };
  assert.equal(verdictOf(checkRow(st, f, OPTS)), "unmet");
});

// ── 整条链路:假取数器(读仓库根目录 cfg.json,每次调用记一行 calls.log) ──
const FAKE = String.raw`import json,sys,os
a=sys.argv; ep=a[a.index('--endpoint')+1]; out=a[a.index('--out-dir')+1]
sym=a[a.index('--symbol')+1] if '--symbol' in a else ''
args=json.loads(a[a.index('--args')+1]) if '--args' in a else {}
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':ep,'sym':sym,'args':args})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
def done(env): print(json.dumps(env)); sys.exit(0)
if ep=='index_constituents':
  ms=cfg['members']; ref='raw/extracted_csindex_%s_%d.json'%(sym,os.getpid())
  json.dump({'rows':[{'code':c,'name':n} for c,n in ms]},open(os.path.join(out,ref),'w'))
  ev=[{'field':'index_member_count','value':len(ms),'period':'2026-09-30','raw_ref':ref}]
  ev+=[{'field':'index_member','value':c+' '+n,'period':'2026-09-30','raw_ref':ref} for c,n in ms[:30]]
  done({'status':'ok','evidence':ev})
if ep=='tx_quotes_batch':
  ev=[]
  for c in args['codes']:
    v=cfg['quotes'].get(c)
    if v is None: continue
    k=('sh' if c[0]=='6' else 'sz')+c
    ev.append({'record_key':k,'field':'pb','value':v['pb'],'note':v.get('security_name','')+'('+k+')','period':'2026-10-08'})
    ev.append({'record_key':k,'field':'security_name','value':v.get('security_name','样本'),'period':'2026-10-08'})
  done({'status':'ok','evidence':ev,'extra':{'stale':[]}})
if ep=='fetch_financials':
  if sym in cfg.get('fin_fail',[]): done({'status':'failed','evidence':[],'errors':[{'source':'sina','error':'HTTP 502'}]})
  ps=['2024-12-31','2025-03-31','2025-06-30','2025-09-30','2025-12-31','2026-03-31','2026-06-30','2026-09-30']
  prof={'2025-09-30':75,'2025-12-31':100,'2026-09-30':90}
  rev={'2025-09-30':1000,'2026-09-30':1100}
  ev=[]
  for p in ps:
    ev.append({'field':'net_profit_parent_cum','value':prof.get(p,60),'unit':'元','period':p})
    ev.append({'field':'revenue_cum','value':rev.get(p,900),'unit':'元','period':p})
  done({'status':'ok','evidence':ev})
if ep=='sina_balance_sheet':
  ev=[]
  for fld,v in [('equity_parent',1000),('total_equity',1000),('total_assets',2500),('goodwill',100)]:
    if fld=='goodwill' and sym in cfg.get('no_goodwill',[]): continue
    ev.append({'field':fld,'value':v,'unit':'元','period':'2026-09-30'})
  done({'status':'ok','evidence':ev})
done({'status':'failed','reason':'unknown','evidence':[]})
`;

/** fetch_financials 是 legacy 端点,registry.fetchArgv 会直接跑这个脚本而不是通用取数器 */
const FAKE_LEGACY = String.raw`import json,sys,os
a=sys.argv
out=a[a.index('--out-dir')+1]
sym=a[a.index('--symbol')+1] if '--symbol' in a else ''
cfg=json.load(open('cfg.json'))
open('calls.log','a').write(json.dumps({'ep':'fetch_financials','sym':sym})+'\n')
os.makedirs(os.path.join(out,'raw'),exist_ok=True)
def done(env): print(json.dumps(env)); sys.exit(0)
if sym in cfg.get('fin_fail',[]): done({'status':'failed','evidence':[],'errors':[{'source':'sina','error':'HTTP 502'}]})
ps=['2024-12-31','2025-03-31','2025-06-30','2025-09-30','2025-12-31','2026-03-31','2026-06-30','2026-09-30']
prof={'2025-09-30':75,'2025-12-31':100,'2026-09-30':90}
rev={'2025-09-30':1000,'2026-09-30':1100}
ev=[]
for p in ps:
  ev.append({'field':'net_profit_parent_cum','value':prof.get(p,60),'unit':'元','period':p})
  ev.append({'field':'revenue_cum','value':rev.get(p,900),'unit':'元','period':p})
done({'status':'ok','evidence':ev})
`;

interface Cfg {
  members: [string, string][];
  quotes: Record<string, { pb: number; security_name?: string }>;
  fin_fail?: string[];
  no_goodwill?: string[];
}

function fakeCtx(): ServiceContext & { setCfg(c: Cfg): void; calls(): { ep: string; sym: string }[] } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vr-strategy-"));
  fs.mkdirSync(path.join(repo, "datasources"));
  fs.copyFileSync(path.join(REPO, "datasources", "registry.json"), path.join(repo, "datasources", "registry.json"));
  const scripts = path.join(repo, ".agents", "skills", "data-access", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "fetch_endpoint.py"), FAKE);
  fs.writeFileSync(path.join(scripts, "fetch_financials.py"), FAKE_LEGACY);
  const dataRoot = path.join(repo, ".local");
  fs.mkdirSync(dataRoot);
  return {
    repoRoot: repo, dataRoot, python: PY, node: process.execPath,
    setCfg: (c) => fs.writeFileSync(path.join(repo, "cfg.json"), JSON.stringify(c)),
    calls: () => { try { return fs.readFileSync(path.join(repo, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
  };
}

const run = (ctx: ServiceContext, query: Record<string, string>) =>
  strategyScreen(ctx, query, new AbortController().signal, new Date("2026-10-08T08:00:00Z"));

test("视图已注册;前端范围和后端同序同名", () => {
  assert.ok(listViews().some((v) => v.id === "strategy_screen" && v.label === "策略选股"));
  assert.deepEqual(UI_UNIVERSES.map((u) => [u.id, u.label]), UNIVERSES.map((u) => [u.id, u.label]));
});

test("参数校验:r > g、策略与范围要认识、阈值合法、至少一个条件", async () => {
  const ctx = fakeCtx();
  try {
    const base = { r: "10", g: "3", pb_max: "2" };
    await assert.rejects(run(ctx, { ...base, r: "3", g: "3" }), bad);
    await assert.rejects(run(ctx, { ...base, r: "2", g: "3" }), bad);
    await assert.rejects(run(ctx, { ...base, strategy: "nope" }), bad);
    await assert.rejects(run(ctx, { ...base, universe: "nope" }), bad);
    await assert.rejects(run(ctx, { ...base, excl_goodwill: "1", goodwill_max: "-1" }), bad);
    await assert.rejects(run(ctx, { ...base, pb_min: "9", pb_max: "1" }), bad);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("整链路:行情 + 逐只财报 → 三态分组、测算合理 PB、缺数据写进 gaps,合规 gate 通过", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({
      members: [["600000", "样本甲"], ["000001", "样本乙"], ["600001", "样本丙"]],
      quotes: { "600000": { pb: 1, security_name: "样本甲" }, "000001": { pb: 3, security_name: "样本乙" }, "600001": { pb: 1.2, security_name: "样本丙" } },
      fin_fail: ["600001"],
    });
    const r = await run(ctx, { universe: "hs300", pb_min: "0", pb_max: "2", roe_min: "5", roe_max: "30", r: "10", g: "3", exclude_st: "1", limit: "300" });
    assert.equal(r.universe.size, 3);
    assert.equal(r.universe.total, 3);
    assert.equal(r.strategy.formula, "合理 PB = (ROE − g) / (r − g)");
    assert.deepEqual(r.rows.map((x) => x.symbol), ["000001", "600000", "600001"], "按代码排列");
    const a = r.rows.find((x) => x.symbol === "600000")!;
    assert.equal(a.roe, 0.115);
    assert.ok(a.fair_pb !== null && Math.abs(a.fair_pb - 0.085 / 0.07) < 1e-9);
    assert.equal(a.verdict, "met");
    assert.equal(r.rows.find((x) => x.symbol === "000001")!.verdict, "unmet", "当前 PB 3 超出 PB 上限");
    assert.equal(r.rows.find((x) => x.symbol === "600001")!.verdict, "missing", "财报失败的那只单独成组");
    assert.ok(r.gaps.some((g) => /财报没取到 1 只/.test(g)));
    assert.ok(r.conditions.some((c) => c.id === "fair_pb"));
    assert.ok(complianceGate(JSON.stringify(r)).ok, "产出不得出现动作建议或评分用语");
    assert.doesNotMatch(JSON.stringify(r), /排名|得分|score|rank/);
    assert.equal(ctx.calls().filter((c) => c.ep === "fetch_financials").length, 3, "每只财报只取一次");
    assert.equal(ctx.calls().filter((c) => c.ep === "sina_balance_sheet").length, 3);
    assert.equal(ctx.calls().filter((c) => c.ep === "tx_quotes_batch").length, 1);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("三项排除:勾上才启用;商誉科目缺失写进 gaps 且记缺数据", async () => {
  const ctx = fakeCtx();
  try {
    ctx.setCfg({
      members: [["600000", "样本甲"], ["000001", "样本乙"]],
      quotes: { "600000": { pb: 1, security_name: "样本甲" }, "000001": { pb: 1, security_name: "样本乙" } },
      no_goodwill: ["000001"],
    });
    const r = await run(ctx, { universe: "hs300", excl_goodwill: "1", goodwill_max: "30", excl_leverage: "1", leverage_max: "3", excl_revenue: "1", revenue_min: "0", exclude_st: "0" });
    assert.ok(r.conditions.some((c) => c.id === "goodwill"));
    assert.ok(r.conditions.some((c) => c.id === "leverage"));
    assert.ok(r.conditions.some((c) => c.id === "revenue"));
    assert.ok(r.gaps.some((g) => /商誉/.test(g)));
    assert.equal(r.rows.find((x) => x.symbol === "000001")!.verdict, "missing");
    assert.equal(r.rows.find((x) => x.symbol === "600000")!.verdict, "met");
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});

test("取数上限:超出的不取数、不进结果,写进 gaps", async () => {
  const ctx = fakeCtx();
  try {
    const members: [string, string][] = [["600000", "甲"], ["600001", "乙"], ["600002", "丙"]];
    const quotes: Cfg["quotes"] = {};
    for (const [c, n] of members) quotes[c] = { pb: 1, security_name: n };
    ctx.setCfg({ members, quotes });
    const r = await run(ctx, { universe: "hs300", limit: "2", exclude_st: "0", pb_max: "2" });
    assert.equal(r.universe.size, 2);
    assert.equal(r.universe.total, 3);
    assert.ok(r.gaps.some((g) => /其余 1 只没取数/.test(g)));
    assert.equal(ctx.calls().filter((c) => c.ep === "fetch_financials").length, 2);
    assert.equal(DEFAULT_LIMIT, 300);
  } finally { fs.rmSync(ctx.repoRoot, { recursive: true, force: true }); }
});
