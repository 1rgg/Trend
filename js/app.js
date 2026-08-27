/**
 * Asset Trend 实时版
 * 纯前端直连公开行情接口：代码搜索、历史 K 线、当日分时、
 * 场外基金实时估值与历史净值。无后端，纯静态可部署（GitHub Pages 等）。
 *
 * 数据来源：
 *   - K 线 / 分时 / 实时行情：腾讯财经 web.ifzq.gtimg.cn（变量注入式脚本，免 CORS）
 *     注：东方财富 push2his 系列 K 线接口 2026 年起加强反爬（需登录 Cookie，
 *     否则返回空响应），已切换到腾讯财经。
 *   - 代码搜索：searchapi.eastmoney.com（失败时降级腾讯 smartbox）
 *   - 基金净值：fund.eastmoney.com/pingzhongdata/{code}.js
 */
(function () {
  "use strict";

  /* ============================================================
   * 1. JSONP / 变量注入式脚本加载工具
   * ============================================================ */
  let jsonpCounter = 0;
  function jsonp(url, options) {
    options = options || {};
    const cbKey = options.cbKey || "cb";
    const timeout = options.timeout || 12000;
    return new Promise(function (resolve, reject) {
      const cbName = "__jp_" + (++jsonpCounter) + "_" + Date.now();
      window[cbName] = function (data) {
        cleanup();
        resolve(data);
      };
      const script = document.createElement("script");
      script.id = cbName;
      script.onerror = function () {
        cleanup();
        reject(new Error("JSONP 加载失败"));
      };
      const sep = url.indexOf("?") >= 0 ? "&" : "?";
      script.src = url + sep + cbKey + "=" + cbName;
      document.body.appendChild(script);
      const timer = setTimeout(function () {
        cleanup();
        reject(new Error("JSONP 超时"));
      }, timeout);
      function cleanup() {
        clearTimeout(timer);
        if (window[cbName]) {
          try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
        }
        const el = document.getElementById(cbName);
        if (el) el.remove();
      }
    });
  }

  // 「变量注入式」接口：脚本执行后把数据赋值给 window[varName]（非回调式 JSONP）
  // options.charset 用于 GBK 接口（如腾讯 smartbox）
  function fetchVar(url, varName, timeout, charset) {
    timeout = timeout || 12000;
    return new Promise(function (resolve, reject) {
      if (window[varName]) {
        try { delete window[varName]; } catch (e) { window[varName] = undefined; }
      }
      const script = document.createElement("script");
      let done = false;
      script.onerror = function () { finish(reject, new Error("脚本加载失败")); };
      script.onload = function () {
        const val = window[varName];
        finish(resolve, val);
      };
      const timer = setTimeout(function () {
        finish(reject, new Error("数据加载超时"));
      }, timeout);
      function finish(fn, arg) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        script.remove();
        if (window[varName]) {
          try { delete window[varName]; } catch (e) { window[varName] = undefined; }
        }
        fn(arg);
      }
      if (charset) script.charset = charset;
      script.src = url;
      document.body.appendChild(script);
    });
  }

  // 用于 pingzhongdata.js 这种「注入全局变量」式脚本（取整个全局对象集合）
  function loadScriptOnce(url, timeout) {
    timeout = timeout || 12000;
    return new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.src = url;
      script.onload = function () { script.remove(); resolve(); };
      script.onerror = function () { script.remove(); reject(new Error("脚本加载失败")); };
      document.body.appendChild(script);
      setTimeout(function () { script.remove(); reject(new Error("脚本加载超时")); }, timeout);
    });
  }

  /* ============================================================
   * 2. 行情接口封装
   * ============================================================ */
  const SEARCH_URL = "https://searchapi.eastmoney.com/api/suggest/get";
  const SMARTBOX_URL = "https://smartbox.gtimg.cn/s3/";
  const KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
  const MINUTE_URL = "https://web.ifzq.gtimg.cn/appstock/app/minute/query";
  const FUND_PZ_BASE = "https://fund.eastmoney.com/pingzhongdata/";
  const SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E96223";

  // 东财搜索（支持中文 / 代码 / 拼音，带类型与 QuoteID）；偶发限流时自动重试一次
  async function searchCode(keyword) {
    if (!keyword || !keyword.trim()) return [];
    const url = SEARCH_URL +
      "?input=" + encodeURIComponent(keyword) +
      "&type=14&token=" + SEARCH_TOKEN + "&count=20";
    let lastErr = null;
    for (let i = 0; i < 2; i++) {
      try {
        const data = await jsonp(url);
        const tbl = data && data.QuotationCodeTable;
        return (tbl && tbl.Data) || [];
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("搜索失败");
  }

  // 腾讯 smartbox 搜索兜底：v_hint="sh~600519~贵州茅台~gzmt~GP-A^..."
  async function smartboxSearch(keyword) {
    if (!keyword || !keyword.trim()) return [];
    const url = SMARTBOX_URL +
      "?v=2&q=" + encodeURIComponent(keyword) + "&t=all";
    const raw = await fetchVar(url, "v_hint", 12000, "gbk");
    if (!raw || typeof raw !== "string") return [];
    return raw.split("^").filter(Boolean).map(function (seg) {
      const p = seg.split("~");
      if (p.length < 3) return null;
      const mkt = (p[0] || "").toLowerCase();
      if (mkt !== "sh" && mkt !== "sz") return null; // 仅支持沪深标的
      return {
        Code: p[1],
        Name: p[2],
        MktNum: mkt === "sh" ? "1" : "2",
        QuoteID: (mkt === "sh" ? "1." : "0.") + p[1],
        Classify: /^F/.test(p[4] || "") ? "OTCFUND" : "AStock",
        SecurityTypeName: "股票",
      };
    }).filter(Boolean);
  }

  // 搜索入口：东财优先，失败降级腾讯
  async function doSearch(keyword) {
    try {
      const r = await searchCode(keyword);
      if (r.length) return r;
    } catch (e) { /* ignore, fallback */ }
    return await smartboxSearch(keyword);
  }

  // secid 前缀：优先用搜索接口的 MktNum，否则按代码规律兜底
  function toSecid(code, mktNum) {
    code = String(code);
    if (mktNum !== undefined && mktNum !== null && mktNum !== "") {
      const m = Number(mktNum);
      if (m === 1) return "1." + code;  // 沪
      if (m === 2) return "0." + code;  // 深
    }
    if (/^(6|9|5)/.test(code)) return "1." + code; // 沪个股 / 沪 ETF(5) / B 股
    if (/^(0|3|2)/.test(code)) return "0." + code; // 深个股 / 创业板 / 深 ETF
    if (/^000/.test(code)) return "1." + code; // 上证系指数
    if (/^399/.test(code)) return "0." + code; // 深证系指数
    return "1." + code;
  }

  // secid → 腾讯代码符号（如 1.600519 → sh600519）
  function secidToSymbol(secid) {
    const parts = String(secid).split(".");
    const prefix = parts[0] === "1" ? "sh" : "sz";
    return prefix + parts[1];
  }

  // 判断是否为场外开放式基金（走净值路径，不走 K 线）
  function isOpenFund(item) {
    return (item && item.Classify) === "OTCFUND";
  }

  // 腾讯 K 线：param={symbol},{day|week|month},,,{count},{qfq|hfq|}
  // 返回键名带复权前缀（qfqday / hfqday / day），行为 [date,open,close,high,low,volume]
  const FQ_PREFIX = { 0: "", 1: "qfq", 2: "hfq" };

  async function fetchKline(secid, opts) {
    opts = opts || {};
    const periodKey = opts.periodKey || "day"; // day | week | month
    const fq = FQ_PREFIX[opts.fqt === undefined ? 1 : opts.fqt];
    const count = opts.count || 1200;
    const symbol = secidToSymbol(secid);
    const url = KLINE_URL +
      "?param=" + [symbol, periodKey, "", "", count, fq].join(",") +
      "&_var=__kline";
    const data = await fetchVar(url, "__kline");
    const node = data && data.data && data.data[symbol];
    const rows = node && ((fq ? node[fq + periodKey] : node[periodKey]) || node[periodKey]) || [];
    return rows.map(function (r) {
      return {
        date: r[0],
        open: +r[1],
        close: +r[2],
        high: +r[3],
        low: +r[4],
        volume: +r[5] || 0,
        amount: +(r[6] || 0) || 0,
      };
    });
  }

  // 当日分时："HHMM price 累计量 累计额"，均价 = 累计额 / 累计量；昨收取 qt 第 5 位
  async function fetchTrend(secid) {
    const symbol = secidToSymbol(secid);
    const url = MINUTE_URL + "?code=" + symbol + "&_var=__minute";
    const data = await fetchVar(url, "__minute");
    const node = data && data.data && data.data[symbol];
    const rawPoints = (node && node.data && node.data.data) || [];
    const qt = (node && node.qt && node.qt[symbol]) || [];
    let prevVol = 0;
    const points = rawPoints.map(function (line) {
      const p = line.split(" ");
      const cumVol = +p[2] || 0;
      const cumAmt = +p[3] || 0;
      const t = ("0000" + p[0]).slice(-4);
      const pt = {
        time: t.slice(0, 2) + ":" + t.slice(2),
        price: +p[1],
        volume: Math.max(cumVol - prevVol, 0),
      };
      pt.avg = cumVol ? cumAmt / cumVol : pt.price;
      prevVol = cumVol;
      return pt;
    });
    return {
      points: points,
      preClose: +qt[4] || 0,
      name: qt[1] || "",
      code: qt[2] || "",
    };
  }

  // 注：fundgz 实时估值接口（fundgz.1234567.com.cn）已下线，基金实时估值暂不可用，
  // 场外基金改用 pingzhongdata 净值历史 + 当日涨跌展示。

  async function fetchFundNAV(code) {
    // pingzhongdata.js 会注入 window.Data_netWorthTrend（单位净值历史）
    const url = FUND_PZ_BASE + code + ".js";
    try {
      await loadScriptOnce(url);
    } catch (e) {
      return [];
    }
    const arr = window.Data_netWorthTrend || [];
    return arr.map(function (item) {
      const dt = new Date(item.x);
      return {
        date: fmtDate(dt),
        close: +item.y,
        open: +item.y,
        high: +item.y,
        low: +item.y,
        volume: 0,
        pct: item.equityReturn,
      };
    });
  }

  /* ============================================================
   * 3. 通用辅助
   * ============================================================ */
  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function fmtNumber(n, digits) {
    digits = digits === undefined ? 2 : digits;
    if (n === null || n === undefined || isNaN(n)) return "-";
    return Number(n).toLocaleString("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function parseDate(str) {
    return new Date(str + "T00:00:00");
  }

  function addMonths(date, months) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
  }

  function rangeStart(range, endDate) {
    const end = new Date(endDate);
    switch (range) {
      case "1m": return addMonths(end, -1);
      case "3m": return addMonths(end, -3);
      case "6m": return addMonths(end, -6);
      case "1y": return addMonths(end, -12);
      case "all": default: return null;
    }
  }

  function filterData(data, start, end) {
    return data.filter(function (row) {
      const d = parseDate(row.date);
      if (start && d < new Date(start + "T00:00:00")) return false;
      if (end && d > new Date(end + "T00:00:00")) return false;
      return true;
    });
  }

  function computeMetricsForRange(records) {
    if (!records || records.length === 0) return null;
    const closes = records.map(function (r) { return r.close; });
    const first = closes[0];
    const last = closes[closes.length - 1];
    const totalReturn = first ? (last - first) / first : 0;

    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i - 1]) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    let volatility = 0;
    if (returns.length > 1) {
      const mean = returns.reduce(function (a, b) { return a + b; }, 0) / returns.length;
      const variance = returns.reduce(function (s, r) { return s + Math.pow(r - mean, 2); }, 0) / (returns.length - 1);
      volatility = Math.sqrt(variance) * Math.sqrt(252);
    }

    let maxDd = 0;
    let peak = first;
    closes.forEach(function (c) {
      if (c > peak) peak = c;
      const dd = peak ? (peak - c) / peak : 0;
      if (dd > maxDd) maxDd = dd;
    });

    return {
      end_close: last,
      total_return: totalReturn,
      total_return_pct: (totalReturn * 100).toFixed(2) + "%",
      annualized_volatility: volatility,
      annualized_volatility_pct: (volatility * 100).toFixed(2) + "%",
      max_drawdown: maxDd,
      max_drawdown_pct: (maxDd * 100).toFixed(2) + "%",
      high: Math.max.apply(null, closes),
      low: Math.min.apply(null, closes),
    };
  }

  // 判断当前是否在 A 股交易时段（周一至周五 9:25-11:30 / 13:00-15:00）
  function isMarketOpen() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
    const hm = now.getHours() * 100 + now.getMinutes();
    return (hm >= 925 && hm <= 1130) || (hm >= 1300 && hm <= 1500);
  }

  /* ============================================================
   * 4. 状态
   * ============================================================ */
  const els = {
    searchInput: document.getElementById("search-input"),
    suggestList: document.getElementById("suggest-list"),
    currentInfo: document.getElementById("current-info"),
    periodChips: document.getElementById("period-chips"),
    fqtChips: document.getElementById("fqt-chips"),
    rangeChips: document.getElementById("range-chips"),
    startDate: document.getElementById("start-date"),
    endDate: document.getElementById("end-date"),
    applyDate: document.getElementById("apply-date"),
    autoRefresh: document.getElementById("auto-refresh"),
    metricClose: document.getElementById("metric-close"),
    metricReturn: document.getElementById("metric-return"),
    metricVol: document.getElementById("metric-vol"),
    metricDd: document.getElementById("metric-dd"),
    metricHigh: document.getElementById("metric-high"),
    metricLow: document.getElementById("metric-low"),
    metricExtra: document.getElementById("metric-extra"),
    sourceNote: document.getElementById("source-note"),
    chart: document.getElementById("trend-chart"),
  };

  const state = {
    current: null,        // { code, name, secid, kind:'kline'|'fund', mktNum, type }
    period: "1d",         // trend | 1d | week | month
    fqt: 1,               // 0 1 2
    range: "1y",          // 1m 3m 6m 1y all
    chart: null,
    refreshTimer: null,
    suggestHover: -1,
  };

  const PERIOD_KEY = { "1d": "day", week: "week", month: "month" };

  /* ============================================================
   * 5. 搜索建议
   * ============================================================ */
  let suggestDebounce = null;
  function bindSearch() {
    els.searchInput.addEventListener("input", function () {
      clearTimeout(suggestDebounce);
      const kw = els.searchInput.value.trim();
      if (!kw) { hideSuggest(); return; }
      suggestDebounce = setTimeout(function () { loadSuggest(kw); }, 300);
    });

    els.searchInput.addEventListener("focus", function () {
      if (els.suggestList.children.length) showSuggest();
    });

    els.searchInput.addEventListener("keydown", function (e) {
      const items = els.suggestList.querySelectorAll(".suggest-item");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.suggestHover = Math.min(state.suggestHover + 1, items.length - 1);
        updateSuggestHover(items);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        state.suggestHover = Math.max(state.suggestHover - 1, 0);
        updateSuggestHover(items);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (state.suggestHover >= 0 && items[state.suggestHover]) {
          items[state.suggestHover].click();
        }
      } else if (e.key === "Escape") {
        hideSuggest();
      }
    });

    document.addEventListener("click", function (e) {
      if (!els.searchInput.contains(e.target) && !els.suggestList.contains(e.target)) {
        hideSuggest();
      }
    });
  }

  function updateSuggestHover(items) {
    items.forEach(function (el, i) {
      el.classList.toggle("hover", i === state.suggestHover);
    });
  }

  async function loadSuggest(keyword) {
    let results;
    try {
      results = await doSearch(keyword);
    } catch (e) {
      renderSuggest([], "搜索失败，稍后重试");
      return;
    }
    renderSuggest(results);
  }

  function renderSuggest(results, errMsg) {
    els.suggestList.innerHTML = "";
    if (errMsg) {
      const li = document.createElement("div");
      li.className = "suggest-empty";
      li.textContent = errMsg;
      els.suggestList.appendChild(li);
      showSuggest();
      return;
    }
    if (!results.length) {
      const li = document.createElement("div");
      li.className = "suggest-empty";
      li.textContent = "无匹配结果";
      els.suggestList.appendChild(li);
      showSuggest();
      return;
    }
    // 去重：同代码同名称只留一条，优先展示 A 股/指数/ETF
    const seen = {};
    const list = [];
    results.forEach(function (it) {
      const key = it.Code + "_" + it.Name;
      if (seen[key]) return;
      seen[key] = 1;
      list.push(it);
    });
    list.slice(0, 12).forEach(function (it, idx) {
      const li = document.createElement("div");
      li.className = "suggest-item";
      li.dataset.idx = idx;
      const kind = isOpenFund(it) ? "fund" : "kline";
      li.dataset.kind = kind;
      const tag = tagForItem(it);
      li.innerHTML =
        '<span class="s-code">' + escapeHtml(it.Code) + "</span>" +
        '<span class="s-name">' + escapeHtml(it.Name) + "</span>" +
        '<span class="s-type ' + kind + '">' + tag + "</span>";
      li.addEventListener("click", function () {
        pickSuggest(it, kind);
      });
      li.addEventListener("mouseenter", function () {
        state.suggestHover = idx;
        updateSuggestHover(els.suggestList.querySelectorAll(".suggest-item"));
      });
      els.suggestList.appendChild(li);
    });
    state.suggestHover = -1;
    showSuggest();
  }

  function tagForItem(it) {
    if (!it) return "股票";
    if (it.Classify === "OTCFUND") return "场外基金";
    const sn = it.SecurityTypeName || "";
    const cl = it.Classify || "";
    if (/指数|Index/i.test(sn + cl)) return "指数";
    if (cl === "Fund" || /基金/.test(sn)) return "ETF";
    if (/沪A|深A|A股|AStock/.test(sn + cl)) return "A股";
    return sn || "股票";
  }

  function pickSuggest(it, kind) {
    // 优先用接口返回的 QuoteID（已含市场前缀，如 1.600519 / 0.000858），否则兜底推断
    const secid = (kind === "fund") ? null : (it.QuoteID || toSecid(it.Code, it.MktNum));
    state.current = {
      code: it.Code,
      name: it.Name,
      secid: secid,
      kind: kind,
      mktNum: it.MktNum,
      type: it.Type,
    };
    els.searchInput.value = it.Name + " " + it.Code;
    hideSuggest();

    // 根据类型调整可用周期
    applyPeriodVisibility();
    // 基金默认走净值；K线类默认日K
    state.period = (kind === "fund") ? "nav" : "1d";
    syncPeriodActive();

    loadCurrent();
  }

  function applyPeriodVisibility() {
    const isFund = state.current && state.current.kind === "fund";
    // 场外基金：隐藏分时/复权/区间，只显示净值
    els.periodChips.querySelectorAll("button").forEach(function (b) {
      const p = b.dataset.period;
      if (isFund) {
        b.style.display = (p === "nav") ? "" : "none";
      } else {
        b.style.display = (p === "nav") ? "none" : "";
      }
    });
    els.fqtChips.style.display = isFund ? "none" : "";
    document.querySelectorAll(".range-block").forEach(function (el) {
      el.style.display = isFund ? "none" : "";
    });
  }

  function showSuggest() { els.suggestList.style.display = "block"; }
  function hideSuggest() { els.suggestList.style.display = "none"; state.suggestHover = -1; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ============================================================
   * 6. 加载数据 + 渲染
   * ============================================================ */
  async function loadCurrent() {
    if (!state.current) return;
    const c = state.current;
    setChartLoading(true);
    clearRefreshTimer();
    try {
      if (c.kind === "fund") {
        await loadFund(c);
      } else if (state.period === "trend") {
        await loadTrend(c);
        maybeStartRefresh();
      } else {
        await loadKlineRange(c);
      }
    } catch (e) {
      console.error(e);
      renderError(e.message || "加载失败");
      setChartLoading(false);
    }
  }

  async function loadKlineRange(c) {
    const records = await fetchKline(c.secid, { periodKey: PERIOD_KEY[state.period] || "day", fqt: state.fqt });
    // 区间筛选
    let all = records;
    let start = null, end = null;
    if (state.range !== "all" && records.length) {
      const maxDate = records[records.length - 1].date;
      const s = rangeStart(state.range, maxDate);
      start = s ? fmtDate(s) : null;
      end = maxDate;
      els.endDate.value = end;
      els.startDate.value = start || records[0].date;
    } else if (records.length) {
      els.endDate.value = records[records.length - 1].date;
      els.startDate.value = records[0].date;
    }
    const filtered = (state.range === "all") ? records : filterData(records, start, end);
    renderCandle(filtered, c);
    updateMetrics(filtered);
    els.sourceNote.textContent = "数据来源：腾讯财经（实时） · 更新于 " + new Date().toLocaleString("zh-CN");
    setChartLoading(false);
  }

  async function loadTrend(c) {
    const r = await fetchTrend(c.secid);
    renderTrend(r, c);
    updateTrendMetrics(r);
    els.sourceNote.textContent = "数据来源：腾讯财经分时（实时） · 更新于 " + new Date().toLocaleString("zh-CN");
    setChartLoading(false);
  }

  async function loadFund(c) {
    // 历史净值（pingzhongdata.js 注入 Data_netWorthTrend）
    const nav = await fetchFundNAV(c.code);
    // 默认取近 1 年
    let filtered = nav;
    let start = null, end = null;
    if (nav.length) {
      const maxDate = nav[nav.length - 1].date;
      const s = addMonths(parseDate(maxDate), -12);
      start = fmtDate(s);
      end = maxDate;
      filtered = filterData(nav, start, end);
    }
    renderFundNAV(filtered, c);
    updateMetrics(filtered);
    updateFundExtra(filtered, c);
    els.sourceNote.textContent = "数据来源：东方财富基金净值（pingzhongdata） · 更新于 " + new Date().toLocaleString("zh-CN");
    setChartLoading(false);
  }

  /* ---------- 指标面板 ---------- */
  function updateMetrics(records) {
    const m = computeMetricsForRange(records);
    if (!m) {
      ["metricClose", "metricReturn", "metricVol", "metricDd", "metricHigh", "metricLow"].forEach(function (k) {
        els[k].textContent = "-";
        els[k].classList.remove("up", "down");
      });
      els.metricExtra.innerHTML = "";
      return;
    }
    els.metricClose.textContent = fmtNumber(m.end_close, 4);
    els.metricReturn.textContent = m.total_return_pct;
    els.metricReturn.classList.remove("up", "down");
    els.metricReturn.classList.add(m.total_return >= 0 ? "up" : "down");
    els.metricVol.textContent = m.annualized_volatility_pct;
    els.metricVol.classList.remove("up", "down");
    els.metricDd.textContent = m.max_drawdown_pct;
    els.metricDd.classList.remove("up");
    els.metricDd.classList.add("down");
    els.metricHigh.textContent = fmtNumber(m.high, 4);
    els.metricLow.textContent = fmtNumber(m.low, 4);
    els.metricExtra.innerHTML = "";
  }

  function updateTrendMetrics(r) {
    const pts = r.points;
    if (!pts.length) return;
    const last = pts[pts.length - 1];
    const pre = r.preClose;
    const chg = pre ? (last.price - pre) : 0;
    const pct = pre ? (chg / pre) : 0;
    const high = Math.max.apply(null, pts.map(function (p) { return p.price; }));
    const low = Math.min.apply(null, pts.map(function (p) { return p.price; }));
    const vol = pts.reduce(function (s, p) { return s + p.volume; }, 0);

    els.metricClose.textContent = fmtNumber(last.price, 4);
    els.metricReturn.textContent = (pct * 100).toFixed(2) + "% (" + (chg >= 0 ? "+" : "") + fmtNumber(chg, 4) + ")";
    els.metricReturn.classList.remove("up", "down");
    els.metricReturn.classList.add(chg >= 0 ? "up" : "down");
    els.metricVol.textContent = fmtNumber(vol);
    els.metricVol.classList.remove("up", "down");
    els.metricDd.textContent = fmtNumber(pre, 4);
    els.metricDd.classList.remove("up", "down");
    els.metricHigh.textContent = fmtNumber(high, 4);
    els.metricLow.textContent = fmtNumber(low, 4);
    els.metricExtra.innerHTML =
      "<div class=\"metric\"><span class=\"metric-label\">均价</span><strong class=\"metric-value\">" + fmtNumber(last.avg, 4) + "</strong></div>";
    els.sourceNote.textContent = "昨收 " + fmtNumber(pre, 4) + " · 最新 " + fmtNumber(last.price, 4) + " @ " + last.time;
  }

  function updateFundExtra(records, c) {
    // fundgz 实时估值接口已下线，改用净值历史最新一条展示当日涨跌
    if (!records || !records.length) {
      els.metricExtra.innerHTML = "<div class=\"metric\"><span class=\"metric-label\">最新净值</span><strong class=\"metric-value\">-</strong></div>";
      return;
    }
    const last = records[records.length - 1];
    const dayPct = (last.pct !== undefined && last.pct !== null) ? +last.pct : null;
    els.metricExtra.innerHTML =
      "<div class=\"metric\"><span class=\"metric-label\">最新净值</span><strong class=\"metric-value\">" + fmtNumber(last.close, 4) + "</strong></div>" +
      "<div class=\"metric\"><span class=\"metric-label\">净值日期</span><strong class=\"metric-value\" style=\"font-size:0.9rem\">" + last.date + "</strong></div>" +
      (dayPct === null ? "" :
        "<div class=\"metric\"><span class=\"metric-label\">当日涨跌</span><strong class=\"metric-value " + (dayPct >= 0 ? "up" : "down") + "\">" +
          (dayPct >= 0 ? "+" : "") + dayPct.toFixed(2) + "%</strong></div>");
  }

  /* ---------- 图表渲染 ---------- */
  const COLOR_UP = "#ef4444";   // 涨-红
  const COLOR_DOWN = "#16a34a"; // 跌-绿
  const COLOR_NEUTRAL = "#2563eb";

  function renderCandle(records, c) {
    ensureChart();
    if (!records.length) {
      state.chart.clear();
      state.chart.setOption({ title: { text: "暂无数据", left: "center", top: "center" } });
      return;
    }
    const dates = records.map(function (r) { return r.date; });
    const candles = records.map(function (r) {
      return [r.open, r.close, r.low, r.high];
    });
    const volumes = records.map(function (r) { return r.volume; });
    const volColors = records.map(function (r) {
      return r.close >= r.open ? "rgba(239,68,68,0.6)" : "rgba(22,163,74,0.6)";
    });

    const option = {
      title: { text: c.name + " " + c.code, left: 10, textStyle: { fontSize: 14 } },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        formatter: function (params) {
          const p = params[0];
          const idx = p.dataIndex;
          const r = records[idx];
          if (!r) return "";
          const chg = r.open ? ((r.close - r.open) / r.open) : 0;
          const cl = chg >= 0 ? "up" : "down";
          return "<strong>" + r.date + "</strong><br/>" +
            "开 " + fmtNumber(r.open, 4) + "<br/>" +
            "收 " + fmtNumber(r.close, 4) + " <span style=\"color:" + (chg >= 0 ? COLOR_UP : COLOR_DOWN) + "\">(" + (chg >= 0 ? "+" : "") + (chg * 100).toFixed(2) + "%)</span><br/>" +
            "高 " + fmtNumber(r.high, 4) + "<br/>" +
            "低 " + fmtNumber(r.low, 4) + "<br/>" +
            "量 " + fmtNumber(r.volume, 0);
        },
      },
      legend: { data: ["K线", "成交量"], top: 28 },
      grid: [
        { left: "3%", right: "3%", top: "14%", height: "54%" },
        { left: "3%", right: "3%", top: "72%", height: "18%" },
      ],
      xAxis: [
        { type: "category", data: dates, scale: true, gridIndex: 0, boundaryGap: true },
        { type: "category", data: dates, gridIndex: 1, axisLabel: { show: false } },
      ],
      yAxis: [
        { scale: true, gridIndex: 0, splitLine: { lineStyle: { type: "dashed" } } },
        { scale: true, gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false } },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1], start: 0, end: 100 },
        { type: "slider", xAxisIndex: [0, 1], start: 0, end: 100, bottom: 0, height: 20 },
      ],
      series: [
        {
          name: "K线",
          type: "candlestick",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: candles,
          itemStyle: {
            color: COLOR_UP,
            color0: COLOR_DOWN,
            borderColor: COLOR_UP,
            borderColor0: COLOR_DOWN,
          },
        },
        {
          name: "成交量",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes,
          itemStyle: { color: function (p) { return volColors[p.dataIndex]; } },
        },
      ],
    };
    state.chart.setOption(option, true);
  }

  function renderTrend(r, c) {
    ensureChart();
    const pts = r.points;
    if (!pts.length) {
      state.chart.clear();
      state.chart.setOption({ title: { text: "暂无分时数据（非交易时段）", left: "center", top: "center" } });
      return;
    }
    const times = pts.map(function (p) { return p.time.slice(11); }); // HH:MM
    const prices = pts.map(function (p) { return p.price; });
    const avgs = pts.map(function (p) { return p.avg; });
    const vols = pts.map(function (p) { return p.volume; });
    const pre = r.preClose;
    const last = prices[prices.length - 1];
    const lineColor = (pre && last >= pre) ? COLOR_UP : COLOR_DOWN;

    const option = {
      title: { text: c.name + " " + c.code + " 分时", left: 10, textStyle: { fontSize: 14 } },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        formatter: function (params) {
          const p = params[0];
          const idx = p.dataIndex;
          const pt = pts[idx];
          if (!pt) return "";
          const chg = pre ? (pt.price - pre) : 0;
          const pct = pre ? (chg / pre) : 0;
          return "<strong>" + pt.time + "</strong><br/>" +
            "价 " + fmtNumber(pt.price, 4) + " <span style=\"color:" + (chg >= 0 ? COLOR_UP : COLOR_DOWN) + "\">(" + (chg >= 0 ? "+" : "") + (pct * 100).toFixed(2) + "%)</span><br/>" +
            "均 " + fmtNumber(pt.avg, 4) + "<br/>" +
            "量 " + fmtNumber(pt.volume, 0);
        },
      },
      legend: { data: ["价格", "均价"], top: 28 },
      grid: [
        { left: "3%", right: "3%", top: "14%", height: "54%" },
        { left: "3%", right: "3%", top: "72%", height: "18%" },
      ],
      xAxis: [
        { type: "category", data: times, gridIndex: 0, boundaryGap: false },
        { type: "category", data: times, gridIndex: 1, axisLabel: { show: false } },
      ],
      yAxis: [
        { scale: true, gridIndex: 0, splitLine: { lineStyle: { type: "dashed" } } },
        { scale: true, gridIndex: 1, splitLine: { show: false }, axisLabel: { show: false } },
      ],
      dataZoom: [
        { type: "inside", xAxisIndex: [0, 1], start: 0, end: 100 },
        { type: "slider", xAxisIndex: [0, 1], start: 0, end: 100, bottom: 0, height: 20 },
      ],
      series: [
        {
          name: "价格", type: "line", xAxisIndex: 0, yAxisIndex: 0,
          data: prices, smooth: true, symbol: "none",
          lineStyle: { width: 1.5, color: lineColor },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: lineColor + "40" },
              { offset: 1, color: lineColor + "01" },
            ]),
          },
          markLine: pre ? {
            symbol: "none", silent: true,
            data: [{ yAxis: pre }],
            lineStyle: { color: "#9ca3af", type: "dashed", width: 1 },
            label: { formatter: "昨收 " + fmtNumber(pre, 4), position: "insideEndTop", fontSize: 10, color: "#6b7280" },
          } : undefined,
        },
        {
          name: "均价", type: "line", xAxisIndex: 0, yAxisIndex: 0,
          data: avgs, smooth: true, symbol: "none",
          lineStyle: { width: 1, color: "#f59e0b", type: "dashed" },
        },
        {
          name: "成交", type: "bar", xAxisIndex: 1, yAxisIndex: 1,
          data: vols, itemStyle: { color: "#93c5fd" },
        },
      ],
    };
    state.chart.setOption(option, true);
  }

  function renderFundNAV(records, c) {
    ensureChart();
    if (!records.length) {
      state.chart.clear();
      state.chart.setOption({ title: { text: "暂无净值数据", left: "center", top: "center" } });
      return;
    }
    const dates = records.map(function (r) { return r.date; });
    const navs = records.map(function (r) { return r.close; });
    const first = navs[0];
    const last = navs[navs.length - 1];
    const lineColor = (last >= first) ? COLOR_UP : COLOR_DOWN;

    const option = {
      title: { text: c.name + " " + c.code + " 单位净值", left: 10, textStyle: { fontSize: 14 } },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        formatter: function (params) {
          const p = params[0];
          const idx = p.dataIndex;
          const r = records[idx];
          if (!r) return "";
          const chg = first ? (r.close - first) / first : 0;
          const dayPct = (r.pct !== undefined && r.pct !== null) ? (+r.pct) : null;
          return "<strong>" + r.date + "</strong><br/>" +
            "净值 " + fmtNumber(r.close, 4) + "<br/>" +
            "区间累计 " + (chg >= 0 ? "+" : "") + (chg * 100).toFixed(2) + "%<br/>" +
            (dayPct === null ? "" : "当日 " + (dayPct >= 0 ? "+" : "") + dayPct.toFixed(2) + "%");
        },
      },
      grid: { left: "3%", right: "3%", top: "12%", bottom: "12%" },
      xAxis: { type: "category", data: dates, scale: true, boundaryGap: false },
      yAxis: { scale: true, splitLine: { lineStyle: { type: "dashed" } } },
      dataZoom: [
        { type: "inside", start: 0, end: 100 },
        { type: "slider", start: 0, end: 100, bottom: 0, height: 20 },
      ],
      series: [{
        name: "净值", type: "line", data: navs, smooth: true, symbol: "none",
        lineStyle: { width: 2, color: lineColor },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: lineColor + "33" },
            { offset: 1, color: lineColor + "01" },
          ]),
        },
      }],
    };
    state.chart.setOption(option, true);
  }

  function renderError(msg) {
    ensureChart();
    state.chart.clear();
    state.chart.setOption({
      title: { text: msg, left: "center", top: "center", textStyle: { color: "#dc2626", fontSize: 14 } },
    });
  }

  function ensureChart() {
    if (!state.chart) state.chart = echarts.init(els.chart);
  }
  function setChartLoading(loading) {
    if (!state.chart) return;
    if (loading) {
      state.chart.showLoading("default", { text: "加载中…", color: "#2563eb", textColor: "#6b7280", maskColor: "rgba(255,255,255,0.6)" });
    } else {
      state.chart.hideLoading();
    }
  }

  /* ============================================================
   * 7. 周期 / 复权 / 区间 控件
   * ============================================================ */
  function bindControls() {
    els.periodChips.addEventListener("click", function (e) {
      if (e.target.tagName !== "BUTTON") return;
      const p = e.target.dataset.period;
      state.period = p;
      syncPeriodActive();
      loadCurrent();
    });
    els.fqtChips.addEventListener("click", function (e) {
      if (e.target.tagName !== "BUTTON") return;
      state.fqt = +e.target.dataset.fqt;
      syncFqtActive();
      if (state.current && state.current.kind !== "fund" && state.period !== "trend") loadCurrent();
    });
    els.rangeChips.addEventListener("click", function (e) {
      if (e.target.tagName !== "BUTTON") return;
      state.range = e.target.dataset.range;
      syncRangeActive();
      if (state.current && state.current.kind !== "fund" && state.period !== "trend") loadCurrent();
    });
    els.applyDate.addEventListener("click", function () {
      syncRangeActive(false);
      state.range = "custom";
      if (state.current && state.current.kind !== "fund" && state.period !== "trend") loadCurrent();
    });
    els.autoRefresh.addEventListener("change", function () {
      if (els.autoRefresh.checked) {
        maybeStartRefresh();
      } else {
        clearRefreshTimer();
      }
    });
  }

  function syncPeriodActive() {
    els.periodChips.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.period === state.period);
    });
  }
  function syncFqtActive() {
    els.fqtChips.querySelectorAll("button").forEach(function (b) {
      b.classList.toggle("active", +b.dataset.fqt === state.fqt);
    });
  }
  function syncRangeActive(clearActive) {
    if (clearActive === undefined) clearActive = true;
    if (clearActive) {
      els.rangeChips.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("active", b.dataset.range === state.range);
      });
    } else {
      els.rangeChips.querySelectorAll("button").forEach(function (b) { b.classList.remove("active"); });
    }
  }

  /* ---------- 自动刷新（盘中分时） ---------- */
  function maybeStartRefresh() {
    clearRefreshTimer();
    if (!els.autoRefresh.checked) return;
    if (!state.current || state.current.kind === "fund") return;
    if (state.period !== "trend") return;
    state.refreshTimer = setInterval(function () {
      if (state.current && state.period === "trend") loadTrend(state.current);
    }, 30000);
  }
  function clearRefreshTimer() {
    if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
  }

  /* ============================================================
   * 8. 初始化
   * ============================================================ */
  function init() {
    bindSearch();
    bindControls();
    syncPeriodActive();
    syncFqtActive();
    syncRangeActive();
    updateMarketStatus();
    window.addEventListener("resize", function () { if (state.chart) state.chart.resize(); });

    // 默认加载上证指数日 K，让首屏有内容
    pickSuggest({
      Code: "000001",
      Name: "上证指数",
      MktNum: "1",
      QuoteID: "1.000001",
      Classify: "Index",
      SecurityTypeName: "指数",
    }, "kline");
  }

  function updateMarketStatus() {
    const el = document.getElementById("market-status");
    if (!el) return;
    el.textContent = isMarketOpen() ? "● 交易中" : "○ 休市";
  }

  init();
})();
