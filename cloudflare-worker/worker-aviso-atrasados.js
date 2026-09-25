// Worker Cloudflare — manda um e-mail resumo dos aparelhos atrasados, uma
// vez por dia, pra quem estiver na lista de destinatários.
//
// Pra ler o Firestore, esse Worker faz login como um usuário comum do
// próprio PMOC ALECE (não precisa de "conta de serviço" do Google, nem de
// nada novo no Google Cloud) -- só um e-mail/senha criado igual qualquer
// outra conta, em Configurações > Usuários. Recomendo criar uma conta só
// pra isso (ex: "robo.avisos@pcm-alece.local"), permissão "Trabalhador"
// (só precisa poder LER os equipamentos, nada mais).
//
// Variáveis de ambiente que esse Worker precisa (Settings > Variables and
// Secrets, todas como "Secret"):
//   FIREBASE_WEB_API_KEY   (a mesma já usada no Worker das fotos)
//   FIREBASE_PROJECT_ID    (idem, = "pcm-alece")
//   ROBO_EMAIL             (o e-mail da conta criada só pra esse Worker)
//   ROBO_SENHA             (a senha dessa conta)
//   RESEND_API_KEY         (a chave criada em resend.com/api-keys)
//   EMAIL_REMETENTE        (ex: "PMOC ALECE <avisos@seudominio.com.br>" --
//                            precisa de domínio verificado no Resend; sem
//                            isso, use "onboarding@resend.dev" pra testar,
//                            que só entrega pro e-mail da conta Resend)
//   EMAIL_DESTINATARIOS    (e-mails separados por vírgula)
//
// Além do e-mail, esse Worker também manda um aviso push direto pro
// computador/celular de quem ativou em "Minha conta" (mesmo com o site
// fechado) -- pra isso, mais três variáveis (mesmo lugar, como "Secret"):
//   VAPID_PUBLIC_KEY       (tem que ser IDÊNTICA à constante VAPID_PUBLIC_KEY
//                            em app.js -- são o mesmo par de chaves)
//   VAPID_PRIVATE_KEY_JWK  (a chave privada correspondente, em JSON/JWK)
//   VAPID_SUBJECT          (um contato de quem manda: "mailto:..." ou "https://...")
// Sem essas três, o Worker continua mandando e-mail normalmente -- só pula
// o aviso push (ver enviarNotificacoesPush).
//
// Pra testar sem esperar o horário programado: visite a URL desse Worker
// no navegador (GET) -- ele roda na hora e mostra o resultado.

async function loginComoRobo(env) {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: env.ROBO_EMAIL, password: env.ROBO_SENHA, returnSecureToken: true }),
    }
  );
  const dados = await resp.json();
  if (!resp.ok) throw new Error("Falha ao logar como robô: " + (dados.error?.message || resp.status));
  return dados.idToken;
}

function lerValorFirestore(valor) {
  if (valor.stringValue !== undefined) return valor.stringValue;
  if (valor.integerValue !== undefined) return Number(valor.integerValue);
  if (valor.doubleValue !== undefined) return valor.doubleValue;
  if (valor.booleanValue !== undefined) return valor.booleanValue;
  // mapValue = campo objeto (ex: "keys" da inscrição push, {p256dh, auth})
  // -- sem esse caso, esses campos aninhados viravam "" silenciosamente.
  if (valor.mapValue !== undefined) return camposParaObjeto(valor.mapValue.fields || {});
  return "";
}
function camposParaObjeto(campos) {
  const obj = {};
  for (const chave of Object.keys(campos)) obj[chave] = lerValorFirestore(campos[chave]);
  return obj;
}
function documentoParaObjeto(doc) {
  return { id: doc.name.split("/").pop(), ...camposParaObjeto(doc.fields || {}) };
}

