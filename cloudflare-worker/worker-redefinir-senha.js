// Worker Cloudflare — deixa um ADMIN redefinir a senha de outra pessoa
// (ex: alguém esqueceu a senha e não lembra a atual pra trocar sozinho em
// "Minha conta").
//
// Por que isso precisa de um Worker: o Firebase (do jeito que o PMOC usa,
// só no navegador) só deixa a PRÓPRIA pessoa trocar sua senha -- ninguém
// consegue trocar a senha de outra conta com o SDK normal, nem sendo
// admin. Pra isso é preciso uma "conta de serviço" do Google (bem
// diferente de uma conta de usuário do PMOC), que só funciona em um
// servidor -- e como o PMOC não tem servidor próprio, esse Worker faz
// esse papel, do mesmo jeito que o worker.js já faz pra assinar as fotos.
//
// Isso NÃO precisa de plano pago nenhum (nem do Firebase, nem do Google
// Cloud, nem do Cloudflare) -- só de gerar uma chave, uma vez.
//
// COMO CONFIGURAR (só precisa fazer uma vez):
//
// 1. No Firebase, vá em: Configurações do projeto (⚙️) > Contas de serviço
//    > "Gerar nova chave privada". Isso baixa um arquivo .json -- guarde
//    ele num lugar seguro (dá acesso de admin ao projeto inteiro).
//
// 2. Abra esse .json e copie dois valores dele:
//      "client_email"  -> vira o secret GOOGLE_SA_EMAIL
//      "private_key"   -> vira o secret GOOGLE_SA_PRIVATE_KEY (copie com
//                          as quebras de linha "\n" e tudo, exatamente
//                          como está no arquivo, entre as aspas)
//
// 3. Crie um Worker novo no Cloudflare chamado "redefinir-senha" (esse
//    nome importa: o site já está configurado esperando a URL
//    "https://redefinir-senha.pmoc-alece-sistemas.workers.dev" -- se
//    usar outro nome, avise pra ajustar essa URL no app.js).
//
// 4. Cole o conteúdo desse arquivo nele e em Settings > Variables and
//    Secrets, adicione (todos como "Secret"):
//      GOOGLE_SA_EMAIL
//      GOOGLE_SA_PRIVATE_KEY
//      FIREBASE_WEB_API_KEY   (o mesmo já usado no worker.js)
//      FIREBASE_PROJECT_ID    (idem, = "pcm-alece")
//
// ORIGEM_PERMITIDA: troque se o PMOC mudar de endereço de novo, pra só
// esse site poder chamar isso.
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

// Só admin (de verdade, não bloqueado) pode redefinir a senha de outra
// pessoa -- mesma regra que o Firestore já usa (souAdmin()), só que
// checada aqui porque esse Worker faz uma coisa que nenhuma regra do
// Firestore consegue proteger sozinha (mexer no login em si, não num
// documento).
async function souAdminDeVerdade(uid, idToken, env) {
  const resp = await fetch(
    `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/usuarios/${uid}`,
    { headers: { Authorization: `Bearer ${idToken}` } }
  );
  if (!resp.ok) return false;
  const dados = await resp.json();
  if (dados.fields?.bloqueado?.booleanValue === true) return false;
  return dados.fields?.permissao?.stringValue === "admin";
}

function base64UrlEncode(entrada) {
  const bytes = typeof entrada === "string" ? new TextEncoder().encode(entrada) : new Uint8Array(entrada);
  let binario = "";
  bytes.forEach((b) => { binario += String.fromCharCode(b); });
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function chavePemParaArrayBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    // Ignora QUALQUER coisa que não seja um caractere válido de base64 --
    // aspas coladas junto, "\n" digitado como texto, quebra de linha de
    // verdade, espaço etc. Mais seguro que tentar adivinhar exatamente o
    // que sobrou de formatação ao colar a chave no secret do Cloudflare.
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes.buffer;
}

// Monta e assina (com a chave da conta de serviço) um "cheque especial"
// (JWT) que o Google troca por um token de acesso de admin de verdade --
// é assim que o Firebase Admin SDK funciona por baixo dos panos, só que
// escrito na mão aqui porque o Worker não tem o Node.js pra rodar esse
// SDK diretamente.
async function obterTokenDeAcessoGoogle(env) {
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = { alg: "RS256", typ: "JWT" };
  const carga = {
    iss: env.GOOGLE_SA_EMAIL,
    scope: "https://www.googleapis.com/auth/identitytoolkit",
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  };
  const jwtSemAssinatura = `${base64UrlEncode(JSON.stringify(cabecalho))}.${base64UrlEncode(JSON.stringify(carga))}`;

  const chave = await crypto.subtle.importKey(
    "pkcs8",
    chavePemParaArrayBuffer(env.GOOGLE_SA_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const assinatura = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", chave, new TextEncoder().encode(jwtSemAssinatura));
  const jwt = `${jwtSemAssinatura}.${base64UrlEncode(assinatura)}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const dados = await resp.json();
  if (!resp.ok) throw new Error("Falha ao autenticar com o Google: " + (dados.error_description || dados.error || resp.status));
  return dados.access_token;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cabecalhosCors() });
    }
    if (request.method !== "POST") {
      return respostaJson({ erro: "Método não permitido." }, 405);
    }

    const idToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!idToken) return respostaJson({ erro: "Faça login primeiro." }, 401);

    const resultadoLogin = await verificarLogin(idToken, env);
    if (resultadoLogin.erro) return respostaJson({ erro: "Falha no login: " + resultadoLogin.erro }, 401);

    const ehAdmin = await souAdminDeVerdade(resultadoLogin.uid, idToken, env);
    if (!ehAdmin) return respostaJson({ erro: "Só administradores podem redefinir a senha de outra pessoa." }, 403);

    let corpo;
    try {
      corpo = await request.json();
    } catch {
      return respostaJson({ erro: "Corpo da requisição inválido." }, 400);
    }
    const uidAlvo = String(corpo.uid || "");
    const novaSenha = String(corpo.novaSenha || "");
    if (!uidAlvo) return respostaJson({ erro: "Faltou dizer de quem é a conta." }, 400);
    if (novaSenha.length < 6) return respostaJson({ erro: "A nova senha precisa ter pelo menos 6 caracteres." }, 400);

    try {
      const tokenDeAcesso = await obterTokenDeAcessoGoogle(env);
      const resp = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:update", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenDeAcesso}` },
        body: JSON.stringify({ localId: uidAlvo, password: novaSenha, returnSecureToken: false }),
      });
      const dados = await resp.json();
      if (!resp.ok) return respostaJson({ erro: dados.error?.message || "Falha ao redefinir a senha." }, 500);
      return respostaJson({ ok: true });
    } catch (err) {
      return respostaJson({ erro: "Erro interno: " + err.message }, 500);
    }
  },
};
