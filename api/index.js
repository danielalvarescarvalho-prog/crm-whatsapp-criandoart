// ============================================================
// CRM WhatsApp v1 — CriandoArt (versão serverless para Vercel)
// Backend: Express + Vercel Postgres + JWT (cookie httpOnly)
// WhatsApp: apenas API oficial da Meta (Cloud API) via webhooks.
// Exportado como serverless function em /api/index.js.
// ============================================================
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sql, ensureDb, stageIdByName, upsertContactFromMessage } = require('./db');

// ---------- Config ----------
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const COOKIE_NAME = 'crm_token';
const JWT_TTL = '12h';
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 12; // 12h

const WA_CLOUD_TOKEN = process.env.WA_CLOUD_TOKEN || '';
const WA_CLOUD_PHONE_ID = process.env.WA_CLOUD_PHONE_ID || '';
const WA_CLOUD_VERIFY_TOKEN = process.env.WA_CLOUD_VERIFY_TOKEN || '';
const WA_CLOUD_APP_SECRET = process.env.WA_CLOUD_APP_SECRET || '';

function cloudApiConfigurado() {
  return Boolean(WA_CLOUD_TOKEN && WA_CLOUD_PHONE_ID);
}

// ============================================================
// APP EXPRESS
// ============================================================
const app = express();

// Diagnóstico (temporário) — ANTES do middleware do banco
app.get('/api/debug/env', (req, res) => {
  const keys = Object.keys(process.env).filter(k =>
    /POSTGRES|DATABASE|STORAGE|NEON/i.test(k)
  );
  res.json({ db_vars_found: keys, node_version: process.version });
});

// Garante schema + seeds do Postgres antes de atender (idempotente).
app.use(async (req, res, next) => {
  try {
    await ensureDb();
    next();
  } catch (e) {
    console.error('[db] falha na inicialização:', e.message);
    next(e);
  }
});

// Webhook da Cloud API (Meta) — ANTES do json parser (precisa do corpo raw
// para validar a assinatura). Rotas públicas, sem login.
app.post('/webhook/whatsapp', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try {
    if (!verificarAssinaturaMeta(req, req.body)) {
      return res.status(403).json({ error: 'assinatura inválida' });
    }
    const payload = JSON.parse(req.body.toString('utf8'));
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const msg of value.messages || []) {
          if (msg.type !== 'text' || !msg.text?.body) continue;
          const phone = String(msg.from || '').replace(/\D/g, '');
          const pushName = value.contacts?.find((c) => c.wa_id === msg.from)?.profile?.name || null;
          try { await registrarMensagemRecebida(phone, pushName, msg.text.body, msg.id); }
          catch (e) { console.error('[webhook] erro:', e.message); }
        }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] erro:', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === WA_CLOUD_VERIFY_TOKEN) {
    console.log('[webhook] verificação da Meta OK');
    return res.status(200).send(challenge);
  }
  res.status(403).send('verificação falhou');
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ---------- Auth via JWT (cookie httpOnly) — sem servidor de sessão ----------
function requireLogin(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'não autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    return res.status(401).json({ error: 'não autenticado' });
  }
}

function setAuthCookie(res, user) {
  const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });
}

