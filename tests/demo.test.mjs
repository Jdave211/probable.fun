import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDemoGroup, simulateDemoApi } from '../src/demo.js';

test('practice selling reduces holdings and credits the quoted receipt amount', () => {
  const group = buildDemoGroup('QA');
  const trade = body => simulateDemoApi('/api/markets/demo-yes/trade', { body: JSON.stringify({ participant: 'QA', outcomeId: 'demo-yes', side: 'yes', ...body }) }, group, [group]);
  trade({ action: 'buy', amount: 10 });
  const market = group.markets.find(m => m.id === 'demo-yes');
  const held = market.positions.QA['demo-yes'];
  const balance = group.balances.QA;
  const { trade: receipt } = trade({ action: 'sell', shares: 1, amount: 0.6 });
  assert.equal(market.positions.QA['demo-yes'], held - 1);
  assert.ok(group.balances.QA > balance);
  assert.equal(receipt.cashAmount, group.balances.QA - balance);
  assert.equal(receipt.shares, -1);
});

test('practice overselling is rejected without changing any state', () => {
  const group = buildDemoGroup('QA');
  const before = JSON.stringify(group);
  assert.throws(() => simulateDemoApi('/api/markets/demo-yes/trade', { body: JSON.stringify({ participant: 'QA', outcomeId: 'demo-yes', action: 'sell', shares: 1, amount: 1 }) }, group, [group]), /shares you own/);
  assert.equal(JSON.stringify(group), before);
});
