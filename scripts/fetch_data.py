#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
使用 AkShare 拉取指数、基金、股票历史行情，输出为静态 JSON 文件供前端加载。
适配 GitHub Pages 纯静态部署：不依赖任何服务端接口，只生成可被 HTTP 访问的 JSON。
"""
import argparse
import json
import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

# 项目根目录（脚本位于 scripts/，项目根目录为上级目录）
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

# 默认支持的资产池（用户可自行扩展）
DEFAULT_ASSETS = [
    # 指数
    {"code": "000001", "name": "上证指数", "type": "index", "market": "sh"},
    {"code": "000300", "name": "沪深300", "type": "index", "market": "sh"},
    {"code": "000688", "name": "科创50", "type": "index", "market": "sh"},
    {"code": "399006", "name": "创业板指", "type": "index", "market": "sz"},
    {"code": "000685", "name": "上证科创板芯片指数", "type": "index", "market": "sh"},
    # 基金
    {"code": "006480", "name": "广发纳斯达克100ETF联接(QDII)C", "type": "fund"},
    {"code": "020671", "name": "易方达上证科创板芯片ETF联接C", "type": "fund"},
    # 股票示例
    {"code": "600519", "name": "贵州茅台", "type": "stock", "market": "sh"},
    {"code": "000858", "name": "五粮液", "type": "stock", "market": "sz"},
]


def random_walk(start_price: float, n: int, volatility: float = 0.02, drift: float = 0.0001):
    """生成带随机游走的 OHLC 序列，用于 AkShare 不可用时兜底演示。"""
    today = datetime.now()
    data = []
    price = start_price
    for i in range(n):
        d = today - timedelta(days=n - 1 - i)
        # 跳过周末
        if d.weekday() >= 5:
            continue
        change = random.gauss(drift, volatility)
        open_p = price * (1 + random.uniform(-0.005, 0.005))
        close_p = price * (1 + change)
        high_p = max(open_p, close_p) * (1 + random.uniform(0, 0.01))
        low_p = min(open_p, close_p) * (1 - random.uniform(0, 0.01))
        vol = int(random.uniform(1e5, 1e7))
        data.append(
            {
                "date": d.strftime("%Y-%m-%d"),
                "open": round(open_p, 4),
                "high": round(high_p, 4),
                "low": round(low_p, 4),
                "close": round(close_p, 4),
                "volume": vol,
            }
        )
        price = close_p
    return data


def generate_fund_demo(code: str, n: int = 252):
    """基金使用 NAV 序列演示。"""
    start_price = random.uniform(0.8, 2.0)
    today = datetime.now()
    data = []
    price = start_price
    for i in range(n):
        d = today - timedelta(days=n - 1 - i)
        if d.weekday() >= 5:
            continue
        change = random.gauss(0.0001, 0.015)
        nav = price * (1 + change)
        data.append(
            {
                "date": d.strftime("%Y-%m-%d"),
                "open": round(nav, 4),
                "high": round(nav, 4),
                "low": round(nav, 4),
                "close": round(nav, 4),
                "volume": 0,
            }
        )
        price = nav
    return data


def fetch_fund_data(code: str, start_date: str, end_date: str):
    import akshare as ak

    df = ak.fund_open_fund_daily_em(symbol=code)
    if df is None or df.empty:
        return None
    # fund_open_fund_daily_em 返回全部历史，按日期过滤
    df["净值日期"] = pd.to_datetime(df["净值日期"])
    df = df[(df["净值日期"] >= start_date) & (df["净值日期"] <= end_date)]
    if df.empty:
        return None
    df = df.rename(
        columns={
            "净值日期": "date",
            "单位净值": "close",
            "累计净值": "acc_nav",
        }
    )
    df["open"] = df["close"]
    df["high"] = df["close"]
    df["low"] = df["close"]
    df["volume"] = 0
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    return df[["date", "open", "high", "low", "close", "volume"]]


def normalize_to_records(df: pd.DataFrame) -> list:
    """将 DataFrame 转为前端标准记录列表。"""
    if df is None or df.empty:
        return []
    # 统一字段名
    column_map = {}
    for c in df.columns:
        c_str = str(c).strip()
        if c_str in ["日期", "净值日期"]:
            column_map[c] = "date"
        elif c_str in ["开盘", "open"]:
            column_map[c] = "open"
        elif c_str in ["收盘", "close", "单位净值"]:
            column_map[c] = "close"
        elif c_str in ["最高", "high"]:
            column_map[c] = "high"
        elif c_str in ["最低", "low"]:
            column_map[c] = "low"
        elif c_str in ["成交量", "volume", "成交额"]:
            column_map[c] = "volume"
    df = df.rename(columns=column_map)
    # 选择必要字段
    required = ["date", "open", "high", "low", "close", "volume"]
    for col in required:
        if col not in df.columns:
            df[col] = 0 if col != "date" else ""
    df = df[required]
    # 按日期升序
    df = df.sort_values("date").reset_index(drop=True)
    records = df.to_dict(orient="records")
    # 类型安全
    for r in records:
        r["open"] = float(r["open"]) if pd.notna(r["open"]) else 0.0
        r["high"] = float(r["high"]) if pd.notna(r["high"]) else 0.0
        r["low"] = float(r["low"]) if pd.notna(r["low"]) else 0.0
        r["close"] = float(r["close"]) if pd.notna(r["close"]) else 0.0
        r["volume"] = int(float(r["volume"])) if pd.notna(r["volume"]) else 0
    return records


def fetch_asset(asset: dict, start_date: str, end_date: str, fallback: bool = True):
    """获取单个资产数据，失败时可选使用演示数据。"""
    code = asset["code"]
    asset_type = asset["type"]
    records = []
    error = None
    try:
        if asset_type == "index":
            import akshare as ak

            df = ak.index_zh_a_hist(symbol=code, period="daily", start_date=start_date, end_date=end_date)
            records = normalize_to_records(df)
        elif asset_type == "stock":
            import akshare as ak

            df = ak.stock_zh_a_hist(symbol=code, period="daily", start_date=start_date, end_date=end_date, adjust="qfq")
            records = normalize_to_records(df)
        elif asset_type == "fund":
            try:
                records = fetch_fund_data(code, start_date, end_date)
            except Exception as e:
                # 部分基金代码 AkShare 接口可能不支持，尝试用 ETF 历史行情兜底
                import akshare as ak

                df = ak.fund_etf_hist_em(symbol=code, period="daily", start_date=start_date, end_date=end_date, adjust="qfq")
                records = normalize_to_records(df)
        else:
            raise ValueError(f"不支持的资产类型: {asset_type}")
    except Exception as e:
        error = str(e)
        records = []

    if not records and fallback:
        print(f"  [fallback] {code} 使用演示数据（原因：{error or '无数据'}）", file=sys.stderr)
        if asset_type == "fund":
            records = generate_fund_demo(code)
        else:
            records = random_walk(start_price=random.uniform(50, 500), n=365)

    return records


def compute_metrics(records: list) -> dict:
    """计算关键指标摘要。"""
    if not records:
        return {}
    closes = [r["close"] for r in records]
    dates = [r["date"] for r in records]
    first = closes[0]
    last = closes[-1]
    total_return = (last - first) / first if first else 0.0
    # 年化波动（日收益率标准差 * sqrt(252)）
    returns = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes)) if closes[i - 1]]
    import statistics

    volatility = statistics.stdev(returns) * (252 ** 0.5) if len(returns) > 1 else 0.0
    # 最大回撤
    max_dd = 0.0
    peak = first
    for c in closes:
        if c > peak:
            peak = c
        dd = (peak - c) / peak if peak else 0.0
        if dd > max_dd:
            max_dd = dd
    high = max(closes)
    low = min(closes)
    return {
        "start_date": dates[0],
        "end_date": dates[-1],
        "start_close": round(first, 4),
        "end_close": round(last, 4),
        "total_return": round(total_return, 4),
        "total_return_pct": f"{total_return * 100:.2f}%",
        "annualized_volatility": round(volatility, 4),
        "annualized_volatility_pct": f"{volatility * 100:.2f}%",
        "max_drawdown": round(max_dd, 4),
        "max_drawdown_pct": f"{max_dd * 100:.2f}%",
        "high": round(high, 4),
        "low": round(low, 4),
    }


def write_asset_json(asset: dict, records: list, data_dir: Path):
    """写入单个资产的 JSON 文件。"""
    metrics = compute_metrics(records)
    payload = {
        "code": asset["code"],
        "name": asset["name"],
        "type": asset["type"],
        "market": asset.get("market", ""),
        "currency": "CNY",
        "source": "AkShare / 演示数据",
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "metrics": metrics,
        "data": records,
    }
    out_path = data_dir / f"{asset['code']}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return out_path


def build_catalog(assets: list, data_dir: Path):
    """生成资产目录 index.json，前端据此填充搜索列表。"""
    catalog = []
    for asset in assets:
        code = asset["code"]
        file_path = data_dir / f"{code}.json"
        if not file_path.exists():
            continue
        with open(file_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        catalog.append(
            {
                "code": code,
                "name": payload["name"],
                "type": payload["type"],
                "market": payload.get("market", ""),
                "file": f"data/{code}.json",
                "updated_at": payload["updated_at"],
                "latest_close": payload["metrics"].get("end_close") if payload.get("metrics") else None,
            }
        )
    catalog_path = data_dir / "index.json"
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)
    return catalog_path


def main():
    parser = argparse.ArgumentParser(description="生成静态资产走势 JSON 数据")
    parser.add_argument("--days", type=int, default=365, help="拉取最近 N 个交易日/自然日数据，默认 365")
    parser.add_argument("--no-fallback", action="store_true", help="AkShare 失败时不生成演示数据")
    parser.add_argument("--assets", type=str, default=None, help="逗号分隔的资产代码，默认使用内置资产池")
    parser.add_argument("--output", type=Path, default=DATA_DIR, help="JSON 输出目录")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    end_date = datetime.now()
    start_date = end_date - timedelta(days=args.days)
    start_str = start_date.strftime("%Y%m%d")
    end_str = end_date.strftime("%Y%m%d")
    print(f"时间区间: {start_str} ~ {end_str}")

    if args.assets:
        codes = [c.strip() for c in args.assets.split(",")]
        assets = [a for a in DEFAULT_ASSETS if a["code"] in codes]
        # 允许外部未定义的代码，但需补全最小信息（默认按股票处理）
        known_codes = {a["code"] for a in assets}
        for c in codes:
            if c not in known_codes:
                assets.append({"code": c, "name": c, "type": "stock", "market": "sh"})
    else:
        assets = DEFAULT_ASSETS

    print(f"共 {len(assets)} 个资产需要处理")
    for asset in assets:
        print(f"处理 {asset['code']} {asset['name']} ({asset['type']})...")
        records = fetch_asset(asset, start_str, end_str, fallback=not args.no_fallback)
        out_path = write_asset_json(asset, records, DATA_DIR)
        print(f"  -> {out_path} ({len(records)} 条)")

    catalog_path = build_catalog(assets, DATA_DIR)
    print(f"目录文件 -> {catalog_path}")


if __name__ == "__main__":
    main()
