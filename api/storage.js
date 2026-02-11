// Vercel Serverless Function
// Persistance partagée via Vercel Postgres (Neon).
//
// L'app cliente appelle :
// - GET  /api/storage              -> { ok:true, kv:{} }
// - POST /api/storage {kv}         -> { ok:true }
// - POST /api/storage {ping:true}  -> { ok:true }
//
// Prérequis (Vercel) : connecter une base "Vercel Postgres (Neon)" au projet.
// Vercel injecte automatiquement les variables d'environnement Postgres.

// Support Neon connection strings provided as DATABASE_URL (outside Vercel Postgres integration)
// by mapping them to POSTGRES_URL for @vercel/postgres.
if (!process.env.POSTGRES_URL && process.env.DATABASE_URL){
  process.env.POSTGRES_URL = process.env.DATABASE_URL;
}

const { sql } = require('@vercel/postgres');

const STORAGE_KEY = 'sdmfpippdc:storage:v1';
const PING_KEY = 'sdmfpippdc:ping:v1';

function hasPostgresEnv(){
  return !!(
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    process.env.POSTGRES_HOST ||
    process.env.DATABASE_URL
  );
}

async function ensureSchema(){
  // Minimal schema: single-row JSON payload per key.
  await sql`
    CREATE TABLE IF NOT EXISTS app_storage (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
}

function parseBody(req){
  // Vercel peut fournir un body déjà parsé, ou une string.
  try{
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    return req.body || {};
  }catch(e){
    return {};
  }
}

module.exports = async function handler(req, res){
  try{
    // Diagnostic endpoint (no secrets): /api/storage?diag=1
    let diag = false;
    try{
      const u = new URL(req.url, 'http://localhost');
      const v = u.searchParams.get('diag');
      diag = (v === '1' || v === 'true');
    }catch(e){
      // Fallback: naive check
      diag = (req && req.url && String(req.url).indexOf('diag=1') >= 0);
    }

    if (diag){
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        ok: true,
        diag: {
          hasPostgresEnv: hasPostgresEnv(),
          has_POSTGRES_URL: !!process.env.POSTGRES_URL,
          has_POSTGRES_PRISMA_URL: !!process.env.POSTGRES_PRISMA_URL,
          has_POSTGRES_URL_NON_POOLING: !!process.env.POSTGRES_URL_NON_POOLING,
          has_POSTGRES_HOST: !!process.env.POSTGRES_HOST,
          has_DATABASE_URL: !!process.env.DATABASE_URL,
          node: process.version
        }
      });
    }

    if (!hasPostgresEnv()){
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({
        ok: false,
        error: 'pg_not_configured',
        message: 'Vercel Postgres (Neon) non configuré (variables d\'environnement manquantes).'
      });
    }

    await ensureSchema();

    if (req.method === 'GET'){
      const { rows } = await sql`SELECT value FROM app_storage WHERE key = ${STORAGE_KEY} LIMIT 1;`;
      const kv = (rows && rows[0] && rows[0].value) ? rows[0].value : {};
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true, kv });
    }

    if (req.method === 'POST'){
      const body = parseBody(req);

      if (body && body.ping){
        const stamp = String(Date.now());
        await sql`
          INSERT INTO app_storage(key, value, updated_at)
          VALUES (${PING_KEY}, ${JSON.stringify({ stamp })}::jsonb, NOW())
          ON CONFLICT (key)
          DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
        `;
        const { rows } = await sql`SELECT value FROM app_storage WHERE key = ${PING_KEY} LIMIT 1;`;
        const ok = !!(rows && rows[0] && rows[0].value && rows[0].value.stamp === stamp);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(ok ? 200 : 500).json({ ok });
      }

      const kv = (body && body.kv && typeof body.kv === 'object') ? body.kv : {};

      await sql`
        INSERT INTO app_storage(key, value, updated_at)
        VALUES (${STORAGE_KEY}, ${JSON.stringify(kv)}::jsonb, NOW())
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
      `;

      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }catch(e){
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({
      ok: false,
      error: e && e.message ? String(e.message) : 'server_error',
      details: {
        code: e && e.code ? String(e.code) : undefined,
        name: e && e.name ? String(e.name) : undefined
      }
    });
  }
};
