"""宏观源:人民银行社会融资规模增量(月度,亿元)/ 国家统计局 PMI。移植自 a-stock-data SKILL.md §11.1 / §11.2。官方网页解析,零鉴权;依赖 pandas(+xlrd/openpyxl)。"""
from __future__ import annotations

import io
import os
import re
import sys
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sources._http import http_get  # noqa: E402

_UA = {"User-Agent": "Mozilla/5.0"}
PBC_BASE = "https://www.pbc.gov.cn"
PBC_INDEX = f"{PBC_BASE}/diaochatongjisi/116219/116319/index.html"
NBS_INDEX = "https://www.stats.gov.cn/sj/zxfb/"


def _macro_get(url: str, timeout: int = 30) -> str:
    r = http_get(url, headers=_UA, timeout=timeout, ext="html")
    r.raise_for_status()
    r.encoding = r.apparent_encoding or "utf-8"
    return r.text


def _abs_pbc(href: str) -> str:
    return href if href.startswith("http") else PBC_BASE + href


def pboc_social_financing(year: Optional[int] = None) -> list[dict]:
    """社融增量统计表(仅支持 2021 年起版式):[{month:'YYYY-MM', afre_total, rmb_loans, fx_loans, entrusted_loans, trust_loans, undiscounted_bankers_acceptance, corporate_bonds, government_bonds, equity_financing, abs_by_depository, loans_written_off}] 单位亿元"""
    import pandas as pd
    idx = _macro_get(PBC_INDEX)
    years = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(\d{4})年统计数据\s*</a>""", idx)
    if not years:
        raise RuntimeError("人民银行索引页未找到「XXXX年统计数据」链接,页面结构可能已变更")
    table = {int(y): href for href, y in years}
    target = max(table) if year is None else int(year)
    if target not in table:
        raise ValueError(f"人民银行无 {target} 年数据,可选年份: {sorted(table, reverse=True)[:8]}")
    ypage = _macro_get(_abs_pbc(table[target]))
    topics = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(社会融资规模)\s*</a>""", ypage)
    if not topics:
        raise RuntimeError(f"{target} 年页未找到「社会融资规模」专题链接")
    tpage = _macro_get(_abs_pbc(topics[0][0]))
    books = re.findall(r"""href=["']([^"']+\.xlsx?)["']""", tpage)
    if not books:
        raise RuntimeError(f"{target} 年社融专题页未找到 xls/xlsx 附件")
    xr = http_get(_abs_pbc(books[0]), headers=_UA, timeout=60, ext="xlsx" if books[0].endswith("xlsx") else "xls")
    xr.raise_for_status()
    raw = pd.read_excel(io.BytesIO(xr.content), header=None)
    start = next((i for i in range(len(raw)) if str(raw.iloc[i, 0]).strip() == "月份"), None)
    if start is None:
        raise RuntimeError(f"{target} 年社融表没有独立的「月份」表头单元格;本端点仅支持 2021 年起版式")
    cols = ["month", "afre_total", "rmb_loans", "fx_loans", "entrusted_loans", "trust_loans", "undiscounted_bankers_acceptance", "corporate_bonds", "government_bonds", "equity_financing",
            "abs_by_depository", "loans_written_off"]
    df = raw.iloc[start + 3:].copy().iloc[:, :len(cols)]
    df.columns = cols
    df = df[df["month"].astype(str).str.match(r"^\d{4}\.\d{1,2}$", na=False)].copy()
    for c in cols[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    def _month_label(v):
        m = re.match(r"^(\d{4})\.(\d{1,2})$", str(v).strip())
        if not m:
            return None
        ys, ms = m.group(1), m.group(2)
        if len(ms) == 1:
            ms += "0"  # Excel 吃掉 2026.10 的尾零 → 2026.1;1 月始终写作 .01
        return f"{ys}-{int(ms):02d}"

    df["month"] = [_month_label(v) for v in df["month"]]
    df = df[df["month"].notna()]
    df = df[df["month"].str.startswith(f"{target}-")].dropna(subset=["afre_total"]).reset_index(drop=True)
    if df.empty:
        raise RuntimeError(f"社融表解析后无有效月份({target} 年),格式可能已变更")
    return [{k: (None if (isinstance(v, float) and v != v) else v) for k, v in rec.items()} for rec in df.to_dict("records")]


def _pbc_year_page(year: Optional[int] = None) -> tuple[int, str]:
    """人民银行「XXXX年统计数据」页 → (年份, 页面 HTML)。与社融增量表同一套索引结构,仅支持 2021 年起版式。"""
    idx = _macro_get(PBC_INDEX)
    years = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*(\d{4})年统计数据\s*</a>""", idx)
    if not years:
        raise RuntimeError("人民银行索引页未找到「XXXX年统计数据」链接,页面结构可能已变更")
    table = {int(y): href for href, y in years}
    target = max(table) if year is None else int(year)
    if target not in table:
        raise ValueError(f"人民银行无 {target} 年数据,可选年份: {sorted(table, reverse=True)[:8]}")
    return target, _macro_get(_abs_pbc(table[target]))


def _pbc_book(year: int, topic: str, title_contains: str, max_probe: int = 10):
    """按专题页附件的表内标题挑 xls/xlsx → (附件 href, DataFrame)。
    附件链接的锚文本全是「xls」,分不出是哪张表,只能逐个下载看首行标题;按上传时间倒序通常几张内命中。"""
    import pandas as pd
    ypage = _pbc_year_page(year)[1]
    links = re.findall(r"""href=["']([^"']+)["'][^>]*>\s*([^<]+)\s*</a>""", ypage)
    tp = next((h for h, t in links if topic in t), None)
    if not tp:
        raise RuntimeError(f"{year} 年页未找到「{topic}」专题链接")
    books = re.findall(r"""href=["']([^"']+\.xlsx?)["']""", _macro_get(_abs_pbc(tp)))
    if not books:
        raise RuntimeError(f"{year} 年「{topic}」专题页未找到 xls/xlsx 附件")
    last_err: Exception | None = None
    for href in books[:max_probe]:
        try:
            xr = http_get(_abs_pbc(href), headers=_UA, timeout=60, ext="xlsx" if href.endswith("xlsx") else "xls")
            xr.raise_for_status()
            raw = pd.read_excel(io.BytesIO(xr.content), header=None)
            title = str(raw.iloc[0, 0])
            if title_contains in title:
                return href, raw
            last_err = RuntimeError(f"标题不符:{title[:24]!r}")
        except ValueError:
            raise
        except Exception as e:  # noqa: BLE001 —— 单个附件读不了就跳过试下一个
            last_err = e
    raise RuntimeError(f"{year} 年「{topic}」附件里没找到标题含「{title_contains}」的表({max_probe} 个内):{last_err}")


def pboc_social_financing_stock(year: Optional[int] = None) -> list[dict]:
    """社融存量统计表(月末存量与同比增速):[{month:'YYYY-MM', afre_stock(万亿元), afre_stock_yoy(%)}]。
    月份单元格是浮点数(2026.1 既可能是 1 月也可能是被 Excel 吃掉尾零的 10 月,两者不分),
    所以月份按列位置对齐 1..12 月 —— 存量表是自然年宽表,首列数据列一定是 1 月。"""
    import pandas as pd
    target, _ = _pbc_year_page(year)
    _, raw = _pbc_book(target, "社会融资规模", "存量统计表")
    header = next((i for i in range(len(raw)) if str(raw.iloc[i, 0]).startswith("项目")), None)
    if header is None or header < 1:
        raise RuntimeError(f"{target} 年社融存量表没有「项目」表头行,格式可能已变更")
    row = next((i for i in range(header + 1, len(raw)) if "社会融资规模存量" in str(raw.iloc[i, 0])), None)
    if row is None:
        raise RuntimeError(f"{target} 年社融存量表没找到「社会融资规模存量」合计行")
    out_rows = []
    for mi in range(12):
        base = 1 + 2 * mi  # 每个月占两列:(存量, 增速)
        stock, yoy = pd.to_numeric(raw.iloc[row, base], errors="coerce"), pd.to_numeric(raw.iloc[row, base + 1], errors="coerce")
        if stock != stock:  # NaN = 当月还没发布
            continue
        out_rows.append({"month": f"{target}-{mi + 1:02d}", "afre_stock": float(stock), "afre_stock_yoy": None if yoy != yoy else float(yoy)})
    if not out_rows:
        raise RuntimeError(f"{target} 年社融存量表解析后无有效月份,格式可能已变更")
    return out_rows


def pboc_money_supply(year: Optional[int] = None) -> list[dict]:
    """货币供应量(M0 / M1 / M2 月末余额,亿元):[{month:'YYYY-MM', m0, m1, m2}]。
    表里没有同比列,同比由调用方拿上一年同月自算;官方口径调整时(如 M1 修约)自算值可能与公布值有出入。
    月份同样按列位置对齐 1..12 月(见社融存量表的说明)。"""
    import pandas as pd
    target, _ = _pbc_year_page(year)
    _, raw = _pbc_book(target, "货币统计概览", "货币供应量")
    header = next((i for i in range(len(raw)) if str(raw.iloc[i, 0]).startswith("项目")), None)
    if header is None:
        raise RuntimeError(f"{target} 年货币供应量表没有「项目」表头行,格式可能已变更")
    month_cols = [c for c in range(raw.shape[1]) if re.match(r"^\d{4}\.\d{1,2}$", str(raw.iloc[header, c]).strip())]
    if not month_cols:
        raise RuntimeError(f"{target} 年货币供应量表「项目」行下没有月份列,格式可能已变更")

    def row_of(pattern: str) -> int:
        r = next((i for i in range(header + 1, len(raw)) if any(pattern in str(v) for v in raw.iloc[i].tolist())), None)
        if r is None:
            raise RuntimeError(f"{target} 年货币供应量表没找到含「{pattern}」的行")
        return r

    r_m2, r_m1, r_m0 = row_of("M2）"), row_of("M1）"), row_of("M0）")
    out_rows = []
    for mi, c in enumerate(month_cols):
        vals = {}
        for key, r in (("m2", r_m2), ("m1", r_m1), ("m0", r_m0)):
            v = pd.to_numeric(raw.iloc[r, c], errors="coerce")
            if v == v:
                vals[key] = float(v)
        if "m2" not in vals:
            continue
        out_rows.append({"month": f"{target}-{mi + 1:02d}", **vals, "m1": vals.get("m1"), "m0": vals.get("m0")})
    if not out_rows:
        raise RuntimeError(f"{target} 年货币供应量表解析后无有效月份,格式可能已变更")
    return out_rows


def _cn_date(v) -> Optional[str]:
    """「2025年05月15日」→ '2025-05-15';EM 的 '2026-09-01 00:00:00' 也截成日期;别的格式返回 None(调用方跳过)。"""
    s = str(v or "").strip()
    m = re.match(r"^(\d{4})年(\d{2})月(\d{2})日$", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else None


def em_macro_rrr(limit: int = 100) -> list[dict]:
    """存款准备金率历次调整(东财 datacenter RPT_ECONOMY_DEPOSIT_RESERVE,按生效日倒序):
    [{trade_date:'YYYY-MM-DD', rate_big_before, rate_big, rate_small_before, rate_small, change_big, change_small}]
    rate_big = 大型存款类金融机构调整后(%),rate_small = 中小型(%),change_* 为本次变动(百分点)。"""
    from sources.astock_ported import _em_datacenter_strict

    rows = _em_datacenter_strict("RPT_ECONOMY_DEPOSIT_RESERVE", sort_columns="TRADE_DATE", sort_types="-1", page_size=min(int(limit), 500))
    out_rows = []
    for r in rows[: int(limit)]:
        td = _cn_date(r.get("TRADE_DATE"))
        if not td:
            continue
        rec = {"trade_date": td, "announce_date": _cn_date(r.get("REPORT_DATE"))}
        for src, dst in (("INTEREST_RATE_BB", "rate_big_before"), ("INTEREST_RATE_BA", "rate_big"), ("INTEREST_RATE_SB", "rate_small_before"),
                         ("INTEREST_RATE_SA", "rate_small"), ("CHANGE_RATE_B", "change_big"), ("CHANGE_RATE_S", "change_small")):
            try:
                rec[dst] = float(r.get(src)) if r.get(src) is not None else None
            except (TypeError, ValueError):
                rec[dst] = None
        if rec["rate_big"] is not None:
            out_rows.append(rec)
    if not out_rows:
        raise RuntimeError("存款准备金率表解析后无有效行(东财报表结构可能已变更)")
    return out_rows


def em_macro_gdp(limit: int = 40) -> list[dict]:
    """GDP 季度累计(东财 datacenter RPT_ECONOMY_GDP,按报告期倒序):
    [{period:'2026年第1-3季度', report_date:'YYYY-MM-DD', gdp_cum(亿元,现价累计), gdp_cum_yoy(%)}]。
    累计值口径:第 1 季度行就是当季;同比 SUM_SAME 是现价累计同比。"""
    from sources.astock_ported import _em_datacenter_strict

    rows = _em_datacenter_strict("RPT_ECONOMY_GDP", sort_columns="REPORT_DATE", sort_types="-1", page_size=min(int(limit), 500))
    out_rows = []
    for r in rows[: int(limit)]:
        period = str(r.get("TIME") or "").strip()
        rd = _cn_date(r.get("REPORT_DATE"))
        try:
            cum = float(r.get("DOMESTICL_PRODUCT_BASE")) if r.get("DOMESTICL_PRODUCT_BASE") is not None else None
            yoy = float(r.get("SUM_SAME")) if r.get("SUM_SAME") is not None else None
        except (TypeError, ValueError):
            continue
        if not period or rd is None or cum is None:
            continue
        out_rows.append({"period": period, "report_date": rd, "gdp_cum": cum, "gdp_cum_yoy": yoy})
    if not out_rows:
        raise RuntimeError("GDP 表解析后无有效行(东财报表结构可能已变更)")
    return out_rows


def nbs_pmi() -> dict:
    """最新 PMI:{title, period:'YYYY-MM', manufacturing_pmi, non_manufacturing_pmi, composite_pmi, pmi_large, pmi_medium, pmi_small, source_url};三主指标解析不到 → 抛错。"""
    idx = _macro_get(NBS_INDEX)
    links = re.findall(r'<a[^>]+href="([^"]+)"[^>]*>\s*([^<]{6,80}?)\s*</a>', idx)
    hit = next(((u, t) for u, t in links if "采购经理指数" in t), None)
    if not hit:
        raise RuntimeError("国家统计局最新发布页未找到「采购经理指数」条目")
    href, title = hit
    url = href if href.startswith("http") else NBS_INDEX + href.lstrip("./")
    html = _macro_get(url)
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.S)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[\s　\xa0]+", "", text)

    def grab(pat):
        m = re.search(pat, text)
        return float(m.group(1)) if m else None

    ym = re.search(r"(\d{4})年(\d{1,2})月", title)
    large = medium = small = None
    combined = re.search(r"大、中、小型企业PMI分别为([\d.]+)%、([\d.]+)%和([\d.]+)%", text)
    if combined:
        large, medium, small = (float(x) for x in combined.groups())
    else:
        m_ms = re.search(r"中、小型企业PMI分别为([\d.]+)%和([\d.]+)%", text)
        if m_ms:
            medium, small = (float(x) for x in m_ms.groups())
        for name, pat in (("large", r"大型企业PMI为([\d.]+)%"), ("medium", r"中型企业PMI为([\d.]+)%"), ("small", r"小型企业PMI为([\d.]+)%")):
            m = re.search(pat, text)
            if m:
                v = float(m.group(1))
                if name == "large":
                    large = v
                elif name == "medium" and medium is None:
                    medium = v
                elif name == "small" and small is None:
                    small = v
    result = {"title": title.strip(), "period": f"{ym.group(1)}-{int(ym.group(2)):02d}" if ym else None, "manufacturing_pmi": grab(r"(?<!非)制造业采购经理指数（PMI）为([\d.]+)%"),
              "non_manufacturing_pmi": grab(r"非制造业商务活动指数为([\d.]+)%"), "composite_pmi": grab(r"综合PMI产出指数为([\d.]+)%"), "pmi_large": large, "pmi_medium": medium, "pmi_small": small,
              "source_url": url}
    absent = [k for k in ("manufacturing_pmi", "non_manufacturing_pmi", "composite_pmi") if result[k] is None]
    if absent:
        raise RuntimeError(f"PMI 正文措辞可能已变更,无法解析 {absent};请核对页面:{url}")
    return result
