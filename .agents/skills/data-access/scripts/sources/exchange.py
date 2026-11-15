"""交易所 / 备用源:龙虎榜官方备源(深交所结构化 + 上交所全文)、公告备源(深市走深交所官方,沪市走东财 np-anotice)。移植自 a-stock-data SKILL.md 备用源速查。"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.request
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import UA, norm_ticker  # noqa: E402
from sources._http import http_get, http_json, insecure_tls_allowed, last_raw_ref, record_raw  # noqa: E402

_NOVERIFY = ssl.create_default_context()
_NOVERIFY.check_hostname = False
_NOVERIFY.verify_mode = ssl.CERT_NONE


def _szse_json(url: str, headers: dict, data: Optional[bytes] = None, timeout: int = 15) -> tuple:
    """深交所接口:先正常校验证书;SSL 失败再免校验重试并在返回里标注(不静默)。返回 (json, tls_verified)"""
    try:
        r = http_get(url, headers=headers, timeout=timeout, ext="json") if data is None else None
        if r is not None:
            r.raise_for_status()
            return r.json(), True
        import requests
        resp = requests.post(url, data=data, headers=headers, timeout=timeout)
        resp.raise_for_status()
        record_raw(resp.content, "json", url)
        return resp.json(), True
    except Exception as e:  # noqa: BLE001
        if "SSL" not in type(e).__name__ and "certificate" not in str(e).lower():
            raise
        if not insecure_tls_allowed():
            raise RuntimeError(f"深交所接口证书校验失败({type(e).__name__});若接受风险可设 VRA_ALLOW_INSECURE_TLS=1 降级(仅研究用)") from e
        req = urllib.request.Request(url, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout, context=_NOVERIFY) as resp:
            body = resp.read()
        record_raw(body, "json", url)
        return json.loads(body), False


def dragon_tiger_backup(trade_date: Optional[str] = None) -> dict:
    """龙虎榜官方备源:{date, szse:[{code,name,amount,reason}], sse_raw(全文), tls_verified};trade_date 缺省 = 北京时间今天"""
    if not trade_date:
        from datetime import datetime
        from common import TZ_SH
        trade_date = datetime.now(TZ_SH).strftime("%Y-%m-%d")
    su = f"https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1842_xxpl&TABKEY=tab1&txtStart={trade_date}&txtEnd={trade_date}&random=0.9"
    d, ok = _szse_json(su, {"User-Agent": UA, "Referer": "https://www.szse.cn/disclosure/supervision/dealinfo/index.html"})
    raw_sz = last_raw_ref()
    out = {"date": trade_date, "szse": [], "sse_raw": "", "tls_verified": ok, "_raw_sz": raw_sz, "_raw_sse": None}
    for row in (d[0].get("data", []) if d else []):
        out["szse"].append({"code": row.get("zqdm"), "name": row.get("zqjc"), "amount": row.get("cjje"), "reason": row.get("plyy"), "_raw": raw_sz})
    r = http_get(f"https://query.sse.com.cn/infodisplay/showTradePublicFile.do?jsonCallBack=cb&isPagination=false&dateTx={trade_date}",
                 headers={"User-Agent": UA, "Referer": "https://www.sse.com.cn/disclosure/diclosure/public/"}, timeout=15, ext="js")
    t = r.text
    out["_raw_sse"] = getattr(r, "_vra_raw_ref", None)
    if "(" in t:
        out["sse_raw"] = "\n".join((json.loads(t[t.index("(") + 1: t.rindex(")")]) or {}).get("fileContents") or [])  # 非交易日 fileContents 为 null
    return out


SSE_OVERVIEW_SQL = "COMMON_SSE_SJ_GPSJ_CJGK_MRGK_C"
# 上交所每日概况的产品行:01 主板 A 股、02 B 股、03 科创板、17 沪市合计
SSE_OVERVIEW_PRODUCTS = {"01": "主板A股", "02": "B股", "03": "科创板", "17": "沪市合计"}


def _f(v) -> Optional[float]:
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def sse_market_overview(date: Optional[str] = None, lookback: int = 10) -> dict:
    """上交所「每日概况」:按产品给市价总值 / 流通市值 / 成交金额 / 换手率(亿元、%,交易所原值不换算)。
    date 缺省 = 北京时间今天;当天没有数据(非交易日 / 还没发布)就往前找最近一个有数据的交易日,最多 lookback 个自然日。
    返回 {date(数据所属日), products:[{code,name,date,market_value,float_value,amount,list_num,turnover_pct,float_turnover_pct}], _raw};
    换手率是交易所按「成交金额 ÷ 对应市值」算的,两个口径都给:turnover_pct 用市价总值,float_turnover_pct 用流通市值。
    """
    from datetime import datetime, timedelta
    from common import TZ_SH

    if date:
        start = datetime.strptime(date, "%Y-%m-%d").date()
        lookback = 1  # 指定了日期就只认这一天:找不到就报错,不偷偷换成别的日子
    else:
        start = datetime.now(TZ_SH).date()
    rows, used = [], None
    for back in range(max(1, lookback)):
        day = (start - timedelta(days=back)).strftime("%Y-%m-%d")
        d = http_json(f"https://query.sse.com.cn/commonQuery.do?sqlId={SSE_OVERVIEW_SQL}"
                      f"&PRODUCT_CODE=01,02,03,17&type=inParams&SEARCH_DATE={day}",
                      headers={"User-Agent": UA, "Referer": "https://www.sse.com.cn/market/stockdata/overview/day/"}, timeout=15)
        rows = (d or {}).get("result") or []
        if rows:
            used = day
            break
    if not rows:
        raise RuntimeError(f"上交所每日概况 {start} 往前 {lookback} 天都没有数据(非交易日或还没发布)")
    ref = last_raw_ref()
    products = []
    for r in rows:
        code = str(r.get("PRODUCT_CODE") or "").strip()
        td = str(r.get("TRADE_DATE") or "").strip()
        products.append({
            "code": code, "name": SSE_OVERVIEW_PRODUCTS.get(code, code),
            "date": f"{td[:4]}-{td[4:6]}-{td[6:]}" if len(td) == 8 else used,
            "market_value": _f(r.get("TOTAL_VALUE")), "float_value": _f(r.get("NEGO_VALUE")),
            "amount": _f(r.get("TRADE_AMT")), "list_num": _f(r.get("LIST_NUM")),
            "turnover_pct": _f(r.get("TOTAL_TO_RATE")), "float_turnover_pct": _f(r.get("NEGO_TO_RATE")),
            "_raw": ref,
        })
    return {"date": used, "products": products, "_raw": ref}


def announcements_backup(code: str, page_size: int = 20) -> list[dict]:
    """公告备源:[{title, time, pdf}];深市 → szse annList,沪市 / 北交所 → 东财 np-anotice"""
    digits, market = norm_ticker(code, stock_only=True)
    if market == "SZ":
        body = json.dumps({"channelCode": ["listedNotice_disc"], "pageSize": page_size, "pageNum": 1, "stock": [digits]}).encode()
        d, _ = _szse_json("https://www.szse.cn/api/disc/announcement/annList", {"User-Agent": UA, "Content-Type": "application/json", "Referer": "https://www.szse.cn/disclosure/listed/notice/index.html"}, data=body)
        return [{"title": a.get("title"), "time": (a.get("publishTime") or "")[:10], "pdf": "https://disc.static.szse.cn/download" + (a.get("attachPath") or "")} for a in d.get("data", []) or []]
    d = http_json(f"https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size={page_size}&page_index=1&ann_type=A&client_source=web&stock_list={digits}&f_node=0&s_node=0", headers={"User-Agent": UA}, timeout=15)
    return [{"title": a.get("title"), "time": (a.get("notice_date") or "")[:10], "pdf": f"https://pdf.dfcfw.com/pdf/H2_{a.get('art_code', '')}_1.pdf"} for a in (d.get("data") or {}).get("list") or []]