async function listarColecao(caminho, idToken, env) {
  const documentos = [];
  let pageToken = "";
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${caminho}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(`Falha ao ler ${caminho}: ${dados.error?.message || resp.status}`);
    (dados.documents || []).forEach((doc) => documentos.push(documentoParaObjeto(doc)));
    pageToken = dados.nextPageToken || "";
  } while (pageToken);
  return documentos;
}

async function cicloAtualId(idToken, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ciclos?orderBy=criadoEm desc&pageSize=1`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  const dados = await resp.json();
  if (!resp.ok || !dados.documents?.length) return null;
  return dados.documents[0].name.split("/").pop();
}

// Mesma regra de "atrasado" usada no app (estaAtrasado em app.js): data
// agendada já passou e o status ainda não é "Concluída".
function estaAtrasado(item, hojeISO) {
  return item.dataAgendada && item.statusPreventiva !== "Concluída" && item.dataAgendada < hojeISO;
}

function montarEmailHtml(atrasados, hojeFormatado) {
  if (!atrasados.length) {
    return `<p>Nenhum aparelho atrasado hoje (${hojeFormatado}). 🎉</p>`;
  }
  const porPredio = {};
  atrasados.forEach((e) => {
    const predio = e.local || "SEDE";
    (porPredio[predio] = porPredio[predio] || []).push(e);
  });
  const secoes = Object.keys(porPredio).sort().map((predio) => `
    <h3 style="margin:16px 0 6px;font-size:14px;">${predio} (${porPredio[predio].length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#10263D;color:#fff;">
        <th style="padding:6px 8px;text-align:left;">Patrimônio</th>
        <th style="padding:6px 8px;text-align:left;">Ambiente</th>
        <th style="padding:6px 8px;text-align:left;">Equipe</th>
        <th style="padding:6px 8px;text-align:left;">Data agendada</th>
      </tr></thead>
      <tbody>
        ${porPredio[predio].map((e) => `
          <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:6px 8px;">${e.patrimonio || "-"}</td>
            <td style="padding:6px 8px;">${e.ambiente || "-"}</td>
            <td style="padding:6px 8px;">${e.equipeResponsavel || "-"}</td>
            <td style="padding:6px 8px;">${(e.dataAgendada || "").split("-").reverse().join("/")}</td>
          </tr>`).join("")}
      </tbody>
    </table>`).join("");
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
      <h2 style="color:#10263D;">PMOC ALECE — ${atrasados.length} aparelho(s) atrasado(s)</h2>
      <p style="color:#555;font-size:13px;">Resumo gerado automaticamente em ${hojeFormatado}.</p>
      ${secoes}
    </div>`;
}

async function enviarEmail(html, atrasadosCount, env) {
  const destinatarios = (env.EMAIL_DESTINATARIOS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!destinatarios.length) throw new Error("EMAIL_DESTINATARIOS não configurado.");

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_REMETENTE || "onboarding@resend.dev",
      to: destinatarios,
      subject: `PMOC ALECE — ${atrasadosCount} aparelho(s) atrasado(s)`,
      html,
    }),
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("Falha ao enviar e-mail: " + (dados.message || resp.status));
  return dados;
}

// ---------------------------------------------------------------------
// Notificação push do navegador (aviso "instantâneo" no computador/
// celular de quem ativou em "Minha conta", mesmo com o site fechado) --
// implementação própria da RFC 8291 (criptografia "aes128gcm") + RFC 8292
// (assinatura VAPID), usando só a Web Crypto API (crypto.subtle), o mesmo
// subconjunto disponível aqui no Worker, no navegador e no Node. Validada
// byte a byte e com um round-trip completo (cifrar aqui, decifrar com a
// lib "web-push", padrão de fato da indústria) antes de entrar em produção.

