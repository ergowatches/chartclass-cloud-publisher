/**
 * Cloud half of the Chart Class publisher. Runs on GitHub Actions, so reels go
 * out with the laptop shut.
 *
 * Since 3 Oct the laptop only has to push videos: each one sits on the `media`
 * branch, served by GitHub Pages, and schedule.json says when it goes out. At
 * post time this job hands Instagram the Pages URL, waits for the container to
 * finish processing, and publishes. Nothing expires, so the queue can run days
 * ahead. (Entries carrying a `container` instead of a `video` are the old
 * preloaded kind and are still published as before.)
 *
 * Guards, in order, all checked against what is actually live on the account:
 *   - token works
 *   - posting hours, London
 *   - minimum gap since the last reel that went live
 *   - breakout hold: a reel from the last 18h with 3,000+ views at 250+/h
 *   - never post something already live (caption match)
 * At most one reel per run.
 */
import { readFileSync } from 'node:fs';

const TOKEN = process.env.IG_TOKEN, USER = process.env.IG_USER_ID;
if (!TOKEN || !USER) { console.error('IG_TOKEN / IG_USER_ID secrets missing'); process.exit(1); }
const API = 'https://graph.instagram.com/v21.0';
const q = (o) => new URLSearchParams({ ...o, access_token: TOKEN });
const get = async (p, o = {}) => (await fetch(`${API}${p}?${q(o)}`)).json();
const post = async (p, o = {}) => (await fetch(`${API}${p}?${q(o)}`, { method: 'POST' })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GAP_MIN = 55;
const OPEN = 9 * 60 - 10, CLOSE = 21 * 60 + 15;           // 08:50 - 21:15 London

const me = await get('/me', { fields: 'username' });
if (me.error) { console.error(`token rejected: ${me.error.message}`); process.exit(1); }
console.log(`token ok: @${me.username}`);

const [hh, mm] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false })
  .format(new Date()).split(':').map(Number);
if (hh * 60 + mm < OPEN || hh * 60 + mm > CLOSE) { console.log(`outside posting hours (London ${hh}:${String(mm).padStart(2, '0')}), holding`); process.exit(0); }

const recent = await get(`/${USER}/media`, { fields: 'id,timestamp,caption', limit: '30' });
const live = recent.data || [];
const lastAt = live[0]?.timestamp ? Date.parse(live[0].timestamp) : 0;
if (Date.now() - lastAt < GAP_MIN * 60e3) {
  console.log(`last reel went live ${Math.round((Date.now() - lastAt) / 60e3)} min ago, holding (gap ${GAP_MIN} min)`);
  process.exit(0);
}

for (const x of live.slice(0, 6)) {
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

const isLive = (p) => {
  const head = (p.caption || '').trim().slice(0, 60);
  return head && live.some((m) => (m.caption || '').trim().startsWith(head));
};

const { posts = [] } = JSON.parse(readFileSync('schedule.json', 'utf8'));
const now = Date.now();
const due = posts
  .filter((p) => Date.parse(p.at) <= now && now - Date.parse(p.at) < 14 * 24 * 3600e3)
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

for (const p of due) {
  if (isLive(p)) continue;
  let container = p.container;

  if (!container) {
    if (!p.video) { console.log(`#${p.id} has neither video nor container, skipping`); continue; }
    const c = await post(`/${USER}/media`, { media_type: 'REELS', video_url: p.video, caption: p.caption || '', share_to_feed: 'true' });
    if (c.error) { console.log(`#${p.id} container failed: ${c.error.message}`); continue; }
    container = c.id;
    console.log(`#${p.id} container ${container} created from ${p.video}`);
    let code = '';
    for (let k = 0; k < 40; k++) {                       // up to ~6.5 min
      await sleep(10000);
      const s = await get(`/${container}`, { fields: 'status_code,status' });
      code = s.status_code;
      if (code === 'FINISHED' || code === 'ERROR' || code === 'EXPIRED') { if (code !== 'FINISHED') console.log(`#${p.id} ${code}: ${s.status || ''}`); break; }
    }
    if (code !== 'FINISHED') { console.log(`#${p.id} not ready (${code}), will retry next run`); continue; }
  } else {
    const st = await get(`/${container}`, { fields: 'status_code' });
    if (st.status_code === 'PUBLISHED') continue;
    if (st.status_code !== 'FINISHED') { console.log(`#${p.id} preloaded container is ${st.status_code || st.error?.message}, skipping`); continue; }
  }

  const r = await post(`/${USER}/media_publish`, { creation_id: container });
  if (r.error) { console.error(`#${p.id} publish failed: ${r.error.message}`); process.exitCode = 1; break; }
  console.log(`#${p.id} published as media ${r.id} (${p.hook || ''})`);
  break;                                                  // one per run
}
if (!due.length) console.log('nothing due');
