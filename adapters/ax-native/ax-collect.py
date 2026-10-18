#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通用 AX 采集轻量骨架（verify-suite · 驱动层 adapter: ax-native）

演示「枚举 / 富化分离 + 超集采集门 + 无静默降级 + 完整性断言」的通用骨架。
目标特定逻辑（找窗口、找列表、截图锚定）以 TODO 标注，便于移植到任意原生 App
（Windows UIA / macOS AX / 移动端无障碍桥同构）。

依赖（可选，仅富化遍需要）: pip install uiautomation mss numpy
无目标窗口时可用 `python ax-collect.py --demo` 打印 schema 示例，验证结构正确。

设计灵魂:
  1) 需求驱动: 只序列化需求字段；AX 已含文字就不截图。
  2) 确定性 + 可溯源: AX 为 ground truth；截图补位标 confidence=medium。
  3) 两遍分离: 枚举遍只读 AX 不截图（快且全）；富化遍仅 AX 盲区字段截图。
  4) 超集采集门: 类名匹配 OR 名称含日期时间；被过滤节点进账本，绝不静默丢行。
  5) 完整性断言: 去重 + 已知总数比对；空/缺 = 执行错误，不是"完成"。
"""
from __future__ import annotations
import argparse
import collections
import json
import os
import re
import time

ROOT = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# 采集门（超集，禁止白名单静默丢行）
# ---------------------------------------------------------------------------
MSG_CLASSES = ("ChatTextItemView", "ChatImageItemView", "ChatItemView", "ChatVoiceItemView")
DT_RE = re.compile(r"(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})")


def collection_gate(class_name: str, name: str) -> bool:
    """超集门：类名匹配 OR 名称含日期时间，二者满足其一即收录。"""
    if any(c in (class_name or "") for c in MSG_CLASSES):
        return True
    if DT_RE.search(name or ""):
        return True
    return False


# ---------------------------------------------------------------------------
# 枚举遍：只读 AX，不截图，快且全
# ---------------------------------------------------------------------------
def read_items(lc):
    """从列表控件读取所有可见项（虚拟化列表需配合滚动）。

    返回 (items, filtered_classes)。被采集门过滤的节点类名进账本，绝不静默丢弃。
    """
    out, filtered = [], collections.Counter()
    for k in lc.GetChildren():
        cls = k.ClassName or ""
        name = k.Name or ""
        if not collection_gate(cls, name):
            filtered[cls] += 1
            continue
        # TODO(目标特定): 从不同 App 的 Name 格式解析 body/time。
        # 通用约定: AX Name = 正文 + 日期 + 时间（high 证据）。
        m = DT_RE.search(name)
        dt_key = [int(m.group(i)) for i in range(1, 6)] if m else [0, 0, 0, 0, 0]
        out.append({
            "sig": f"{cls}|{name[:24]}",          # 稳定签名（目标特定可改为 role|norm(name)）
            "className": cls,
            "name": name,
            "body": name,
            "time": m.group(0) if m else "",
            "rect": {"left": 0, "top": 0, "right": 0, "bottom": 0},  # TODO: k.BoundingRectangle
            "dtKey": dt_key,
            "contentType": "text",
            "source": "ax-tree",
            "confidence": "high",
        })
    return out, filtered


def settle(lc, timeout: float = 2.5):
    """等列表停稳：首项签名 + 末项签名 + 长度连续稳定 >= 2 次，再读 rect。

    同步纪律：settle 只在富化遍需要锚定截图时才调用；枚举遍滚完即读 AX。
    """
    prev, stable, cur = None, 0, []
    t0 = time.time()
    while time.time() - t0 < timeout:
        cur = read_items(lc)[0]
        sig = (cur[0]["sig"], cur[-1]["sig"], len(cur)) if cur else None
        stable = stable + 1 if sig == prev else 0
        prev = sig
        if stable >= 2:
            return cur
        time.sleep(0.06)
    return cur


def sweep_enum(win, lc, tag: str):
    """枚举遍：滚完虚拟化列表、只读 AX、不截图。返回去重后的消息列表。"""
    # TODO(目标特定): win.SetActive(); 把光标移到列表中央; 滚到顶
    records = {}
    # for step in range(120):
    #     cur = settle(lc)  # 枚举遍也可轻量轮询，但绝不截图
    #     for it in cur:
    #         records.setdefault(it["sig"], it)
    #     若列表首/末签名连续稳定 -> break
    #     滚轮翻页
    return list(records.values())


# ---------------------------------------------------------------------------
# 富化遍：仅 AX 盲区字段截图，带 degradation
# ---------------------------------------------------------------------------
def enrich_blind_fields(records, win, lc):
    """对 AX 拿不到的字段（如头像）截图补位，confidence=medium，记 degradation。

    同步纪律：settle 等列表停稳 -> 读 rect -> 立即 mss 截帧（方向前缀避免覆盖）。
    """
    degradation = {
        "avatarInAX": False,
        "nameInAX": False,
        "reason": "头像/昵称不在 AX 树暴露，需截图补位（medium）。",
        "filteredClasses": [],
    }
    # TODO(目标特定):
    #   for rec in records:
    #       if rec 需要头像:
    #           settle(lc); rect = rec["rect"]
    #           frame = mss.grab(rect);  # 带方向前缀 W0D042.png
    #           rec["avatar"] = {"source": "screenshot", "confidence": "medium",
    #                            "evidence": {"frame": ..., "method": "som-id|pixel-stats"}}
    return records, degradation


# ---------------------------------------------------------------------------
# 完整性断言
# ---------------------------------------------------------------------------
def assert_integrity(msgs, expected: int | None = None):
    """去重 + 已知总数比对。空/缺 = 执行错误，不是"完成"。"""
    sigs = [m["sig"] for m in msgs]
    dedup = len(sigs) == len(set(sigs))
    count_ok = (expected is None) or (len(msgs) == expected)
    if not (dedup and count_ok):
        raise AssertionError(
            f"完整性断言失败: 去重={dedup} 期望数={expected} 实得={len(msgs)}"
        )


# ---------------------------------------------------------------------------
# 输出 schema
# ---------------------------------------------------------------------------
def build_serialized(target: str, windows: dict, frames: list, degradation: dict) -> dict:
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "target": target,
        "adapter": "ax-native",
        "windows": windows,
        "frames": frames,
        "degradation": degradation,
    }


def demo():
    """无目标窗口时打印 schema 示例，验证结构正确。"""
    sample = [
        {"sig": "ChatTextItemView|候选人A 2026年10月18日 21:39", "className": "ChatTextItemView",
         "name": "候选人A 2026年10月18日 21:39", "body": "候选人A", "time": "2026年10月18日 21:39",
         "rect": {"left": 0, "top": 100, "right": 400, "bottom": 140},
         "dtKey": [2026, 10, 18, 21, 39], "contentType": "text",
         "source": "ax-tree", "confidence": "high"},
    ]
    deg = {"avatarInAX": False, "nameInAX": False,
           "reason": "示例：头像需截图补位", "filteredClasses": []}
    return build_serialized("AcmeHR(示例)", {"W0": {"title": "示例窗口", "rect": {}, "count": 1, "messages": sample}}, [], deg)


def main():
    ap = argparse.ArgumentParser(description="通用 AX 采集轻量骨架")
    ap.add_argument("--demo", action="store_true", help="打印 schema 示例后退出")
    ap.add_argument("--out", default="serialized.json")
    ap.add_argument("--expected", type=int, default=None, help="已知总数，用于完整性断言")
    a = ap.parse_args()
    if a.demo:
        print(json.dumps(demo(), ensure_ascii=False, indent=2))
        return
    # TODO(目标特定): 用 uiautomation 找到目标窗口与列表控件
    #   import uiautomation as auto
    #   win = [w for w in auto.GetRootControl().GetChildren() if w.ClassName == "<目标窗口类>"][0]
    #   lc = find_list(win)
    #   msgs = sweep_enum(win, lc, "W0")
    #   msgs, deg = enrich_blind_fields(msgs, win, lc)
    #   assert_integrity(msgs, a.expected)
    #   out = build_serialized("目标", {"W0": {...}}, frames, deg)
    #   json.dump(out, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    raise SystemExit("目标特定逻辑未实现：请在 TODO 处接入 uiautomation 找窗口/列表。")


if __name__ == "__main__":
    main()