function b64urlParaBytes(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function bytesParaB64url(bytes) {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrs) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
const textoAscii = (s) => new TextEncoder().encode(s);

async function hmacSha256(chaveBytes, dadoBytes) {
  const chave = await crypto.subtle.importKey("raw", chaveBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const assinatura = await crypto.subtle.sign("HMAC", chave, dadoBytes);
  return new Uint8Array(assinatura);
}
// HKDF-Expand simplificado pra 1 bloco só (RFC 5869) -- sempre <=32 bytes
// de saída nos três usos daqui embaixo (32, 16 e 12 bytes).
async function hkdfExpandUmBloco(prk, infoBytes, tamanho) {
  const t1 = await hmacSha256(prk, concatBytes(infoBytes, new Uint8Array([1])));
  return t1.slice(0, tamanho);
}
async function hkdf(saltBytes, ikmBytes, infoBytes, tamanho) {
  const prk = await hmacSha256(saltBytes, ikmBytes); // HKDF-Extract
  return hkdfExpandUmBloco(prk, infoBytes, tamanho);
}

// RFC 8291 (Web Push) + RFC 8188 (aes128gcm) -- cifra o payload pra mandar
// pro serviço de push (Google/Mozilla/etc.), que não consegue ler o
// conteúdo, só entregar pro navegador de quem assinou.
async function criptografarPushWeb({ receptorPublicoBytes, authSecretBytes, payloadBytes }) {
  const parServidor = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const servidorPublicoBytes = new Uint8Array(await crypto.subtle.exportKey("raw", parServidor.publicKey));
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));

  const receptorPublico = await crypto.subtle.importKey("raw", receptorPublicoBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const segredoEcdh = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receptorPublico }, parServidor.privateKey, 256)
  );

  // Estágio 1: combina o segredo ECDH com as duas chaves públicas
  // (contexto "WebPush: info") pra virar o IKM do estágio 2.
  const infoWebPush = concatBytes(textoAscii("WebPush: info\0"), receptorPublicoBytes, servidorPublicoBytes);
  const ikm = await hkdf(authSecretBytes, segredoEcdh, infoWebPush, 32);

  // Estágio 2 (aes128gcm): deriva a chave de conteúdo (CEK) e o nonce a
  // partir do "salt" da mensagem + o IKM do estágio 1.
  const prk2 = await hmacSha256(saltBytes, ikm);
  const cek = await hkdfExpandUmBloco(prk2, textoAscii("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpandUmBloco(prk2, textoAscii("Content-Encoding: nonce\0"), 12);

  // Registro único (mensagem pequena): payload + 1 byte delimitador
  // (0x02 = "é o último/único registro"), cifrado com AES-128-GCM.
  const textoClaro = concatBytes(payloadBytes, new Uint8Array([2]));
  const chaveAesGcm = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const cifrado = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, chaveAesGcm, textoClaro)
  );

  // Cabeçalho aes128gcm: salt(16) + record-size(4, big-endian) + idlen(1) + keyid(chave pública do servidor)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const cabecalho = concatBytes(saltBytes, rs, new Uint8Array([servidorPublicoBytes.length]), servidorPublicoBytes);
  return concatBytes(cabecalho, cifrado);
}

// RFC 8292 (VAPID) -- assina um JWT curto (ES256) que identifica o PMOC
// ALECE pro serviço de push, sem precisar de nenhuma conta/API paga.
async function criarVapidJwt(audience, subject, privateJwk) {
  const chave = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const b64urlJson = (obj) => bytesParaB64url(textoAscii(JSON.stringify(obj)));
  const semAssinar =
    b64urlJson({ typ: "JWT", alg: "ES256" }) +
    "." +
    b64urlJson({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
  const assinatura = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chave, textoAscii(semAssinar));
  return semAssinar + "." + bytesParaB64url(new Uint8Array(assinatura));
}

// Manda o aviso push pra UMA inscrição -- devolve o status HTTP da
// resposta do serviço de push. 404/410 = "inscrição não existe mais"
// (normalmente a pessoa desinstalou o navegador ou limpou os dados dele);
// quem chama decide apagar o documento do Firestore nesse caso.
async function enviarNotificacaoPush(inscricao, payloadObj, privateJwk, env) {
  const corpoCifrado = await criptografarPushWeb({
    receptorPublicoBytes: b64urlParaBytes(inscricao.keys.p256dh),
    authSecretBytes: b64urlParaBytes(inscricao.keys.auth),
    payloadBytes: textoAscii(JSON.stringify(payloadObj)),
  });
  const origem = new URL(inscricao.endpoint).origin;
  const jwt = await criarVapidJwt(origem, env.VAPID_SUBJECT, privateJwk);

  const resp = await fetch(inscricao.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body: corpoCifrado,
  });
  return resp.status;
}

