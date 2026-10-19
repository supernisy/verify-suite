## 1. 脚手架与依赖

- [ ] 1.1 在 `adapters/web-cdp/` 增加 `package.json`，声明 `playwright` 依赖与安装脚本
- [ ] 1.2 编写安装说明（含浏览器二进制下载），并更新 `adapters/web-cdp/README.md` 标注「引擎已换 Playwright」
- [ ] 1.3 在 `skills/ui-testing-workflow/SKILL.md` Step 0 前置确认增加：引导用户确认 / 安装 Playwright + 浏览器二进制

## 2. 驱动层实现

- [ ] 2.1 新增 `adapters/web-cdp/playwright-driver.mjs`，封装 `locate`（语义定位 + strict）、`drive`（auto-wait 交互）、`assert`（web-first 可重试）、`trace`（产出轨迹）
- [ ] 2.2 将 `scripts/ax-collect.mjs` 的等待 / 点击 / 输入 / 断言从裸 CDP 迁移到 `playwright-driver.mjs`，保留 AX 取树逻辑与指纹主键 `role|norm(name)`
- [ ] 2.3 同步更新骨架 `adapters/web-cdp/ax-collect.py`，增加 Playwright 变体（或重写）

## 3. 入口覆盖验证

- [ ] 3.1 入口 A：用既有 `acceptance/ui-testing/contract.yaml` 跑通，验证每条 given/when/then 证据等级不变
- [ ] 3.2 入口 B：用一份直接给的轻量用例跑通，验证共用同一引擎、执行纪律一致

## 4. 验收与归档

- [ ] 4.1 `openspec validate playwright-web-driver` 通过
- [ ] 4.2 补充 `acceptance/playwright-web-driver/contract.yaml`（SpecGate 第二步），门禁复用 `specgate-gate.yml`
- [ ] 4.3 实现完成后 `openspec archive playwright-web-driver` 将 spec 并入主 specs
