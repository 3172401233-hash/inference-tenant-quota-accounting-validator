import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager } from '../src/quota-manager.js';
import { runScenario } from '../src/cli.js';

function makeManager(nodeQuota = 1000, tenants = { t1: 600, t2: 600 }) {
  const manager = new QuotaManager(nodeQuota);
  for (const [id, quota] of Object.entries(tenants)) {
    manager.addTenant(id, quota);
  }
  return manager;
}

test('并发预留：按优先级准入，不突破租户与节点配额', () => {
  const manager = makeManager(1000, { t1: 700, t2: 500 });
  const decisions = manager.admitBatch([
    { tenantId: 't1', requestId: 'low', tokens: 500, priority: 1 },
    { tenantId: 't1', requestId: 'high', tokens: 600, priority: 9 },
    { tenantId: 't2', requestId: 'other', tokens: 400, priority: 5 },
  ]);
  const byId = Object.fromEntries(decisions.map((d) => [d.requestId, d]));
  assert.equal(byId.high.admitted, true);
  assert.equal(byId.other.admitted, true);
  assert.equal(byId.low.admitted, false);
  assert.equal(byId.low.reason, 'tenant_quota_exceeded');
  const { node, tenants } = manager.report();
  assert.equal(node.reserved, 1000);
  assert.ok(node.reserved <= node.quota);
  assert.ok(tenants.t1.reserved <= tenants.t1.quota);
});

test('并发预留：多租户共享节点时不突破节点总配额', () => {
  const manager = makeManager(800, { t1: 700, t2: 700 });
  assert.equal(manager.reserve('t1', 'r1', 500).admitted, true);
  assert.equal(manager.reserve('t2', 'r2', 400).admitted, false);
  assert.equal(manager.reserve('t2', 'r3', 300).admitted, true);
  const { node } = manager.report();
  assert.equal(node.reserved, 800);
  assert.equal(node.available, 0);
});

test('取消返还：取消后预留余额恢复，可再次预留', () => {
  const manager = makeManager();
  manager.reserve('t1', 'r1', 400);
  assert.equal(manager.report().tenants.t1.reserved, 400);
  const cancel = manager.cancel('r1');
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.refunded, 400);
  assert.equal(manager.report().tenants.t1.reserved, 0);
  assert.equal(manager.reserve('t1', 'r2', 400).admitted, true);
});

test('取消是幂等的：重复取消只记冲突，不重复返还', () => {
  const manager = makeManager();
  manager.reserve('t1', 'r1', 300);
  manager.cancel('r1');
  const again = manager.cancel('r1');
  assert.equal(again.cancelled, false);
  assert.equal(again.refunded, 0);
  assert.equal(manager.report().tenants.t1.reserved, 0);
  assert.ok(manager.report().conflicts.some((c) => c.type === 'duplicate_cancel'));
});

test('同一请求只能结算一次：重复结算不重复扣费', () => {
  const manager = makeManager();
  manager.reserve('t1', 'r1', 500);
  const first = manager.settle('r1', 120, 300);
  assert.equal(first.settled, true);
  assert.equal(first.billed, 420);
  assert.equal(first.released, 80);
  const second = manager.settle('r1', 120, 300);
  assert.equal(second.settled, false);
  assert.equal(second.reason, 'already_settled');
  const { tenants, conflicts } = manager.report();
  assert.equal(tenants.t1.used, 420);
  assert.equal(tenants.t1.reserved, 0);
  assert.ok(conflicts.some((c) => c.type === 'duplicate_settlement'));
});

test('重复预留是幂等的：同一 requestId 不重复占用配额', () => {
  const manager = makeManager();
  manager.reserve('t1', 'r1', 300);
  const dup = manager.reserve('t1', 'r1', 300);
  assert.equal(dup.admitted, true);
  assert.equal(dup.deduplicated, true);
  assert.equal(manager.report().tenants.t1.reserved, 300);
  assert.ok(manager.report().conflicts.some((c) => c.type === 'duplicate_reservation'));
});

test('重试不重复计费：已结算请求的重试被拒绝', () => {
  const manager = makeManager();
  manager.reserve('t1', 'r1', 300);
  manager.settle('r1', 100, 150);
  const retry = manager.reserve('t1', 'r1', 300);
  assert.equal(retry.admitted, false);
  assert.equal(retry.reason, 'already_settled');
  assert.equal(manager.report().tenants.t1.used, 250);
  assert.ok(manager.report().conflicts.some((c) => c.type === 'retry_after_settle'));
});

test('取消后重试：建立新预留且只结算一次', () => {
  const manager = makeManager();
  manager.reserve('t1', 'r1', 300);
  manager.cancel('r1');
  const retry = manager.reserve('t1', 'r1', 200);
  assert.equal(retry.admitted, true);
  const settled = manager.settle('r1', 90, 100);
  assert.equal(settled.settled, true);
  assert.equal(settled.billed, 190);
  const { tenants } = manager.report();
  assert.equal(tenants.t1.used, 190);
  assert.equal(tenants.t1.reserved, 0);
});

test('已取消请求不能结算，已结算请求不能取消', () => {
  const manager = makeManager();
  manager.reserve('t1', 'r1', 200);
  manager.cancel('r1');
  assert.equal(manager.settle('r1', 10, 10).settled, false);
  manager.reserve('t1', 'r2', 200);
  manager.settle('r2', 50, 50);
  assert.equal(manager.cancel('r2').cancelled, false);
  assert.equal(manager.report().tenants.t1.used, 100);
});

test('场景驱动：端到端输出准入、余额、计费与冲突', () => {
  const result = runScenario({
    nodeQuota: 1000,
    tenants: [{ id: 'a', quota: 600 }, { id: 'b', quota: 600 }],
    steps: [
      { op: 'batch', requests: [
        { tenantId: 'a', requestId: 'a1', tokens: 500, priority: 5 },
        { tenantId: 'b', requestId: 'b1', tokens: 500, priority: 5 },
        { tenantId: 'b', requestId: 'b2', tokens: 200, priority: 1 },
      ] },
      { op: 'settle', requestId: 'a1', inputTokens: 200, outputTokens: 200 },
      { op: 'settle', requestId: 'a1', inputTokens: 200, outputTokens: 200 },
      { op: 'cancel', requestId: 'b1' },
    ],
  });
  const admitted = Object.fromEntries(result.admissions.map((d) => [d.requestId, d.admitted]));
  assert.deepEqual(admitted, { a1: true, b1: true, b2: false });
  assert.equal(result.tenants.a.used, 400);
  assert.equal(result.tenants.b.reserved, 0);
  assert.ok(result.conflicts.some((c) => c.type === 'duplicate_settlement'));
  assert.ok(result.conflicts.some((c) => c.type === 'admission_denied'));
});
