/**
 * 审批模块单测
 *
 * 安全关注点：
 *   - button_data 来自客户端（不可信），解析必须严格、失败即拒绝
 *   - 令牌一次性、按用户隔离、会过期
 *   - 用户标识提取要覆盖单聊/群聊两种场景
 *   - 按钮结构必须符合 QQ 协议（type/permission/click_limit）
 *
 * 用法: bin\node.cmd tests\approval.test.js
 */

import assert from 'node:assert/strict';
import {
  ApprovalManager,
  buildApprovalKeyboard,
  parseButtonData,
  extractInteractionUserId,
  extractButtonData,
  ackText,
  buildApprovalPrompt,
} from '../src/qq/approval.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${e.message.split('\n')[0]}`);
  }
}

console.log('\n=== 键盘构造（QQ 协议合规）===');

test('包含允许与拒绝两个按钮', () => {
  const kb = buildApprovalKeyboard('ABC234');
  const buttons = kb.content.rows[0].buttons;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].id, 'btn-allow');
  assert.equal(buttons[1].id, 'btn-deny');
});

test('按钮动作为回调型且限制点击一次', () => {
  const kb = buildApprovalKeyboard('ABC234');
  for (const b of kb.content.rows[0].buttons) {
    assert.equal(b.action.type, 1, 'type 应为 1（回调）');
    assert.equal(b.action.click_limit, 1, 'click_limit 应为 1，从交互层减少重放');
    assert.equal(typeof b.action.data, 'string');
  }
});

test('render_data 三个字段齐全（label/visited_label/style）', () => {
  const kb = buildApprovalKeyboard('ABC234');
  for (const b of kb.content.rows[0].buttons) {
    assert.equal(typeof b.render_data.label, 'string');
    assert.equal(typeof b.render_data.visited_label, 'string');
    assert.equal(typeof b.render_data.style, 'number');
    assert.ok(b.render_data.label.length > 0);
  }
});

test('按钮数据编码了动作与令牌', () => {
  const kb = buildApprovalKeyboard('abc234');
  const [allow, deny] = kb.content.rows[0].buttons;
  assert.equal(allow.action.data, 'apv:ABC234', '令牌应被规范为大写');
  assert.equal(deny.action.data, 'dny:ABC234');
});

test('令牌为空时不崩溃', () => {
  assert.doesNotThrow(() => buildApprovalKeyboard(''));
  assert.doesNotThrow(() => buildApprovalKeyboard(null));
  assert.doesNotThrow(() => buildApprovalKeyboard(undefined));
});

console.log('\n=== 按钮数据解析（不可信输入）===');

test('合法允许数据', () => {
  assert.deepEqual(parseButtonData('apv:ABC234'), { action: 'approve', token: 'ABC234' });
});

test('合法拒绝数据', () => {
  assert.deepEqual(parseButtonData('dny:XYZ789'), { action: 'deny', token: 'XYZ789' });
});

test('未知动作前缀被拒绝', () => {
  assert.equal(parseButtonData('evil:ABC234'), null);
  assert.equal(parseButtonData('rm:ABC234'), null);
});

test('缺少分隔符被拒绝', () => {
  assert.equal(parseButtonData('apvABC234'), null);
  assert.equal(parseButtonData(':ABC234'), null);
});

test('令牌长度不符被拒绝', () => {
  assert.equal(parseButtonData('apv:ABC23'), null, '5 位应拒绝');
  assert.equal(parseButtonData('apv:ABC2345'), null, '7 位应拒绝');
  assert.equal(parseButtonData('apv:'), null, '空令牌应拒绝');
});

test('含字母表外字符的令牌被拒绝', () => {
  // 字母表刻意排除了易混字符 0 O 1 I，避免用户手输时混淆
  assert.equal(parseButtonData('apv:ABC01I'), null, '含 0/1/I 应拒绝');
  assert.deepEqual(parseButtonData('apv:ABC234'), { action: 'approve', token: 'ABC234' });
});

