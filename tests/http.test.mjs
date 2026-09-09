import test from 'node:test';
import assert from 'node:assert/strict';
import {readApiResponse} from '../src/http.js';

test('structured field errors produce useful messages', async () => {
  const response = new Response(JSON.stringify({detail: [{loc: ['body','amount'], msg: 'Must be positive'}]}), {status:422});
  await assert.rejects(readApiResponse(response), /amount: Must be positive/);
});
test('server diagnostics stay out of the UI', async () => {
  const response = new Response(JSON.stringify({detail:'database credential-secret'}), {status:503});
  await assert.rejects(readApiResponse(response), e => e.status === 503 && !e.message.includes('credential-secret') && e.message.includes('try again'));
});
test('expired sessions give a sign-in recovery action', async () => {
  await assert.rejects(readApiResponse(new Response('', {status:401})), /Sign in again/);
});
test('HTML proxy errors do not appear as JSON parse errors', async () => {
  await assert.rejects(readApiResponse(new Response('<html>Bad gateway</html>', {status:502})), /try again/);
});
test('successful invalid JSON gives a recoverable error', async () => {
  await assert.rejects(readApiResponse(new Response('<html>SPA fallback</html>')), /unexpected response/);
});
test('successful payload is unchanged', async () => {
  assert.deepEqual(await readApiResponse(Response.json({groups:[]})), {groups:[]});
});
