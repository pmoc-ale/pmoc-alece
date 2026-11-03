// Worker Cloudflare — gera um resumo em texto (2 a 4 frases) a partir dos
// NÚMEROS JÁ CALCULADOS da Análise GLPI (nunca o CSV bruto), usando o
// Workers AI da própria Cloudflare.
//
// Por que um Worker e não chamar a IA direto do navegador: a chave/acesso
// de IA não pode ficar exposta no app.js (qualquer pessoa que abrisse o
// código-fonte do site conseguiria usá-la à vontade). O Worker AI em si
// não precisa de chave -- é um "binding" do próprio Cloudflare -- mas
// mesmo assim o endpoint precisa exigir login, senão qualquer um na
// internet poderia ficar chamando isso e gastando a cota diária gratuita
// à toa (ver AVISO DE SEGURANÇA abaixo).
//
// QUANDO isso é chamado: só 1 vez por importação de CSV do GLPI (não a
// cada pessoa que abre o dashboard) -- o app.js chama este Worker logo
// depois de importar, guarda o texto que voltar no Firestore (campo
// narrativaIA, dentro de analiseGlpi/glpi), e todo mundo que abre o
// dashboard só LÊ esse texto pronto. Com esse uso (poucas vezes por
// semana), fica bem dentro da cota gratuita do Workers AI (10.000
// "Neurons" por dia).
//
// COMO CONFIGURAR (só precisa fazer uma vez):
//
// 1. No Cloudflare, crie um Worker novo chamado "narrativa-glpi" (esse
//    nome importa: o app.js espera a URL
//    "https://narrativa-glpi.pmoc-alece-sistemas.workers.dev" -- se usar
//    outro nome, ajuste URL_NARRATIVA_GLPI em app.js).
// 2. Cole o conteúdo desse arquivo nele.
// 3. Settings > Bindings > Add > Workers AI -- nome do binding: "AI"
//    (sem isso, env.AI não existe e o Worker sempre dá erro). Isso NÃO
//    precisa de cartão de crédito nem plano pago.
// 4. Settings > Variables and Secrets, adicione (como "Secret"):
//      FIREBASE_WEB_API_KEY   (o mesmo já usado nos outros Workers)
// 5. Deploy.
//
// AVISO DE SEGURANÇA: este endpoint exige um token de login válido do
// Firebase (igual ao worker-redefinir-senha.js) -- não é aberto pra
// qualquer requisição, mas também não checa se é ADMIN (só se está
// logado e não bloqueado), porque o pior que um usuário comum
// mal-intencionado conseguiria fazer é gastar um pouco da cota diária
// gratuita de IA -- não lê nem grava nada no Firestore.
const ORIGEM_PERMITIDA = "https://pmoc-ale.github.io";

function cabecalhosCors() {
  return {
    "Access-Control-Allow-Origin": ORIGEM_PERMITIDA,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  };
}

function respostaJson(dados, status = 200) {
  return new Response(JSON.stringify(dados), {
    status,
    headers: { "Content-Type": "application/json", ...cabecalhosCors() },
  });
}

// Confere o token de login do Firebase e devolve o UID, ou { erro } se inválido/expirado.
async function verificarLogin(idToken, env) {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    }
  );
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) return { erro: dados.error?.message || `HTTP ${resp.status} do Firebase` };
  const uid = dados.users?.[0]?.localId;
  if (!uid) return { erro: "Token válido mas sem usuário associado." };
  return { uid };
}

// Limites generosos (não é texto livre do usuário, é número calculado por
// nós) -- só pra garantir que o prompt não fique gigante por engano.
function textoSeguro(v, max) {
  return String(v ?? "").slice(0, max);
}
function listaFormatada(itens, max) {
  if (!Array.isArray(itens)) return "(nenhum)";
  return itens.slice(0, 8).map((it) => `${textoSeguro(it.nome, 80)}: ${Number(it.valor) || 0}`).join("; ") || "(nenhum)";
}

