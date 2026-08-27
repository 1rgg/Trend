# Asset Trend · 实时版

一个**纯前端**的资产走势查询页面，浏览器直接调用东方财富公开 JSONP 接口获取**实时**行情，无需后端、无需预先抓取数据，可直接部署到 GitHub Pages 等静态托管。

支持**任意代码搜索**并展示 A 股、指数、ETF 的分时 / 日 K / 周 K / 月 K 走势，以及场外基金的净值历史与盘中实时估值。

## 特性

- **实时走势**：当日分时图盘中实时刷新；日 / 周 / 月 K 线随取随查
- **任意搜索**：输入中文名称、6 位代码或拼音首字母即可模糊匹配（如「茅台」「006480」「纳指」）
- **场外基金**：单位净值历史曲线 + 盘中实时估算（fundgz）
- **复权切换**：前复权 / 不复权 / 后复权
- **关键指标**：最新价、涨跌幅、年化波动率、最大回撤、区间最高 / 最低
- **纯静态部署**：无后端依赖，GitHub Pages / Cloudflare Pages / Vercel 直接托管

## 在线预览

部署到 GitHub Pages 后访问：`https://<你的用户名>.github.io/<仓库名>/`

## 项目结构

```
.
├── index.html        # 入口页面（搜索框 / 周期 / 复权 / 区间 / 自动刷新）
├── css/style.css     # 样式
├── js/app.js         # 前端逻辑（JSONP 接口封装 + ECharts 渲染）
└── README.md
```

## 本地预览

无需安装任何依赖，只要一个静态服务器：

```bash
# Python
python -m http.server 8000
# 访问 http://localhost:8000
```

打开后在搜索框输入资产名称 / 代码即可。

## 数据来源

均为东方财富公开接口（[AkShare](https://www.akshare.xyz/) 底层亦抓取同一来源）：

| 数据 | 接口 |
|------|------|
| 代码搜索 | `searchapi.eastmoney.com/api/suggest/get` |
| 历史 K 线 | `push2his.eastmoney.com/api/qt/stock/kline/get` |
| 当日分时 | `push2his.eastmoney.com/api/qt/stock/trends2/get` |
| 基金估值 | `fundgz.1234567.com.cn/js/{code}.js` |
| 基金净值 | `fund.eastmoney.com/pingzhongdata/{code}.js` |

> ⚠️ 接口为非官方公开，无 SLA 保证，偶发限流或字段变更属正常现象。

## 部署到 GitHub Pages

1. 将本项目 push 到 GitHub 仓库。
2. 进入仓库 **Settings → Pages → Build and deployment**。
3. Source 选择 **Deploy from a branch**，分支选 `main`、目录选 `/ (root)`。
4. 保存后稍等片刻即可通过 Pages 链接访问。

> 本项目不再需要 GitHub Actions 定时抓取数据，因为行情全部实时获取。

## 关键指标说明

| 指标 | 说明 |
|------|------|
| 最新价 | 当前区间最后一根 K 线的收盘价 / 最新分时价 |
| 涨跌幅 | K 线：区间首末收盘变化；分时：相对昨收 |
| 年化波动率 | 日收益率标准差 × √252 |
| 最大回撤 | 区间内从最高点到最低点的最大跌幅 |
| 区间最高 / 最低 | 区间内收盘价的最大 / 最小值 |

## 技术栈

- 前端：原生 HTML5 / CSS3 / ES6
- 图表：[Apache ECharts](https://echarts.apache.org/)（CDN，含 candlestick）
- 数据：东方财富公开 JSONP 接口
- 部署：任意静态托管（GitHub Pages 等）

## 免责声明

本项目仅供学习研究使用，不构成任何投资建议。市场有风险，投资需谨慎。
