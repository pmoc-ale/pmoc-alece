// Worker Cloudflare — cópia automática dos dados do PMOC pra uma Planilha
// Google, E das fotos pra um bucket Cloudflare R2. Roda sozinho todo dia
// (Cron Trigger, configurado no painel da Cloudflare, não aqui no código) e
// serve quatro coisas de uma vez:
//   1. Uma "visão de banco de dados" de tudo que está no sistema, em
//      formato de planilha, filtrável.
//   2. Um backup dos DADOS fora do Firebase, atualizado automaticamente.
//   3. Um backup das FOTOS fora do Cloudinary, num bucket R2 que é seu
//      (independe da conta/plano do Cloudinary continuar existindo).
//   4. Uma fonte de dados pronta pra plugar no Looker Studio (BI) depois.
//
// Como funciona: usa uma "conta de serviço" do Google (Service Account) —
// diferente do login de uma pessoa, é uma credencial de robô que a gente
// autoriza a ler o Firestore inteiro e escrever numa planilha específica.
// As fotos usam um mecanismo separado (um "binding" R2 da própria
// Cloudflare) -- [2026-11] trocado do Google Drive pro R2 porque uma conta
// de serviço do Google NUNCA tem cota de armazenamento própria no Drive
// (só em "Shared Drives", que exige Google Workspace pago; confirmado em
// produção com o erro "Service Accounts do not have storage quota").
//
// Variáveis de ambiente que esse Worker precisa (Settings > Variables and
// Secrets, todas como "Secret", exceto FIREBASE_PROJECT_ID que pode ser
// texto normal):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   (do arquivo JSON da conta de serviço)
//   GOOGLE_PRIVATE_KEY             (idem — o campo "private_key" inteiro,
//                                    incluindo as linhas -----BEGIN/END-----)
//   FIREBASE_PROJECT_ID            (= "pcm-alece")
//   GOOGLE_SHEET_ID                (o ID da planilha — vem no link dela,
//                                    entre "/d/" e "/edit")
//   CHAVE_EXECUCAO_MANUAL          (senha inventada por você, pra proteger
//                                    o endpoint -- ver fetch() lá embaixo)
//
// Além dos secrets, esse Worker precisa de um BINDING (Settings > Bindings
// > Add > R2 bucket, nome do binding: "BUCKET") apontando pro bucket R2
// onde as fotos vão ficar. Crie o bucket antes em R2 > Create bucket.
//
// A planilha precisa ter 6 abas, com esses nomes exatos:
//   Equipamentos, Historico, Ordens, Auditoria, Feriados, Equipes
//
// A planilha precisa estar COMPARTILHADA (botão "Compartilhar") com o
// e-mail da conta de serviço, com permissão de Editor.
//
// O backup de fotos é incremental: cada dia só baixa e reenvia as fotos que
// ainda não estão no bucket (confere pelo nome do arquivo antes de
// reenviar), e processa no máximo MAX_FOTOS_POR_EXECUCAO novas por vez,
// pra não estourar o tempo de execução do Worker num dia em que tiver
// muita coisa nova de uma vez -- o que sobrar fica pro próximo dia, sem
// perder nada.

// Escopo "datastore" (não ".readonly") porque a API do Firestore precisa
// dele mesmo só pra ler -- quem realmente impede escrita é o papel "Cloud
// Datastore Viewer" dado à conta de serviço no IAM, não o escopo em si.
// (Fotos não usam mais escopo do Google -- ver nota em backupFotos sobre
// a troca pra Cloudflare R2.)
const ESCOPOS_GOOGLE = "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/spreadsheets";
const MAX_FOTOS_POR_EXECUCAO = 60;