async function apagarInscricaoPush(uid, idToken, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/pushSubscriptions/${uid}`;
  await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${idToken}` } }).catch(() => {});
}

// Manda o aviso push pra todo mundo que ativou em "Minha conta" -- só
// quando tem aparelho atrasado de verdade (não faz sentido acordar o
// celular/computador de ninguém todo dia só pra dizer "está tudo bem").
// Se as chaves VAPID ainda não estiverem configuradas, não quebra o envio
// de e-mail por causa disso -- só pula o aviso push.
async function enviarNotificacoesPush(atrasados, idToken, env) {
  if (!atrasados.length) return { enviadas: 0, motivo: "Nada atrasado, não avisa." };
  if (!env.VAPID_PRIVATE_KEY_JWK || !env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) {
    return { enviadas: 0, motivo: "VAPID não configurado." };
  }

  const privateJwk = JSON.parse(env.VAPID_PRIVATE_KEY_JWK);
  const inscricoes = await listarColecao("pushSubscriptions", idToken, env);
  if (!inscricoes.length) return { enviadas: 0, motivo: "Ninguém ativou avisos push ainda." };

  const payload = {
    titulo: "PMOC ALECE",
    corpo:
      atrasados.length === 1
        ? "1 aparelho está atrasado hoje."
        : `${atrasados.length} aparelhos estão atrasados hoje.`,
  };
  let enviadas = 0;
  for (const inscricao of inscricoes) {
    try {
      const status = await enviarNotificacaoPush(inscricao, payload, privateJwk, env);
      if (status === 404 || status === 410) await apagarInscricaoPush(inscricao.id, idToken, env);
      else if (status >= 200 && status < 300) enviadas++;
      else console.error("Push recusado, status", status, "endpoint", inscricao.endpoint);
    } catch (err) {
      console.error("Falha ao enviar push pra", inscricao.id, err);
    }
  }
  return { enviadas, total: inscricoes.length };
}

async function rodarAvisoAtrasados(env) {
  const idToken = await loginComoRobo(env);
  const cicloId = await cicloAtualId(idToken, env);
  if (!cicloId) return { enviado: false, motivo: "Nenhum ciclo ativo encontrado." };

  const equipamentos = await listarColecao(`ciclos/${cicloId}/equipamentos`, idToken, env);
  const hoje = new Date();
  const hojeISO = hoje.toISOString().slice(0, 10);
  const hojeFormatado = hoje.toLocaleDateString("pt-BR");
  const atrasados = equipamentos.filter((e) => estaAtrasado(e, hojeISO));

  const html = montarEmailHtml(atrasados, hojeFormatado);
  const resultadoEnvio = await enviarEmail(html, atrasados.length, env);
  const resultadoPush = await enviarNotificacoesPush(atrasados, idToken, env).catch((err) => ({
    enviadas: 0,
    erro: err.message,
  }));
  return { enviado: true, atrasados: atrasados.length, resultadoEnvio, resultadoPush };
}

export default {
  // Roda sozinho, no horário configurado em Settings > Triggers > Cron Triggers.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rodarAvisoAtrasados(env));
  },

  // Também dá pra rodar manualmente visitando a URL do Worker no navegador.
  async fetch(request, env) {
    try {
      const resumo = await rodarAvisoAtrasados(env);
      return new Response(JSON.stringify({ ok: true, ...resumo }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, erro: err.message }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
