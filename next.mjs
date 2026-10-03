/**
 * When should the next waiter wake? Prints an ISO time, or nothing.
 *  - a due post that is not live yet (held by gap, hours or breakout): retry in 20 min
 *  - otherwise the next scheduled post's time (+30s)
 */
import { readFileSync } from 'node:fs';
const TOKEN = process.env.IG_TOKEN, USER = process.env.IG_USER_ID;
const { posts = [] } = JSON.parse(readFileSync('schedule.json', 'utf8'));
const r = await (await fetch(`https://graph.instagram.com/v21.0/${USER}/media?fields=caption&limit=30&access_token=${TOKEN}`)).json();
const live = (r.data || []).map((m) => (m.caption || '').trim());
const isLive = (p) => { const h = (p.caption || '').trim().slice(0, 60); return h && live.some((c) => c.startsWith(h)); };
const now = Date.now();
const pending = posts.filter((p) => !isLive(p) && now - Date.parse(p.at) < 36 * 3600e3);
const overdue = pending.filter((p) => Date.parse(p.at) <= now);
const future = pending.map((p) => Date.parse(p.at)).filter((t) => t > now).sort((a, b) => a - b);
let t = null;
if (overdue.length) t = now + 20 * 60e3;
if (future.length && (t === null || future[0] + 30e3 < t)) t = future[0] + 30e3;
if (t) console.log(new Date(t).toISOString());
