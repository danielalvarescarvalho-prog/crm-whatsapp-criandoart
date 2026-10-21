// ============================================================
// Central de IAs — ponte com a Sol.
// POST /api/sol-work {key, action:"ask", prompt, task} -> cria pergunta pendente
// GET  /api/sol-work?action=status&id=123                -> consulta resposta
// GET  /api/sol-work?action=pending&key=HUB_KEY          -> lista pendentes (cron da Sol)
// POST /api/sol-work {key, action:"answer", id, answer}  -> Sol responde
// ============================================================
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.CRM_DATABASE_URL, { fullResults: true });

async function ensure() {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS hub_questions (
      id SERIAL PRIMARY KEY,
      prompt TEXT NOT NULL,
      task TEXT DEFAULT 'pergunta',
      status TEXT DEFAULT 'pending',
      sol_answer TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      answered_at TIMESTAMPTZ
    )`);
}

module.exports = async (req, res) => {
  try {
    await ensure();
    const { action } = req.query || {};

    if (req.method === 'POST' && action === 'ask') {
      const { prompt, task } = req.body || {};
      if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt obrigatório' });
      const { rows } = await sql`
        INSERT INTO hub_questions (prompt, task) VALUES (${String(prompt).slice(0, 8000)}, ${String(task || 'pergunta').slice(0, 40)})
        RETURNING id`;
      return res.json({ ok: true, id: rows[0].id });
    }

    if (req.method === 'GET' && action === 'status') {
      const { rows } = await sql`SELECT id, status, sol_answer, answered_at FROM hub_questions WHERE id = ${Number(req.query.id)}`;
      if (!rows[0]) return res.status(404).json({ error: 'não encontrada' });
      return res.json(rows[0]);
    }

    // Área da Sol (cron) — protegida por HUB_KEY
    const key = req.query.key || (req.body || {}).key;
    if (key !== process.env.HUB_KEY) return res.status(403).json({ error: 'chave inválida' });

    if (req.method === 'GET' && action === 'pending') {
      const { rows } = await sql`SELECT id, prompt, task, created_at FROM hub_questions WHERE status = 'pending' ORDER BY id ASC LIMIT 10`;
      return res.json({ ok: true, pending: rows });
    }

    if (req.method === 'POST' && action === 'answer') {
      const { id, answer } = req.body || {};
      if (!id || !answer) return res.status(400).json({ error: 'id e answer obrigatórios' });
      await sql`UPDATE hub_questions SET sol_answer = ${String(answer)}, status = 'done', answered_at = NOW() WHERE id = ${Number(id)}`;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'ação inválida' });
  } catch (e) {
    res.status(500).json({ error: 'falha interna' });
  }
};
