# AirGuard 数据链A：离线分析链

区域采集/历史记录 → CSV → Python 脚本 → 时空统计、趋势分析 → report.html 静态报告

## 目录结构

```
python_anaiysis/
├── airguard_offline_analyze.py   # 分析脚本（pandas + matplotlib）
├── sample_airguard.csv           # 示例数据（三区域 + 6 行脏数据演示质量校验）
├── README.md
└── report/
    └── report.html               # 输出：单文件报告，图表内嵌 base64，无外部依赖
```

## 运行步骤

```bash
# 1. 安装依赖（仅首次）
pip install pandas matplotlib

# 2. 运行分析（用示例数据）
python airguard_offline_analyze.py sample_airguard.csv

# 3. 浏览器打开输出
start report/report.html
```

## 增量合并（从总视图导出 CSV 持续追加）

1. 在 web/index.html 的 D1 面板点「开始记录」→ 页面持续采集各区域报文 →「导出 CSV」下载 `airguard_records_xxx.csv`
2. 把下载的 CSV 放进 `report/` 目录（或任意位置）
3. 运行：

```bash
python airguard_offline_analyze.py report/airguard_records_xxx.csv
```

脚本会自动：读取累计数据集 `report/history_merged.csv`（原有数据不变）→ 合并本次新 CSV → 按 zoneId+time 去重 → 重新生成 `report/report.html`。报告头部的「历史累计 / 本次新增 / 合并去重 / 累计有效」统计可看到增量效果。

> 想从头开始累计：删除 `report/history_merged.csv` 后重新运行即可。

## 更换全新 CSV 重新生成

准备一份符合统一字段的 CSV（列名：`zoneId,pm25,co2,crowdLevel,status,time`，zoneId 取值 zone-n / zone-s / zone-w，time 格式 `yyyy-MM-dd HH:mm:ss`），然后：

```bash
python airguard_offline_analyze.py 你的数据.csv
```

脚本会全自动完成清洗 → 校验 → 统计 → 出图 → 覆盖生成 `report/report.html`，全程无手工干预。

## CSV 输入约定

| 字段 | 说明 |
|---|---|
| zoneId | zone-n 宿舍区 / zone-s 教学区 / zone-w 食堂区 |
| pm25 | 数值（合理范围 0~600 μg/m³） |
| co2 | 数值（合理范围 300~6000 ppm） |
| crowdLevel | 0稀疏 / 1正常 / 2拥挤 / 3严重拥挤 |
| status | 判级结果（脚本会用统一规则重算校验合规性） |
| time | `yyyy-MM-dd HH:mm:ss` |

## 统一判级规则（脚本内复现，用于校验 CSV status 合规性）

1. pm25 > 150 → 重度污染
2. pm25 > 75 → 轻度污染
3. co2 ≥ 1500 → 通风不足风险
4. 其余 → 正常

## 报告内容

1. 数据质量校验：缺失字段 / pm25、co2 数值越界 / crowdLevel 非法取值 / zoneId 非法 / time 格式错误（逐项统计 + 示例明细）
2. status 合规性校验：统一规则重算与 CSV 逐行对比，列出不一致记录
3. 分区统计：各区域 pm25、co2 均值 / 最小 / 最大
4. 时间趋势图：pm25、co2 随时间变化（分区域）
5. 异常事件统计：各区域各类 status 出现次数
6. crowdLevel 人流密度分布统计
7. 事件时间线：异常记录时间轴图 + 明细表
