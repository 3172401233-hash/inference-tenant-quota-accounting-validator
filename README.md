# inference-tenant-quota-accounting-validator

验证推理租户配额、预留和并发计费。

> **说明：本项目是纯本地的配额记账校验器，不调用任何真实推理服务。**
> 输入/输出 token 数由场景文件直接给出，用于验证准入、预留、结算与取消的记账正确性。

## 环境

- Node.js >= 24.16.0（已在 24.16.0 上验证）

## 功能

- **准入控制**：请求先按预估 token 预留配额；租户配额或节点总配额不足时拒绝，短请求不会被长请求的无界占用阻塞（预留即入账）。
- **并发与优先级**：`admitBatch` 模拟并发预留，按优先级从高到低准入，优先级相同按提交顺序。
- **结算一次**：同一 `requestId` 只能结算一次，实际用量 = 输入 + 输出 token，未用预留立即返还；重复结算记为冲突且不重复扣费。
- **取消返还**：取消返还全部未用预留，幂等；已取消请求不能结算，已结算请求不能取消。
- **重试不重复计费**：已结算请求的重试直接拒绝；已取消请求的重试建立新预留（旧预留已返还），仍只结算一次。
- **共享节点配额**：多租户共享节点时，所有租户 `used + reserved` 之和不超过节点总配额。

## 使用

```bash
node src/cli.js examples/scenario.json
```

场景文件定义节点总配额、租户配额和操作序列（`reserve` / `batch` / `settle` / `cancel`），
输出 JSON 包含四部分：

- `admissions`：每个请求的准入决策（`admitted` / `reason`）
- `tenants` / `node`：各租户与节点的预留余额、已计费用量和可用量
- `settlements` / `cancellations`：每次结算与取消的结果
- `conflicts`：重复结算、重复取消、配额不足等冲突事件

## 测试

```bash
node --test
```

覆盖：并发预留（优先级准入、节点总配额上限）、取消返还（含幂等）、
重复结算去重、重复预留去重、重试不重复计费，以及端到端场景。

## 结构

- `src/quota-manager.js`：配额/预留/结算核心（`QuotaManager`）
- `src/cli.js`：场景驱动 CLI 与 `runScenario`
- `test/quota-manager.test.js`：`node:test` 测试
- `examples/scenario.json`：示例场景