function base64Url(bytes) {
  let binario = "";
  bytes.forEach((b) => (binario += String.fromCharCode(b)));
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlTexto(texto) {
  return base64Url(new TextEncoder().encode(texto));
}

async function importarChavePrivada(pem) {
  const corpo = pem
    .replace(/\\n/g, "\n") // caso a quebra de linha tenha vindo como texto "\n" em vez de quebra de linha de verdade
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const bytes = Uint8Array.from(atob(corpo), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

// Autentica como a conta de serviço e devolve um token de acesso do Google,
// válido por 1 hora, com permissão de ler o Firestore e escrever na planilha.
async function obterAccessTokenGoogle(env) {
  const agora = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: ESCOPOS_GOOGLE,
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  };
  const semAssinar = `${base64UrlTexto(JSON.stringify(header))}.${base64UrlTexto(JSON.stringify(claimSet))}`;
  const chave = await importarChavePrivada(env.GOOGLE_PRIVATE_KEY);
  const assinatura = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    chave,
    new TextEncoder().encode(semAssinar)
  );
  const jwt = `${semAssinar}.${base64Url(new Uint8Array(assinatura))}`;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  const dados = await resp.json();
  if (!resp.ok) throw new Error("Falha ao autenticar com o Google: " + (dados.error_description || dados.error));
  return dados.access_token;
}

// Converte o formato "tipado" do Firestore (campo.stringValue,
// campo.integerValue etc) num objeto JS comum.
function lerValorFirestore(valor) {
  if (valor.stringValue !== undefined) return valor.stringValue;
  if (valor.integerValue !== undefined) return Number(valor.integerValue);
  if (valor.doubleValue !== undefined) return valor.doubleValue;
  if (valor.booleanValue !== undefined) return valor.booleanValue;
  if (valor.arrayValue !== undefined) {
    return (valor.arrayValue.values || []).map(lerValorFirestore).join(", ");
  }
  if (valor.nullValue !== undefined) return "";
  return "";
}

function documentoParaObjeto(doc) {
  const obj = { id: doc.name.split("/").pop() };
  const campos = doc.fields || {};
  for (const chave of Object.keys(campos)) {
    obj[chave] = lerValorFirestore(campos[chave]);
  }
  return obj;
}

async function listarColecao(caminho, token, env) {
  const documentos = [];
  let pageToken = "";
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${caminho}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const dados = await resp.json();
    if (!resp.ok) throw new Error(`Falha ao ler ${caminho}: ${dados.error?.message || resp.status}`);
    (dados.documents || []).forEach((doc) => documentos.push(documentoParaObjeto(doc)));
    pageToken = dados.nextPageToken || "";
  } while (pageToken);
  return documentos;
}

async function cicloAtualId(token, env) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/ciclos?orderBy=criadoEm desc&pageSize=1`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const dados = await resp.json();
  if (!resp.ok || !dados.documents?.length) return null;
  return dados.documents[0].name.split("/").pop();
}

async function escreverAba(nomeAba, colunas, linhas, token, env) {
  const valores = [colunas, ...linhas.map((obj) => colunas.map((c) => (obj[c] ?? "").toString()))];
  const range = `${nomeAba}!A1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const resp = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: valores }),
  });
  if (!resp.ok) {
    const erro = await resp.json().catch(() => ({}));
    throw new Error(`Falha ao escrever na aba ${nomeAba}: ${erro.error?.message || resp.status}`);
  }
}

// [2026-11] Trocado de Google Drive pra Cloudflare R2: uma conta de
// serviço do Google NUNCA tem cota de armazenamento própria (mesmo com a
// pasta compartilhada como Editor) -- só consegue gravar em "Shared
// Drives", que só existe em contas Google Workspace pagas. Como o
// pmoc.alece.sistemas@gmail.com é um Gmail comum, não tinha como salvar
// foto no Drive de jeito nenhum. R2 resolve isso: é um espaço de arquivo
// da própria Cloudflare (10 GB grátis), acessado via "binding" (ver
// "BUCKET" no fetch() lá embaixo), sem precisar de token nem conta do
// Google pra essa parte.

// Lista os nomes de arquivo já presentes no bucket (paginado -- um bucket
// com muita foto não cabe numa página só). Só o nome, que é tudo que
// precisamos pra decidir o que já foi feito.
async function nomesJaNoBucket(env) {
  const nomes = new Set();
  let cursor;
  do {
    const pagina = await env.BUCKET.list({ cursor });
    pagina.objects.forEach((o) => nomes.add(o.key));
    cursor = pagina.truncated ? pagina.cursor : undefined;
  } while (cursor);
  return nomes;
}

// Baixa a foto (URL pública do Cloudinary, sem precisar de autenticação) e
// grava no bucket R2 com esse mesmo nome.
async function copiarFotoParaR2(url, nomeArquivo, env) {
  const respFoto = await fetch(url);
  if (!respFoto.ok) throw new Error(`Falha ao baixar a foto (${respFoto.status})`);
  const bytes = await respFoto.arrayBuffer();
  await env.BUCKET.put(nomeArquivo, bytes, { httpMetadata: { contentType: "image/jpeg" } });
}

