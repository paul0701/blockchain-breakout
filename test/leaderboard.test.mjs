import assert from 'node:assert/strict';
import { handle } from '../netlify/lib/core.mjs';

function fakeStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v, opts = {}) {
      if (opts.onlyIfNew && m.has(k)) return { modified: false };
      m.set(k, JSON.stringify(v));
      return { modified: true };
    },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    _m: m,
  };
}

let clock = 1_800_000_000_000;
const outbox = [];
const d = { players: fakeStore(), scores: fakeStore(), secret: 'test-secret', now: () => clock, sendEmail: async (m) => { outbox.push(m); } };
const lastCode = () => outbox[outbox.length - 1].text.match(/is (\d{6})/)[1];

const post = async (body) => {
  const res = await handle(new Request('https://x.test/api/leaderboard', { method: 'POST', body: JSON.stringify(body) }), d);
  return { status: res.status, data: await res.json() };
};
const get = async (q = '') => {
  const res = await handle(new Request('https://x.test/api/leaderboard' + q), d);
  return { status: res.status, data: await res.json() };
};

// An honest 60 second run: speed integrates to roughly 1,378 m.
const honest = { dist: 1378, frags: 100, time: 60 };
honest.score = honest.dist + honest.frags * 25 + 200;

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  ', name); };

await t('start issues a token', async () => {
  const r = await post({ action: 'start' });
  assert.equal(r.status, 200);
  assert.match(r.data.token, /^\d+\.[0-9a-f]{12}\.[0-9a-f]{64}$/);
});

await t('claim rejects bad names and pins', async () => {
  assert.equal((await post({ action: 'claim', name: 'x', pin: '1234' })).status, 400);
  assert.equal((await post({ action: 'claim', name: 'Bad<script>', pin: '1234' })).status, 400);
  assert.equal((await post({ action: 'claim', name: 'Paul', pin: '12' })).status, 400);
  assert.equal((await post({ action: 'claim', name: 'Paul', pin: 'abcd' })).status, 400);
});

await t('claim creates a name, then protects it with the PIN', async () => {
  const a = await post({ action: 'claim', name: 'Paul', pin: '1234' });
  assert.equal(a.status, 200); assert.equal(a.data.created, true);
  const b = await post({ action: 'claim', name: 'paul', pin: '1234' });
  assert.equal(b.status, 200); assert.equal(b.data.created, false); assert.equal(b.data.name, 'Paul');
  const c = await post({ action: 'claim', name: 'PAUL', pin: '9999' });
  assert.equal(c.status, 403);
});

await t('PIN is never stored in plain text', async () => {
  const raw = d.players._m.get('paul');
  assert.ok(!raw.includes('1234'));
});

await t('honest run is accepted and ranked first', async () => {
  const { data: { token } } = await post({ action: 'start' });
  clock += 75_000; // wall clock passes at least as long as the run
  const r = await post({ action: 'submit', name: 'Paul', pin: '1234', token, ...honest });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.improved, true); assert.equal(r.data.rank, 1); assert.equal(r.data.best, honest.score);
});

await t('claiming run time longer than the real wall clock is rejected', async () => {
  const { data: { token } } = await post({ action: 'start' });
  clock += 10_000; // only 10s have passed
  const r = await post({ action: 'submit', name: 'Paul', pin: '1234', token, ...honest });
  assert.equal(r.status, 400);
});

await t('impossible distance, fragments and bonus are rejected', async () => {
  const mk = async (over) => {
    const { data: { token } } = await post({ action: 'start' });
    clock += 70_000;
    const body = { ...honest, ...over };
    return post({ action: 'submit', name: 'Paul', pin: '1234', token, ...body });
  };
  assert.equal((await mk({ dist: 9000, score: 9000 + 2500 + 200 })).status, 400, 'too far for the time');
  assert.equal((await mk({ dist: 200, score: 200 + 2500 + 200 })).status, 400, 'too slow for the time');
  assert.equal((await mk({ frags: 5000, score: 1378 + 125000 })).status, 400, 'too many fragments');
  assert.equal((await mk({ score: 1_000_000 })).status, 400, 'bonus out of range');
  assert.equal((await mk({ score: 1378 + 2500 - 5 })).status, 400, 'score below its parts');
  assert.equal((await mk({ time: 2 })).status, 400, 'run too short');
  assert.equal((await mk({ score: 'lots' })).status, 400, 'wrong type');
});

