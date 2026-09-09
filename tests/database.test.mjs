import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const owner = '00000000-0000-0000-0000-000000000001';
const member = '00000000-0000-0000-0000-000000000002';
const db = new PGlite();
await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
// gen_random_uuid is a core PostgreSQL function; PGlite does not ship pgcrypto.
await db.exec((await fs.readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
await db.exec(await fs.readFile(new URL('../supabase/migrations/20260909000000_production_integrity.sql', import.meta.url), 'utf8'));
await db.exec(`INSERT INTO groups(id,name) VALUES ('qa','QA'); INSERT INTO group_members(group_id,user_id,name) VALUES ('qa','${owner}','Owner'),('qa','${member}','Member');`);

async function event(id, count=3) {
  await db.query("INSERT INTO market_events(id,group_id,title,closes_at,created_by_user_id) VALUES ($1,'qa','QA',now()+interval '1 day',$2)", [id,owner]);
  for(let i=0;i<count;i++) await db.query('INSERT INTO market_outcomes(id,event_id,title,sort_order,quantity,price) VALUES ($1,$2,$3,$4,20000*ln(1.0/$5),1.0/$5)', [`${id}-${i}`,id,`Outcome ${i}`,i,count]);
}
async function balance(user=owner) {return Number((await db.query('SELECT balance FROM group_members WHERE user_id=$1',[user])).rows[0].balance);}
async function basket(id, action='buy', amount=500, user=owner) {
  return (await db.query('SELECT place_complement_event_trade_for_user($1,$2,$3,$4,$5) AS result',[id,`${id}-0`,action,amount,user])).rows[0].result;
}
async function snapshot(id) {
  return (await db.query(`SELECT jsonb_build_object(
    'event',(SELECT to_jsonb(e) FROM market_events e WHERE id=$1),
    'members',(SELECT jsonb_agg(m ORDER BY name) FROM group_members m),
    'outcomes',(SELECT jsonb_agg(o ORDER BY id) FROM market_outcomes o WHERE event_id=$1),
    'positions',(SELECT jsonb_agg(p ORDER BY id) FROM event_positions p WHERE event_id=$1),
    'trades',(SELECT jsonb_agg(t ORDER BY id) FROM event_trades t WHERE event_id=$1)) AS state`,[id])).rows[0].state;
}

test('NO basket updates balance once and holds equal shares of each alternative', async () => {
  await event('basket');
  const before=await balance();
  const result=await basket('basket');
  assert.equal(await balance(), before-500);
  assert.equal(result.trades.length,2);
  assert.equal(result.trades.reduce((sum,t)=>sum+Number(t.cash_amount),0),500);
  const positions=(await db.query("SELECT outcome_id,shares,user_id FROM event_positions WHERE event_id='basket' ORDER BY outcome_id")).rows;
  assert.equal(positions.length,2);
  assert.equal(positions[0].shares,positions[1].shares);
  assert(positions.every(p=>p.user_id===owner && p.outcome_id!=='basket-0'));
  const total=Number((await db.query("SELECT sum(price) AS total FROM market_outcomes WHERE event_id='basket'")).rows[0].total);
  assert(Math.abs(total-1)<1e-7);
});
test('NO basket selling credits cash and burns equal shares', async () => {
  const before=await balance();
  const result=await basket('basket','sell',50);
  assert.equal(await balance(),before+50);
  assert(result.trades.every(t=>Number(t.shares_delta)<0));
});
test('failed trade history insertion rolls back prices, positions and cash', async () => {
  const before=await snapshot('basket');
  await db.exec("CREATE FUNCTION qa_fail_trade() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected history failure'; END $$; CREATE TRIGGER qa_fail BEFORE INSERT ON event_trades FOR EACH ROW EXECUTE FUNCTION qa_fail_trade();");
  await assert.rejects(basket('basket'),/Injected history failure/);
  await db.exec('DROP TRIGGER qa_fail ON event_trades; DROP FUNCTION qa_fail_trade();');
  assert.deepEqual(await snapshot('basket'),before);
});
test('overselling and nonmember trades leave all persisted state unchanged', async () => {
  const before=await snapshot('basket');
  await assert.rejects(basket('basket','sell',9999),/Not enough/);
  await assert.rejects(basket('basket','buy',5,'00000000-0000-0000-0000-000000000099'),/Join this group/);
  await assert.rejects(basket('basket','buy',.001),/trade amount|whole cents/);
  assert.deepEqual(await snapshot('basket'),before);
});
test('closed and eliminated outcomes cannot accept NO trades', async () => {
  await event('closed');
  await db.exec("UPDATE market_events SET closes_at=now()-interval '1 minute' WHERE id='closed'");
  await assert.rejects(basket('closed'),/closed/);
  await event('eliminated');
  await db.exec("UPDATE market_outcomes SET status='eliminated' WHERE id='eliminated-0'");
  await assert.rejects(basket('eliminated'),/eliminated/);
});
test('binary YES and NO settlement pays winning shares once', async () => {
  for(const winner of [0,1]) {
    const id=`binary${winner}`;
    await event(id,2);
    const outcome=`${id}-${winner}`;
    await db.query("SELECT place_event_trade_for_user($1,$2,'Owner','buy',100,$3)",[id,outcome,owner]);
    const before=await balance();
    const result=(await db.query("SELECT resolve_event_market($1,$2,'Owner') AS result",[id,outcome])).rows[0].result;
    assert(Math.abs(await balance()-before-Number(result.payouts[0].payout))<.011);
    const settled=await snapshot(id);
    await assert.rejects(db.query("SELECT resolve_event_market($1,$2,'Owner')",[id,outcome]),/Already resolved/);
    assert.deepEqual(await snapshot(id),settled);
  }
});
test('NO basket pays once if one of the other outcomes wins', async () => {
  const before=await balance();
  const result=(await db.query("SELECT resolve_event_market('basket','basket-2','Owner') AS result")).rows[0].result;
  assert.equal(result.payouts.length,1);
  assert(Math.abs(await balance()-before-Number(result.payouts[0].payout))<.011);
});
test('anonymous and authenticated browser roles cannot read tables or execute trades', async () => {
  for(const role of ['anon','authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(db.query('SELECT * FROM season_predictions'),/permission denied/);
      await assert.rejects(db.query('SELECT * FROM group_invites'),/permission denied/);
      await assert.rejects(db.query("SELECT resolve_event_market('basket','basket-2','forged')"),/permission denied/);
      await assert.rejects(basket('basket'),/permission denied/);
    } finally {await db.exec('RESET ROLE');}
  }
});
test('readiness detects reopened browser permissions', async () => {
  assert.equal((await db.query('SELECT probable_production_readiness() AS result')).rows[0].result.ready,true);
  await db.exec('GRANT SELECT ON season_predictions TO anon');
  await assert.rejects(db.query('SELECT probable_production_readiness()'),/locked down/);
  await db.exec('REVOKE SELECT ON season_predictions FROM anon');
});
test.after(async () => {await db.close();});