// Reúne as fotos de equipamentos/histórico/ordens, acha quais ainda não
// foram copiadas pro R2, e copia até o limite de uma execução. O nome
// do arquivo é estável (baseado no id do documento) -- rodar de novo não
// duplica nada, só preenche o que faltou.
async function backupFotos(equipamentos, historico, ordens, env) {
  if (!env.BUCKET) return { pulado: "Bucket R2 não configurado (falta o binding \"BUCKET\" em Settings > Bindings)" };

  const candidatos = [
    ...equipamentos.filter((e) => e.fotoUrl).map((e) => ({ url: e.fotoUrl, nome: `equipamento_${e.patrimonio || e.id}.jpg` })),
    ...historico.filter((h) => h.fotoUrl).map((h) => ({ url: h.fotoUrl, nome: `historico_${h.id}.jpg` })),
    ...ordens.filter((o) => o.fotoUrl).map((o) => ({ url: o.fotoUrl, nome: `ordem_${o.id}.jpg` })),
  ];

  const jaExistentes = await nomesJaNoBucket(env);
  const faltando = candidatos.filter((c) => !jaExistentes.has(c.nome));
  const paraEnviarAgora = faltando.slice(0, MAX_FOTOS_POR_EXECUCAO);

  let enviadas = 0;
  const falhas = [];
  for (const foto of paraEnviarAgora) {
    try {
      await copiarFotoParaR2(foto.url, foto.nome, env);
      enviadas++;
    } catch (err) {
      falhas.push({ nome: foto.nome, erro: err.message });
    }
  }

  return {
    totalNoSistema: candidatos.length,
    jaBackupeadas: jaExistentes.size,
    enviadasAgora: enviadas,
    aindaFaltando: Math.max(0, faltando.length - enviadas),
    falhas,
  };
}

async function rodarBackup(env) {
  const token = await obterAccessTokenGoogle(env);
  const cicloId = await cicloAtualId(token, env);

  const [equipamentos, historico, ordens, auditoria, feriados, equipes] = await Promise.all([
    cicloId ? listarColecao(`ciclos/${cicloId}/equipamentos`, token, env) : [],
    cicloId ? listarColecao(`ciclos/${cicloId}/historico`, token, env) : [],
    cicloId ? listarColecao(`ciclos/${cicloId}/ordens`, token, env) : [],
    listarColecao("auditoria", token, env),
    listarColecao("feriados", token, env),
    listarColecao("equipes", token, env),
  ]);

  await escreverAba("Equipamentos", [
    "id", "patrimonio", "setor", "ambiente", "local", "setorPCM", "equipeResponsavel",
    "statusPreventiva", "dataAgendada", "diaPlanejado", "semanaPlanejada", "origem",
    "marca", "modelo", "capacidade", "tipoGas", "observacao", "fotoUrl",
  ], equipamentos, token, env);

  await escreverAba("Historico", [
    "id", "equipamentoId", "patrimonio", "setor", "ambiente", "local", "equipe", "usuario",
    "tipo", "statusAnterior", "statusNovo", "fotoUrl", "registradoEm",
  ], historico, token, env);

  await escreverAba("Ordens", [
    "id", "equipamentoId", "patrimonio", "setor", "ambiente", "local", "equipe",
    "dataAgendada", "status", "tecnico", "avaliacaoEstrelas", "checklist", "registradoEm",
  ], ordens, token, env);

  await escreverAba("Auditoria", [
    "id", "acao", "detalhes", "usuario", "registradoEm",
  ], auditoria, token, env);

  await escreverAba("Feriados", [
    "id", "tipo", "label", "dataInicio", "dataFim",
  ], feriados, token, env);

  await escreverAba("Equipes", [
    "id", "predio", "ordem", "nome",
  ], equipes, token, env);

  const fotos = await backupFotos(equipamentos, historico, ordens, env);

  return {
    equipamentos: equipamentos.length,
    historico: historico.length,
    ordens: ordens.length,
    auditoria: auditoria.length,
    feriados: feriados.length,
    equipes: equipes.length,
    fotos,
  };
}

export default {
  // Roda sozinho, no horário configurado em Settings > Triggers > Cron Triggers
  // -- não passa pelo fetch() abaixo, então não precisa da chave.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rodarBackup(env));
  },

  // Também dá pra rodar manualmente visitando a URL do Worker no navegador
  // (útil pra testar sem esperar o horário programado) -- mas só com a
  // chave certa em ?chave=..., senão qualquer pessoa que descobrisse essa
  // URL conseguiria disparar o backup (ler o Firestore, escrever na
  // planilha, baixar fotos) sem estar logada no sistema. Configure
  // CHAVE_EXECUCAO_MANUAL em Settings > Variables and Secrets (tipo
  // Secret) com um valor longo e aleatório.
  async fetch(request, env) {
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ ok: false, erro: "Método não permitido." }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }
    const chave = new URL(request.url).searchParams.get("chave");
    if (!env.CHAVE_EXECUCAO_MANUAL || chave !== env.CHAVE_EXECUCAO_MANUAL) {
      return new Response(JSON.stringify({ ok: false, erro: "Não autorizado. Visite a URL com ?chave=SUA_CHAVE (configurada nas Variables and Secrets do Worker)." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    try {
      const resumo = await rodarBackup(env);
      return new Response(JSON.stringify({ ok: true, resumo }, null, 2), {
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
