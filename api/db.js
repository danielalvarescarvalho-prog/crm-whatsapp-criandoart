// ============================================================
// CRM WhatsApp — camada de banco (Neon Postgres, serverless)
// Substitui o better-sqlite3 (síncrono) pelo driver serverless do Neon.
// Na Vercel, o Neon é a integração nativa de Postgres.
// ============================================================
const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

// Conexão preguiçosa: só conecta quando a primeira query rodar.
// Aceita POSTGRES_URL (padrão Vercel) ou DATABASE_URL.
// fullResults: true → resultados no formato { rows, ... } (estilo node-postgres).
const sql = neon(process.env.POSTGRES_URL || process.env.DATABASE_URL || 'postgres://localhost:5432/crm', {
  fullResults: true,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stages (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    name TEXT,
    phone TEXT UNIQUE NOT NULL,
    stage_id INTEGER REFERENCES stages(id),
    tags TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    appointment_at TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    direction TEXT CHECK(direction IN ('IN','OUT')) NOT NULL,
    body TEXT,
    wa_message_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS templates (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_stage ON contacts(stage_id)`,
];

async function seed() {
  const { rows: u } = await sql`SELECT COUNT(*) AS c FROM users`;
  if (Number(u[0].c) === 0) {
    const hash = bcrypt.hashSync(process.env.SEED_PASSWORD || 'criandoart123', 10);
    await sql`INSERT INTO users (username, password_hash) VALUES ('daniel', ${hash}), ('elaine', ${hash})`;
    console.log('[seed] usuários criados: daniel, elaine');
  }
  const { rows: s } = await sql`SELECT COUNT(*) AS c FROM stages`;
  if (Number(s[0].c) === 0) {
    const names = ['Novo', 'Em atendimento', 'Qualificado', 'Agendado', 'Compareceu', 'Faltou', 'Perdido'];
    for (let i = 0; i < names.length; i++) {
      await sql`INSERT INTO stages (name, position) VALUES (${names[i]}, ${i})`;
    }
    console.log('[seed] etapas do funil criadas');
  }
  const { rows: t } = await sql`SELECT COUNT(*) AS c FROM templates`;
  if (Number(t[0].c) === 0) {
    await sql`INSERT INTO templates (name, body) VALUES
      ('Boas-vindas', 'Olá! Aqui é da CriandoArt 😊 Recebemos seu contato e já vamos te atender. Como podemos ajudar?'),
      ('Follow-up', 'Oi! Passando para retomar nossa conversa — ficou alguma dúvida? Estou à disposição para ajudar 👍'),
      ('Confirmação de agendamento', 'Olá! Confirmando seu agendamento conosco. Qualquer imprevisto, é só me avisar por aqui. Até lá! 🙌')`;
    console.log('[seed] 3 modelos de mensagem criados');
  }
}

// Garante schema + seeds uma única vez por instância (idempotente).
// Em serverless, cada cold start chama isso na primeira requisição.
let initPromise = null;
function ensureDb() {
  if (!initPromise) {
    initPromise = (async () => {
      for (const stmt of SCHEMA) await sql.query(stmt);
      await seed();
    })().catch((e) => {
      initPromise = null; // permite nova tentativa na próxima requisição
      throw e;
    });
  }
  return initPromise;
}

async function stageIdByName(name) {
  const { rows } = await sql`SELECT id FROM stages WHERE name = ${name}`;
  return rows[0] ? rows[0].id : null;
}

// Cria ou atualiza o contato a partir de uma mensagem recebida.
async function upsertContactFromMessage(phone, pushName) {
  const clean = String(phone).replace(/\D/g, '');
  const { rows } = await sql`SELECT * FROM contacts WHERE phone = ${clean}`;
  let c = rows[0];
  if (!c) {
    const stageId = await stageIdByName('Novo');
    const ins = await sql`
      INSERT INTO contacts (name, phone, stage_id)
      VALUES (${pushName || clean}, ${clean}, ${stageId})
      RETURNING *`;
    c = ins.rows[0];
    console.log(`[wa] novo contato: ${c.name} (${clean}) -> etapa "Novo"`);
  } else if (pushName && (!c.name || c.name === c.phone)) {
    await sql`UPDATE contacts SET name = ${pushName}, updated_at = NOW() WHERE id = ${c.id}`;
    c.name = pushName;
  }
  return c;
}

module.exports = { sql, ensureDb, stageIdByName, upsertContactFromMessage };
