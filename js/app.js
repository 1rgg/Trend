/**
 * Asset Trend 前端
 * 纯静态实现：加载 data/index.json 与 data/{code}.json，用 ECharts 渲染走势。
 */

(function () {
  const ASSETS_URL = "./data/index.json";

  const els = {
    assetSelect: document.getElementById("asset-select"),
    rangeChips: document.getElementById("range-chips"),
    startDate: document.getElementById("start-date"),
    endDate: document.getElementById("end-date"),
    applyDate: document.getElementById("apply-date"),
    metricClose: document.getElementById("metric-close"),
    metricReturn: document.getElementById("metric-return"),
    metricVol: document.getElementById("metric-vol"),
    metricDd: document.getElementById("metric-dd"),
    metricHigh: document.getElementById("metric-high"),
    metricLow: document.getElementById("metric-low"),
    sourceNote: document.getElementById("source-note"),
    chart: document.getElementById("trend-chart"),
  };

  let catalog = [];
  let currentAsset = null;
  let chartInstance = null;
  let currentRange = "1y";

  // 格式化数字
  function fmtNumber(n, digits = 2) {
    if (n === null || n === undefined || isNaN(n)) return "-";
    return Number(n).toLocaleString("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function parseDate(str) {
    return new Date(str + "T00:00:00");
  }

  function formatDateISO(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addMonths(date, months) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
  }

  function rangeStart(range, endDate) {
    const end = new Date(endDate);
    switch (range) {
      case "1m":
        return addMonths(end, -1);
      case "3m":
        return addMonths(end, -3);
      case "6m":
        return addMonths(end, -6);
      case "1y":
        return addMonths(end, -12);
      case "all":
      default:
        return null;
    }
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json();
  }

  function renderCatalog() {
    els.assetSelect.innerHTML = '<option value="" disabled selected>请选择资产</option>';
    const groups = { index: "指数", fund: "基金", stock: "股票" };
    const byType = {};
    catalog.forEach((item) => {
      if (!byType[item.type]) byType[item.type] = [];
      byType[item.type].push(item);
    });

    Object.keys(groups).forEach((type) => {
      if (!byType[type]) return;
      const optGroup = document.createElement("optgroup");
      optGroup.label = groups[type];
      byType[type].forEach((item) => {
        const option = document.createElement("option");
        option.value = item.code;
        option.textContent = `${item.code} ${item.name}`;
        optGroup.appendChild(option);
      });
      els.assetSelect.appendChild(optGroup);
    });
  }

  function updateMetricValues(metrics) {
    if (!metrics || !metrics.end_close) {
      ["metricClose", "metricReturn", "metricVol", "metricDd", "metricHigh", "metricLow"].forEach((k) => {
        els[k].textContent = "-";
        els[k].classList.remove("up", "down");
      });
      return;
    }

    els.metricClose.textContent = fmtNumber(metrics.end_close, 4);

    const totalReturn = metrics.total_return;
    els.metricReturn.textContent = metrics.total_return_pct || fmtNumber(totalReturn * 100, 2) + "%";
    els.metricReturn.classList.toggle("up", totalReturn >= 0);
    els.metricReturn.classList.toggle("down", totalReturn < 0);

    els.metricVol.textContent = metrics.annualized_volatility_pct || fmtNumber(metrics.annualized_volatility * 100, 2) + "%";
    els.metricVol.classList.remove("up", "down");

    els.metricDd.textContent = metrics.max_drawdown_pct || fmtNumber(metrics.max_drawdown * 100, 2) + "%";
    els.metricDd.classList.add("down");

    els.metricHigh.textContent = fmtNumber(metrics.high, 4);
    els.metricLow.textContent = fmtNumber(metrics.low, 4);

    els.sourceNote.textContent = `数据更新于：${currentAsset.updated_at || "未知"} · 来源：${currentAsset.source || "AkShare"}`;
  }

  function filterData(data, start, end) {
    return data.filter((row) => {
      const d = parseDate(row.date);
      if (start && d < new Date(start + "T00:00:00")) return false;
      if (end && d > new Date(end + "T00:00:00")) return false;
      return true;
    });
  }

  function computeMetricsForRange(records) {
    if (!records || records.length === 0) return null;
    const closes = records.map((r) => r.close);
    const first = closes[0];
    const last = closes[closes.length - 1];
    const totalReturn = (last - first) / first;

    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const volatility = Math.sqrt(variance) * Math.sqrt(252);

    let maxDd = 0;
    let peak = first;
    closes.forEach((c) => {
      if (c > peak) peak = c;
      const dd = (peak - c) / peak;
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
      high: Math.max(...closes),
      low: Math.min(...closes),
    };
  }

  function renderChart(records) {
    if (!chartInstance) {
      chartInstance = echarts.init(els.chart);
    }

    if (!records || records.length === 0) {
      chartInstance.clear();
      chartInstance.setOption({
        title: { text: "暂无数据", left: "center", top: "center" },
      });
      return;
    }

    const dates = records.map((r) => r.date);
    const closes = records.map((r) => r.close);
    const volumes = records.map((r) => r.volume || 0);
    const colorUp = "#ef4444";
    const colorDown = "#22c55e";

    const option = {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        formatter: function (params) {
          const date = params[0].axisValue;
          const lines = [`<strong>${date}</strong>`];
          params.forEach((p) => {
            const val = typeof p.value === "number" ? p.value.toFixed(4) : p.value;
            lines.push(`${p.marker} ${p.seriesName}: ${val}`);
          });
          return lines.join("<br/>");
        },
      },
      legend: { data: ["收盘价", "成交量"], top: 0 },
      grid: [
        { left: "3%", right: "3%", top: "12%", height: "55%" },
        { left: "3%", right: "3%", top: "72%", height: "18%" },
      ],
      xAxis: [
        { type: "category", data: dates, scale: true, gridIndex: 0, boundaryGap: false },
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
          name: "收盘价",
          type: "line",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: closes,
          smooth: true,
          symbol: "none",
          lineStyle: { width: 2, color: colorUp },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(239, 68, 68, 0.25)" },
              { offset: 1, color: "rgba(239, 68, 68, 0.01)" },
            ]),
          },
        },
        {
          name: "成交量",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: volumes,
          itemStyle: { color: "#93c5fd" },
        },
      ],
    };

    chartInstance.setOption(option, true);
  }

  function updateView() {
    if (!currentAsset) return;

    const allRecords = currentAsset.data || [];
    const endDate = els.endDate.value;
    const startDate = els.startDate.value;
    const filtered = filterData(allRecords, startDate, endDate);

    const metrics = computeMetricsForRange(filtered);
    updateMetricValues(metrics);
    renderChart(filtered);
  }

  function setRange(range) {
    if (!currentAsset || currentAsset.data.length === 0) return;
    currentRange = range;

    const allDates = currentAsset.data.map((r) => r.date);
    const maxDate = allDates[allDates.length - 1];
    const start = rangeStart(range, maxDate);

    els.endDate.value = maxDate;
    els.startDate.value = start ? formatDateISO(start) : allDates[0];

    updateView();
  }

  async function loadAsset(code) {
    const meta = catalog.find((c) => c.code === code);
    if (!meta) return;

    try {
      const asset = await fetchJSON(`./${meta.file}`);
      currentAsset = asset;
      setRange(currentRange);
    } catch (err) {
      console.error("加载资产数据失败:", err);
      alert(`加载 ${code} 数据失败: ${err.message}`);
    }
  }

  function initEventListeners() {
    els.assetSelect.addEventListener("change", (e) => {
      loadAsset(e.target.value);
    });

    els.rangeChips.addEventListener("click", (e) => {
      if (e.target.tagName !== "BUTTON") return;
      Array.from(els.rangeChips.children).forEach((btn) => btn.classList.remove("active"));
      e.target.classList.add("active");
      setRange(e.target.dataset.range);
    });

    els.applyDate.addEventListener("click", () => {
      Array.from(els.rangeChips.children).forEach((btn) => btn.classList.remove("active"));
      currentRange = "custom";
      updateView();
    });

    window.addEventListener("resize", () => {
      if (chartInstance) chartInstance.resize();
    });
  }

  async function init() {
    try {
      catalog = await fetchJSON(ASSETS_URL);
    } catch (err) {
      console.error("加载资产目录失败:", err);
      els.assetSelect.innerHTML = '<option value="" disabled selected>目录加载失败</option>';
      return;
    }

    renderCatalog();
    initEventListeners();

    if (catalog.length > 0) {
      // 默认选中第一个
      const firstCode = catalog[0].code;
      els.assetSelect.value = firstCode;
      await loadAsset(firstCode);
    }
  }

  init();
})();