test('易混字符不能靠大小写归一伪装（真实绕过点）', () => {
  // 若实现先 toUpperCase 再校验，'o'→'O'、'i'→'I' 会让这些值蒙混过关
  for (const bad of ['abc01i', 'ABCO1I', 'oooiii', 'ABCOOO', 'ABC111']) {
    assert.equal(parseButtonData(`apv:${bad}`), null, `应拒绝: ${bad}`);
  }
});

test('小写合法令牌被规范化后接受（手机输入友好）', () => {
  assert.deepEqual(parseButtonData('apv:abc234'), { action: 'approve', token: 'ABC234' });
});

test('首尾空格被容忍', () => {
  assert.deepEqual(parseButtonData('  apv:ABC234  '), { action: 'approve', token: 'ABC234' });
});

test('非字符串输入一律拒绝', () => {
  for (const v of [null, undefined, 123, {}, [], true]) {
    assert.equal(parseButtonData(v), null, `应拒绝: ${JSON.stringify(v)}`);
  }
});

test('注入尝试被拒绝', () => {
  assert.equal(parseButtonData('apv:ABC234; rm -rf /'), null);
  assert.equal(parseButtonData("apv:ABC234' OR '1'='1"), null);
  assert.equal(parseButtonData('apv:../../../etc/passwd'), null);
});

console.log('\n=== 用户标识提取 ===');

test('单聊取 user_openid', () => {
  assert.equal(extractInteractionUserId({ user_openid: 'U1' }), 'U1');
});

test('群聊取 group_member_openid', () => {
  assert.equal(extractInteractionUserId({ group_member_openid: 'M1' }), 'M1');
});

test('回退到 resolved.user_id', () => {
  assert.equal(extractInteractionUserId({ data: { resolved: { user_id: 'R1' } } }), 'R1');
});

test('优先级：user_openid 优先', () => {
  const e = { user_openid: 'U1', group_member_openid: 'M1', data: { resolved: { user_id: 'R1' } } };
  assert.equal(extractInteractionUserId(e), 'U1');
});

test('取不到标识时返回 null（调用方必须拒绝）', () => {
  assert.equal(extractInteractionUserId({}), null);
  assert.equal(extractInteractionUserId(null), null);
  assert.equal(extractInteractionUserId({ user_openid: '   ' }), null);
  assert.equal(extractInteractionUserId({ user_openid: 123 }), null);
});

console.log('\n=== 按钮数据提取 ===');

test('取 resolved.button_data', () => {
  assert.equal(extractButtonData({ data: { resolved: { button_data: 'apv:X' } } }), 'apv:X');
});

test('回退到 button_id', () => {
  assert.equal(extractButtonData({ data: { resolved: { button_id: 'b1' } } }), 'b1');
});

test('无数据返回 null', () => {
  assert.equal(extractButtonData({}), null);
  assert.equal(extractButtonData({ data: {} }), null);
  assert.equal(extractButtonData(null), null);
});

console.log('\n=== ApprovalManager：基本流程 ===');

test('create 返回 6 位令牌且不含易混字符', () => {
  const am = new ApprovalManager();
  const { token, expiresInSec } = am.create('U1', '删除日志');
  assert.match(token, /^[A-Z2-9]{6}$/);
  assert.ok(expiresInSec > 0);
});

test('consume 成功返回原任务', () => {
  const am = new ApprovalManager();
  const { token } = am.create('U1', '删除日志文件');
  const r = am.consume('U1', token);
  assert.equal(r.ok, true);
  assert.equal(r.task, '删除日志文件');
});

test('令牌一次性（防重放）', () => {
  const am = new ApprovalManager();
  const { token } = am.create('U1', 'X');
  assert.equal(am.consume('U1', token).ok, true);
  assert.equal(am.consume('U1', token).ok, false, '同一令牌不应能用两次');
});

console.log('\n=== ApprovalManager：安全语义 ===');

