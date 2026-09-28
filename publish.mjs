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

const { posts = [] } = JSON.parse(readFileSync('schedule.json', 'utf8'));
const now = Date.now();
const due = posts
  .filter((p) => Date.parse(p.at) <= now && now - Date.parse(p.at) < 8 * 3600e3)
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
