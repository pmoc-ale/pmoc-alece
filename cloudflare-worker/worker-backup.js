// Worker Cloudflare — cópia automática dos dados do PMOC pra uma Planilha
// Google, E das fotos pra uma pasta do Google Drive. Roda sozinho todo dia
// (Cron Trigger, configurado no painel da Cloudflare, não aqui no código) e
// serve quatro coisas de uma vez:
//   1. Uma "visão de banco de dados" de tudo que está no sistema, em
//      formato de planilha, filtrável.
//   2. Um backup dos DADOS fora do Firebase, atualizado automaticamente.
//   3. Um backup das FOTOS fora do Cloudinary, numa pasta do Drive que é
//      sua (independe da conta/plano do Cloudinary continuar existindo).
//   4. Uma fonte de dados pronta pra plugar no Looker Studio (BI) depois.
//
// Como funciona: usa uma "conta de serviço" do Google (Service Account) —
// diferente do login de uma pessoa, é uma credencial de robô que a gente
// autoriza a ler o Firestore inteiro, escrever numa planilha específica e
// enviar arquivo pra uma pasta específica do Drive.
//
// Variáveis de ambiente que esse Worker precisa (Settings > Variables and
// Secrets, todas como "Secret", exceto a última que pode ser texto normal):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   (do arquivo JSON da conta de serviço)
//   GOOGLE_PRIVATE_KEY             (idem — o campo "private_key" inteiro,
//                                    incluindo as linhas -----BEGIN/END-----)
//   FIREBASE_PROJECT_ID            (= "pcm-alece")
//   GOOGLE_SHEET_ID                (o ID da planilha — vem no link dela,
//                                    entre "/d/" e "/edit")
//   GOOGLE_DRIVE_FOLDER_ID         (o ID da pasta do Drive pras fotos —
//                                    vem no link dela, depois de "/folders/")
//
// A planilha precisa ter 6 abas, com esses nomes exatos:
//   Equipamentos, Historico, Ordens, Auditoria, Feriados, Equipes
//
// A planilha E a pasta do Drive precisam estar COMPARTILHADAS (botão
// "Compartilhar") com o e-mail da conta de serviço, com permissão de Editor.
//
// O backup de fotos é incremental: cada dia só baixa e reenvia as fotos que
// ainda não estão na pasta (confere pelo nome do arquivo antes de reenviar),
// e processa no máximo MAX_FOTOS_POR_EXECUCAO novas por vez, pra não
// estourar o tempo de execução do Worker num dia em que tiver muita coisa
// nova de uma vez -- o que sobrar fica pro próximo dia, sem perder nada.

// Escopo "datastore" (não ".readonly") porque a API do Firestore precisa
// dele mesmo só pra ler -- quem realmente impede escrita é o papel "Cloud
// Datastore Viewer" dado à conta de serviço no IAM, não o escopo em si.
// "drive" (não "drive.file") porque precisa LISTAR o que já existe na pasta
// antes de decidir o que falta enviar -- "drive.file" só enxergaria os
// arquivos que o próprio Worker criou nessa sessão, não os de execuções
// anteriores.
const ESCOPOS_GOOGLE = "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";
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

// Lista os nomes de arquivo já presentes na pasta do Drive (paginado --
// uma pasta com muita foto não cabe numa página só). Só o nome, que é
// tudo que precisamos pra decidir o que já foi feito.
async function nomesJaNaPasta(token, env) {
  const nomes = new Set();
  let pageToken = "";
  do {
    const q = encodeURIComponent(`'${env.GOOGLE_DRIVE_FOLDER_ID}' in parents and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(name)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const dados = await resp.json();
    if (!resp.ok) throw new Error("Falha ao listar a pasta do Drive: " + (dados.error?.message || resp.status));
    (dados.files || []).forEach((f) => nomes.add(f.name));
    pageToken = dados.nextPageToken || "";
  } while (pageToken);
  return nomes;
}

// Baixa a foto (URL pública do Cloudinary, sem precisar de autenticação) e
// sobe pro Drive via upload multipart (metadado + bytes na mesma
// requisição) -- mais simples que o upload resumível, e o tamanho de uma
// foto já comprimida pelo app (ver comprimirImagem em app.js) é pequeno o
// bastante pra não precisar dele.
async function copiarFotoParaDrive(url, nomeArquivo, token, env) {
  const respFoto = await fetch(url);
  if (!respFoto.ok) throw new Error(`Falha ao baixar a foto (${respFoto.status})`);
  const bytes = await respFoto.arrayBuffer();

  const metadados = { name: nomeArquivo, parents: [env.GOOGLE_DRIVE_FOLDER_ID] };
  const boundary = "pmocbackup" + Date.now();
  const partes = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadados)}\r\n`,
    `--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
  ];
  const corpo = new Blob([partes[0], partes[1], bytes, `\r\n--${boundary}--`]);

  const resp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: corpo,
  });
  if (!resp.ok) {
    const erro = await resp.json().catch(() => ({}));
    throw new Error(`Falha ao enviar ${nomeArquivo} pro Drive: ${erro.error?.message || resp.status}`);
  }
}

// Reúne as fotos de equipamentos/histórico/ordens, acha quais ainda não
// foram copiadas pro Drive, e copia até o limite de uma execução. O nome
// do arquivo é estável (baseado no id do documento) -- rodar de novo não
// duplica nada, só preenche o que faltou.
async function backupFotos(equipamentos, historico, ordens, token, env) {
  if (!env.GOOGLE_DRIVE_FOLDER_ID) return { pulado: "GOOGLE_DRIVE_FOLDER_ID não configurado" };

  const candidatos = [
    ...equipamentos.filter((e) => e.fotoUrl).map((e) => ({ url: e.fotoUrl, nome: `equipamento_${e.patrimonio || e.id}.jpg` })),
    ...historico.filter((h) => h.fotoUrl).map((h) => ({ url: h.fotoUrl, nome: `historico_${h.id}.jpg` })),
    ...ordens.filter((o) => o.fotoUrl).map((o) => ({ url: o.fotoUrl, nome: `ordem_${o.id}.jpg` })),
  ];

  const jaExistentes = await nomesJaNaPasta(token, env);
  const faltando = candidatos.filter((c) => !jaExistentes.has(c.nome));
  const paraEnviarAgora = faltando.slice(0, MAX_FOTOS_POR_EXECUCAO);

  let enviadas = 0;
  const falhas = [];
  for (const foto of paraEnviarAgora) {
    try {
      await copiarFotoParaDrive(foto.url, foto.nome, token, env);
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

  const fotos = await backupFotos(equipamentos, historico, ordens, token, env);

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