function montarPrompt(r) {
  const pctAberto = r.totalChamados ? ((r.abertos / r.totalChamados) * 100).toFixed(1) : "0";
  return `Você resume dados de manutenção de ar-condicionado pro gestor de uma assembleia legislativa (PMOC ALECE). Escreva um resumo em português do Brasil, de 2 a 4 frases, tom direto e profissional, SEM markdown, SEM listas, SEM saudação.

Regras importantes:
- Use SOMENTE os números abaixo. Não invente nenhum dado que não esteja aqui.
- Não fale de prazo, SLA ou atraso -- esse sistema não tem prazo definido.
- Não afirme a CAUSA de nada (ex: não diga "por falta de manutenção") -- aponte o padrão, não a causa.
- Se algum número parecer pequeno ou irrelevante, não force uma conclusão em cima dele.

Dados do recorte (${textoSeguro(r.periodoInicio, 20)} a ${textoSeguro(r.periodoFim, 20)}):
- Total de chamados: ${Number(r.totalChamados) || 0}
- Em aberto: ${Number(r.abertos) || 0} (${pctAberto}%)
- Encerrados: ${Number(r.fechados) || 0}
- Setores com mais chamados: ${listaFormatada(r.topSetores)}
- Tipos de falha mais comuns: ${listaFormatada(r.topFalhas)}
- Distribuição por prioridade: ${listaFormatada(r.porPrioridade)}`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cabecalhosCors() });
    }
    if (request.method !== "POST") {
      return respostaJson({ erro: "Método não permitido." }, 405);
    }
    if (!env.AI) {
      return respostaJson({ erro: "Workers AI não está configurado neste Worker (falta o binding \"AI\" em Settings > Bindings)." }, 500);
    }

    const idToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!idToken) return respostaJson({ erro: "Faça login primeiro." }, 401);
    const resultadoLogin = await verificarLogin(idToken, env);
    if (resultadoLogin.erro) return respostaJson({ erro: "Falha no login: " + resultadoLogin.erro }, 401);

    let corpo;
    try {
      corpo = await request.json();
    } catch {
      return respostaJson({ erro: "Corpo da requisição inválido." }, 400);
    }
    if (!corpo || typeof corpo.totalChamados !== "number") {
      return respostaJson({ erro: "Faltam os números resumidos (totalChamados etc)." }, 400);
    }

    try {
      const prompt = montarPrompt(corpo);
      // [2026-11] @cf/meta/llama-3.1-8b-instruct foi descontinuado pela
      // Cloudflare. Tentei @cf/openai/gpt-oss-20b e depois glm-4.7-flash,
      // mas os dois são modelos "reasoning" -- gastam o max_tokens numa
      // etapa de "pensar" escondida (aparece como campo "reasoning" na
      // resposta) e só escrevem o texto final DEPOIS, então com um limite
      // baixo voltavam com content: null. O llama-3.3-70b abaixo é um
      // modelo de instrução "clássico" (mesma família do 3.1 que
      // descontinuaram, sem essa etapa escondida), bem mais previsível pra
      // essa tarefa simples. Se esse também sumir do catálogo no futuro,
      // troque aqui por outro da lista em
      // https://developers.cloudflare.com/workers-ai/models/ (categoria
      // "Text Generation") -- evite qualquer um descrito como
      // "reasoning"/"thinking".
      const resultado = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500,
      });
      // A interface do Workers AI é padronizada (resultado.response), mas
      // alguns modelos (ex: os "reasoning" como o gpt-oss) às vezes vêm
      // num formato de resposta de chat -- os dois fallbacks cobrem isso
      // sem precisar trocar esse trecho de novo se o modelo mudar.
      const texto = (resultado?.response || resultado?.choices?.[0]?.message?.content || (typeof resultado === "string" ? resultado : "") || "").trim();
      // Se vier vazio de novo, mostra um pedaço do que a IA realmente
      // devolveu (em vez de só "não devolveu nada") -- ajuda a descobrir
      // em qual campo o texto está vindo, sem precisar abrir o log do
      // Worker na Cloudflare pra cada tentativa.
      if (!texto) return respostaJson({ erro: "A IA não devolveu nenhum texto. Resposta crua: " + JSON.stringify(resultado).slice(0, 300) }, 500);
      return respostaJson({ ok: true, texto });
    } catch (err) {
      return respostaJson({ erro: "Erro ao gerar o resumo: " + err.message }, 500);
    }
  },
};
