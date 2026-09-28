/**
 * Cloud half of the Chart Class publisher. Runs on GitHub Actions, so reels go
 * out while the laptop is asleep.
 *
 * The laptop does the heavy part while it is awake (render, host, create the
 * Instagram container, wait for FINISHED) and pushes schedule.json here. This
 * job only calls media_publish on containers whose time has come. Containers
 * live 24h, so the laptop keeps the next ~22h preloaded.
 *
 * Idempotent without any state of its own: a published container reports
 * status_code PUBLISHED, so a rerun can never post twice. At most one reel per
 * run, so a delayed runner cannot dump a backlog in a burst.
 */
import { readFileSync } from 'node:fs';

const TOKEN = process.env.IG_TOKEN, USER = process.env.IG_USER_ID;
if (!TOKEN || !USER) { console.error('IG_TOKEN / IG_USER_ID secrets missing'); process.exit(1); }
const API = 'https://graph.instagram.com/v21.0';
const get = async (p, q = {}) => (await fetch(`${API}${p}?${new URLSearchParams({ ...q, access_token: TOKEN })}`)).json();
const post = async (p, q = {}) => (await fetch(`${API}${p}?${new URLSearchParams({ ...q, access_token: TOKEN })}`, { method: 'POST' })).json();

// Prove the token works on every run, so a stale secret fails loudly here
// instead of silently at the next slot.
const me = await get('/me', { fields: 'username' });
if (me.error) { console.error(`token rejected: ${me.error.message}`); process.exit(1); }
console.log(`token ok: @${me.username}`);

// Never post on top of the last reel. On 28 Sept GitHub's scheduler fired four
// hours late and then twice in five minutes, putting two reels out back to back
// while a third was breaking out. Ask the account what actually went live last.
const GAP_MIN = 55;
const recent = await get(`/${USER}/media`, { fields: 'timestamp', limit: '1' });
const lastAt = recent.data?.[0]?.timestamp ? Date.parse(recent.data[0].timestamp) : 0;
if (Date.now() - lastAt < GAP_MIN * 60e3) {
  console.log(`last reel went live ${Math.round((Date.now() - lastAt) / 60e3)} min ago, holding (gap ${GAP_MIN} min)`);
  process.exit(0);
}

// Breakout hold, mirrored from src/breakout.mjs in the main repo: while any reel
// from the last 18h has 3,000+ views at 250+/hour, the next one waits.
const recent6 = await get(`/${USER}/media`, { fields: 'id,timestamp', limit: '6' });
for (const x of recent6.data || []) {
  const ageH = (Date.now() - Date.parse(x.timestamp)) / 3600e3;
  if (ageH > 18) continue;
  const ins = await get(`/${x.id}/insights`, { metric: 'views' });
  const views = ins.data?.[0]?.values?.[0]?.value ?? 0;
  const rate = views / Math.max(ageH, 0.25);
  if (views >= 3000 && rate >= 250) {
    console.log(`breakout hold: reel ${x.id} has ${views} views at ${Math.round(rate)}/h (${ageH.toFixed(1)}h old); not posting`);
    process.exit(0);
  }
}

const { posts = [] } = JSON.parse(readFileSync('schedule.json', 'utf8'));
const now = Date.now();
const due = posts
  // late by more than 90 min means the slot is gone; the laptop reschedules it
  .filter((p) => Date.parse(p.at) <= now && now - Date.parse(p.at) < 90 * 60e3)
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

for (const p of due) {
  const st = await get(`/${p.container}`, { fields: 'status_code' });
  if (st.error) { console.log(`#${p.id} container ${p.container}: ${st.error.message}`); continue; }
  if (st.status_code === 'PUBLISHED') continue;
  if (st.status_code !== 'FINISHED') { console.log(`#${p.id} container is ${st.status_code}, skipping`); continue; }
  const r = await post(`/${USER}/media_publish`, { creation_id: p.container });
  if (r.error) { console.error(`#${p.id} publish failed: ${r.error.message}`); process.exitCode = 1; break; }
  console.log(`#${p.id} published as media ${r.id} (${p.hook})`);
  break;                                  // one per run
}
if (!due.length) console.log('nothing due');