test('跨用户确认被拒绝', () => {
  const am = new ApprovalManager();
  const { token } = am.create('U1', 'X');
  assert.equal(am.consume('U2', token).ok, false);
  assert.equal(am.consume('U1', token).ok, true, '原主人仍可用（未被误消费）');
});

test('跨用户失败不泄露令牌存在性', () => {
  const am = new ApprovalManager();
  const { token } = am.create('U1', 'X');
  const cross = am.consume('U2', token);
  const bogus = am.consume('U2', 'ZZZZZZ');
  assert.equal(cross.reason, bogus.reason);
});

test('过期令牌失效', () => {
  let t = 1000;
  const am = new ApprovalManager({ ttlMs: 100, now: () => t });
  const { token } = am.create('U1', 'X');
  t += 200;
  assert.equal(am.consume('U1', token).ok, false);
});

test('未过期令牌可用（边界）', () => {
  let t = 1000;
  const am = new ApprovalManager({ ttlMs: 100, now: () => t });
  const { token } = am.create('U1', 'X');
  t += 99;
  assert.equal(am.consume('U1', token).ok, true);
});

test('每用户待确认有上限', () => {
  const am = new ApprovalManager({ maxPerUser: 3 });
  for (let i = 0; i < 10; i++) am.create('U1', `t${i}`);
  assert.ok(am.size() <= 3, `应限制在 3 以内，实得 ${am.size()}`);
});

test('上限按用户独立计算', () => {
  const am = new ApprovalManager({ maxPerUser: 2 });
  for (let i = 0; i < 5; i++) am.create('U1', `t${i}`);
  am.create('U2', 'other');
  assert.equal(am.countFor('U2'), 1, 'U2 不应被 U1 的数量挤掉');
});

test('令牌大小写不敏感、忽略空格', () => {
  const am = new ApprovalManager();
  const { token } = am.create('U1', 'X');
  assert.equal(am.consume('U1', `  ${token.toLowerCase()}  `).ok, true);
});

test('未知令牌返回失败', () => {
  const am = new ApprovalManager();
  assert.equal(am.consume('U1', 'AAAAAA').ok, false);
  assert.equal(am.consume('U1', '').ok, false);
  assert.equal(am.consume('U1', null).ok, false);
});

test('countFor / listFor 按用户隔离', () => {
  const am = new ApprovalManager();
  am.create('U1', 'A');
  am.create('U2', 'B');
  assert.equal(am.countFor('U1'), 1);
  assert.equal(am.countFor('U2'), 1);
  assert.equal(am.listFor('U1')[0].task, 'A');
});

test('生成的令牌唯一', () => {
  const am = new ApprovalManager({ maxPerUser: 1000 });
  const seen = new Set();
  for (let i = 0; i < 300; i++) seen.add(am.create('U1', `t${i}`).token);
  assert.equal(seen.size, 300);
});

console.log('\n=== 文案 ===');

test('ackText 返回对应文案', () => {
  assert.match(ackText('approve'), /允许/);
  assert.match(ackText('deny'), /拒绝/);
  assert.ok(ackText('bogus').length > 0, '未知动作也要有兜底文案');
});

test('审批提示包含令牌、指令与有效期', () => {
  const p = buildApprovalPrompt('删除所有日志', 'ABC234', ['命中删除动词'], 300);
  assert.match(p, /ABC234/);
  assert.match(p, /删除所有日志/);
  assert.match(p, /确认/);
  assert.match(p, /5 分钟/);
});

test('提示中的超长指令被截断', () => {
  const p = buildApprovalPrompt('x'.repeat(500), 'ABC234');
  assert.ok(p.length < 700, `提示不应过长，实得 ${p.length}`);
  assert.match(p, /…/);
});

test('无理由时提示仍完整', () => {
  const p = buildApprovalPrompt('任务', 'ABC234', []);
  assert.match(p, /ABC234/);
  assert.ok(!p.includes('undefined'));
});

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(50) + '\n');

process.exit(failed === 0 ? 0 : 1);
