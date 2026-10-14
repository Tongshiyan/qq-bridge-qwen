/**
 * 速率限制（滑动窗口）
 *
 * 目的：防误触刷屏、防滥用、防单条指令失控导致排队堆积。
 *
 * 用内存中的时间戳队列实现，无需外部依赖。
 * 单进程部署下足够；若将来多实例，需要换成 Redis 等共享存储。
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;

export class RateLimiter {
  /**
   * @param {{perUserPerMinute: number, perUserPerHour: number, globalPerMinute: number}} limits
   */
  constructor(limits) {
    this.limits = limits;
    /** @type {Map<string, number[]>} userId -> 时间戳数组 */
    this.userHits = new Map();
    /** @type {number[]} 全局时间戳数组 */
    this.globalHits = [];
  }

  /** 清掉窗口外的旧记录。 */
  #prune(now, window, arr) {
    // 数组按时间递增，找到第一个仍在窗口内的位置
    let i = 0;
    while (i < arr.length && now - arr[i] > window) i++;
    if (i > 0) arr.splice(0, i);
    return arr;
  }

  /**
   * 检查并消费一次配额。
   * @param {string} userId
   * @returns {{allowed: boolean, reason?: string, retryAfterSec?: number, scope?: string}}
   */
  check(userId) {
    const now = Date.now();
    const key = String(userId);

    let hits = this.userHits.get(key) ?? [];
    hits = this.#prune(now, HOUR, hits);
    this.globalHits = this.#prune(now, MINUTE, this.globalHits);

    // 1) 全局每分钟
    if (this.globalHits.length >= this.limits.globalPerMinute) {
      const oldest = this.globalHits[0];
      return {
        allowed: false,
        scope: 'global',
        reason: `全局每分钟上限 ${this.limits.globalPerMinute} 次已达`,
        retryAfterSec: Math.max(1, Math.ceil((MINUTE - (now - oldest)) / 1000)),
      };
    }

    // 2) 单用户每分钟
    const inMinute = hits.filter((t) => now - t <= MINUTE);
    if (inMinute.length >= this.limits.perUserPerMinute) {
      const oldest = inMinute[0];
      return {
        allowed: false,
        scope: 'user-minute',
        reason: `每分钟上限 ${this.limits.perUserPerMinute} 次已达`,
        retryAfterSec: Math.max(1, Math.ceil((MINUTE - (now - oldest)) / 1000)),
      };
    }

    // 3) 单用户每小时
    if (hits.length >= this.limits.perUserPerHour) {
      const oldest = hits[0];
      return {
        allowed: false,
        scope: 'user-hour',
        reason: `每小时上限 ${this.limits.perUserPerHour} 次已达`,
        retryAfterSec: Math.max(1, Math.ceil((HOUR - (now - oldest)) / 1000)),
      };
    }

    // 通过：记账
    hits.push(now);
    this.userHits.set(key, hits);
    this.globalHits.push(now);

    return { allowed: true };
  }

  /** 查询某用户当前用量，不消费配额。 */
  usage(userId) {
    const now = Date.now();
    const hits = this.#prune(now, HOUR, this.userHits.get(String(userId)) ?? []);
    return {
      lastMinute: hits.filter((t) => now - t <= MINUTE).length,
      lastHour: hits.length,
      limits: this.limits,
    };
  }

  /** 释放某用户的全部记录（比如管理员手动解封）。 */
  reset(userId) {
    if (userId === undefined) {
      this.userHits.clear();
      this.globalHits = [];
      return;
    }
    this.userHits.delete(String(userId));
  }
}
