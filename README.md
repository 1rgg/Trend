# Asset Trend

一个可部署在 **GitHub Pages** 上的纯静态资产走势查询页面。

支持查询并展示 **指数、基金、股票** 的历史走势，包含搜索/选择入口、时间区间筛选、走势图表、关键指标摘要及数据来源说明。所有数据均通过 [AkShare](https://www.akshare.xyz/) 预先抓取，转换为静态 JSON 文件供前端加载，完全适配 GitHub Pages 的静态部署限制。

## 在线预览

开启 GitHub Pages 后访问：`https://<你的用户名>.github.io/<仓库名>/`

## 项目结构

```
.
├── index.html              # 入口页面
├── css/style.css           # 样式
├── js/app.js               # 前端逻辑（ECharts 渲染）
├── data/                   # 生成的静态 JSON 数据
│   ├── index.json          # 资产目录
│   ├── 000001.json         # 上证指数
│   └── ...
├── scripts/
│   └── fetch_data.py       # AkShare 数据抓取脚本
├── requirements.txt        # Python 依赖
├── .github/workflows/
│   └── update-and-deploy.yml  # 定时更新数据并部署 Pages
└── README.md
```

## 本地使用

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 生成数据

```bash
# 拉取内置资产池近一年数据
python scripts/fetch_data.py

# 仅更新指定资产
python scripts/fetch_data.py --assets 000001,006480 --days 180
```

### 3. 本地预览

```bash
python -m http.server 8000
# 访问 http://localhost:8000
```

## 支持的资产

默认内置资产池可在 `scripts/fetch_data.py` 中的 `DEFAULT_ASSETS` 修改：

- 指数：上证指数、沪深300、科创50、创业板指、上证科创板芯片指数
- 基金：广发纳斯达克100ETF联接(QDII)C、易方达上证科创板芯片ETF联接C
- 股票：贵州茅台、五粮液

## 部署到 GitHub Pages

1. 将本项目 push 到 GitHub 仓库。
2. 进入仓库 **Settings → Pages → Build and deployment**。
3. Source 选择 **GitHub Actions**。
4. 工作流 `.github/workflows/update-and-deploy.yml` 已配置好：
   - 每日北京时间 09:00 自动拉取最新数据并部署。
   - 支持手动触发 `workflow_dispatch`。
   - `push` 到 `main` 分支时也会自动部署。

## 关键指标说明

| 指标 | 说明 |
|------|------|
| 最新收盘价 | 当前选中区间最后一天的收盘价/净值 |
| 区间涨跌幅 | `(期末 - 期初) / 期初` |
| 年化波动率 | 日收益率标准差 × √252 |
| 最大回撤 | 区间内从最高点到最低点的最大跌幅 |
| 区间最高价/最低价 | 区间内收盘价的最大/最小值 |

## 技术栈

- 前端：原生 HTML5 / CSS3 / ES6
- 图表：[Apache ECharts](https://echarts.apache.org/)（CDN）
- 数据：[AkShare](https://www.akshare.xyz/) + Python
- 部署：GitHub Pages + GitHub Actions

## 免责声明

本项目仅供学习研究使用，不构成任何投资建议。市场有风险，投资需谨慎。
