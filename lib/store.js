/**
 * Persistent store. On Vercel, serverless functions forget memory between requests,
 * so state lives in Upstash Redis (Vercel Storage -> Upstash for Redis, free tier).
 * Locally (no env vars) everything stays in memory.
 */
// Accept the standard names, or the same names with any prefix Vercel may add (e.g. STORAGE_KV_REST_API_URL)
const findEnv = (suffixes) => {
  for (const sfx of suffixes) if (process.env[sfx]) return process.env[sfx].trim();
  for (const [k, v] of Object.entries(process.env)) if (v && suffixes.some((sfx) => k.endsWith(`_${sfx}`))) return v.trim();
  return '';
};
const URL_ = findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
const TOKEN = findEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);
const PREFIX = process.env.STORE_PREFIX || "petpal-dlv";
const useRedis = Boolean(URL_ && TOKEN);

const mem = { kv: new Map(), lists: new Map() };

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(`redis: ${j.error}`);
  return j.result;
}

async function get(key) {
  if (!useRedis) return mem.kv.has(key) ? mem.kv.get(key) : null;
  return redis(['GET', `${PREFIX}:${key}`]);
}
async function set(key, value, ttlSec) {
  if (!useRedis) { mem.kv.set(key, value); return; }
  const cmd = ['SET', `${PREFIX}:${key}`, value];
  if (ttlSec) cmd.push('EX', String(ttlSec));
  await redis(cmd);
}
async function del(key) {
  if (!useRedis) { mem.kv.delete(key); mem.lists.delete(key); return; }
  await redis(['DEL', `${PREFIX}:${key}`]);
}
async function push(key, value, keep = 500) {
  if (!useRedis) {
    const l = mem.lists.get(key) || [];
    l.push(value); while (l.length > keep) l.shift();
    mem.lists.set(key, l); return;
  }
  await redis(['RPUSH', `${PREFIX}:${key}`, value]);
  await redis(['LTRIM', `${PREFIX}:${key}`, String(-keep), '-1']);
}
async function range(key) {
  if (!useRedis) return mem.lists.get(key) || [];
  return redis(['LRANGE', `${PREFIX}:${key}`, '0', '-1']);
}

module.exports = { get, set, del, push, range, useRedis };
