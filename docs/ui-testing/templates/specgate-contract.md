# spec gate 契约模板 — 通用 UI 测试

> **用法**：复制本模板到 `acceptance/ui-testing/<scenario>.yaml`（或 `.md`）。会被 `.github/workflows/specgate-gate.yml` 门禁读取。
> **原则**：把"对"定义成可验证断言；**空结果 = 执行错误，不是"无差异"**；每个字段带证据等级；N 次内不满足就 fail-loudly。

---

## contract: <契约名>
```yaml
scenario: <场景描述>
target: <目标 UI / 应用 / 窗口标题>
adapter: <ax-native | cdp | ...>     # 对应 verify-suite 驱动层适配器

given:
  ui_state: <前置 UI 状态>
  known_facts:                        # 用于完整性断言的已知事实
    expected_count: <N | null>        # 已知总数；null 表示需从首尾时间跨度推断
    time_span: ["<起始>", "<结束>"]    # 已知时间跨度

when:
  mode: <observe | drive | multi-step>
  steps:
    - <步骤1：如"枚举遍滚完列表、只读 AX">
    - <步骤2：如"富化遍仅对头像字段截图">

then:                                # 可机器校验的断言
  fields_present: [<字段列表，必须存在且非空>]
  integrity:
    count_equals: <N>               # 去重计数 == 已知总数
    dedup: true                     # 按稳定签名去重
    time_span_in: ["<起始>", "<结束>"]
  evidence:
    per_field_source:               # 每个字段来源
      <字段>: ax-tree               # 或 screenshot
    confidence:
      ax-tree: high
      screenshot: medium
  fail_loud:
    retry_limit: 3                  # N 次内不满足即显式失败
    on_timeout: raise               # 不静默当成功

degradation:                         # 降级账本（必填，禁止留空掩饰）
  ax_missing_fields: [<AX 拿不到的字段，如 avatar>]
  fallback: screenshot              # 走截图补位，confidence=medium
  filtered_classes: [<被采集门过滤掉的节点类名，进账本>]
  notes: <任何未覆盖 / 不确定项，标 uncertain>
```

> **完整性断言是契约的灵魂**：没有 `expected_count` / `time_span` 校验的契约，等于允许"首图没滚到底"这类静默截断通过门禁。务必填。