app.post('/api/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const { rows } = await sql`SELECT * FROM users WHERE username = ${(username || '').trim().toLowerCase()}`;
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'usuário ou senha inválidos' });
    }
    setAuthCookie(res, user);
    res.json({ ok: true, username: user.username });
  } catch (e) { next(e); }
});
app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});
app.get('/api/me', requireLogin, (req, res) => {
  res.json({ username: req.user.username });
});
app.post('/api/account/password', requireLogin, async (req, res, next) => {
  try {
    const { current, next: nextPass } = req.body || {};
    const { rows } = await sql`SELECT * FROM users WHERE id = ${req.user.sub}`;
    const user = rows[0];
    if (!user || !bcrypt.compareSync(current || '', user.password_hash)) {
      return res.status(400).json({ error: 'senha atual incorreta' });
    }
    if (!nextPass || nextPass.length < 6) {
      return res.status(400).json({ error: 'a nova senha precisa de ao menos 6 caracteres' });
    }
    await sql`UPDATE users SET password_hash = ${bcrypt.hashSync(nextPass, 10)} WHERE id = ${user.id}`;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ============================================================
// API — ETAPAS (STAGES)
// ============================================================
app.get('/api/stages', requireLogin, async (req, res, next) => {
  try {
    const { rows } = await sql`SELECT * FROM stages ORDER BY position`;
    res.json(rows);
  } catch (e) { next(e); }
});
app.post('/api/stages', requireLogin, async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'nome obrigatório' });
    const { rows: m } = await sql`SELECT COALESCE(MAX(position), -1) AS m FROM stages`;
    const { rows } = await sql`
      INSERT INTO stages (name, position) VALUES (${name.trim()}, ${Number(m[0].m) + 1})
      RETURNING *`;
    res.json(rows[0]);
  } catch (e) { next(e); }
});
app.put('/api/stages/order', requireLogin, async (req, res, next) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids deve ser um array' });
    for (let i = 0; i < ids.length; i++) {
      await sql`UPDATE stages SET position = ${i} WHERE id = ${ids[i]}`;
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ============================================================
// API — CONTATOS
// ============================================================
async function contactWithLast(c) {
  const { rows } = await sql`
    SELECT body, direction, created_at FROM messages
    WHERE contact_id = ${c.id} ORDER BY id DESC LIMIT 1`;
  return { ...c, last_message: rows[0] || null };
}
app.get('/api/contacts', requireLogin, async (req, res, next) => {
  try {
    const { stage_id, q } = req.query;
    const conds = [];
    const vals = [];
    if (stage_id) { vals.push(stage_id); conds.push(`stage_id = $${vals.length}`); }
    if (q) { vals.push(`%${q}%`, `%${q}%`); conds.push(`(name ILIKE $${vals.length - 1} OR phone ILIKE $${vals.length})`); }
    let text = 'SELECT * FROM contacts';
    if (conds.length) text += ' WHERE ' + conds.join(' AND ');
    text += ' ORDER BY updated_at DESC';
    const { rows } = await sql.query(text, vals);
    res.json(await Promise.all(rows.map(contactWithLast)));
  } catch (e) { next(e); }
});
app.get('/api/contacts/:id', requireLogin, async (req, res, next) => {
  try {
    const { rows } = await sql`SELECT * FROM contacts WHERE id = ${req.params.id}`;
    if (!rows[0]) return res.status(404).json({ error: 'contato não encontrado' });
    res.json(await contactWithLast(rows[0]));
  } catch (e) { next(e); }
});
app.post('/api/contacts', requireLogin, async (req, res, next) => {
  try {
    const { name, phone, stage_id, tags, notes, appointment_at } = req.body || {};
    const cleanPhone = (phone || '').replace(/\D/g, '');
    if (!cleanPhone) return res.status(400).json({ error: 'telefone obrigatório' });
    const sid = stage_id || await stageIdByName('Novo');
    try {
      const { rows } = await sql`
        INSERT INTO contacts (name, phone, stage_id, tags, notes, appointment_at)
        VALUES (${name || cleanPhone}, ${cleanPhone}, ${sid}, ${tags || ''}, ${notes || ''}, ${appointment_at || null})
        RETURNING *`;
      res.json(rows[0]);
    } catch (e) {
      if (String(e.message).includes('duplicate') || String(e.code) === '23505') {
        return res.status(409).json({ error: 'telefone já cadastrado' });
      }
      throw e;
    }
  } catch (e) { next(e); }
});
app.put('/api/contacts/:id', requireLogin, async (req, res, next) => {
  try {
    const allowed = ['name', 'phone', 'stage_id', 'tags', 'notes', 'appointment_at'];
    const sets = [], vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        let v = req.body[k];
        if (k === 'phone') v = String(v).replace(/\D/g, '');
        if (k === 'appointment_at' && !v) v = null;
        vals.push(v);
        sets.push(`${k} = $${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'nada para atualizar' });
    sets.push('updated_at = NOW()');
    vals.push(req.params.id);
    await sql.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    const { rows } = await sql`SELECT * FROM contacts WHERE id = ${req.params.id}`;
    res.json(await contactWithLast(rows[0]));
  } catch (e) { next(e); }
});
app.delete('/api/contacts/:id', requireLogin, async (req, res, next) => {
  try {
    await sql`DELETE FROM contacts WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/contacts/:id/messages', requireLogin, async (req, res, next) => {
  try {
    const { rows } = await sql`SELECT * FROM messages WHERE contact_id = ${req.params.id} ORDER BY id ASC`;
    res.json(rows);
  } catch (e) { next(e); }
});

// ============================================================
// API — TEMPLATES
// ============================================================
app.get('/api/templates', requireLogin, async (req, res, next) => {
  try {
    const { rows } = await sql`SELECT * FROM templates ORDER BY id`;
    res.json(rows);
  } catch (e) { next(e); }
});
app.post('/api/templates', requireLogin, async (req, res, next) => {
  try {
    const { name, body } = req.body || {};
    if (!name || !body) return res.status(400).json({ error: 'nome e texto obrigatórios' });
    const { rows } = await sql`INSERT INTO templates (name, body) VALUES (${name}, ${body}) RETURNING *`;
    res.json(rows[0]);
  } catch (e) { next(e); }
});
app.put('/api/templates/:id', requireLogin, async (req, res, next) => {
  try {
    const { name, body } = req.body || {};
    await sql`UPDATE templates
      SET name = COALESCE(${name ?? null}, name), body = COALESCE(${body ?? null}, body)
      WHERE id = ${req.params.id}`;
    const { rows } = await sql`SELECT * FROM templates WHERE id = ${req.params.id}`;
    res.json(rows[0]);
  } catch (e) { next(e); }
});
app.delete('/api/templates/:id', requireLogin, async (req, res, next) => {
  try {
    await sql`DELETE FROM templates WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ============================================================
// API — DASHBOARD
// ============================================================
app.get('/api/dashboard', requireLogin, async (req, res, next) => {
  try {
    const { rows: stages } = await sql`
      SELECT s.name AS stage, COUNT(c.id) AS total
      FROM stages s LEFT JOIN contacts c ON c.stage_id = s.id
      GROUP BY s.id, s.name ORDER BY s.position`;
    const por_estagio = {};
    for (const r of stages) por_estagio[r.stage] = Number(r.total);

    const { rows: pares } = await sql`
      SELECT c.id,
        (SELECT MIN(created_at) FROM messages m WHERE m.contact_id = c.id AND m.direction = 'IN') AS primeiro_in,
        (SELECT MIN(m2.created_at) FROM messages m2
           WHERE m2.contact_id = c.id AND m2.direction = 'OUT'
             AND m2.created_at >= (SELECT MIN(created_at) FROM messages m WHERE m.contact_id = c.id AND m.direction = 'IN')
        ) AS primeiro_out
      FROM contacts c`;
    let soma = 0, n = 0;
    for (const p of pares) {
      if (p.primeiro_in && p.primeiro_out) {
        const diff = (new Date(p.primeiro_out) - new Date(p.primeiro_in)) / 60000;
        if (diff >= 0) { soma += diff; n++; }
      }
    }
    const tempo_medio_primeira_resposta_min = n ? Math.round(soma / n) : null;

    const { rows: followups_pendentes } = await sql`
      SELECT c.id, c.name, c.phone, s.name AS stage,
        (SELECT MAX(created_at) FROM messages m WHERE m.contact_id = c.id) AS ultima_msg
      FROM contacts c JOIN stages s ON s.id = c.stage_id
      WHERE s.name IN ('Em atendimento', 'Qualificado')
        AND NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.contact_id = c.id AND m.direction = 'OUT'
            AND m.created_at >= NOW() - INTERVAL '24 hours'
        )
      ORDER BY ultima_msg ASC`;

    res.json({ por_estagio, tempo_medio_primeira_resposta_min, followups_pendentes });
  } catch (e) { next(e); }
});

// ============================================================
// WHATSAPP — apenas API oficial da Meta (Cloud API)
// O Baileys (QR code / WebSocket) foi removido: não funciona em serverless.
// Envio: HTTPS ao graph.facebook.com. Recebimento: webhook acima.
// ============================================================
async function enviarViaCloudAPI(phone, body) {
  if (!cloudApiConfigurado()) throw new Error('Cloud API não configurada (WA_CLOUD_TOKEN / WA_CLOUD_PHONE_ID)');
  const to = String(phone).replace(/\D/g, '');
  const resp = await fetch(`https://graph.facebook.com/v22.0/${WA_CLOUD_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_CLOUD_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: String(body).slice(0, 4000), preview_url: false },
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error('Cloud API: ' + (data?.error?.message || `HTTP ${resp.status}`));
  }
  return data;
}

async function registrarMensagemRecebida(phone, pushName, texto, waId) {
  const contato = await upsertContactFromMessage(phone, pushName);
  await sql`
    INSERT INTO messages (contact_id, direction, body, wa_message_id)
    VALUES (${contato.id}, 'IN', ${texto}, ${waId || null})`;
  await sql`UPDATE contacts SET updated_at = NOW() WHERE id = ${contato.id}`;
  return contato;
}

function verificarAssinaturaMeta(req, rawBody) {
  if (!WA_CLOUD_APP_SECRET) return true; // sem secret, pula a verificação
  const sig = req.headers['x-hub-signature-256'] || '';
  const esperado = 'sha256=' + crypto.createHmac('sha256', WA_CLOUD_APP_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado));
  } catch (_) { return false; }
}

app.get('/api/whatsapp/status', requireLogin, (req, res) => {
  res.json({
    provider: 'cloudapi',
    connected: cloudApiConfigurado(),
    phone: null,
    detail: cloudApiConfigurado()
      ? 'Cloud API configurada — envio ativo'
      : 'configure WA_CLOUD_TOKEN e WA_CLOUD_PHONE_ID nas variáveis de ambiente',
  });
});
// Mantido por compatibilidade com o frontend antigo: não há mais QR code.
app.get('/api/whatsapp/qr', requireLogin, (req, res) => {
  res.json({ status: 'cloudapi', qr: null, phone: null, detail: 'Conexão via API oficial — sem QR code' });
});

async function sendToContact(contato, body) {
  const result = await enviarViaCloudAPI(contato.phone, body.trim());
  const waId = result?.messages?.[0]?.id || null;
  await sql`
    INSERT INTO messages (contact_id, direction, body, wa_message_id)
    VALUES (${contato.id}, 'OUT', ${body.trim()}, ${waId})`;
  await sql`UPDATE contacts SET updated_at = NOW() WHERE id = ${contato.id}`;
}
app.post('/api/whatsapp/send', requireLogin, async (req, res, next) => {
  try {
    const { contact_id, phone, body } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: 'texto obrigatório' });
    let contato = null;
    if (contact_id) {
      const { rows } = await sql`SELECT * FROM contacts WHERE id = ${contact_id}`;
      contato = rows[0];
      if (!contato) return res.status(404).json({ error: 'contato não encontrado' });
    } else if (phone) {
      contato = await upsertContactFromMessage(phone, null);
    } else {
      return res.status(400).json({ error: 'informe contact_id ou phone' });
    }
    await sendToContact(contato, body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/contacts/:id/messages', requireLogin, async (req, res, next) => {
  try {
    const { body } = req.body || {};
    if (!body || !body.trim()) return res.status(400).json({ error: 'texto obrigatório' });
    const { rows } = await sql`SELECT * FROM contacts WHERE id = ${req.params.id}`;
    if (!rows[0]) return res.status(404).json({ error: 'contato não encontrado' });
    await sendToContact(rows[0], body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
// FRONTEND ESTÁTICO + SPA FALLBACK
// (No deploy Vercel, o rewrite /(.*) -> /api/index manda tudo p/ cá;
//  o express.static serve os arquivos de public/.)
// ============================================================
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get(/^\/(?!api|webhook).*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Tratamento de erros da API
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, req, res, next) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'erro interno' });
});

// Exportado como serverless function (@vercel/node).
module.exports = app;
