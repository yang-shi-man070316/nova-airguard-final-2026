#!/usr/bin/env python3
# AirGuard 传感器模拟器：周期发布三区域环境报文（retain=True 保留消息）
# retain=True 的作用：任何新打开的页面（总视图 / 3D / 移动端 / 小程序）一订阅立即收到
# 各区域最新一条状态，无需等待下一轮报文。
#
# 用法：
#   pip install paho-mqtt
#   python sensor_sim.py            # 正常模式（健康值轻微波动）
#   python sensor_sim.py case1      # D2 用例1：zone-w 连续重度污染+拥挤，zone-s 通风不足
#   python sensor_sim.py case2      # D2 用例2：zone-s 重度污染，zone-w 轻度污染
#   python sensor_sim.py case3      # D2 用例3：全部正常（无优先关注区域）
#   python sensor_sim.py d3         # D3 剧本：zone-w 异常→改善→正常×2 完整事件链路（自动递增时间戳）
#   python sensor_sim.py clear      # 清除三个区域主题的保留消息（页面刷新后回到「暂无数据」）
import json
import random
import sys
import time
from datetime import datetime

import paho.mqtt.client as mqtt

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1883          # mosquitto 默认 TCP 端口
INTERVAL = 5                # 发布周期（秒）
TOPIC = "airguard/{zone}/env"

# 各场景固定基准值：(pm25, co2, crowdLevel)
SCENARIOS = {
    "normal": {
        "zone-n": (35, 800, 0),
        "zone-s": (50, 900, 1),
        "zone-w": (45, 850, 1),
    },
    # D2 用例1：预期优先关注 zone-w（重度污染 10 分 + 拥挤 3 分 + 持续异常 2 分 = 15 分）
    "case1": {
        "zone-n": (35, 800, 0),    # 正常
        "zone-s": (40, 1600, 1),   # 通风不足风险（4 分）
        "zone-w": (160, 900, 2),   # 重度污染 + 拥挤
    },
    # D2 用例2：预期优先关注 zone-s（10+1=11 分 > zone-w 的 6+3=9 分）
    "case2": {
        "zone-n": (35, 800, 0),    # 正常
        "zone-s": (160, 700, 1),   # 重度污染
        "zone-w": (90, 1000, 2),   # 轻度污染 + 拥挤
    },
    # D2 用例3：全部正常 → 无优先关注区域
    "case3": {
        "zone-n": (35, 800, 0),
        "zone-s": (50, 900, 1),
        "zone-w": (45, 850, 1),
    },
}

# D3 剧本（zone-w 按 4 步推进，每一步自动生成新时间戳）：
#   步骤0：重度污染+拥挤 → 事件 OPEN（请在此期间点击「干预」按钮）
#   步骤1：轻度污染（改善仍异常）→ 保持 HANDLING，存入验证列表
#   步骤2：正常 ×1 → 连续正常计数 1
#   步骤3：正常 ×2 且人流 ≤1 → RECOVERED，事件归档
D3_SEQUENCE = [
    (160, 900, 2),
    (90, 1000, 1),
    (35, 800, 1),
    (30, 750, 0),
]


def build_payload(zone, pm25, co2, crowd_level):
    # 数据契约：zoneId（大写 I）、pm25、co2、crowdLevel、time
    # crowdLevel 保留 source 标记（任务书 D2 要求）：simulated 来源按 README 声明置信度 1.0
    return {
        "zoneId": zone,
        "pm25": pm25,
        "co2": co2,
        "crowdLevel": crowd_level,
        "crowdSource": "simulated",
        "crowdConfidence": 1.0,
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
    if mode != "d3" and mode != "clear" and mode not in SCENARIOS:
        print("用法: python sensor_sim.py [normal|case1|case2|case3|d3|clear]")
        sys.exit(1)
    base = SCENARIOS.get(mode, SCENARIOS["normal"])

    # 兼容 paho-mqtt 1.x / 2.x 两种 Client 构造方式
    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="airguard-sensor-sim")
    else:
        client = mqtt.Client(client_id="airguard-sensor-sim")

    client.connect(BROKER_HOST, BROKER_PORT, 60)
    client.loop_start()

    # clear 模式：向三个区域主题发布空消息（retain），清除保留数据后退出
    if mode == "clear":
        for zone in ("zone-n", "zone-s", "zone-w"):
            client.publish(TOPIC.format(zone=zone), "", qos=0, retain=True)
            print("[sensor_sim] 已清除保留消息:", TOPIC.format(zone=zone))
        client.disconnect()
        print("[sensor_sim] 清除完成，页面刷新后显示「暂无数据」")
        return

    print("[sensor_sim] 场景=%s broker=%s:%s 周期=%ss retain=True" %
          (mode, BROKER_HOST, BROKER_PORT, INTERVAL))

    try:
        step = 0
        while True:
            if mode == "d3":
                # D3 剧本：zone-w 按 4 步序列推进，zone-n / zone-s 保持正常
                pm25, co2, crowd = D3_SEQUENCE[step % len(D3_SEQUENCE)]
                payload = build_payload("zone-w", pm25, co2, crowd)
                client.publish(TOPIC.format(zone="zone-w"), json.dumps(payload), qos=0, retain=True)
                print("[%s] airguard/zone-w/env -> %s  (D3 步骤 %d/4)" % (
                    datetime.now().strftime("%H:%M:%S"),
                    json.dumps(payload, ensure_ascii=False), step % len(D3_SEQUENCE) + 1))
                for zone in ("zone-n", "zone-s"):
                    p, c, k = base[zone]
                    p = max(5, p + random.randint(-3, 3))
                    c = max(400, c + random.randint(-30, 30))
                    payload = build_payload(zone, p, c, k)
                    client.publish(TOPIC.format(zone=zone), json.dumps(payload), qos=0, retain=True)
                    print("[%s] %s -> %s" % (
                        datetime.now().strftime("%H:%M:%S"),
                        TOPIC.format(zone=zone), json.dumps(payload, ensure_ascii=False)))
                step += 1
            else:
                for zone, (pm25, co2, crowd) in base.items():
                    p, c, k = pm25, co2, crowd
                    if mode == "normal":
                        # 健康值附近轻微波动，保持状态为正常
                        p = max(5, pm25 + random.randint(-3, 3))
                        c = max(400, co2 + random.randint(-30, 30))
                    payload = build_payload(zone, p, c, k)
                    topic = TOPIC.format(zone=zone)
                    # retain=True：新打开页面一订阅立即收到最新状态（关键）
                    client.publish(topic, json.dumps(payload), qos=0, retain=True)
                    print("[%s] %s -> %s" % (
                        datetime.now().strftime("%H:%M:%S"), topic, json.dumps(payload, ensure_ascii=False)))
            time.sleep(INTERVAL)
    except KeyboardInterrupt:
        print("\n[sensor_sim] 已停止")
        client.disconnect()


if __name__ == "__main__":
    main()
