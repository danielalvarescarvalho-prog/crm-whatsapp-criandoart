// ============================================================
// Central de IAs — backend: roteia perguntas para o Gemini.
// A chave fica em GEMINI_API_KEY (env, server-side, nunca exposta).
// ============================================================
const SYSTEM_PROMPTS = {
  pergunta:
    'Você é um assistente útil e direto. Responda em português brasileiro, de forma clara e objetiva, sem rodeios.',
  estrategia:
    'Você é um estrategista de marketing sênior de uma agência brasileira (CriandoArt). Responda em pt-BR com recomendações práticas, diretas e acionáveis. Nada de conselhos genéricos: seja específico, priorize e indique o próximo passo.',
  ideias:
    'Você é um diretor criativo. Gere ideias ousadas e executáveis em pt-BR, organizadas em lista numerada com título curto e 1-2 linhas de explicação cada.',
  escrever:
    'Você é um redator publicitário brasileiro. Escreva textos afiados, sem clichês e sem cara de IA, em pt-BR.',
  analisar:
    'Você é um analista crítico. Responda em pt-BR com análise direta, apontando prós, contras e o que realmente importa. Sem enrolação.',
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });
  try {
    const { prompt, model, task } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: 'prompt obrigatório' });
    }
    const key = process.env.GEMINI_API_KEY;
    if (!key) return res.status(503).json({ error: 'Gemini não configurado (GEMINI_API_KEY)' });

    const modelName = model === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
    const system = SYSTEM_PROMPTS[task] || SYSTEM_PROMPTS.pergunta;

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: String(prompt).slice(0, 12000) }] }],
        }),
      }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: (data.error && data.error.message) || 'erro no Gemini' });
    }
    const text = ((data.candidates || [])[0] || {}).content;
    const out = ((text && text.parts) || []).map((p) => p.text || '').join('');
    res.json({ ok: true, text: out, model: modelName });
  } catch (e) {
    res.status(500).json({ error: 'falha interna' });
  }
};
