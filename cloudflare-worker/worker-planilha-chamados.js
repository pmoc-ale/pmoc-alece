// Worker Cloudflare — lê a planilha de chamados do Forms (Google Sheets)
// e devolve as linhas pro PMOC, pra não depender de baixar/reimportar o
// arquivo toda vez (ver aba "Gerar OS").
//
// Por que um Worker e não buscar direto do navegador: mesmo que a
// planilha estivesse pública, o Google não libera esse endereço pra ser
// lido por JavaScript rodando num site diferente (CORS) -- um Worker
// busca "de servidor pra servidor", onde isso não se aplica. Também
// aproveita pra usar OAuth em vez de exigir que a planilha seja pública:
// basta compartilhar com a conta pmoc.alece.sistemas@gmail.com (a mesma
// usada no backup, ver worker-backup.js).
//
// COMO CONFIGURAR (só precisa fazer uma vez):
//
// 1. No Cloudflare, crie um Worker novo chamado "planilha-chamados" (esse
//    nome importa: o app.js espera a URL
//    "https://planilha-chamados.pmoc-alece-sistemas.workers.dev" -- se
//    usar outro nome, ajuste URL_PLANILHA_CHAMADOS em app.js).
// 2. Cole o conteúdo desse arquivo nele.
// 3. Compartilhe a planilha de chamados com pmoc.alece.sistemas@gmail.com
//    (pode ser só como "Leitor") -- Compartilhar, no canto superior
//    direito do Google Sheets.
// 4. Settings > Variables and Secrets, adicione (como "Secret", exceto o
//    ID da planilha que pode ser "Text"):
//      FIREBASE_WEB_API_KEY       (o mesmo já usado nos outros Workers)
//      GOOGLE_OAUTH_CLIENT_ID     (o mesmo do worker-backup.js)
//      GOOGLE_OAUTH_CLIENT_SECRET (o mesmo do worker-backup.js)
//      GOOGLE_OAUTH_REFRESH_TOKEN (o mesmo do worker-backup.js)
//      SHEET_ID_CHAMADOS          (o ID na URL da planilha, entre
//                                  /d/ e /edit -- não é o link inteiro)
// 5. Deploy.
//
// AVISO DE SEGURANÇA: exige um token de login válido do Firebase (igual
// ao worker-redefinir-senha.js) -- não checa se é admin, mas o pior que
// um usuário comum mal-intencionado conseguiria fazer é ler essa mesma
// planilha de chamados (nada mais sensível do que isso).
const ORIGEM_PERMITIDA = "https://pmoc-ale.github.io";

function cabecalhosCors() {
  return {
    "Access-Control-Allow-Origin": ORIGEM_PERMITIDA,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) }
  );
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) return { erro: dados.error?.message || `HTTP ${resp.status} do Firebase` };
  const uid = dados.users?.[0]?.localId;
  if (!uid) return { erro: "Token válido mas sem usuário associado." };
  return { uid };
}

// Mesmo mecanismo de worker-backup.js (obterAccessTokenOAuthUsuario) --
// um "refresh token" obtido uma vez via OAuth Playground, autorizando
// como pmoc.alece.sistemas@gmail.com.
async function obterAccessToken(env) {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const dados = await resp.json();
  if (!resp.ok) throw new Error("Falha ao renovar o token: " + (dados.error_description || dados.error));
  return dados.access_token;
}

// O link que a Jovanna usa tem "?gid=1978174237" (identifica a ABA, não
// tem nome) -- a API de Sheets só lê por NOME da aba, então primeiro
// pergunta a lista de abas (título + gid de cada uma) e acha qual bate.
async function nomeDaAbaPorGid(sheetId, gid, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const dados = await resp.json();
  if (!resp.ok) throw new Error("Falha ao listar abas da planilha: " + (dados.error?.message || resp.status));
  const abas = dados.sheets || [];
  const aba = gid ? abas.find((a) => String(a.properties.sheetId) === String(gid)) : abas[0];
  if (!aba) throw new Error(`Não encontrei nenhuma aba com gid=${gid} nessa planilha.`);
  return aba.properties.title;
}

async function lerLinhas(sheetId, gid, token) {
  const nomeAba = await nomeDaAbaPorGid(sheetId, gid, token);
  const range = `'${nomeAba}'`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const dados = await resp.json();
  if (!resp.ok) throw new Error("Falha ao ler a planilha: " + (dados.error?.message || resp.status));
  return dados.values || [];
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cabecalhosCors() });
    }
    if (request.method !== "GET") {
      return respostaJson({ erro: "Método não permitido." }, 405);
    }
    if (!env.SHEET_ID_CHAMADOS) {
      return respostaJson({ erro: "Falta configurar SHEET_ID_CHAMADOS nas Variables and Secrets do Worker." }, 500);
    }

    const idToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!idToken) return respostaJson({ erro: "Faça login primeiro." }, 401);
    const resultadoLogin = await verificarLogin(idToken, env);
    if (resultadoLogin.erro) return respostaJson({ erro: "Falha no login: " + resultadoLogin.erro }, 401);

    const gid = new URL(request.url).searchParams.get("gid") || "";

    try {
      const token = await obterAccessToken(env);
      const linhas = await lerLinhas(env.SHEET_ID_CHAMADOS, gid, token);
      return respostaJson({ ok: true, linhas });
    } catch (err) {
      return respostaJson({ erro: err.message }, 500);
    }
  },
};
