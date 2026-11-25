#!/usr/bin/env node
/**
 * 场景驱动的配额校验 CLI（纯本地模拟，不调用真实推理服务）。
 *
 * 用法: node src/cli.js <scenario.json>
 *
 * 场景格式：
 * {
 *   "nodeQuota": 100000,
 *   "tenants": [{ "id": "t1", "quota": 60000 }],
 *   "steps": [
 *     { "op": "reserve", "tenantId": "t1", "requestId": "r1", "tokens": 500, "priority": 1 },
 *     { "op": "batch", "requests": [ { "tenantId": "t1", "requestId": "r2", "tokens": 300, "priority": 5 } ] },
 *     { "op": "settle", "requestId": "r1", "inputTokens": 120, "outputTokens": 300 },
 *     { "op": "cancel", "requestId": "r2" }
 *   ]
 * }
 */
import { readFile } from 'node:fs/promises';
import { QuotaManager } from './quota-manager.js';

export function runScenario(scenario) {
  const manager = new QuotaManager(scenario.nodeQuota);
  for (const tenant of scenario.tenants) {
    manager.addTenant(tenant.id, tenant.quota);
  }

  const admissions = [];
  const settlements = [];
  const cancellations = [];

  for (const step of scenario.steps ?? []) {
    switch (step.op) {
      case 'reserve':
        admissions.push(manager.reserve(step.tenantId, step.requestId, step.tokens, step.priority ?? 0));
        break;
      case 'batch':
        admissions.push(...manager.admitBatch(step.requests));
        break;
      case 'settle':
        settlements.push(manager.settle(step.requestId, step.inputTokens, step.outputTokens));
        break;
      case 'cancel':
        cancellations.push(manager.cancel(step.requestId));
        break;
      default:
        throw new Error(`unknown op: ${step.op}`);
    }
  }

  return { admissions, settlements, cancellations, ...manager.report() };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    console.error('用法: node src/cli.js <scenario.json>');
    process.exit(1);
  }
  const scenario = JSON.parse(await readFile(path, 'utf8'));
  console.log(JSON.stringify(runScenario(scenario), null, 2));
}
