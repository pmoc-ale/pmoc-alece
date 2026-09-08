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
  return "";
}
function documentoParaObjeto(doc) {
  const obj = { id: doc.name.split("/").pop() };
  const campos = doc.fields || {};
  for (const chave of Object.keys(campos)) obj[chave] = lerValorFirestore(campos[chave]);
  return obj;
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
  return { enviado: true, atrasados: atrasados.length, resultadoEnvio };
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