await t('forged and missing tokens are rejected', async () => {
  clock += 10_000;
  const { data: { token } } = await post({ action: 'start' });
  const [a, b] = token.split('.');
  clock += 70_000;
  const base = { action: 'submit', name: 'Paul', pin: '1234', ...honest, score: honest.score + 10 };
  assert.equal((await post({ ...base, token: `${a}.${b}.${'0'.repeat(64)}` })).status, 400);
  assert.equal((await post({ ...base, token: undefined })).status, 400);
  assert.equal((await post({ ...base, token: `${Number(a) - 100000}.${b}.${token.split('.')[2]}` })).status, 400);
});

await t('wrong PIN cannot submit for someone else', async () => {
  const { data: { token } } = await post({ action: 'start' });
  clock += 70_000;
  const r = await post({ action: 'submit', name: 'Paul', pin: '0000', token, ...honest });
  assert.equal(r.status, 403);
});

await t('submissions are rate limited per player', async () => {
  const { data: { token } } = await post({ action: 'start' });
  clock += 70_000;
  const ok = await post({ action: 'submit', name: 'Paul', pin: '1234', token, ...honest, score: honest.score - 50 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.improved, false);
  clock += 500;
  const again = await post({ action: 'submit', name: 'Paul', pin: '1234', token, ...honest });
  assert.equal(again.status, 429);
});

await t('a second player ranks by score, and improving replaces the old entry', async () => {
  await post({ action: 'claim', name: 'Sarah', pin: '5555' });
  const run = async (name, pin, score, time = 60) => {
    const { data: { token } } = await post({ action: 'start' });
    clock += (time + 15) * 1000;
    return post({ action: 'submit', name, pin, token, dist: 1378, frags: 100, time, score });
  };
  const low = await run('Sarah', '5555', 1378 + 2500 + 20);
  assert.equal(low.data.rank, 2);
  const high = await run('Sarah', '5555', 1378 + 2500 + 800);
  assert.equal(high.data.improved, true);
  assert.equal(high.data.rank, 1);
  const board = (await get()).data.entries;
  assert.deepEqual(board.map((e) => e.name), ['Sarah', 'Paul']);
  assert.equal(board.length, 2, 'old Sarah entry was removed');
  assert.equal(d.scores._m.size, 2);
});

await t('leaderboard GET honours limit and sends only public fields', async () => {
  const r = await get('?limit=1');
  assert.equal(r.data.entries.length, 1);
  assert.deepEqual(Object.keys(r.data.entries[0]).sort(), ['dist', 'frags', 'name', 'score']);
});

await t('bad requests are handled', async () => {
  const res = await handle(new Request('https://x.test/api/leaderboard', { method: 'POST', body: 'not json' }), d);
  assert.equal(res.status, 400);
  const res2 = await handle(new Request('https://x.test/api/leaderboard', { method: 'DELETE' }), d);
  assert.equal(res2.status, 405);
  assert.equal((await post({ action: 'nope' })).status, 400);
});

await t('Halving: a halved run with its fork and halving counts is accepted, but a plain run that low is not', async () => {
  await post({ action: 'claim', name: 'Halver', pin: '4242' });
  const run = async (extra, time = 120) => {
    const { data: { token } } = await post({ action: 'start' });
    clock += (time + 10) * 1000;
    return post({ action: 'submit', name: 'Halver', pin: '4242', token, time, dist: 2700, frags: 40, ...extra });
  };
  // dist 2700 + 1000 from fragments = 3700 earned. One halving leaves about half of it, plus later earnings.
  assert.equal((await run({ score: 2300, forks: 1, halvings: 1 })).status, 200, 'a real halving is fine');
  assert.equal((await run({ score: 2300 })).status, 400, 'same score with no halving reported is not');
  assert.equal((await run({ score: 1000, forks: 1, halvings: 1 })).status, 400, 'one halving cannot take it below half');
  assert.equal((await run({ score: 3000, forks: 0, halvings: 1 })).status, 400, 'cannot halve without a fork');
  assert.equal((await run({ score: 3000, forks: 5, halvings: 0 })).status, 400, 'too many forks for the run time');
  assert.equal((await run({ score: 3000, forks: 1.5, halvings: 0 })).status, 400, 'counts must be whole numbers');
});

await t('Halving: the bull run allowance lets a lucky run through, and old clients still work', async () => {
  const run = async (extra) => {
    const { data: { token } } = await post({ action: 'start' });
    clock += 130 * 1000;
    return post({ action: 'submit', name: 'Halver', pin: '4242', token, time: 120, dist: 2700, frags: 40, ...extra });
  };
  assert.equal((await run({ score: 2700 + 1000 + 8000, forks: 2, halvings: 0 })).status, 200, 'big bonus with two bull runs');
  assert.equal((await run({ score: 2700 + 1000 + 8000 + 9000 })).status, 400, 'same bonus beyond the cap is not');
  assert.equal((await run({ score: 2700 + 1000 + 300 })).status, 200, 'no forks or halvings fields at all');
});

await t('Hack: hits cost points but are declared, and the counts have to fit the run', async () => {
  await post({ action: 'claim', name: 'Hacked', pin: '5151' });
  const run = async (extra, time = 120) => {
    const { data: { token } } = await post({ action: 'start' });
    clock += (time + 10) * 1000;
    return post({ action: 'submit', name: 'Hacked', pin: '5151', token, time, dist: 2700, frags: 40, ...extra });
  };
  // dist 2700 + 1000 from fragments = 3700. Two hits take 1000 off, so 2700 is a real score from a hacked run.
  assert.equal((await run({ score: 2700, hacks: 1, hits: 2 })).status, 200, 'two hits in one hack');
  assert.equal((await run({ score: 2700 })).status, 400, 'the same score with no hack reported is not');
  assert.equal((await run({ score: 1500, hacks: 1, hits: 2 })).status, 400, 'hits cannot take more than 500 each');
  assert.equal((await run({ score: 3000, hacks: 0, hits: 1 })).status, 400, 'cannot be hit without a hack');
  assert.equal((await run({ score: 3000, hacks: 6, hits: 1 })).status, 400, 'too many hacks for the run time');
  assert.equal((await run({ score: 3000, hacks: 1, hits: 1.5 })).status, 400, 'counts must be whole numbers');
  assert.equal((await run({ score: 3700 + 300, hacks: 1, hits: 0 })).status, 200, 'a clean hack with its bonus is fine');
});

await t('Cold Storage: a frozen score is declared, and the count has to fit the run', async () => {
  await post({ action: 'claim', name: 'Frosty', pin: '6161' });
  const run = async (extra, time = 120) => {
    const { data: { token } } = await post({ action: 'start' });
    clock += (time + 10) * 1000;
    return post({ action: 'submit', name: 'Frosty', pin: '6161', token, time, dist: 2700, frags: 40, ...extra });
  };
  // dist 2700 + 1000 from fragments = 3700, and one cold storage froze 400 m of it.
  assert.equal((await run({ score: 3300, colds: 1 })).status, 200, 'one cold storage froze 400 points');
  assert.equal((await run({ score: 3300 })).status, 400, 'the same score with no cold storage reported is not');
  assert.equal((await run({ score: 2900, colds: 1 })).status, 400, 'one cold storage cannot freeze 800');
  assert.equal((await run({ score: 2900, colds: 2 })).status, 200, 'two of them can');
  assert.equal((await run({ score: 3300, colds: 6 })).status, 400, 'too many cold storages for the run time');
  assert.equal((await run({ score: 3300, colds: 0.5 })).status, 400, 'counts must be whole numbers');
  // the vault keeps a halving from biting as hard, which only ever leaves the score higher than the floor
  assert.equal((await run({ score: 2600, colds: 1, forks: 1, halvings: 1 })).status, 200, 'banked points survive a halving');
});

await t('PIN recovery: a saved email gets a code, and the code sets a new PIN', async () => {
  let r = await post({ action: 'claim', name: 'Forgetful', pin: '1111', email: ' Paul@Example.com ' });
  assert.equal(r.status, 200); assert.equal(r.data.email, 'p***@example.com', 'only a masked email comes back');
  const rec = await d.players.get('forgetful');
  assert.equal(rec.email, 'paul@example.com', 'stored trimmed and lower case');
  r = await post({ action: 'forgot', name: 'forgetful' });
  assert.equal(r.status, 200); assert.equal(outbox.length, 1); assert.equal(outbox[0].to, 'paul@example.com');
  const code = lastCode();
  assert.equal((await post({ action: 'reset', name: 'Forgetful', code: code === '123456' ? '654321' : '123456', pin: '2222' })).status, 403, 'wrong code');
  assert.equal((await post({ action: 'reset', name: 'Forgetful', code, pin: '22' })).status, 400, 'new PIN still has to be valid');
  r = await post({ action: 'reset', name: 'Forgetful', code, pin: '2222' });
  assert.equal(r.status, 200);
  assert.equal((await post({ action: 'claim', name: 'Forgetful', pin: '1111' })).status, 403, 'old PIN no longer works');
  assert.equal((await post({ action: 'claim', name: 'Forgetful', pin: '2222' })).status, 200, 'new PIN works');
  assert.equal((await post({ action: 'reset', name: 'Forgetful', code, pin: '3333' })).status, 400, 'a used code cannot be used again');
});

await t('PIN recovery: no leaks, no spam, codes expire and lock after wrong guesses', async () => {
  const before = outbox.length;
  const a = await post({ action: 'forgot', name: 'Nobody Here' });
  await post({ action: 'claim', name: 'NoEmail', pin: '4444' });
  const b = await post({ action: 'forgot', name: 'NoEmail' });
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(a.data.message, b.data.message, 'same answer either way');
  assert.equal(outbox.length, before, 'nothing sent without a saved email');
  assert.equal((await post({ action: 'claim', name: 'NoEmail', pin: '4444', email: 'not-an-email' })).status, 400);
  assert.equal((await post({ action: 'claim', name: 'NoEmail', pin: '9999', email: 'thief@example.com' })).status, 403, 'wrong PIN cannot set an email');
  assert.equal((await post({ action: 'claim', name: 'NoEmail', pin: '4444', email: 'owner@example.com' })).data.email, 'o****@example.com', 'right PIN can add one later');
  assert.equal((await post({ action: 'forgot', name: 'NoEmail' })).status, 200);
  assert.equal((await post({ action: 'forgot', name: 'NoEmail' })).status, 429, 'one email a minute');
  clock += 16 * 60 * 1000;
  assert.equal((await post({ action: 'reset', name: 'NoEmail', code: lastCode(), pin: '5555' })).status, 400, 'codes expire after 15 minutes');
  await post({ action: 'forgot', name: 'NoEmail' });
  const good = lastCode(), bad = good === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) await post({ action: 'reset', name: 'NoEmail', code: bad, pin: '5555' });
  assert.equal((await post({ action: 'reset', name: 'NoEmail', code: good, pin: '5555' })).status, 400, 'five wrong guesses kill the code');
  const lb = await get();
  assert.ok(!JSON.stringify(lb.data).includes('@'), 'emails never appear on the leaderboard');
});

console.log(`\n${passed} tests passed`);
