#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AirGuard 数据链A：离线分析链
区域采集/历史记录 → CSV → Python 脚本 → 时空统计、趋势分析 → report.html 静态报告

用法：python airguard_offline_analyze.py input.csv [--out report]
输出：<out>/report.html（单文件，图表以 base64 内嵌，无外部图片依赖）
依赖：pandas / matplotlib
"""
import argparse
import base64
import html
import io
import os
import sys
from datetime import datetime

import matplotlib
matplotlib.use('Agg')  # 后台渲染，无需图形界面
import matplotlib.pyplot as plt
import pandas as pd

# ============ 全局配置 ============
REQUIRED_COLS = ['zoneId', 'pm25', 'co2', 'crowdLevel', 'status', 'time']
ZONES = ['zone-n', 'zone-s', 'zone-w']
ZONE_CN = {'zone-n': '宿舍区', 'zone-s': '教学区', 'zone-w': '食堂区'}
STATUS_ORDER = ['重度污染', '轻度污染', '通风不足风险', '正常']
STATUS_COLOR = {'重度污染': '#ef4444', '轻度污染': '#f59e0b', '通风不足风险': '#9c27b0', '正常': '#22c55e'}
TIME_FMT = '%Y-%m-%d %H:%M:%S'
PM25_RANGE = (0, 600)    # pm25 合理数值范围（μg/m³）
CO2_RANGE = (300, 6000)  # co2 合理数值范围（ppm）
CROWD_LEVELS = {0, 1, 2, 3}

# 中文字体处理：优先微软雅黑/黑体，避免图表中文乱码
plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'PingFang SC', 'Noto Sans CJK SC', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False


# ============ 统一判级规则（与全端一致，颗粒物优先，顺序不可调换） ============
def calc_status(pm25, co2):
    """① pm25>150 → 重度污染；② pm25>75 → 轻度污染；
       ③ co2≥1500 → 通风不足风险；④ 其余 → 正常"""
    if pm25 > 150:
        return '重度污染'
    if pm25 > 75:
        return '轻度污染'
    if co2 >= 1500:
        return '通风不足风险'
    return '正常'


# ============ 图表工具 ============
def fig_to_base64(fig):
    """matplotlib 图 → base64 字符串（用于内嵌 HTML，不依赖外部图片文件）"""
    buf = io.BytesIO()
    fig.savefig(buf, format='png', dpi=110, bbox_inches='tight')
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def build_trend_fig(df, col, unit, color):
    """时间趋势图：pm25 / co2 随时间变化，分区域三个子图"""
    fig, axes = plt.subplots(1, 3, figsize=(15, 4), sharey=True)
    for ax, z in zip(axes, ZONES):
        sub = df[df['zoneId'] == z].sort_values('time')
        ax.plot(sub['time'], sub[col], marker='o', markersize=3, linewidth=1.2, color=color)
        ax.set_title(ZONE_CN[z] + '（' + z + '）', fontsize=11)
        ax.set_ylabel(unit, fontsize=9)
        ax.tick_params(axis='x', rotation=35, labelsize=8)
        ax.grid(alpha=0.3)
    fig.suptitle(col.upper() + ' 时间趋势（分区域）', fontsize=13)
    fig.tight_layout()
    return fig


def build_status_fig(ct):
    """异常事件统计：各区域各类 status 出现次数（分组柱状图）"""
    fig, ax = plt.subplots(figsize=(9, 4))
    x = range(len(ct.index))
    width = 0.2
    for i, st in enumerate(STATUS_ORDER):
        ax.bar([v + i * width for v in x], ct[st], width, label=st, color=STATUS_COLOR[st])
    ax.set_xticks([v + 1.5 * width for v in x])
    ax.set_xticklabels([ZONE_CN[z] + '（' + z + '）' for z in ct.index])
    ax.set_ylabel('次数')
    ax.legend()
    ax.grid(axis='y', alpha=0.3)
    fig.tight_layout()
    return fig


def build_crowd_fig(ct):
    """crowdLevel 人流密度分布统计（分组柱状图）"""
    fig, ax = plt.subplots(figsize=(9, 4))
    x = range(len(ct.index))
    width = 0.2
    colors = ['#cbd5e1', '#93c5fd', '#f59e0b', '#ef4444']
    for i, lv in enumerate(sorted(CROWD_LEVELS)):
        ax.bar([v + i * width for v in x], ct[lv], width, label='等级 ' + str(lv), color=colors[i])
    ax.set_xticks([v + 1.5 * width for v in x])
    ax.set_xticklabels([ZONE_CN[z] + '（' + z + '）' for z in ct.index])
    ax.set_ylabel('次数')
    ax.legend(title='crowdLevel')
    ax.grid(axis='y', alpha=0.3)
    fig.tight_layout()
    return fig


def build_event_timeline_fig(ab):
    """事件时间线：异常记录在时间轴上的分布（按区域分层、按等级着色）"""
    fig, ax = plt.subplots(figsize=(14, 3.8))
    ypos = {z: i for i, z in enumerate(ZONES)}
    for st in ['重度污染', '轻度污染', '通风不足风险']:
        sub = ab[ab['status'] == st]
        if sub.empty:
            continue
        ax.scatter(sub['time'], [ypos[z] for z in sub['zoneId']], s=70,
                   color=STATUS_COLOR[st], label=st, zorder=3)
    ax.set_yticks(list(ypos.values()))
    ax.set_yticklabels([ZONE_CN[z] + '（' + z + '）' for z in ZONES])
    ax.set_xlabel('时间')
    ax.grid(axis='x', alpha=0.3)
    ax.legend()
    fig.autofmt_xdate()
    fig.tight_layout()
    return fig


# ============ HTML 报告 ============
CSS = """
body { font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background:#f5f7fa; color:#1f2937; margin:0; padding:24px; }
.wrap { max-width: 1150px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 17px; border-left: 4px solid #2563eb; padding-left: 10px; margin: 34px 0 12px; }
h3 { font-size: 14px; color: #4b5563; margin: 16px 0 8px; }
.meta { color: #6b7280; font-size: 12px; margin-bottom: 8px; }
.card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:16px; margin-top:12px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; background: #fff; }
th, td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: center; }
th { background: #f8fafc; }
img { max-width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; margin-top: 8px; }
.ok { color: #22c55e; font-weight: 600; }
.bad { color: #ef4444; font-weight: 600; }
.warn { color: #b45309; font-weight: 600; }
.code { font-family: Consolas, monospace; font-size: 12px; color:#4b5563; background:#f8fafc; padding:8px 10px; border-radius:6px; white-space: pre-wrap; }
footer { text-align:center; color:#9ca3af; font-size:12px; margin-top:40px; }
"""


def row_samples(df, n=5):
    """取问题行示例（前 n 行紧凑文本）"""
    if df.empty:
        return '无'
    cols = [c for c in REQUIRED_COLS if c in df.columns]
    return html.escape(df[cols].head(n).to_string(index=False))


def build_html(args, n_hist, n_new, n_dedup, n_bad, checks, n_clean, mismatch, stats, status_ct, crowd_ct, abnormal,
               fig_pm25, fig_co2, fig_status, fig_crowd, fig_timeline):
    img = lambda f: '<img src="data:image/png;base64,%s" alt="chart">' % fig_to_base64(f)

    # 数据质量校验表
    check_rows = ''
    for name, cnt, action, sample in checks:
        cls = 'ok' if cnt == 0 else 'bad'
        check_rows += ('<tr><td>%s</td><td class="%s">%d</td><td>%s</td><td class="code">%s</td></tr>'
                       % (html.escape(name), cls, cnt, action, row_samples(sample)))

    # status 合规性校验表
    if mismatch.empty:
        status_check = '<p class="ok">✅ CSV 中 status 字段与统一判级规则完全一致（%d 条有效记录全部合规）。</p>' % n_clean
    else:
        status_check = ('<p class="bad">⚠ 发现 %d 条 status 与统一判级规则不一致（按 pm25/co2 重算），仅作校验提示，不修改数据：</p>'
                        % len(mismatch))
        mc = mismatch[['zoneId', 'time', 'pm25', 'co2', 'status', 'status_calc']].copy()
        mc['time'] = mc['time'].dt.strftime(TIME_FMT)
        mc.columns = ['zoneId', 'time', 'pm25', 'co2', 'CSV中status', '规则重算status']
        status_check += mc.head(20).to_html(index=False)

    # 分区统计表
    stats_disp = stats.copy()
    stats_disp.index = [ZONE_CN[z] + '（' + z + '）' for z in stats_disp.index]
    stats_disp.columns = ['pm25均值', 'pm25最小', 'pm25最大', 'co2均值', 'co2最小', 'co2最大', '记录数']
    stats_html = stats_disp.to_html()

    # status 次数表 + crowd 分布表
    status_ct_disp = status_ct.copy()
    status_ct_disp.index = [ZONE_CN[z] + '（' + z + '）' for z in status_ct_disp.index]
    crowd_ct_disp = crowd_ct.copy()
    crowd_ct_disp.index = [ZONE_CN[z] + '（' + z + '）' for z in crowd_ct_disp.index]
    crowd_ct_disp.columns = ['等级0 稀疏', '等级1 正常', '等级2 拥挤', '等级3 严重拥挤']

    # 事件时间线表（异常记录，最多 100 条）
    if abnormal.empty:
        timeline_html = '<p class="ok">✅ 无异常记录。</p>'
    else:
        tl = abnormal[['time', 'zoneId', 'status', 'pm25', 'co2', 'crowdLevel']].copy()
        tl['time'] = tl['time'].dt.strftime(TIME_FMT)
        tl['zoneId'] = tl['zoneId'].map(lambda z: ZONE_CN.get(z, z) + '（' + z + '）')
        tl.columns = ['时间', '区域', '异常等级', 'pm25', 'co2', 'crowdLevel']
        timeline_html = tl.head(100).to_html(index=False)

    page = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AirGuard 数据链A 离线分析报告</title>
<style>{css}</style>
</head>
<body>
<div class="wrap">
<h1>AirGuard 数据链A · 离线分析报告</h1>
<p class="meta">输入 CSV：{input_file} ｜ 历史累计 {n_hist} 条 + 本次新增 {n_new} 条，合并去重 {n_dedup} 条，质量剔除 {n_bad} 条，累计有效 {n_clean} 条 ｜ 生成时间：{gen_time}</p>

<h2>1 数据质量校验</h2>
<div class="card">
<table>
<tr><th>校验项</th><th>问题数</th><th>处理方式</th><th>示例明细（前5条）</th></tr>
{check_rows}
</table>
<p class="meta" style="margin-top:8px;">清洗策略：缺失字段/越界数值/非法取值/格式错误 的记录直接剔除，不参与后续统计。</p>
</div>

<h2>2 status 合规性校验（统一判级规则复现比对）</h2>
<div class="card">{status_check}</div>

<h2>3 分区统计（pm25 / co2 均值、最小、最大）</h2>
<div class="card">{stats_html}</div>

<h2>4 时间趋势（分区域）</h2>
<div class="card">
<h3>PM2.5 趋势</h3>{img_pm25}
<h3>CO₂ 趋势</h3>{img_co2}
</div>

<h2>5 异常事件统计（各类 status 出现次数）</h2>
<div class="card">{img_status}{status_table}</div>

<h2>6 crowdLevel 人流密度分布</h2>
<div class="card">{img_crowd}{crowd_table}</div>

<h2>7 事件时间线（异常记录）</h2>
<div class="card">{img_timeline}{timeline_html}</div>

<footer>AirGuard 数据链A 离线分析 · 图表与样式全部内嵌，无外部依赖 · 累计数据集 report/history_merged.csv 每次运行自动累加，更换 CSV 输入可全自动重新生成</footer>
</div>
</body>
</html>""".format(
        css=CSS,
        input_file=html.escape(os.path.basename(args.input)),
        n_hist=n_hist,
        n_new=n_new,
        n_dedup=n_dedup,
        n_bad=n_bad,
        n_clean=n_clean,
        gen_time=datetime.now().strftime(TIME_FMT),
        check_rows=check_rows,
        status_check=status_check,
        stats_html=stats_html,
        img_pm25=img(fig_pm25),
        img_co2=img(fig_co2),
        img_status=img(fig_status),
        status_table=status_ct_disp.to_html(),
        img_crowd=img(fig_crowd),
        crowd_table=crowd_ct_disp.to_html(),
        img_timeline=img(fig_timeline) if fig_timeline is not None else '<p class="ok">✅ 无异常记录，时间线为空。</p>',
        timeline_html=timeline_html,
    )
    return page


# ============ 主流程 ============
def main():
    ap = argparse.ArgumentParser(description='AirGuard 数据链A离线分析：CSV → 统计/趋势 → report.html（增量合并）')
    ap.add_argument('input', help='输入 CSV 文件路径（字段：zoneId,pm25,co2,crowdLevel,status,time）')
    ap.add_argument('--out', default='report', help='输出目录（默认 report）')
    args = ap.parse_args()

    if not os.path.isfile(args.input):
        print('[错误] 输入文件不存在:', args.input)
        sys.exit(1)

    # ---- 读取本次输入 CSV ----
    try:
        raw = pd.read_csv(args.input)
    except Exception as e:
        print('[错误] CSV 读取失败:', e)
        sys.exit(1)
    n_new = len(raw)

    # ---- 字段级检查：必需列缺失则中止 ----
    missing_cols = [c for c in REQUIRED_COLS if c not in raw.columns]
    if missing_cols:
        print('[错误] CSV 缺少必需字段:', missing_cols, '（要求：%s）' % ', '.join(REQUIRED_COLS))
        sys.exit(1)

    # ---- 与历史累计数据集合并：原数据不变，新 CSV 增量追加 ----
    history_path = os.path.join(args.out, 'history_merged.csv')
    n_hist = 0
    if os.path.isfile(history_path):
        try:
            hist = pd.read_csv(history_path)
            n_hist = len(hist)
            raw = pd.concat([hist, raw], ignore_index=True)
            print('[信息] 已合并历史累计数据 %d 条' % n_hist)
        except Exception as e:
            print('[警告] 历史数据集读取失败（本次仅使用输入数据）:', e)

    # 统一转类型：非法值转 NaN 进入质量检查，time 按统一格式解析
    raw['pm25'] = pd.to_numeric(raw['pm25'], errors='coerce')
    raw['co2'] = pd.to_numeric(raw['co2'], errors='coerce')
    raw['crowdLevel'] = pd.to_numeric(raw['crowdLevel'], errors='coerce')
    raw['time'] = pd.to_datetime(raw['time'], format=TIME_FMT, errors='coerce')
    raw['status'] = raw['status'].astype(str).str.strip()

    # ---- 数据质量校验（逐项统计 + 示例） ----
    checks = []
    mask_na = raw[REQUIRED_COLS].isna().any(axis=1)
    checks.append(('缺失字段（行内空值）', int(mask_na.sum()), '剔除', raw[mask_na]))
    mask_pm25 = raw['pm25'].notna() & ~raw['pm25'].between(*PM25_RANGE)
    checks.append(('pm25 数值越界（范围 %s~%s）' % PM25_RANGE, int(mask_pm25.sum()), '剔除', raw[mask_pm25]))
    mask_co2 = raw['co2'].notna() & ~raw['co2'].between(*CO2_RANGE)
    checks.append(('co2 数值越界（范围 %s~%s）' % CO2_RANGE, int(mask_co2.sum()), '剔除', raw[mask_co2]))
    mask_crowd = raw['crowdLevel'].notna() & ~raw['crowdLevel'].isin(CROWD_LEVELS)
    checks.append(('crowdLevel 非法取值（应为 0/1/2/3）', int(mask_crowd.sum()), '剔除', raw[mask_crowd]))
    mask_zone = ~raw['zoneId'].isin(ZONES)
    checks.append(('zoneId 非法取值（应为 zone-n/s/w）', int(mask_zone.sum()), '剔除', raw[mask_zone]))
    mask_time = raw['time'].isna()
    checks.append(('time 格式错误（应为 yyyy-MM-dd HH:mm:ss）', int(mask_time.sum()), '剔除', raw[mask_time]))

    drop_mask = mask_na | mask_pm25 | mask_co2 | mask_crowd | mask_zone | mask_time
    clean = raw[~drop_mask].copy()
    clean['time'] = pd.to_datetime(clean['time'])

    if clean.empty:
        print('[错误] 清洗后无有效数据，无法生成报告')
        sys.exit(1)

    # ---- 合并去重：zoneId+time 相同视为同一条记录，保留后到（新）记录 ----
    n_before_dedup = len(clean)
    clean = clean.drop_duplicates(subset=['zoneId', 'time'], keep='last')
    n_dedup = n_before_dedup - len(clean)
    clean = clean.sort_values('time').reset_index(drop=True)

    # ---- 累计数据集写回（供下次运行继续累加） ----
    clean.to_csv(history_path, index=False, encoding='utf-8-sig')

    # ---- status 合规性校验：用统一判级规则重算，与 CSV 中 status 对比（仅提示，不修改数据） ----
    clean['status_calc'] = clean.apply(lambda r: calc_status(r['pm25'], r['co2']), axis=1)
    mismatch = clean[clean['status'] != clean['status_calc']]

    # ---- 统计分析 ----
    stats = clean.groupby('zoneId').agg(
        pm25_mean=('pm25', 'mean'), pm25_min=('pm25', 'min'), pm25_max=('pm25', 'max'),
        co2_mean=('co2', 'mean'), co2_min=('co2', 'min'), co2_max=('co2', 'max'),
        rows=('pm25', 'count'),
    ).reindex(ZONES).round(1)

    status_ct = pd.crosstab(clean['zoneId'], clean['status']).reindex(index=ZONES, columns=STATUS_ORDER, fill_value=0)
    crowd_ct = pd.crosstab(clean['zoneId'], clean['crowdLevel']).reindex(index=ZONES, columns=sorted(CROWD_LEVELS), fill_value=0)

    abnormal = clean[clean['status'] != '正常'].sort_values('time')

    # ---- 图表（渲染后内嵌 base64） ----
    fig_pm25 = build_trend_fig(clean, 'pm25', 'μg/m³', '#2563eb')
    fig_co2 = build_trend_fig(clean, 'co2', 'ppm', '#16a34a')
    fig_status = build_status_fig(status_ct)
    fig_crowd = build_crowd_fig(crowd_ct)
    fig_timeline = build_event_timeline_fig(abnormal) if not abnormal.empty else None

    # ---- 生成单文件报告 ----
    n_bad = sum(c[1] for c in checks)
    page = build_html(args, n_hist, n_new, n_dedup, n_bad, checks, len(clean), mismatch, stats, status_ct, crowd_ct,
                      abnormal, fig_pm25, fig_co2, fig_status, fig_crowd, fig_timeline)

    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, 'report.html')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(page)

    print('=' * 52)
    print('AirGuard 数据链A 离线分析完成（增量合并）')
    print('  输入文件: %s' % args.input)
    print('  历史累计: %d 条 + 本次新增: %d 条，合并去重: %d 条，质量剔除: %d 条，累计有效: %d 条'
          % (n_hist, n_new, n_dedup, n_bad, len(clean)))
    print('  status 不合规记录: %d 条（仅提示，不修改数据）' % len(mismatch))
    print('  异常事件记录: %d 条' % len(abnormal))
    print('  累计数据集: %s' % os.path.abspath(history_path))
    print('  报告已生成: %s' % os.path.abspath(out_path))
    print('=' * 52)


if __name__ == '__main__':
    main()
