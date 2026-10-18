# 序列化 Schema 模板

> **产物**：`<task>_serialized.json`（如 `chat_serialized.json`）
> **原则**：AX 树为主 + 截图补位；枚举 / 富化分离；超集采集门；无静默降级；每个字段带来源与置信度。

---

## 顶层结构

```json
{
  "generatedAt": "2026-10-18T23:00:00",
  "target": "<应用 / 窗口标识>",
  "adapter": "ax-native",
  "windows": {
    "W0": {
      "title": "<窗口标题>",
      "rect": { "left": 0, "top": 0, "right": 800, "bottom": 600 },
      "count": 95,
      "messages": [ "<message 项，见下>" ]
    }
  },
  "frames": [
    { "file": "W0D000.png", "tag": "W0", "direction": "down", "sig": "<稳定签名>" }
  ],
  "degradation": {
    "avatarInAX": false,
    "nameInAX": false,
    "reason": "<说明哪些字段 AX 不暴露、为何走截图补位>",
    "filteredClasses": [ "<被采集门过滤掉的节点类名，进账本>" ]
  }
}
```

## message 项（枚举遍，来源 AX，confidence=high）

```json
{
  "sig": "<稳定签名: role|norm(name)|index>",
  "className": "ChatTextItemView",
  "name": "<AX Name = 正文 + 日期 + 时间>",
  "body": "<正文>",
  "time": "<右侧时间>",
  "rect": { "left": 0, "top": 100, "right": 400, "bottom": 140 },
  "dtKey": [2026, 10, 18, 21, 39],
  "contentType": "text",
  "source": "ax-tree",
  "confidence": "high"
}
```

## 富化项（截图补位，confidence=medium）

```json
{
  "sig": "<与枚举遍同签名，用于关联>",
  "field": "avatar",
  "source": "screenshot",
  "confidence": "medium",
  "evidence": {
    "frame": "W0D042.png",
    "anchor": { "x": 24, "y": 105, "w": 36, "h": 36 },
    "method": "som-id | pixel-stats",
    "raw": "<SoM 编号 / 像素统计值>"
  }
}
```

## 采集门（超集，禁止白名单静默丢行）

```
收录条件: className ∈ MSG_CLASSES  OR  name 匹配日期时间正则
丢弃动作: 进 degradation.filteredClasses 账本（绝不静默丢弃）
```

## 同步纪律

- **枚举遍**：滚完虚拟化列表 → 立即读 AX → 不截图、不等 `settle`。
- **富化遍**：仅 AX 盲区字段才 `settle`（等列表停稳）+ 截图锚定；帧文件名带方向前缀（`D`/`U`）避免覆盖。
- 滚动 / 缩放 / 布局变化后，**不复用旧 rect**，重新观测。
