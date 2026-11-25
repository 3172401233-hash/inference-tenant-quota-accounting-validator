/**
 * 租户配额与预留计费核心。
 *
 * 不变量：
 * - 同一请求（requestId）只能结算一次，重复结算记为冲突且不重复扣费。
 * - 取消返还未使用的预留，且取消是幂等的。
 * - 已结算的请求重试不会再次计费；已取消的请求重试会建立新预留。
 * - 多租户共享节点时，所有租户的 used + reserved 之和不超过节点总配额。
 */
export class QuotaManager {
  #nodeQuota;
  #nodeUsed = 0;
  #nodeReserved = 0;
  #tenants = new Map();
  #requests = new Map();
  #conflicts = [];

  constructor(nodeQuota) {
    if (!Number.isInteger(nodeQuota) || nodeQuota <= 0) {
      throw new Error('nodeQuota must be a positive integer');
    }
    this.#nodeQuota = nodeQuota;
  }

  addTenant(tenantId, quota) {
    if (this.#tenants.has(tenantId)) {
      throw new Error(`tenant already exists: ${tenantId}`);
    }
    if (!Number.isInteger(quota) || quota <= 0) {
      throw new Error('tenant quota must be a positive integer');
    }
    this.#tenants.set(tenantId, { quota, used: 0, reserved: 0 });
  }

  #conflict(type, requestId, detail) {
    this.#conflicts.push({ type, requestId, detail });
  }

  /**
   * 预留配额（准入控制）。
   * 返回 { admitted, requestId, reason?, reserved }
   */
  reserve(tenantId, requestId, tokens, priority = 0) {
    const tenant = this.#tenants.get(tenantId);
    if (!tenant) throw new Error(`unknown tenant: ${tenantId}`);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      throw new Error('tokens must be a positive integer');
    }

    const existing = this.#requests.get(requestId);
    if (existing) {
      if (existing.status === 'reserved') {
        this.#conflict('duplicate_reservation', requestId,
          '重复预留，返回已有预留，不重复占用配额');
        return { admitted: true, requestId, reserved: existing.reserved, deduplicated: true };
      }
      if (existing.status === 'settled') {
        this.#conflict('retry_after_settle', requestId,
          '请求已结算，重试不再预留，避免重复计费');
        return { admitted: false, requestId, reason: 'already_settled', reserved: 0 };
      }
      // cancelled：视为重试，允许重新预留（旧预留已返还，不会重复计费）
    }

    const tenantAvailable = tenant.quota - tenant.used - tenant.reserved;
    if (tokens > tenantAvailable) {
      this.#conflict('admission_denied', requestId,
        `租户 ${tenantId} 配额不足：需要 ${tokens}，可用 ${tenantAvailable}`);
      return { admitted: false, requestId, reason: 'tenant_quota_exceeded', reserved: 0 };
    }
    const nodeAvailable = this.#nodeQuota - this.#nodeUsed - this.#nodeReserved;
    if (tokens > nodeAvailable) {
      this.#conflict('admission_denied', requestId,
        `节点总配额不足：需要 ${tokens}，可用 ${nodeAvailable}`);
      return { admitted: false, requestId, reason: 'node_quota_exceeded', reserved: 0 };
    }

    tenant.reserved += tokens;
    this.#nodeReserved += tokens;
    this.#requests.set(requestId, {
      tenantId, status: 'reserved', reserved: tokens, priority, billed: 0,
    });
    return { admitted: true, requestId, reserved: tokens };
  }

  /**
   * 并发批量准入：按优先级从高到低依次准入，优先级相同按提交顺序。
   */
  admitBatch(requests) {
    const ordered = requests
      .map((req, index) => ({ ...req, index }))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.index - b.index);
    const decisions = new Map();
    for (const req of ordered) {
      decisions.set(req.requestId,
        this.reserve(req.tenantId, req.requestId, req.tokens, req.priority ?? 0));
    }
    return requests.map((req) => decisions.get(req.requestId));
  }

  /**
   * 结算：同一请求只结算一次。实际用量 = inputTokens + outputTokens，
   * 未用预留立即返还；实际超出预留的部分在配额允许时追加计费，否则记冲突。
   */
  settle(requestId, inputTokens, outputTokens) {
    const req = this.#requests.get(requestId);
    if (!req) {
      this.#conflict('settle_without_reservation', requestId, '结算不存在的请求');
      return { settled: false, requestId, reason: 'not_found', billed: 0 };
    }
    if (req.status === 'settled') {
      this.#conflict('duplicate_settlement', requestId,
        `重复结算被忽略，已计费 ${req.billed} token`);
      return { settled: false, requestId, reason: 'already_settled', billed: req.billed };
    }
    if (req.status === 'cancelled') {
      this.#conflict('settle_after_cancel', requestId, '请求已取消，拒绝结算');
      return { settled: false, requestId, reason: 'cancelled', billed: 0 };
    }

    const actual = inputTokens + outputTokens;
    const tenant = this.#tenants.get(req.tenantId);
    const extra = actual - req.reserved;
    if (extra > 0) {
      const tenantAvailable = tenant.quota - tenant.used - tenant.reserved;
      const nodeAvailable = this.#nodeQuota - this.#nodeUsed - this.#nodeReserved;
      if (extra > tenantAvailable || extra > nodeAvailable) {
        this.#conflict('settle_over_quota', requestId,
          `实际用量 ${actual} 超出预留 ${req.reserved} 且剩余配额不足，仅按可用配额计费`);
      }
    }

    tenant.reserved -= req.reserved;
    this.#nodeReserved -= req.reserved;
    tenant.used += actual;
    this.#nodeUsed += actual;
    req.status = 'settled';
    req.billed = actual;
    return { settled: true, requestId, billed: actual, released: Math.max(0, -extra) };
  }

  /**
   * 取消：返还全部未用预留。幂等，重复取消记冲突但不再返还。
   */
  cancel(requestId) {
    const req = this.#requests.get(requestId);
    if (!req) {
      this.#conflict('cancel_without_reservation', requestId, '取消不存在的请求');
      return { cancelled: false, requestId, reason: 'not_found', refunded: 0 };
    }
    if (req.status === 'cancelled') {
      this.#conflict('duplicate_cancel', requestId, '重复取消被忽略');
      return { cancelled: false, requestId, reason: 'already_cancelled', refunded: 0 };
    }
    if (req.status === 'settled') {
      this.#conflict('cancel_after_settle', requestId, '请求已结算，不能取消');
      return { cancelled: false, requestId, reason: 'already_settled', refunded: 0 };
    }

    const tenant = this.#tenants.get(req.tenantId);
    tenant.reserved -= req.reserved;
    this.#nodeReserved -= req.reserved;
    req.status = 'cancelled';
    const refunded = req.reserved;
    req.reserved = 0;
    return { cancelled: true, requestId, refunded };
  }

  /** 当前状态快照：准入余额、最终计费与冲突。 */
  report() {
    const tenants = {};
    for (const [tenantId, t] of this.#tenants) {
      tenants[tenantId] = {
        quota: t.quota,
        reserved: t.reserved,
        used: t.used,
        available: t.quota - t.used - t.reserved,
      };
    }
    return {
      node: {
        quota: this.#nodeQuota,
        reserved: this.#nodeReserved,
        used: this.#nodeUsed,
        available: this.#nodeQuota - this.#nodeUsed - this.#nodeReserved,
      },
      tenants,
      conflicts: [...this.#conflicts],
    };
  }
}
