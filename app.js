import { db, auth, firebaseConfig } from "./firebase-config.js?v=4";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  collection, collectionGroup, doc, setDoc, getDoc, getDocs, onSnapshot, updateDoc, query,
  orderBy, where, writeBatch, deleteDoc, addDoc, limit, deleteField, runTransaction, FieldPath,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  setPersistence, inMemoryPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

const SUFIXO_LOGIN = "@pcm-alece.local";
function usuarioParaEmail(usuario) {
  return usuario.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "") + SUFIXO_LOGIN;
}
function extrairUsuario(email) {
  return String(email || "").split("@")[0];
}

const PRIORIDADE = {
  "1 - Presidência": 1, "2 - Primeiro Secretário": 2, "3 - Gabinetes": 3,
  "4 - TI/Racks": 4, "5 - Plenário": 5, "6 - Administração": 6, "7 - Todo o resto": 7,
};
const NOMES_DIAS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const STATUS_VALIDOS = ["Pendente", "Em andamento", "Concluída"];
const ROTULOS_PERMISSAO = { admin: "Administrador", padrao: "Padrão", trabalhador: "Trabalhador" };
const CHAVE_VERIFICACAO_ATRASADOS = "PMOCVerificacaoAtrasados";

const CHECKLIST_PREVENTIVA = [
  "Limpeza do filtro de ar",
  "Limpeza da serpentina evaporadora",
  "Limpeza da serpentina condensadora",
  "Verificação e limpeza do dreno de condensado",
  "Verificação da pressão do gás refrigerante",
  "Verificação de vazamentos",
  "Verificação das conexões e fiação elétrica",
  "Verificação da fixação/suportes da unidade",
  "Teste de funcionamento geral",
];

const MARCAS_CONDENSADORA = ["Midea", "Springer", "Carrier", "LG", "Komeco", "Philco", "Elgin", "Hitachi"];
const CAPACIDADES_CONDENSADORA = [
  "7.500 BTU/h", "9.000 BTU/h", "12.000 BTU/h", "18.000 BTU/h", "22.000 BTU/h",
  "24.000 BTU/h", "30.000 BTU/h", "32.000 BTU/h", "36.000 BTU/h", "48.000 BTU/h",
  "56.000 BTU/h", "60.000 BTU/h",
];
const ESPESSURAS_FIO = ["2.5mm", "4mm", "6mm"];
const MODELOS_EVAPORADORA = ["Split Hi-Wall", "Split Inverter", "Cassete", "Piso-Teto"];
const GASES_REFRIGERANTES = ["R22", "R410A", "R32", "R404A", "R134a"];
const MESES_CICLO = 4;

async function calcularProximaData(item) {
  const local = item.local || "SEDE";
  const cap = (ESTADO.config?.capacidades || {})[local] || { nEquipes: 1, aparelhosDia: 2 };
  const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);
  const diasSemana = (ESTADO.config && ESTADO.config.diasSemana) || 5;
  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  const ehDiaUtilLocal = (dt) => DIAS_UTEIS.includes(NOMES_DIAS[(dt.getDay() + 6) % 7]) && !estaEmFeriado(dt);

  const [a, m, d] = item.dataAgendada.split("-");
  let cursor = adicionarMeses(new Date(a, parseInt(m, 10) - 1, d, 12, 0, 0), ESTADO.configSite.mesesCiclo);
  while (!ehDiaUtilLocal(cursor)) cursor.setDate(cursor.getDate() + 1);

  // Conta quantos outros aparelhos do mesmo prédio já têm a próxima
  // preventiva marcada nesse dia, pra não estourar a capacidade.
  const contarNoDia = (iso) =>
    ESTADO.equipamentos.filter((e) => e.id !== item.id && (e.local || "SEDE") === local && e.proximaPreventiva === iso).length;

  while (!ehDiaUtilLocal(cursor) || contarNoDia(formatISO(cursor)) >= capacidadeDia) {
    cursor.setDate(cursor.getDate() + 1);
  }
  return { data: formatISO(cursor), dia: NOMES_DIAS[(cursor.getDay() + 6) % 7] };
}

function adicionarMeses(date, meses) {
  const d = new Date(date.getTime());
  const diaOriginal = d.getDate();
  d.setMonth(d.getMonth() + meses);
  if (d.getDate() !== diaOriginal) d.setDate(0);
  return d;
}
let idEquipamentoEmEdicao = null;

function identificarSetor(setorTxt, ambienteTxt) {
  const texto = `${setorTxt || ""} ${ambienteTxt || ""}`.toUpperCase();
  if (/PRESID/.test(texto)) return "1 - Presidência";
  if (/1[ºªA]?\s*SECRETARIA|SECRETARI[OA]/.test(texto)) return "2 - Primeiro Secretário";
  if (/\bGABINETE\b/.test(texto)) return "3 - Gabinetes";
  if (/\bSERVIDOR\b|\bREDE\b|INFRAESTRUTURA|\bRACK\b|\bCPD\b|DESENVOLVIMENTO/.test(texto)) return "4 - TI/Racks";
  if (/PLEN[ÁA]RIO/.test(texto)) return "5 - Plenário";
  if (/PROTOCOLO|REPROGRAFIA|ADMINISTR/.test(texto)) return "6 - Administração";
  return "7 - Todo o resto";
}

function descobrirPiso(setorTxt) {
  if (!setorTxt) return 99;
  const texto = String(setorTxt).toUpperCase();
  if (texto.includes("SUBSOLO") || texto.includes("TÉRREO") || texto.includes("TERREO")) return 0;
  const m = texto.match(/(\d+)\s*[ºÂ°]?\s*PISO/);
  if (m) return parseInt(m[1], 10);
  return 99;
}

function normalizarStatus(valor) {
  const t = String(valor || "").trim().toUpperCase();
  if (t.includes("CONCL")) return "Concluída";
  if (t.includes("ANDAMENTO") || t.includes("EXECU")) return "Em andamento";
  return "Pendente";
}

function localizarColuna(nomesPossiveis, headers) {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const nome of nomesPossiveis) {
    const idx = lower.indexOf(nome.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  for (const h of headers) {
    for (const nome of nomesPossiveis) {
      if (h.toUpperCase().includes(nome.toUpperCase())) return h;
    }
  }
  return null;
}

function formatISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function formatarDataBR(iso) {
  if (!iso) return "-";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}
// Um aparelho é considerado atrasado quando a data agendada já passou e ele ainda não foi marcado como Concluída.
function estaAtrasado(item) {
  if (!item.dataAgendada || item.statusPreventiva === "Concluída") return false;
  return item.dataAgendada < formatISO(new Date());
}

// Assina/envia fotos via um Worker da Cloudflare (não pelo Firebase Storage —
// exigiria plano pago só pra habilitar). O Worker confere se quem está
// pedindo está de verdade logado e não bloqueado antes de autorizar o envio;
// a "senha" do Cloudinary nunca fica exposta no navegador. Troque a URL
// abaixo pela do seu Worker depois de publicá-lo.
const URL_UPLOAD_FOTO = "https://fotos.pmoc-alece-sistemas.workers.dev";

// Redimensiona/comprime a foto no navegador ANTES de enviar — senão uma
// foto de celular (4-8MB) come a cota gratuita rapidinho.
function comprimirImagem(file, larguraMax = 1280, qualidade = 0.75) {
  return new Promise((resolve, reject) => {
    const imagem = new Image();
    const urlTemp = URL.createObjectURL(file);
    imagem.onload = () => {
      const escala = Math.min(1, larguraMax / imagem.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(imagem.width * escala);
      canvas.height = Math.round(imagem.height * escala);
      canvas.getContext("2d").drawImage(imagem, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(urlTemp);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Falha ao comprimir a imagem."))),
        "image/jpeg",
        qualidade
      );
    };
    imagem.onerror = () => { URL.revokeObjectURL(urlTemp); reject(new Error("Não consegui ler essa imagem.")); };
    imagem.src = urlTemp;
  });
}

// Pede uma assinatura autorizada ao Worker e envia a foto (já comprimida)
// direto pro Cloudinary. `destino` é { folder } para o histórico de
// preventivas, ou { publicId, overwrite: true } pra sobrescrever a foto
// fixa do equipamento.
async function enviarFoto(file, destino) {
  const blobComprimido = await comprimirImagem(file);
  const idToken = await auth.currentUser.getIdToken();

  const respAssinatura = await fetch(URL_UPLOAD_FOTO, {
    method: "POST",
    headers: { Authorization: "Bearer " + idToken, "Content-Type": "application/json" },
    body: JSON.stringify(destino || {}),
  });
  if (!respAssinatura.ok) {
    const erro = await respAssinatura.json().catch(() => ({}));
    throw new Error(erro.erro || "Não autorizado a enviar foto.");
  }
  const assinatura = await respAssinatura.json();

  const formData = new FormData();
  formData.append("file", blobComprimido, "foto.jpg");
  formData.append("api_key", assinatura.apiKey);
  formData.append("timestamp", assinatura.timestamp);
  formData.append("signature", assinatura.signature);
  if (assinatura.folder) formData.append("folder", assinatura.folder);
  if (assinatura.publicId) formData.append("public_id", assinatura.publicId);
  if (assinatura.overwrite) formData.append("overwrite", assinatura.overwrite);

  const respUpload = await fetch(`https://api.cloudinary.com/v1_1/${assinatura.cloudName}/image/upload`, {
    method: "POST",
    body: formData,
  });
  if (!respUpload.ok) throw new Error("Falha ao enviar a foto.");
  const dados = await respUpload.json();
  return dados.secure_url;
}

const ESTADO = {
  meta: null,
  itensCarregados: [],
  equipamentos: [],
  feriados: [],
  ordens: [],
  auditoria: [],
  historico: [],
  chamadosCorretivos: [],
  usuarioNome: null,
  permissao: "padrao",
configSite: { mesesCiclo: MESES_CICLO, urlCorretivas: "", predios: ["SEDE", "ANEXO 1", "ANEXO 2", "ANEXO 3", "ANEXO 4"], fotoObrigatoria: false },
  // Ligado enquanto a tela de Cronograma está mostrando só o(s) prédio(s)
  // novo(s) de uma planilha (fluxo de "adicionar", não o de gerar tudo do
  // zero) -- ver processarArquivo/confirmarAdicaoPredioNovo.
  modoAdicionarPredio: false,
  itensParaAdicionarPredio: null,
  backupPlanilha: null,
  selecaoEquipamentos: new Set(),
  selecaoHistorico: new Set(),
  equipes: [],
  selecaoOrdens: new Set(),
  usuarios: [],
  ordenacaoEquipamentos: null,
  chamadosCorretivosCarregadosEm: null,
  usuarioEmail: null,
  cicloAtual: null,
  ciclos: [],
  unsubscribeCiclos: null,
  fechandoCiclo: false,
  config: null,
  filtros: { equipamentos: "", feriados: "", ordens: "", historico: "" },
  unsubscribe: null,
  unsubscribeFeriados: null,
  unsubscribeOrdens: null,
  unsubscribeHistorico: null,
  calYear: null,
  calMonth: null,
  diaSelecionado: null,
  localFiltro: "Todos",
  diasVaziosCronograma: [],
  plantaSelecionada: null,
  plantas: [],
  unsubscribePlantas: null,
  plantaFiltroStatus: "",
};

// Cada planta cadastrada (coleção "plantas" no Firestore) é amarrada a um
// prédio (o mesmo valor usado no campo "Prédio" do equipamento) -- é o que
// restringe a lista de aparelhos pra marcar nela. O desenho vetorial em si
// (linhas/camadas, pesado demais pra um documento do Firestore) fica
// hospedado no Cloudinary como um JSON "raw"; o Firestore só guarda o link
// (dadosUrl) e os metadados. _dadosPlantaCache guarda, na memória da aba
// aberta, o JSON já baixado de cada planta (pra não rebaixar toda hora).
const _dadosPlantaCache = new Map();

function plantaPorId(id) {
  return ESTADO.plantas.find((p) => p.id === id) || ESTADO.plantas[0];
}

function iniciarSincronizacaoPlantas() {
  if (ESTADO.unsubscribePlantas) ESTADO.unsubscribePlantas();
  ESTADO.unsubscribePlantas = onSnapshot(collection(db, "plantas"), (snap) => {
    ESTADO.plantas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderLocalizacao();
  }, (err) => {
    console.error("Erro ao ler plantas:", err);
  });
}

// Baixa (e guarda em cache) o desenho vetorial completo de uma planta.
async function carregarDadosPlanta(planta) {
  if (_dadosPlantaCache.has(planta.id)) return _dadosPlantaCache.get(planta.id);
  const resp = await fetch(planta.dadosUrl);
  if (!resp.ok) throw new Error("Não consegui baixar o desenho dessa planta.");
  const dados = await resp.json();
  _dadosPlantaCache.set(planta.id, dados);
  return dados;
}

// ------------------------------------------------------------------
// Vínculo evaporadora <-> condensadora por CÓDIGO, não por clique par a
// par. A condensadora normalmente fica numa planta totalmente diferente
// (cobertura), então marcar as duas de uma vez, aparelho por aparelho,
// obrigava a ficar trocando de planta e caçando o aparelho certo numa
// lista toda vez. Do jeito que ficou: as condensadoras de uma planta são
// marcadas com o código de verdade delas (o mesmo que já está desenhado
// na planta, tipo "C7") -- sem escolher aparelho nenhum -- e uma
// evaporadora com "Código na planta" = "E1/C7" acha essa condensadora
// sozinha, sem precisar de nenhum passo extra de vínculo manual.
// ------------------------------------------------------------------
function normalizarCodigo(c) {
  return String(c || "").trim().toUpperCase();
}

// De "E1/C7" (ou "E1 / C7") tira só a parte da condensadora ("C7").
function extrairCodigoCondensadora(codigoPlanta) {
  const partes = String(codigoPlanta || "").split("/");
  if (partes.length < 2) return null;
  const codigo = partes[1].trim();
  return codigo || null;
}

// Procura em TODAS as plantas cadastradas (a condensadora pode estar em
// qualquer uma) uma condensadora marcada com esse código.
function buscarCondensadoraPorCodigo(codigo) {
  const alvo = normalizarCodigo(codigo);
  if (!alvo) return null;
  for (const planta of ESTADO.plantas) {
    const achada = (planta.condensadoras || []).find((c) => normalizarCodigo(c.codigo) === alvo);
    if (achada) return { ...achada, plantaId: planta.id };
  }
  return null;
}

// Condensadora vinculada a UM equipamento específico -- por código
// (fonte principal) ou, se não achar nada por código, pelos campos
// antigos de vínculo direto (condensadoraPlantaId/X/Y), pra não perder
// nada que já tenha sido marcado do jeito antigo antes dessa mudança.
function condensadoraDoEquipamento(item) {
  const codigo = extrairCodigoCondensadora(item.codigoPlanta);
  if (codigo) {
    const achada = buscarCondensadoraPorCodigo(codigo);
    if (achada) return achada;
  }
  if (item.condensadoraPlantaId && item.condensadoraX != null) {
    return { plantaId: item.condensadoraPlantaId, x: item.condensadoraX, y: item.condensadoraY, codigo: null };
  }
  return null;
}

// Caminho inverso: todas as evaporadoras cadastradas cujo "Código na
// planta" aponta pra essa condensadora.
function evaporadorasQueApontamPara(codigo) {
  const alvo = normalizarCodigo(codigo);
  if (!alvo) return [];
  return ESTADO.equipamentos.filter((e) => normalizarCodigo(extrairCodigoCondensadora(e.codigoPlanta)) === alvo);
}
const URL_CHAMADOS_CORRETIVOS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vR2Ysf9JofZL_2Xn_JPJFaPrMX6IGiwMQWFyhgJcqu8BK_4imC_lmrMgfpDWLnI6MIdcC0OYSDUQFPw/pub?gid=1978174237&single=true&output=csv";
ESTADO.configSite.urlCorretivas = URL_CHAMADOS_CORRETIVOS;
const INTERVALO_ATUALIZACAO_CORRETIVOS_MS = 5 * 60 * 1000; 

const COL_CORRETIVA = {
  DATA: 0, EQUIPE: 1, CHAMADO: 2, ANEXO: 4,
  GABINETE: 6, SALA: 7, NOME_SETOR: 8, SALA_SETOR: 9,
  TOMBO: 12, TAG: 13,
  SEDE: 23, ANEXO1: 24, ANEXO2: 25, ANEXO3: 26, ANEXO4: 27,
  SOLUCIONADO: 28, DESCRICAO_PROBLEMA: 29, PECA_FALTANTE: 30,
};

function converterDataCorretiva(valor) {
  if (typeof valor === "number") {
    const ms = Math.round((valor - 25569) * 86400 * 1000);
    return new Date(ms);
  }
  if (typeof valor === "string" && valor.trim()) {
    const m = valor.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const [, d, mo, y, h, mi, s] = m;
      return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
    }
  }
  return null;
}

function formatarDataHoraCorretiva(dataObj) {
  if (!dataObj) return "-";
  const dia = String(dataObj.getDate()).padStart(2, "0");
  const mes = String(dataObj.getMonth() + 1).padStart(2, "0");
  const ano = dataObj.getFullYear();
  const hora = String(dataObj.getHours()).padStart(2, "0");
  const min = String(dataObj.getMinutes()).padStart(2, "0");
  return `${dia}/${mes}/${ano} ${hora}:${min}`;
}

// Parser de CSV simples, sem depender do XLSX (que tenta "adivinhar" tipo de
// célula e converte datas assumindo formato americano mês/dia, bagunçando as
// datas em dd/mm/aaaa da planilha de corretivos). Trata campos entre aspas
// (podem conter vírgula) e aspas duplicadas ("") como aspas literais.
function parseCSV(texto) {
  const linhas = [];
  let linha = [];
  let campo = "";
  let dentroDeAspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroDeAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else dentroDeAspas = false;
      } else {
        campo += c;
      }
    } else if (c === '"') {
      dentroDeAspas = true;
    } else if (c === ",") {
      linha.push(campo);
      campo = "";
    } else if (c === "\r") {
      // ignora — a quebra de linha real é tratada no \n
    } else if (c === "\n") {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
    } else {
      campo += c;
    }
  }
  if (campo !== "" || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

async function carregarChamadosCorretivos(forcar) {
  const agora = Date.now();
  if (!forcar && ESTADO.chamadosCorretivosCarregadosEm &&
      (agora - ESTADO.chamadosCorretivosCarregadosEm) < INTERVALO_ATUALIZACAO_CORRETIVOS_MS) {
    return;
  }
  try {
    const resp = await fetch(ESTADO.configSite.urlCorretivas || URL_CHAMADOS_CORRETIVOS, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const texto = await resp.text();
    const linhas = parseCSV(texto);
    const dados = linhas.slice(1);

    ESTADO.chamadosCorretivos = dados.map((linha) => {
      const localAdicional = [linha[COL_CORRETIVA.SEDE], linha[COL_CORRETIVA.ANEXO1],
        linha[COL_CORRETIVA.ANEXO2], linha[COL_CORRETIVA.ANEXO3], linha[COL_CORRETIVA.ANEXO4]]
        .find((v) => String(v || "").trim()) || "";
      const dataObj = converterDataCorretiva(linha[COL_CORRETIVA.DATA]);
      return {
        data: dataObj ? dataObj.toISOString() : "", // formato que ordena certo
        dataFormatada: formatarDataHoraCorretiva(dataObj), // formato que aparece na tela
        equipe: linha[COL_CORRETIVA.EQUIPE] || "",
        chamado: linha[COL_CORRETIVA.CHAMADO] || "",
        anexo: String(linha[COL_CORRETIVA.ANEXO] || "").trim(),
        gabinete: linha[COL_CORRETIVA.GABINETE] || "",
        sala: linha[COL_CORRETIVA.SALA] || "",
        nomeSetor: linha[COL_CORRETIVA.NOME_SETOR] || "",
        salaSetor: linha[COL_CORRETIVA.SALA_SETOR] || "",
        localAdicional,
        tombo: String(linha[COL_CORRETIVA.TOMBO] || "").trim(),
        tag: String(linha[COL_CORRETIVA.TAG] || "").trim(),
        solucionado: linha[COL_CORRETIVA.SOLUCIONADO] || "",
        descricaoProblema: linha[COL_CORRETIVA.DESCRICAO_PROBLEMA] || "",
        pecaFaltante: linha[COL_CORRETIVA.PECA_FALTANTE] || "",
      };
    });
    ESTADO.chamadosCorretivosCarregadosEm = agora;
    renderEquipamentosCadastro();
  } catch (err) {
    console.error("Erro ao carregar chamados corretivos:", err);
  }
}

function normalizarTexto(v) {
  return String(v || "").trim().toUpperCase();
}

// Protege contra HTML/script escondido em texto vindo de fora (planilha
// importada, formulário público de chamados, campos digitados por usuários)
// antes de inserir na tela via innerHTML. Sem isso, alguém poderia escrever
// algo tipo <script> num campo de texto e rodar código no navegador de quem
// visse aquele dado depois.
function escapeHtml(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Índice de chamados corretivos, reconstruído só quando ESTADO.chamadosCorretivos
// muda de verdade (Firestore/CSV substitui o array inteiro a cada atualização,
// então comparar a referência já garante isso — mesmo truque do cache logo
// abaixo). Sem isso, chamadosDoEquipamento() varria TODOS os chamados pra
// CADA equipamento renderizado, a cada tecla digitada na busca.
let _indiceChamados = { ref: null, porTombo: new Map(), porAnexo: new Map() };

function indiceChamados() {
  if (_indiceChamados.ref === ESTADO.chamadosCorretivos) return _indiceChamados;

  const porTombo = new Map();
  const porAnexo = new Map();
  ESTADO.chamadosCorretivos.forEach((c) => {
    const tomboTag = normalizarTexto(c.tombo) || normalizarTexto(c.tag);
    if (tomboTag) {
      if (!porTombo.has(tomboTag)) porTombo.set(tomboTag, []);
      porTombo.get(tomboTag).push(c);
    }
    const anexoChamado = normalizarTexto(c.anexo);
    if (anexoChamado) {
      if (!porAnexo.has(anexoChamado)) porAnexo.set(anexoChamado, []);
      porAnexo.get(anexoChamado).push(c);
    }
  });

  _indiceChamados = { ref: ESTADO.chamadosCorretivos, porTombo, porAnexo };
  return _indiceChamados;
}

function chamadosDoEquipamento(item) {
  const { porTombo, porAnexo } = indiceChamados();
  const patrimonio = normalizarTexto(item.patrimonio);
  const localItem = normalizarTexto(item.local);
  const setorAmbiente = normalizarTexto(`${item.setor} ${item.ambiente}`);

  const exatos = (patrimonio && porTombo.get(patrimonio)) || [];
  const exatosSet = new Set(exatos);

  const aproximados = [];
  if (localItem) {
    // Só compara pelos NÚMEROS de sala/gabinete (ignorando o andar, que é 1
    // dígito) — palavras genéricas tipo "sala"/"gabinete"/"assessores"
    // aparecem em quase todo chamado do prédio e geravam falso positivo.
    const numerosItem = (setorAmbiente.match(/[0-9]+/g) || []).filter((n) => n.length >= 2);
    if (numerosItem.length) {
      // Varre só os poucos "anexos" distintos que existem (um por prédio),
      // não todos os chamados — o índice já agrupou isso.
      for (const [anexoChamado, lista] of porAnexo) {
        if (anexoChamado !== localItem && !localItem.includes(anexoChamado) && !anexoChamado.includes(localItem)) continue;
        lista.forEach((c) => {
          if (exatosSet.has(c)) return; // já contado como exato, não duplica
          const poolLocal = normalizarTexto(`${c.gabinete} ${c.sala} ${c.nomeSetor} ${c.salaSetor} ${c.localAdicional}`);
          const numerosChamado = poolLocal.match(/[0-9]+/g) || [];
          if (numerosItem.some((n) => numerosChamado.includes(n))) {
            aproximados.push(c);
          }
        });
      }
    }
  }

  const porData = (a, b) => String(b.data).localeCompare(String(a.data));
  return { exatos: [...exatos].sort(porData), aproximados: aproximados.sort(porData) };
}

// Mesma lógica de casamento de chamadosDoEquipamento(), só que ao contrário:
// pra cada chamado, confere se ALGUM equipamento já cadastrado bate com ele.
// O que sobra são chamados de aparelhos que provavelmente ainda não foram
// registrados no sistema.
// Guarda o resultado da última comparação -- comparar cada chamado com cada
// equipamento é uma conta que cresce rápido (equipamentos × chamados), e
// renderEquipamentosCadastro() chama isso a cada digitação na busca/filtro.
// Só recalcula de verdade quando as duas listas mudaram de fato (Firestore
// substitui o array inteiro a cada atualização, então comparar a
// referência já garante isso).
let _cacheChamadosOrfaos = { equipamentosRef: null, chamadosRef: null, resultado: [] };

function chamadosSemEquipamento() {
  if (
    _cacheChamadosOrfaos.equipamentosRef === ESTADO.equipamentos &&
    _cacheChamadosOrfaos.chamadosRef === ESTADO.chamadosCorretivos
  ) {
    return _cacheChamadosOrfaos.resultado;
  }

  const resultado = ESTADO.chamadosCorretivos.filter((c) => {
    const tomboTag = normalizarTexto(c.tombo) || normalizarTexto(c.tag);
    const anexoChamado = normalizarTexto(c.anexo);
    const poolLocal = normalizarTexto(`${c.gabinete} ${c.sala} ${c.nomeSetor} ${c.salaSetor} ${c.localAdicional}`);
    const numerosChamado = poolLocal.match(/[0-9]+/g) || [];

    const temEquipamento = ESTADO.equipamentos.some((item) => {
      const patrimonio = normalizarTexto(item.patrimonio);
      if (patrimonio && tomboTag && tomboTag === patrimonio) return true;

      const localItem = normalizarTexto(item.local);
      if (localItem && anexoChamado && (anexoChamado === localItem || localItem.includes(anexoChamado) || anexoChamado.includes(localItem))) {
        const setorAmbiente = normalizarTexto(`${item.setor} ${item.ambiente}`);
        const numerosItem = (setorAmbiente.match(/[0-9]+/g) || []).filter((n) => n.length >= 2);
        if (numerosItem.length && numerosItem.some((n) => numerosChamado.includes(n))) return true;
      }
      return false;
    });

    return !temEquipamento;
  });

  _cacheChamadosOrfaos = {
    equipamentosRef: ESTADO.equipamentos,
    chamadosRef: ESTADO.chamadosCorretivos,
    resultado,
  };
  return resultado;
}

// Preenche o formulário de cadastro manual com o que dá pra aproveitar do
// chamado (prédio, sala/gabinete, tombo) -- a pessoa só confere e confirma.
function prepararCadastroDoChamado(c) {
  if ($("#eqPatrimonio")) $("#eqPatrimonio").value = c.tombo || c.tag || "";

  const anexoNormalizado = normalizarTexto(c.anexo);
  const predioCorrespondente = ESTADO.configSite.predios.find((p) => {
    const pNorm = normalizarTexto(p);
    return pNorm === anexoNormalizado || pNorm.includes(anexoNormalizado) || anexoNormalizado.includes(pNorm);
  });
  if ($("#eqLocal") && predioCorrespondente) $("#eqLocal").value = predioCorrespondente;

  if ($("#eqSetor")) $("#eqSetor").value = [c.nomeSetor, c.gabinete].filter(Boolean).join(" - ") || c.anexo || "";
  if ($("#eqAmbiente")) $("#eqAmbiente").value = c.salaSetor || c.sala || "";

  toast("Formulário preenchido com os dados do chamado — confira e clique em Adicionar.");
  $("#eqPatrimonio")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderChamadosOrfaos() {
  const card = $("#cardChamadosOrfaos");
  const table = $("#chamadosOrfaosTable");
  if (!card || !table) return;

  const orfaos = chamadosSemEquipamento();
  card.hidden = orfaos.length === 0;
  if (!orfaos.length) return;

  $("#chamadosOrfaosCount").textContent = `${orfaos.length}`;
  table.innerHTML = `<thead><tr>
      <th>Data</th><th>Anexo</th><th>Sala/Gabinete</th><th>Chamado</th><th>Descrição</th><th></th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  orfaos.forEach((c) => {
    const tr = document.createElement("tr");
    const salaGabinete = [c.gabinete, c.sala, c.nomeSetor, c.salaSetor].filter(Boolean).join(" / ") || "-";
    tr.innerHTML = `
      <td>${escapeHtml(c.dataFormatada || "-")}</td>
      <td>${escapeHtml(c.anexo || "-")}</td>
      <td>${escapeHtml(salaGabinete)}</td>
      <td>${escapeHtml(c.chamado || "-")}</td>
      <td>${escapeHtml(c.descricaoProblema || c.pecaFaltante || "-")}</td>`;
    const tdBtn = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "btn ghost";
    btn.style.fontSize = "12px";
    btn.style.padding = "6px 12px";
    btn.textContent = "Cadastrar equipamento";
    btn.addEventListener("click", () => prepararCadastroDoChamado(c));
    tdBtn.appendChild(btn);
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

// Substitui window.confirm() por uma janela com a cara do sistema --
// usada no fluxo de subir planilha (Jovanna achou as caixinhas do
// navegador feias). Devolve uma Promise<boolean>, então quem chama usa
// "await" no lugar do valor direto que confirm() devolvia.
function confirmarModal({ titulo = "Confirmar", corpoHtml = "", textoConfirmar = "OK", textoCancelar = "Cancelar", perigo = false }) {
  return new Promise((resolve) => {
    const overlay = $("#modalConfirmOverlay");
    const card = overlay.querySelector(".modal-confirm-card");
    card.classList.toggle("perigo", perigo);
    $("#modalConfirmTitulo").textContent = titulo;
    $("#modalConfirmCorpo").innerHTML = corpoHtml;
    const btnConfirmar = $("#modalConfirmConfirmar");
    const btnCancelar = $("#modalConfirmCancelar");
    btnConfirmar.textContent = textoConfirmar;
    btnConfirmar.className = "btn " + (perigo ? "danger-inverted" : "primary");
    btnCancelar.textContent = textoCancelar;
    overlay.hidden = false;

    function limpar() {
      overlay.hidden = true;
      btnConfirmar.removeEventListener("click", aoConfirmar);
      btnCancelar.removeEventListener("click", aoCancelar);
      overlay.removeEventListener("click", aoClicarFora);
      document.removeEventListener("keydown", aoTeclar);
    }
    function aoConfirmar() { limpar(); resolve(true); }
    function aoCancelar() { limpar(); resolve(false); }
    function aoClicarFora(ev) { if (ev.target === overlay) aoCancelar(); }
    function aoTeclar(ev) { if (ev.key === "Escape") aoCancelar(); }

    btnConfirmar.addEventListener("click", aoConfirmar);
    btnCancelar.addEventListener("click", aoCancelar);
    overlay.addEventListener("click", aoClicarFora);
    document.addEventListener("keydown", aoTeclar);
  });
}

$all(".subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".subtab").forEach((b) => b.classList.remove("active"));
    $all(".subview").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`#subview-${btn.dataset.subview}`).classList.add("active");
    if (btn.dataset.subview === "cfg-usuarios") renderUsuarios();
    if (btn.dataset.subview === "cfg-auditoria") renderAuditoria();
    if (btn.dataset.subview === "cfg-geral") preencherFormularioConfigSite();
    if (btn.dataset.subview === "cfg-equipes") renderEquipesPorPredio();
  });
});

$all(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    // Sair da aba Cronograma sem clicar em "Gerar/Adicionar" abandona o
    // fluxo de "adicionar prédio novo" -- sem isso, um "modo adicionar"
    // esquecido a meio caminho ia continuar escondendo os outros prédios
    // da tela de Capacidade da próxima vez que ela abrisse essa aba pra
    // qualquer outro motivo.
    if (btn.dataset.view !== "config" && ESTADO.modoAdicionarPredio) {
      ESTADO.modoAdicionarPredio = false;
      ESTADO.itensParaAdicionarPredio = null;
      atualizarVisualModoAdicionarPredio();
    }
    $all(".tab").forEach((b) => b.classList.remove("active"));
    $all(".view").forEach((v) => v.classList.remove("active"));
    // Marca TODOS os botões que apontam pra essa mesma view (não só o que
    // foi clicado) -- necessário porque Calendário/Dashboard agora têm um
    // atalho duplicado na barra inferior pro trabalhador, e os dois
    // precisam mostrar o estado "ativo" em sincronia.
    $all(`.tab[data-view="${btn.dataset.view}"]`).forEach((b) => b.classList.add("active"));
    $(`#view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view) {
      localStorage.setItem("ultimaAbaPMOC", btn.dataset.view);
    }
    if (btn.dataset.view === "calendar") renderCalendar();
    if (btn.dataset.view === "ciclos") renderCiclos();
    if (btn.dataset.view === "dashboard") renderDashboard();
    if (btn.dataset.view === "equipamentos") renderEquipamentosCadastro();
    if (btn.dataset.view === "localizacao") renderLocalizacao();
    if (btn.dataset.view === "feriados") renderFeriados();
    if (btn.dataset.view === "ordens") renderOrdens();
    if (btn.dataset.view === "historico") renderHistorico();
    if (btn.dataset.view === "config") { renderCapacidadesPorPredio(); atualizarVisualModoAdicionarPredio(); }
    if (btn.dataset.view === "auditoria") renderAuditoria();
    if (btn.dataset.view === "config-site") preencherFormularioConfigSite();
  });
});

function irParaAba(nome) {
  $(`.tab[data-view="${nome}"]`)?.click();
}
$("#navConfigSite")?.addEventListener("click", () => {
  $all(".tab").forEach((b) => b.classList.remove("active"));
  $all(".view").forEach((v) => v.classList.remove("active"));
  $("#view-config-site").classList.add("active");
  preencherFormularioConfigSite();
});

// ------------------------------------------------------------------
// Filtro por prédio (SEDE / Anexo 1 / Anexo 2 / ...) — usado nas telas
// que listam equipamentos, ordens e histórico.
// ------------------------------------------------------------------
function locaisDisponiveis() {
  const set = new Set(ESTADO.equipamentos.map((e) => e.local || "SEDE"));
  return ["Todos", ...[...set].sort()];
}

function aplicarFiltroLocal(itens) {
  if (ESTADO.localFiltro === "Todos") return itens;
  return itens.filter((i) => (i.local || "SEDE") === ESTADO.localFiltro);
}

function renderSeletorLocal(containerId) {
  const el = $(`#${containerId}`);
  if (!el) return;
  const locais = locaisDisponiveis();
  el.innerHTML = locais.map((l) =>
    `<button class="local-pill ${l === ESTADO.localFiltro ? "active" : ""}" data-local="${l}">${l}</button>`
  ).join("");
  el.querySelectorAll(".local-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      ESTADO.localFiltro = btn.dataset.local;

      // Pula o calendário para o primeiro mês com itens desse prédio, senão
      // o mês visível pode ficar "vazio" só porque o filtro mudou.
      const itensFiltrados = aplicarFiltroLocal(ESTADO.equipamentos).filter((i) => i.dataAgendada);
      if (itensFiltrados.length) {
        const ordenado = [...itensFiltrados].sort((a, b) => a.dataAgendada.localeCompare(b.dataAgendada));
        const primeira = new Date(ordenado[0].dataAgendada + "T12:00:00Z");
        ESTADO.calYear = primeira.getFullYear();
        ESTADO.calMonth = primeira.getMonth();
      }

      renderTodosSeletoresLocal();
      renderCalendar();
      renderDashboard();
      renderEquipamentosCadastro();
      renderOrdens();
      renderHistorico();

      // O painel de "dia selecionado" não escuta o filtro sozinho — se
      // tiver um dia aberto, teria que atualizar ele também, senão fica
      // mostrando os itens do prédio antigo até a pessoa clicar de novo.
      if (ESTADO.diaSelecionado) selecionarDia(ESTADO.diaSelecionado);
    });
  });
}

function renderTodosSeletoresLocal() {
  renderSeletorLocal("localFiltroCalendario");
  renderSeletorLocal("localFiltroDashboard");
  renderSeletorLocal("localFiltroOrdens");
  renderSeletorLocal("localFiltroHistorico");
  renderSeletorLocal("localFiltroEquipamentos");
}

// ------------------------------------------------------------------
// Faixa de alerta de atrasados (visível em qualquer aba)
// ------------------------------------------------------------------
const btnFecharAlertaAtrasados = $("#fecharAlertaAtrasados");
if (btnFecharAlertaAtrasados) {
  btnFecharAlertaAtrasados.addEventListener("click", () => {
    const banner = $("#alertaAtrasados");
    if (banner) {
      banner.dataset.fechado = formatISO(new Date());
    }
    atualizarBannerAtrasados();
  });
}

function atualizarBannerAtrasados() {
  const banner = $("#alertaAtrasados");
  const btnCal = $("#btnReagendarCalendario");
  if (!banner) return;

  const atrasados = ESTADO.equipamentos.filter(estaAtrasado);

  if (!atrasados.length) {
    banner.hidden = true;
    if (btnCal) btnCal.hidden = true;
    return;
  }

  const jaFechadoHoje = banner.dataset.fechado === formatISO(new Date());

  if (jaFechadoHoje) {
    // Aviso já foi fechado no X hoje — some o aviso, mas deixa a opção
    // acessível no calendário (só pra admin — reagendar é uma ação de
    // escrita, e esse botão não era coberto pelo travamento visual do
    // modo padrão/trabalhador por não ser um .btn.primary).
    banner.hidden = true;
    if (btnCal) btnCal.hidden = ESTADO.permissao !== "admin";
    return;
  }

  // Ainda não foi fechado — mostra o aviso normalmente, esconde o botão do
  // calendário (redundante enquanto o aviso já está visível).
  const txt = $("#alertaAtrasadosTexto");
  if (txt) {
    txt.textContent = atrasados.length === 1
      ? "1 aparelho está atrasado."
      : `${atrasados.length} aparelhos estão atrasados.`;
  }
  banner.hidden = false;
  if (btnCal) btnCal.hidden = true;
}
// ------------------------------------------------------------------
// Aviso de dias vazios no cronograma (aparece só na aba Calendário)
// ------------------------------------------------------------------
function atualizarAlertaDiasVazios() {
  const banner = $("#alertaDiasVazios");
  if (!banner) return;

  const diasVazios = ESTADO.diasVaziosCronograma || [];
  if (!diasVazios.length) {
    banner.hidden = true;
    return;
  }

  const txt = $("#alertaDiasVaziosTexto");
  if (txt) {
    txt.textContent = diasVazios.length === 1
      ? "1 dia útil ficou sem nada agendado (provavelmente por causa de um feriado)."
      : `${diasVazios.length} dias úteis ficaram sem nada agendado (provavelmente por causa de feriados).`;
  }
  banner.hidden = false;
}

$("#fecharAlertaDiasVazios")?.addEventListener("click", () => {
  const banner = $("#alertaDiasVazios");
  if (banner) banner.hidden = true;
});

$("#btnAdiantarDiasVazios")?.addEventListener("click", async () => {
  const btn = $("#btnAdiantarDiasVazios");
  btn.disabled = true;
  try {
    await adiantarDiasVazios();
    toast("Cronograma reorganizado para preencher os dias vazios.");
  } catch (err) {
    console.error(err);
    toast("Erro ao reorganizar o cronograma: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

async function adiantarDiasVazios() {
  const itens = ESTADO.equipamentos.filter((e) =>
    e.statusPreventiva !== "Concluída" && e.fixadoManualmente !== true
  );
  if (!itens.length) return;

  compactarCronograma(itens);

  const TAMANHO_LOTE = 200;
  for (let inicio = 0; inicio < itens.length; inicio += TAMANHO_LOTE) {
    const pedaco = itens.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => {
      batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), {
        dataAgendada: item.dataAgendada,
        diaPlanejado: item.diaPlanejado,
        semanaPlanejada: item.semanaPlanejada,
        ordemExecucao: item.ordemExecucao,
      });
    });
    await batch.commit();
  }

  ESTADO.diasVaziosCronograma = [];
  atualizarAlertaDiasVazios();
}

function jaVerificouAtrasadosHoje() {
  try {
    return localStorage.getItem(CHAVE_VERIFICACAO_ATRASADOS) === formatISO(new Date());
  } catch (e) {
    return false;
  }
}

function marcarVerificacaoAtrasadosHoje() {
  try {
    localStorage.setItem(CHAVE_VERIFICACAO_ATRASADOS, formatISO(new Date()));
  } catch (e) {
    // localStorage indisponível (modo privado etc.) — tudo bem, só não terá o cache diário
  }
}


const dropzone = $("#dropzone");
const fileInput = $("#fileInput");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) processarArquivo(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) processarArquivo(fileInput.files[0]);
});

function processarArquivo(file) {
  $("#dropzoneLabel").textContent = `Lendo "${file.name}"...`;
  const cardSumidosAntigo = $("#cardSumidosPlanilha");
  if (cardSumidosAntigo) cardSumidosAntigo.hidden = true;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array" });
      let todasAsLinhas = [];
      wb.SheetNames.forEach((nomeAba) => {
        const sheet = wb.Sheets[nomeAba];
        const linhas = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        linhas.forEach((linha) => { linha.__local = nomeAba.trim(); });
        todasAsLinhas = todasAsLinhas.concat(linhas);
      });

      if (!todasAsLinhas.length) throw new Error("Planilha vazia.");

      // Já existe um cronograma rodando -- subir uma planilha nova
      // sempre apagava TUDO e recomeçava do zero. Agora separa a
      // planilha em duas categorias e pergunta uma coisa pra cada:
      //   - prédio NOVO (não existia): pergunta se quer ADICIONAR (leva
      //     pra tela de Cronograma, só com ele, pra ajustar capacidade).
      //   - prédio que JÁ EXISTE: pergunta se quer ATUALIZAR o cadastro
      //     dele com essa planilha (casa por patrimônio, corrige/
      //     completa quem já existe, adiciona quem for novo -- nunca
      //     apaga nem mexe em status/data/equipe de ninguém).
      // Só cai no "Substituir tudo" (fluxo antigo, apaga tudo e
      // recomeça) se ela recusar as duas opções acima -- ou se nenhuma
      // delas nem chegou a ser oferecida (planilha vazia de algum jeito).
      if (ESTADO.cicloAtual && ESTADO.equipamentos.length) {
        $("#dropzoneLabel").textContent = "Clique ou arraste o arquivo aqui";
        const prediosExistentesSet = new Set(ESTADO.equipamentos.map((e) => e.local || "SEDE"));
        const prediosDaPlanilha = [...new Set(todasAsLinhas.map((l) => (l.__local || "SEDE").trim()))];
        const prediosNovosNaPlanilha = prediosDaPlanilha.filter((p) => !prediosExistentesSet.has(p));
        const prediosJaExistemNaPlanilha = prediosDaPlanilha.filter((p) => prediosExistentesSet.has(p));

        let algumaAcaoTomada = false;

        if (prediosJaExistemNaPlanilha.length) {
          const linhasDesses = todasAsLinhas.filter((l) => prediosJaExistemNaPlanilha.includes((l.__local || "SEDE").trim()));
          const resultado = linhasParaItens(linhasDesses);
          if (resultado.erro) { toast(resultado.erro); return; }
          // Calcula os números de verdade ANTES de perguntar -- assim a
          // pergunta já mostra uma prévia real (quantos vão atualizar,
          // quantos são novos, quantos sumiram), em vez de um texto
          // genérico. Isso ajuda a pegar de cara um erro de digitação no
          // Patrimônio da planilha (que criaria um cadastro duplicado em
          // vez de atualizar o certo -- o número de "novos" ficaria
          // maior do que ela esperava).
          const diff = compararComPlanilha(resultado.itens);
          const querAtualizar = await confirmarModal({
            titulo: "Prévia da atualização",
            corpoHtml:
              `<ul>${diff.porPredioResumo.map((p) =>
                `<li><strong>${escapeHtml(p.local)}</strong>: ${p.atualizar} atualiza${p.atualizar === 1 ? "" : "m"}, ${p.novos} novo(s), ${p.sumidos} sumido(s) da planilha</li>`
              ).join("")}</ul>` +
              `<p><strong>"Sumido"</strong> = já está cadastrado mas o Patrimônio não apareceu nessa planilha -- não será apagado.</p>` +
              `<div class="modal-confirm-aviso">Se os números de "novo(s)" parecerem altos demais, pode ser um erro de digitação no Patrimônio da planilha (em vez de casar com quem já existe, criaria um cadastro duplicado) -- confira antes de confirmar.</div>`,
            textoConfirmar: "Confirmar atualização",
            textoCancelar: "Não atualizar agora",
          });
          if (querAtualizar) {
            await atualizarCadastroPredioExistente(resultado.itens);
            renderSumidosPlanilha(diff.sumidos);
            algumaAcaoTomada = true;
          }
        }

        if (prediosNovosNaPlanilha.length) {
          const querAdicionar = await confirmarModal({
            titulo: "Prédio(s) novo(s) na planilha",
            corpoHtml:
              `<p>${prediosJaExistemNaPlanilha.length ? "Essa planilha também tem" : "Essa planilha tem"} prédio(s) novo(s): ` +
              `<strong>${escapeHtml(prediosNovosNaPlanilha.join(", "))}</strong>.</p>` +
              `<p>Confirmando, você vai pra tela de Cronograma pra ajustar a capacidade desse(s) prédio(s) -- os outros prédios continuam exatamente como estão.</p>`,
            textoConfirmar: "Adicionar ao cronograma",
            textoCancelar: "Não adicionar agora",
          });
          if (querAdicionar) {
            const linhasDesses = todasAsLinhas.filter((l) => prediosNovosNaPlanilha.includes((l.__local || "SEDE").trim()));
            const resultado = linhasParaItens(linhasDesses);
            if (resultado.erro) { toast(resultado.erro); return; }
            ESTADO.modoAdicionarPredio = true;
            ESTADO.itensParaAdicionarPredio = resultado.itens;
            irParaAba("config");
            const hojeUtil = $("#dataInicio");
            if (hojeUtil && !hojeUtil.value) hojeUtil.value = formatISO(new Date());
            return;
          }
        }

        if (algumaAcaoTomada) return;

        const querSubstituir = await confirmarModal({
          titulo: "Substituir o cronograma inteiro?",
          corpoHtml:
            `<p>Isso apaga <strong>todos os prédios atuais</strong> (equipamento, datas, status de cada um) e recomeça do zero só com o que está nessa planilha.</p>` +
            `<div class="modal-confirm-aviso">Essa ação não pode ser desfeita.</div>`,
          textoConfirmar: "Substituir tudo",
          textoCancelar: "Cancelar",
          perigo: true,
        });
        if (!querSubstituir) return;
      }

      // 1. Limpamos o estado atual para não mostrar dados velhos
      ESTADO.equipamentos = [];
      ESTADO.ordens = [];
      ESTADO.historico = [];

      // 2. Classificamos os novos dados
      classificar(todasAsLinhas);

      // 3. Forçamos a atualização da UI (Dashboard e Calendar vão ficar vazios ou prontos para o novo ciclo)
      renderDashboard();
      renderCalendar();

      $("#dropzoneLabel").textContent = `"${file.name}" carregado — ${todasAsLinhas.length} itens.`;

      toast("Planilha carregada! Configure o cronograma.");
      irParaAba("config");

    } catch (err) {
      toast("Erro ao ler o arquivo: " + err.message);
      $("#dropzoneLabel").textContent = "Clique ou arraste o arquivo aqui";
    }
  };
  reader.readAsArrayBuffer(file);
}

// Parte pura de "classificar": transforma linhas de planilha em itens de
// equipamento, sem mexer em ESTADO nem na tela -- extraído assim pra
// poder ser reaproveitado tanto pelo fluxo de "primeira vez" (classificar,
// abaixo) quanto pelo de "adicionar um prédio novo ao cronograma que já
// está rodando" (confirmarAdicaoPredioNovo), sem duplicar a lógica de
// leitura de coluna/limpeza de valor/id estável por patrimônio.
function linhasParaItens(rows) {
  const headers = Object.keys(rows[0]).map((h) => h.trim());
  const colSetor = localizarColuna(["Setor"], headers);
  const colAmbiente = localizarColuna(["Ambiente"], headers);
  const colStatus = localizarColuna(["Status / ano", "Status"], headers);
  const colPatrimonio = localizarColuna(["Patrimônio", "Patrimonio"], headers);

  // Novas colunas ensinadas ao sistema
  const colMarca = localizarColuna(["Marca"], headers);
  const colModelo = localizarColuna(["Modelo"], headers);
  const colPotencia = localizarColuna(["Potência", "BTU", "Capacidade"], headers);
  const colTipoGas = localizarColuna(["Tipo de Gás", "Tipo de Gas", "Gás", "Gas"], headers);
  const colTag = localizarColuna(["TAG", "Tag"], headers);

  if (!colSetor || !colAmbiente) {
    return { erro: "Não encontrei as colunas 'Setor' e 'Ambiente'. Confira o cabeçalho." };
  }
  ESTADO.meta = { colSetor, colAmbiente, colStatus, colPatrimonio };
  let ultimoSetor = "";
  let localAnterior = null;
  let linhasCorrigidas = 0;
  rows.forEach((row) => {
    if (row.__local !== localAnterior) {
      ultimoSetor = "";
      localAnterior = row.__local;
    }
    const valorAtual = String(row[colSetor] ?? "").trim();
    if (valorAtual) {
      ultimoSetor = valorAtual;
    } else if (ultimoSetor) {
      row[colSetor] = ultimoSetor;
      linhasCorrigidas++;
    }
  });
  if (linhasCorrigidas > 0) {
    console.log(`${linhasCorrigidas} linha(s) tinham Setor em branco (célula mesclada) e foram corrigidas.`);
  }

  // Conta quantas vezes cada patrimônio já apareceu nesta planilha, pra
  // desempatar duplicatas reais sem depender da posição da linha — assim
  // o ID de cada máquina fica estável entre reimportações (o que muda é
  // só o próprio número de patrimônio), e os dados técnicos já
  // preenchidos (infoCondensadoras) não se desconectam da máquina só
  // porque uma linha foi inserida/removida em outro lugar da planilha.
  const contagemPorPatrimonio = {};

  const itens = rows.map((row, idx) => {
    const setor = row[colSetor];
    const ambiente = row[colAmbiente];

    // Limpador de valores (Transforma "X" e "-" em vazio)
    const limparValor = (v) => {
      const str = String(v || "").trim();
      if (str === "-" || str.toUpperCase() === "X" || str.toUpperCase() === "N/A" || str === "") return "";
      return str;
    };

    const patrimonio = colPatrimonio ? limparValor(row[colPatrimonio]) : "";
    const marca = colMarca ? limparValor(row[colMarca]) : "";
    const modelo = colModelo ? limparValor(row[colModelo]) : "";

    let capacidade = colPotencia ? limparValor(row[colPotencia]) : "";
    if (capacidade && !capacidade.toLowerCase().includes("btu")) capacidade += " BTU/h";

    const tipoGas = colTipoGas ? limparValor(row[colTipoGas]) : "";
    const tag = colTag ? limparValor(row[colTag]) : "";

    const setorPCM = identificarSetor(setor, ambiente);

    let id;
    if (patrimonio) {
      const base = patrimonio.replace(/[\s/\\"']/g, "_");
      contagemPorPatrimonio[base] = (contagemPorPatrimonio[base] || 0) + 1;
      id = contagemPorPatrimonio[base] > 1 ? `${base}_${contagemPorPatrimonio[base]}` : base;
    } else {
      id = `item_${idx}`;
    }

    return {
      id,
      patrimonio,
      tag,
      marca,          // <--- Salva no Firebase
      modelo,         // <--- Salva no Firebase
      capacidade,     // <--- Salva no Firebase
      tipoGas,
      setor, ambiente,
      local: row.__local || "SEDE",
      statusCondicao: colStatus ? row[colStatus] : "",
      setorPCM,
      prioridadeSetor: PRIORIDADE[setorPCM] || 7,
      pisoPCM: descobrirPiso(setor),
      statusPreventiva: "Pendente",
      observacao: "",
    };
  });

  itens.sort((a, b) =>
    a.prioridadeSetor - b.prioridadeSetor ||
    a.pisoPCM - b.pisoPCM ||
    String(a.ambiente).localeCompare(String(b.ambiente)) ||
    String(a.patrimonio).localeCompare(String(b.patrimonio))
  );

  return { itens };
}

function classificar(rows) {
  const resultado = linhasParaItens(rows);
  if (resultado.erro) {
    toast(resultado.erro);
    return;
  }
  ESTADO.itensCarregados = resultado.itens;
  renderCapacidadesPorPredio();
  renderPreview(resultado.itens);
}

// Acrescenta o(s) prédio(s) preparados em ESTADO.itensParaAdicionarPredio
// (só prédio que ainda NÃO existe no cadastro atual -- ver processarArquivo)
// ao ciclo já em andamento, sem apagar nem reagendar nada dos prédios que
// já existem -- cada prédio já anda no próprio ritmo, com sua própria
// equipe (mesmo agrupamento por "local" que gerarCronograma usa), então
// adicionar um prédio novo não mexe na equipe nem nas datas de nenhum
// outro. Lê capacidade/data/rodízio dos MESMOS campos da tela de
// Cronograma (Parâmetros Iniciais + Capacidade por Prédio) -- a mesma
// interface de sempre, só que preenchida com o(s) prédio(s) novo(s) em
// vez da lista inteira (ver locaisParaConfigurar).
async function confirmarAdicaoPredioNovo() {
  const itensDaPlanilha = ESTADO.itensParaAdicionarPredio;
  if (!itensDaPlanilha || !itensDaPlanilha.length) {
    toast("Nada pra adicionar -- volte na aba Levantamento e suba a planilha do prédio novo.");
    return;
  }

  const dataInicioStr = $("#dataInicio")?.value;
  if (!dataInicioStr) {
    toast("Escolha a data de início.");
    return;
  }
  const diasSemana = Math.min(7, Math.max(1, parseInt($("#diasSemana")?.value, 10) || 5));
  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  function ehDiaUtilLocal(data) {
    return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
  }
  const [anoI, mesI, diaI] = dataInicioStr.split("-");
  const dataInicioBase = new Date(anoI, parseInt(mesI, 10) - 1, diaI, 12, 0, 0);
  while (!ehDiaUtilLocal(dataInicioBase)) dataInicioBase.setDate(dataInicioBase.getDate() + 1);

  const capacidades = lerCapacidadesDaTela();
  const porPredio = new Map();
  itensDaPlanilha.forEach((item) => {
    const local = item.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(item);
  });

  $("#btnGerar").disabled = true;
  try {
    const idsExistentes = new Set(ESTADO.equipamentos.map((e) => e.id));
    const todosNovosItens = [];
    const resumo = [];
    const prediosAdicionados = new Set();

    for (const [local, itensDoPredio] of porPredio.entries()) {
      const cap = capacidades[local] || { nEquipes: 1, aparelhosDia: 2, modoRodizio: false, equipesAtivas: [] };
      const nEquipes = Math.max(1, cap.nEquipes || 1);
      const aparelhosDia = Math.max(1, cap.aparelhosDia || 1);

      if (cap.modoRodizio && (!cap.equipesAtivas || !cap.equipesAtivas.length)) {
        toast(`"${local}": marcou rodízio mas não selecionou nenhuma equipe. Cadastre equipe(s) nesse prédio em Configurações > Equipes primeiro, ou desmarque "Fazer rodízio".`);
        continue;
      }

      // Fora do modo rodízio, cria (ou reaproveita) as equipes desse
      // prédio no Firestore -- sem isso elas não apareceriam na aba
      // Equipes depois, só o nome ficaria "pendurado" no equipamento sem
      // um registro de verdade por trás. Guarda o nome de cada uma num
      // mapa local (em vez de reconsultar ESTADO.equipes logo em
      // seguida) porque ESTADO.equipes só atualiza quando o listener em
      // tempo real do Firebase recebe o dado de volta -- não instantâneo.
      const mapaEquipeLocal = new Map();
      if (!cap.modoRodizio) {
        for (let ordemEq = 1; ordemEq <= nEquipes; ordemEq++) {
          const existente = ESTADO.equipes.find((e) => e.predio === local && e.ordem === ordemEq);
          if (existente) {
            mapaEquipeLocal.set(ordemEq, existente.nome);
          } else {
            const nome = `Equipe ${ordemEq}`;
            await addDoc(collection(db, "equipes"), { predio: local, ordem: ordemEq, nome });
            mapaEquipeLocal.set(ordemEq, nome);
          }
        }
      }

      const capacidadeDia = nEquipes * aparelhosDia;
      let dataCursor = new Date(dataInicioBase);
      let contador = 0;
      let diasUteisAgendados = 0;
      let grupoAmbienteAtual = null;
      let indiceGrupo = -1;
      let ordem = 0;

      itensDoPredio.forEach((item) => {
        // Evita colidir com um ID já existente (patrimônio repetido em
        // outro prédio, por engano de digitação na planilha) -- sem
        // isso, o batch.set ia SOBRESCREVER o equipamento existente,
        // apagando o histórico/status dele.
        if (idsExistentes.has(item.id)) {
          item.id = `${item.id}_novo_${Math.random().toString(36).slice(2, 6)}`;
        }
        idsExistentes.add(item.id);

        const chaveAmbiente = `${item.setor}||${item.ambiente}`;
        if (chaveAmbiente !== grupoAmbienteAtual) {
          grupoAmbienteAtual = chaveAmbiente;
          indiceGrupo++;
        }
        const slotDaSala = indiceGrupo % nEquipes;

        if (cap.modoRodizio && cap.equipesAtivas && cap.equipesAtivas.length > 0) {
          const pool = cap.equipesAtivas;
          const indiceNoPool = (diasUteisAgendados * nEquipes + slotDaSala) % pool.length;
          item.equipeResponsavel = pool[indiceNoPool];
        } else {
          const ordemEquipe = slotDaSala + 1;
          item.equipeResponsavel = mapaEquipeLocal.get(ordemEquipe) || `Equipe ${ordemEquipe}`;
        }

        ordem++;
        item.ordemExecucao = ordem;
        item.dataAgendada = formatISO(dataCursor);
        item.diaPlanejado = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
        const diffDias = Math.floor((dataCursor - dataInicioBase) / 86400000);
        item.semanaPlanejada = `Semana ${Math.floor(diffDias / 7) + 1}`;

        contador++;
        if (contador >= capacidadeDia) {
          contador = 0;
          diasUteisAgendados++;
          do { dataCursor.setDate(dataCursor.getDate() + 1); } while (!ehDiaUtilLocal(dataCursor));
        }
        todosNovosItens.push(item);
      });

      prediosAdicionados.add(local);
      const diasNecessarios = Math.ceil(itensDoPredio.length / capacidadeDia);
      resumo.push(`${local}: ${itensDoPredio.length} equipamento(s), começa ${formatISO(dataInicioBase)}, ~${diasNecessarios} dia(s) úteis.`);
    }

    if (!todosNovosItens.length) {
      toast("Nada foi adicionado.");
      return;
    }

    // Registra o(s) prédio(s) que realmente foram adicionados na lista
    // mestre de prédios (Configurações -> "Prédio"/"Anexo") -- sem isso,
    // o cadastro/cronograma desse prédio até funcionava, mas ele não
    // aparecia nos seletores de "Prédio" espalhados pelo sistema
    // (cadastrar equipamento manual, subir planta de CAD, tela de
    // Equipes), porque todos eles listam a partir dessa lista, não a
    // partir de quem já tem equipamento cadastrado.
    const prediosNaListaMestre = new Set((ESTADO.configSite && ESTADO.configSite.predios) || []);
    const prediosParaRegistrar = [...prediosAdicionados].filter((l) => !prediosNaListaMestre.has(l));
    if (prediosParaRegistrar.length) {
      const novaConfigSite = { ...(ESTADO.configSite || {}), predios: [...prediosNaListaMestre, ...prediosParaRegistrar] };
      await setDoc(doc(db, "config", "site"), novaConfigSite);
      ESTADO.configSite = novaConfigSite;
    }

    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < todosNovosItens.length; inicio += TAMANHO_LOTE) {
      const pedaco = todosNovosItens.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((item) => batch.set(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), item));
      await batch.commit();
    }

    await registrarAuditoria("Adicionar prédio ao cronograma", `${[...prediosAdicionados].join(", ")} -- ${todosNovosItens.length} equipamento(s) acrescentado(s), sem mexer nos outros prédios`);

    toast(`Adicionado! ${resumo.join(" ")}`);

    ESTADO.modoAdicionarPredio = false;
    ESTADO.itensParaAdicionarPredio = null;
    atualizarVisualModoAdicionarPredio();
    irParaAba("calendar");
  } catch (err) {
    console.error(err);
    toast("Erro ao adicionar: " + err.message);
  } finally {
    $("#btnGerar").disabled = false;
  }
}

// Atualiza o cadastro de um prédio que JÁ existe, a partir de uma
// planilha exportada de novo (ela editou por fora e quer subir de
// novo) -- sem apagar nem reagendar quem já estava, do jeito que
// "Substituir tudo" faz. Casa cada linha pelo PATRIMÔNIO (a chave real
// do equipamento) dentro do mesmo prédio:
//   - quem já existe tem só os campos "de cadastro" atualizados (setor,
//     ambiente, marca, modelo, capacidade, tipo de gás, status da
//     planilha) -- NUNCA o que é operacional (status da preventiva,
//     data agendada, equipe, observação, marcação na planta). É
//     exatamente isso que "não perder os dados" significa aqui, por
//     isso usa updateDoc só com esses campos, nunca um set() que
//     substituiria o documento inteiro.
//   - quem é novo na planilha (patrimônio que não existia nesse prédio)
//     entra como um cadastro novo, com a mesma equipe/ordem que
//     "Adicionar equipamento manual" já calcularia, e depois
//     reagendarTudo() encaixa a data dele sem mexer em quem já estava
//     agendado.
//   - quem sumiu da planilha (existia, não está mais nela) NÃO é
//     apagado -- fica como está. Decisão de propósito: apagar sozinho é
//     arriscado demais se a planilha tiver algum erro.
// Calcula (sem escrever nada no Firebase) o que vai acontecer se essa
// planilha for aplicada num prédio que já existe: quem vai ser
// ATUALIZADO (casou pelo Patrimônio com um equipamento já cadastrado),
// quem é NOVO (não casou com nada) e quem SUMIU (estava cadastrado
// nesse prédio, mas o Patrimônio dele não apareceu nessa planilha).
// Usada em dois lugares: pra montar a prévia com números de verdade
// ANTES de perguntar se ela quer confirmar (evita, por exemplo, um erro
// de digitação no Patrimônio da planilha virar um cadastro duplicado em
// vez de atualizar o certo) e pra montar o relatório de "sumiu da
// planilha" depois que a atualização roda.
function compararComPlanilha(itensDaPlanilha) {
  const porPredio = new Map();
  itensDaPlanilha.forEach((item) => {
    const local = item.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(item);
  });

  let totalAtualizar = 0, totalNovos = 0;
  const sumidos = [];
  const porPredioResumo = [];

  for (const [local, itensDoPredio] of porPredio.entries()) {
    const existentesDoLocal = ESTADO.equipamentos.filter((e) => (e.local || "SEDE") === local);
    const patrimoniosNaPlanilha = new Set(itensDoPredio.filter((i) => i.patrimonio).map((i) => i.patrimonio));
    const porPatrimonioExistente = new Map();
    existentesDoLocal.forEach((e) => { if (e.patrimonio) porPatrimonioExistente.set(e.patrimonio, e); });

    let atualizarPredio = 0, novosPredio = 0;
    itensDoPredio.forEach((item) => {
      if (item.patrimonio && porPatrimonioExistente.has(item.patrimonio)) atualizarPredio++;
      else novosPredio++;
    });

    const sumidosDoPredio = existentesDoLocal.filter((e) => e.patrimonio && !patrimoniosNaPlanilha.has(e.patrimonio));

    totalAtualizar += atualizarPredio;
    totalNovos += novosPredio;
    sumidos.push(...sumidosDoPredio);
    porPredioResumo.push({ local, atualizar: atualizarPredio, novos: novosPredio, sumidos: sumidosDoPredio.length });
  }

  return { porPredioResumo, totalAtualizar, totalNovos, sumidos };
}

function renderSumidosPlanilha(sumidos) {
  const card = $("#cardSumidosPlanilha");
  if (!card) return;
  if (!sumidos.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("#sumidosCount").textContent = `${sumidos.length} item(ns)`;
  $("#sumidosExplicacao").textContent =
    `Esses equipamentos estão cadastrados no sistema, mas o Patrimônio deles não apareceu na última planilha que você subiu. ` +
    `Ninguém foi apagado -- se algum realmente saiu de uso, remova manualmente na aba Equipamentos.`;
  const cols = [
    ["Patrimônio", (i) => i.patrimonio],
    ["Prédio", (i) => i.local || "SEDE"],
    ["Setor", (i) => i.setor],
    ["Ambiente", (i) => i.ambiente],
    ["Status", (i) => i.statusPreventiva],
  ];
  const table = $("#sumidosTable");
  table.innerHTML = `<thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr></thead>
    <tbody>${sumidos.map((i) => `<tr>${cols.map((c) => `<td>${escapeHtml(String(c[1](i) ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

async function atualizarCadastroPredioExistente(itensDaPlanilha) {
  const CAMPOS_CADASTRO = ["setor", "ambiente", "tag", "marca", "modelo", "capacidade", "tipoGas", "statusCondicao", "setorPCM", "prioridadeSetor", "pisoPCM"];

  const porPredio = new Map();
  itensDaPlanilha.forEach((item) => {
    const local = item.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(item);
  });

  const idsExistentes = new Set(ESTADO.equipamentos.map((e) => e.id));
  const atualizacoes = [];
  const itensNovos = [];
  const resumo = [];
  // Snapshot de TODOS os equipamentos dos prédios tocados por essa planilha
  // (não só os que batem por Patrimônio) -- serve pro "Desfazer": cobre tanto
  // os campos de cadastro alterados quanto qualquer reagendamento que o
  // reagendarTudo() faça de tabela vindo depois (que mexe em todo mundo
  // "Pendente" do(s) mesmo(s) prédio(s), não só nos itens novos).
  const itensAntesSnapshot = [];

  for (const [local, itensDoPredio] of porPredio.entries()) {
    const existentesDoLocal = ESTADO.equipamentos.filter((e) => (e.local || "SEDE") === local);
    existentesDoLocal.forEach((e) => itensAntesSnapshot.push({ ...e }));
    const porPatrimonio = new Map();
    existentesDoLocal.forEach((e) => { if (e.patrimonio) porPatrimonio.set(e.patrimonio, e); });

    let contadorLocal = existentesDoLocal.length;
    let maiorOrdem = existentesDoLocal.reduce((max, e) => Math.max(max, e.ordemExecucao || 0), 0);
    const capLocal = (ESTADO.config && ESTADO.config.capacidades && ESTADO.config.capacidades[local]) || { nEquipes: 2, aparelhosDia: 2 };

    let atualizadosPredio = 0, adicionadosPredio = 0;

    itensDoPredio.forEach((itemPlanilha) => {
      const existente = itemPlanilha.patrimonio ? porPatrimonio.get(itemPlanilha.patrimonio) : null;
      if (existente) {
        const campos = {};
        CAMPOS_CADASTRO.forEach((campo) => { campos[campo] = itemPlanilha[campo]; });
        atualizacoes.push({ id: existente.id, campos });
        atualizadosPredio++;
        return;
      }

      // Novo de verdade -- mesma "roleta" de equipe usada em "Adicionar
      // equipamento manual" (nomeEquipePorVaga cobre o modo clássico; o
      // rodízio precisa da conta de "qual dia" à parte, porque depende
      // de quantos itens desse prédio já existem, não só da vaga).
      maiorOrdem++;
      const ordemExecucao = maiorOrdem;
      let equipeResponsavel;
      if (capLocal.modoRodizio && capLocal.equipesAtivas && capLocal.equipesAtivas.length > 0) {
        const nVagas = Math.max(1, capLocal.nEquipes || 1);
        const capacidadeDia = nVagas * Math.max(1, capLocal.aparelhosDia || 1);
        const diasUteisJaUsados = Math.floor(contadorLocal / capacidadeDia);
        const slotDaSala = (ordemExecucao - 1) % nVagas;
        const pool = capLocal.equipesAtivas;
        equipeResponsavel = pool[(diasUteisJaUsados * nVagas + slotDaSala) % pool.length];
      } else {
        equipeResponsavel = nomeEquipePorVaga(local, ordemExecucao - 1, capLocal.nEquipes);
      }

      let id = itemPlanilha.patrimonio
        ? itemPlanilha.patrimonio.replace(/[\s/\\"']/g, "_")
        : `item_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
      while (idsExistentes.has(id)) id += "_" + Math.random().toString(36).slice(2, 4);
      idsExistentes.add(id);

      const novoItem = {
        id, local,
        patrimonio: itemPlanilha.patrimonio, setor: itemPlanilha.setor, ambiente: itemPlanilha.ambiente,
        tag: itemPlanilha.tag,
        marca: itemPlanilha.marca, modelo: itemPlanilha.modelo, capacidade: itemPlanilha.capacidade,
        tipoGas: itemPlanilha.tipoGas, statusCondicao: itemPlanilha.statusCondicao,
        setorPCM: itemPlanilha.setorPCM, prioridadeSetor: itemPlanilha.prioridadeSetor, pisoPCM: itemPlanilha.pisoPCM,
        statusPreventiva: "Pendente", observacao: "", origem: "manual",
        ordemExecucao, equipeResponsavel, dataAgendada: "", diaPlanejado: "", semanaPlanejada: "",
      };
      itensNovos.push(novoItem);
      contadorLocal++;
      adicionadosPredio++;
    });

    resumo.push(`${local}: ${atualizadosPredio} atualizado(s), ${adicionadosPredio} novo(s).`);
  }

  if (!atualizacoes.length && !itensNovos.length) {
    toast("Nada pra atualizar -- nenhuma linha com patrimônio reconhecível nessa planilha.");
    return;
  }

  try {
    await salvarBackupPlanilha([...porPredio.keys()], itensAntesSnapshot, itensNovos.map((i) => i.id), resumo.join(" "));

    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < atualizacoes.length; inicio += TAMANHO_LOTE) {
      const pedaco = atualizacoes.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((u) => batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", u.id), u.campos));
      await batch.commit();
    }
    for (let inicio = 0; inicio < itensNovos.length; inicio += TAMANHO_LOTE) {
      const pedaco = itensNovos.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((item) => batch.set(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), item));
      await batch.commit();
    }
    // Mesmo truque do cadastro manual: soma os itens novos direto em
    // ESTADO.equipamentos (em vez de esperar o listener do Firebase
    // avisar) -- reagendarTudo() usa esse array na hora, e sem isso não
    // ia enxergar os itens recém-criados a tempo de agendar a data deles.
    ESTADO.equipamentos.push(...itensNovos);
    for (const item of itensNovos) {
      await registrarHistorico(item, "-", "Cadastrado", "Cadastro (atualização de planilha)");
    }

    await registrarAuditoria(
      "Atualizar cadastro por planilha",
      `${resumo.join(" ")} -- ninguém foi apagado (quem sumiu da planilha continua como estava)`
    );

    if (itensNovos.length) {
      toast(`Atualizado! ${resumo.join(" ")} Agendando os novos automaticamente...`);
      await reagendarTudo();
    } else {
      toast(`Atualizado! ${resumo.join(" ")}`);
    }
  } catch (err) {
    console.error(err);
    toast("Erro ao atualizar: " + err.message);
  }
}

// --- Backup/undo da "Atualizar cadastro de prédio existente via planilha" ---
// Guarda só o backup da ÚLTIMA atualização (documento de id fixo) -- é
// apagado assim que usado, então não dá pra desfazer duas vezes seguidas.
const BACKUP_PLANILHA_TAMANHO_LOTE = 300;

async function salvarBackupPlanilha(predios, itensAntes, idsNovosCriados, resumoTexto) {
  const numPartes = Math.max(1, Math.ceil(itensAntes.length / BACKUP_PLANILHA_TAMANHO_LOTE));
  for (let i = 0; i < numPartes; i++) {
    const pedaco = itensAntes.slice(i * BACKUP_PLANILHA_TAMANHO_LOTE, (i + 1) * BACKUP_PLANILHA_TAMANHO_LOTE);
    await setDoc(doc(db, "ciclos", ESTADO.cicloAtual, "backupPlanilha", `parte_${i}`), { itens: pedaco });
  }
  const manifesto = {
    criadoEm: new Date().toISOString(),
    resumo: resumoTexto,
    predios,
    idsNovosCriados,
    numPartes,
  };
  await setDoc(doc(db, "ciclos", ESTADO.cicloAtual, "backupPlanilha", "manifesto"), manifesto);
  ESTADO.backupPlanilha = manifesto;
  renderBotaoDesfazerPlanilha();
}

async function carregarBackupPlanilha() {
  if (!ESTADO.cicloAtual) return;
  try {
    const snap = await getDoc(doc(db, "ciclos", ESTADO.cicloAtual, "backupPlanilha", "manifesto"));
    ESTADO.backupPlanilha = snap.exists() ? snap.data() : null;
  } catch (err) {
    console.error("Erro ao verificar backup de planilha:", err);
    ESTADO.backupPlanilha = null;
  }
  renderBotaoDesfazerPlanilha();
}

function renderBotaoDesfazerPlanilha() {
  const card = $("#cardDesfazerPlanilha");
  if (!card) return;
  const manifesto = ESTADO.backupPlanilha;
  if (!manifesto) { card.hidden = true; return; }
  card.hidden = false;
  const quando = new Date(manifesto.criadoEm).toLocaleString("pt-BR");
  $("#desfazerPlanilhaTexto").textContent = `Última atualização por planilha (${quando}): ${manifesto.resumo}`;
}

async function apagarBackupPlanilha() {
  const manifesto = ESTADO.backupPlanilha;
  if (!manifesto) return;
  const batch = writeBatch(db);
  batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "backupPlanilha", "manifesto"));
  for (let i = 0; i < (manifesto.numPartes || 1); i++) {
    batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "backupPlanilha", `parte_${i}`));
  }
  await batch.commit();
  ESTADO.backupPlanilha = null;
  renderBotaoDesfazerPlanilha();
}

async function desfazerUltimaAtualizacaoPlanilha() {
  const manifesto = ESTADO.backupPlanilha;
  if (!manifesto) { toast("Não há nenhuma atualização por planilha pra desfazer."); return; }

  const quando = new Date(manifesto.criadoEm).toLocaleString("pt-BR");
  const ok = await confirmarModal({
    titulo: "Desfazer atualização por planilha?",
    corpoHtml:
      `<p>Feita em <strong>${quando}</strong>: ${escapeHtml(manifesto.resumo)}</p>` +
      `<p>Isso restaura o cadastro desses prédios (setor, ambiente, marca, modelo, capacidade, tipo de gás, status, ` +
      `e qualquer data/agenda recalculada nessa atualização) pro jeito que estava antes, e remove os equipamentos ` +
      `que foram criados por ela.</p>` +
      `<div class="modal-confirm-aviso">Não afeta outros prédios.</div>`,
    textoConfirmar: "Desfazer",
    textoCancelar: "Manter como está",
  });
  if (!ok) return;

  try {
    const itensRestaurados = [];
    for (let i = 0; i < (manifesto.numPartes || 1); i++) {
      const snap = await getDoc(doc(db, "ciclos", ESTADO.cicloAtual, "backupPlanilha", `parte_${i}`));
      if (snap.exists()) itensRestaurados.push(...(snap.data().itens || []));
    }

    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < itensRestaurados.length; inicio += TAMANHO_LOTE) {
      const pedaco = itensRestaurados.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((item) => batch.set(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), item));
      await batch.commit();
    }

    const idsNovos = manifesto.idsNovosCriados || [];
    for (let inicio = 0; inicio < idsNovos.length; inicio += TAMANHO_LOTE) {
      const pedaco = idsNovos.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((id) => batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id)));
      await batch.commit();
    }

    // Atualiza o estado local na hora (mesmo truque usado no resto do app),
    // sem esperar o listener do Firebase avisar.
    const restauradoPorId = new Map(itensRestaurados.map((item) => [item.id, item]));
    const idsNovosSet = new Set(idsNovos);
    ESTADO.equipamentos = ESTADO.equipamentos
      .filter((e) => !idsNovosSet.has(e.id))
      .map((e) => restauradoPorId.get(e.id) || e);

    await registrarAuditoria("Desfazer atualização por planilha", manifesto.resumo);
    await apagarBackupPlanilha();

    renderCalendar();
    renderDashboard();
    renderComProtecaoDeMenu("#equipamentosTable", renderEquipamentosCadastro);

    toast("Atualização por planilha desfeita.");
  } catch (err) {
    console.error(err);
    toast("Erro ao desfazer: " + err.message);
  }
}

function renderPreview(itens) {
  const card = $("#previewCard");
  card.hidden = false;
  $("#previewCount").textContent = `${itens.length} itens`;
  const cols = [
    ["Patrimônio", (i) => i.patrimonio],
    ["Setor", (i) => i.setor],
    ["Ambiente", (i) => i.ambiente],
    ["Status", (i) => i.statusCondicao],
    ["Setor PCM", (i) => i.setorPCM],
    ["Piso", (i) => (i.pisoPCM === 99 ? "-" : i.pisoPCM)],
  ];
  const table = $("#previewTable");
  table.innerHTML = `<thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr></thead>
    <tbody>${itens.map((i) => `<tr>${cols.map((c) => `<td>${c[1](i) ?? ""}</td>`).join("")}</tr>`).join("")}</tbody>`;
}

$("#btnGerar").addEventListener("click", () => {
  if (ESTADO.modoAdicionarPredio) confirmarAdicaoPredioNovo();
  else gerarCronograma();
});

$("#btnDesfazerPlanilha")?.addEventListener("click", desfazerUltimaAtualizacaoPlanilha);

function estaEmFeriado(date) {
  if (!date || !ESTADO.feriados || ESTADO.feriados.length === 0) return false;
  const iso = formatISO(date);
  return ESTADO.feriados.some((f) => f.dataInicio && f.dataFim && iso >= f.dataInicio && iso <= f.dataFim);
}

async function gerarCronograma() {
  if (!ESTADO.itensCarregados.length) {
    toast("Envie e classifique um levantamento primeiro.");
    irParaAba("upload");
    return;
  }

  const diasSemana = Math.min(7, Math.max(1, parseInt($("#diasSemana")?.value, 10) || 5));
  const dataInicioStr = $("#dataInicio")?.value;
  if (!dataInicioStr) {
    toast("Escolha a data de início do cronograma.");
    return;
  }
  const capacidades = lerCapacidadesDaTela();

  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  function ehDiaUtil(data) {
    return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
  }

  const [anoI, mesI, diaI] = dataInicioStr.split("-");
  let dataInicioBase = new Date(anoI, parseInt(mesI, 10) - 1, diaI, 12, 0, 0);
  while (!ehDiaUtil(dataInicioBase)) dataInicioBase.setDate(dataInicioBase.getDate() + 1);
  const primeiraDataUtilGlobal = new Date(dataInicioBase);

  $("#btnGerar").disabled = true;
  try {
    // Captura os cadastros manuais e o status/observação de itens que já
    // existiam, ANTES de apagar tudo — assim nada se perde no reset.
    const existentes = {};
    const manuaisPreservados = [];
    ESTADO.equipamentos.forEach((dados) => {
      existentes[dados.id] = dados;
      if (dados.origem === "manual") manuaisPreservados.push({ ...dados });
    });

    toast("Apagando ciclos anteriores...");
    await registrarAuditoria("Gerar cronograma", `Novo levantamento com ${ESTADO.itensCarregados.length} itens (apagou ciclos anteriores)`);
    await apagarTodosOsCiclos();

    const cicloRef = doc(collection(db, "ciclos"));
    ESTADO.cicloAtual = cicloRef.id;
    await setDoc(cicloRef, {
        criadoEm: new Date().toISOString(),
        dataInicio: formatISO(primeiraDataUtilGlobal),
        status: "Ativo"
    });
    ESTADO.config = { diasSemana, dataInicio: formatISO(primeiraDataUtilGlobal), capacidades };
    await setDoc(doc(db, "config", "cronograma"), ESTADO.config);
    const itensPlanilha = ESTADO.itensCarregados.map((i) => ({ ...i }));
    toast("Salvando...");
    const itens = [...itensPlanilha, ...manuaisPreservados];

    // Agrupa por prédio — cada grupo anda no próprio ritmo, com sua própria capacidade
    const grupos = new Map();
    itens.forEach((item) => {
      const local = item.local || "SEDE";
      if (!grupos.has(local)) grupos.set(local, []);
      grupos.get(local).push(item);
    });

    const resumoPorPredio = [];

    grupos.forEach((itensDoPredio, local) => {
      const cap = capacidades[local] || { nEquipes: 1, aparelhosDia: 2 };
      const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);

      let dataCursor = new Date(primeiraDataUtilGlobal);
      let contador = 0;
      let diasUteisAgendados = 0; // <--- A ROLETA QUE CONTA OS DIAS
      let grupoAmbienteAtual = null;
      let indiceGrupo = -1;
      let ordem = 0;

      itensDoPredio.forEach((item) => {
        const chaveAmbiente = `${item.setor}||${item.ambiente}`;
        if (chaveAmbiente !== grupoAmbienteAtual) {
          grupoAmbienteAtual = chaveAmbiente;
          indiceGrupo++;
        }

      
        const nVagas = cap.nEquipes || 1;
        const slotDaSala = indiceGrupo % nVagas; // Prende a equipe à Vaga do dia (0 ou 1)

        if (cap.modoRodizio && cap.equipesAtivas && cap.equipesAtivas.length > 0) {
            const pool = cap.equipesAtivas;
            // Avança no pool 1,2 -> 3,4 -> 5,6 conforme o dia muda
            const indiceNoPool = (diasUteisAgendados * nVagas + slotDaSala) % pool.length;
            item.equipeResponsavel = pool[indiceNoPool];
        } else {
            // Se o rodízio estiver desligado, usa o comportamento clássico
            const ordemEquipe = slotDaSala + 1;
            const encontrada = ESTADO.equipes.find((e) => e.predio === local && e.ordem === ordemEquipe);
            item.equipeResponsavel = encontrada ? encontrada.nome : `Equipe ${ordemEquipe}`;
        }
    

        ordem++;
        item.ordemExecucao = ordem;
        item.dataAgendada = formatISO(dataCursor);
        item.diaPlanejado = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
        const diffDias = Math.floor((dataCursor - primeiraDataUtilGlobal) / 86400000);
        item.semanaPlanejada = `Semana ${Math.floor(diffDias / 7) + 1}`;

        const anterior = existentes[item.id];
        if (anterior) {
          item.statusPreventiva = anterior.statusPreventiva || "Pendente";
          item.observacao = anterior.observacao || "";
        }

        contador++;
        if (contador >= capacidadeDia) {
          contador = 0;
          diasUteisAgendados++; 
          do { dataCursor.setDate(dataCursor.getDate() + 1); } while (!ehDiaUtil(dataCursor));
        }
      });

      const diasNecessarios = Math.ceil(itensDoPredio.length / capacidadeDia);
      resumoPorPredio.push(`<strong>${escapeHtml(local)}</strong>: ${itensDoPredio.length} itens · ${diasNecessarios} dia(s) úteis · capacidade ${capacidadeDia}/dia`);
    });

    $("#resumoCapacidade").innerHTML = resumoPorPredio.join("<br>") +
      (manuaisPreservados.length ? `<br>${manuaisPreservados.length} cadastrado(s) manualmente incluído(s)` : "");

    const TAMANHO_LOTE = 400;

    for (let inicio = 0; inicio < itens.length; inicio += TAMANHO_LOTE) {
      const pedaco = itens.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((item) => batch.set(
          doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id),
          item
      ));
      await batch.commit();
      toast(`Salvando... ${Math.min(inicio + TAMANHO_LOTE, itens.length)}/${itens.length}`);
    }

    iniciarSincronizacao();
    toast(`Cronograma gerado e salvo! (${itens.length} itens)`);
    irParaAba("calendar");
  } catch (err) {
    console.error(err);
    toast("Erro ao salvar no Firebase: " + err.message);
  } finally {
    $("#btnGerar").disabled = false;
  }
}

// Reorganiza as datas de TODOS os equipamentos já salvos, respeitando a ordem
// de execução, a capacidade diária e os feriados/férias atuais. É chamada
// automaticamente ao cadastrar um feriado novo ou um equipamento manual, para
// que o cronograma sempre reflita o estado mais recente sem precisar reimportar
// a planilha.
async function reagendarTudo(permitirRecuo = false) {
  if (!ESTADO.equipamentos.length) return;

  if (!ESTADO.config) {
    ESTADO.config = { diasSemana: 5, dataInicio: formatISO(new Date()), capacidades: {} };
  }
  if (!ESTADO.config.capacidades) ESTADO.config.capacidades = {};

  const { diasSemana, dataInicio, capacidades } = ESTADO.config;
  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana || 5);
  const hojeISO = formatISO(new Date());

  function ehDiaUtilLocal(data) {
    return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
  }

  const dataBaseStr = dataInicio > hojeISO ? dataInicio : hojeISO;
  const [anoB, mesB, diaB] = dataBaseStr.split("-");
  const dataCursorInicial = new Date(anoB, parseInt(mesB, 10) - 1, diaB, 12, 0, 0);
  while (!ehDiaUtilLocal(dataCursorInicial)) dataCursorInicial.setDate(dataCursorInicial.getDate() + 1);

  const [anoIn, mesIn, diaIn] = dataInicio.split("-");
  const primeiraDataUtil = new Date(anoIn, parseInt(mesIn, 10) - 1, diaIn, 12, 0, 0);
  while (!ehDiaUtilLocal(primeiraDataUtil)) primeiraDataUtil.setDate(primeiraDataUtil.getDate() + 1);

  const porPredio = new Map();
  ESTADO.equipamentos.forEach((e) => {
    const local = e.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(e);
  });

  const atualizacoes = [];

  porPredio.forEach((itensDoPredio, local) => {
    const cap = capacidades[local] || { nEquipes: 1, aparelhosDia: 2 };
    const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);

    const fixos = itensDoPredio.filter((e) =>
      e.statusPreventiva === "Concluída" ||
      (e.statusPreventiva === "Em andamento" && !estaAtrasado(e)) ||
      e.fixadoManualmente === true
    );
    const pendentes = itensDoPredio
      .filter((e) =>
        (e.statusPreventiva === "Pendente" || (e.statusPreventiva === "Em andamento" && estaAtrasado(e))) &&
        e.fixadoManualmente !== true 
      )
      .sort((a, b) => (a.ordemExecucao || 0) - (b.ordemExecucao || 0));

    const ocupacao = {};
    fixos.forEach((f) => {
      if (f.dataAgendada >= hojeISO) {
        ocupacao[f.dataAgendada] = (ocupacao[f.dataAgendada] || 0) + 1;
      }
    });

    let dataCursor = new Date(dataCursorInicial);

    pendentes.forEach((item) => {
      
      // Impede que o item seja puxado para trás — EXCETO quando quem chamou
      // pediu explicitamente pra permitir (caso de remover feriado, que deve
      // liberar a vaga pros aparelhos recuarem).
      if (!permitirRecuo && item.dataAgendada && item.dataAgendada > formatISO(dataCursor)) {
        const [aA, mA, dA] = item.dataAgendada.split("-");
        dataCursor = new Date(aA, parseInt(mA, 10) - 1, dA, 12, 0, 0);
      }

      while (!ehDiaUtilLocal(dataCursor) || (ocupacao[formatISO(dataCursor)] || 0) >= capacidadeDia) {
        dataCursor.setDate(dataCursor.getDate() + 1);
      }
      
      const novaData = formatISO(dataCursor);
      const novoDia = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
      const diffDias = Math.floor((dataCursor - primeiraDataUtil) / 86400000);
      const novaSemana = `Semana ${Math.max(1, Math.floor(diffDias / 7) + 1)}`;

      ocupacao[novaData] = (ocupacao[novaData] || 0) + 1;

      if (item.dataAgendada !== novaData || item.diaPlanejado !== novoDia || item.semanaPlanejada !== novaSemana) {
        atualizacoes.push({
          id: item.id, dataAgendada: novaData, diaPlanejado: novoDia, semanaPlanejada: novaSemana,
          dataAntiga: item.dataAgendada, refCompleta: item,
        });
      }
    });
  });

  if (atualizacoes.length) {
    const TAMANHO_LOTE = 200;
    const agora = new Date().toISOString();

    for (let inicio = 0; inicio < atualizacoes.length; inicio += TAMANHO_LOTE) {
      const pedaco = atualizacoes.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((u) => {
        batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", u.id), {
          dataAgendada: u.dataAgendada, diaPlanejado: u.diaPlanejado, semanaPlanejada: u.semanaPlanejada,
        });
        if (u.dataAntiga && u.dataAntiga < hojeISO) {
          const novoLogRef = doc(collection(     db,     "ciclos",     ESTADO.cicloAtual,     "historico" ));
          batch.set(novoLogRef, {
            equipamentoId: u.refCompleta.id,
            patrimonio: u.refCompleta.patrimonio || "",
            setor: u.refCompleta.setor || "",
            ambiente: u.refCompleta.ambiente || "",
            local: u.refCompleta.local || "SEDE",
            equipe: u.refCompleta.equipeResponsavel || "",
            tipo: "Atraso Reagendado",
            dataAnterior: u.dataAntiga,
            dataNova: u.dataAgendada,
            registradoEm: agora,
          });
        }
      });
      await batch.commit();
    }
    toast(`Cronograma recalculado (${atualizacoes.length} item(ns) reagendado(s)).`);
  }

  await setDoc(doc(db, "config", "cronograma"), ESTADO.config);
}

async function carregarConfigSite() {
  try {
    const snap = await getDoc(doc(db, "config", "site"));
    if (snap.exists()) {
      const dados = snap.data();
      ESTADO.configSite = {
        mesesCiclo: dados.mesesCiclo || MESES_CICLO,
        urlCorretivas: dados.urlCorretivas || URL_CHAMADOS_CORRETIVOS,
        predios: (dados.predios && dados.predios.length) ? dados.predios : ["SEDE", "ANEXO 1", "ANEXO 2", "ANEXO 3", "ANEXO 4"],
        fotoObrigatoria: dados.fotoObrigatoria === true,
      };
    }
    preencherFormularioConfigSite();
  } catch (err) {
    console.error("Erro ao carregar configurações:", err);
  }
}

function preencherFormularioConfigSite() {
  // Preenche os inputs do formulário (Modo Edição)
  if ($("#cfgMesesCiclo")) $("#cfgMesesCiclo").value = ESTADO.configSite.mesesCiclo;
  if ($("#cfgUrlCorretivas")) $("#cfgUrlCorretivas").value = ESTADO.configSite.urlCorretivas;
  if ($("#cfgPredios")) $("#cfgPredios").value = ESTADO.configSite.predios.join("\n");
  if ($("#cfgFotoObrigatoria")) $("#cfgFotoObrigatoria").checked = ESTADO.configSite.fotoObrigatoria === true;

  // Preenche os textos visuais (Modo Leitura)
  if ($("#txtCfgMeses")) $("#txtCfgMeses").textContent = ESTADO.configSite.mesesCiclo + " meses";
  if ($("#txtCfgUrl")) $("#txtCfgUrl").textContent = ESTADO.configSite.urlCorretivas || "Nenhum link configurado";
  if ($("#txtCfgPredios")) $("#txtCfgPredios").textContent = ESTADO.configSite.predios.join(" · ");
  if ($("#txtCfgFoto")) $("#txtCfgFoto").textContent = ESTADO.configSite.fotoObrigatoria ? "Obrigatória" : "Opcional";

  // CORREÇÃO: Preenche automaticamente as opções de Prédio no cadastro de equipamentos
  const selectEqLocal = $("#eqLocal");
  if (selectEqLocal && ESTADO.configSite && ESTADO.configSite.predios) {
    selectEqLocal.innerHTML = ESTADO.configSite.predios.map(p => `<option value="${p}">${p}</option>`).join("");
  }
}

// --- CONTROLES DE MODO LEITURA/EDIÇÃO ---
$("#btnHabilitarEdicaoCfg")?.addEventListener("click", () => {
  $("#cfgModoLeitura").hidden = true;
  $("#btnHabilitarEdicaoCfg").hidden = true;
  $("#cfgModoEdicao").hidden = false;
});

$("#btnCancelarEdicaoCfg")?.addEventListener("click", () => {
  $("#cfgModoEdicao").hidden = true;
  $("#cfgModoLeitura").hidden = false;
  $("#btnHabilitarEdicaoCfg").hidden = false;
  preencherFormularioConfigSite(); // Volta os inputs pro valor original se a pessoa desistir
});

async function propagarRenomeacaoPredios(renomeacoes) {
  for (const { antigo, novo } of renomeacoes) {
    const afetados = ESTADO.equipamentos.filter((e) => (e.local || "SEDE") === antigo);
    if (afetados.length && ESTADO.cicloAtual) {
      const TAMANHO_LOTE = 400;
      for (let inicio = 0; inicio < afetados.length; inicio += TAMANHO_LOTE) {
        const pedaco = afetados.slice(inicio, inicio + TAMANHO_LOTE);
        const batch = writeBatch(db);
        pedaco.forEach((item) => {
          batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), { local: novo });
        });
        await batch.commit();
      }
    }

    const equipesDoPredio = ESTADO.equipes.filter((e) => e.predio === antigo);
    if (equipesDoPredio.length) {
      const batch = writeBatch(db);
      equipesDoPredio.forEach((eq) => batch.update(doc(db, "equipes", eq.id), { predio: novo }));
      await batch.commit();
    }
  }

  const capacidadesAtuais = { ...((ESTADO.config && ESTADO.config.capacidades) || {}) };
  let capacidadesMudaram = false;
  for (const { antigo, novo } of renomeacoes) {
    if (capacidadesAtuais[antigo]) {
      capacidadesAtuais[novo] = capacidadesAtuais[antigo];
      delete capacidadesAtuais[antigo];
      capacidadesMudaram = true;
    }
  }
  if (capacidadesMudaram) {
    ESTADO.config = { ...(ESTADO.config || {}), capacidades: capacidadesAtuais };
    await setDoc(doc(db, "config", "cronograma"), ESTADO.config);
  }
}

// --- SALVAR CONFIGURAÇÕES ---
$("#btnSalvarConfigSite")?.addEventListener("click", async () => {
  const mesesCiclo = Math.max(1, parseInt($("#cfgMesesCiclo").value, 10) || 4);
  const urlCorretivas = $("#cfgUrlCorretivas").value.trim();
  const predios = $("#cfgPredios").value.split("\n").map((p) => p.trim()).filter(Boolean);
  const fotoObrigatoria = $("#cfgFotoObrigatoria")?.checked === true;

  if (!predios.length) {
    toast("Coloca pelo menos um prédio na lista.");
    return;
  }

  const prediosAntigos = ESTADO.configSite.predios || [];
  const removidos = prediosAntigos.filter((p) => !predios.includes(p));
  const adicionados = predios.filter((p) => !prediosAntigos.includes(p));

  let renomeacoes = [];
  if (removidos.length && removidos.length === adicionados.length) {
    renomeacoes = removidos.map((antigo, i) => ({ antigo, novo: adicionados[i] }));
    const descricao = renomeacoes.map((r) => `"${r.antigo}" → "${r.novo}"`).join(", ");
    const ok = window.confirm(
      `Parece que você renomeou: ${descricao}.\n\nQuer que eu atualize automaticamente os equipamentos, equipes e capacidades já cadastrados pra usar o nome novo? Se a lista mudou por outro motivo, clique em Cancelar (a lista de prédios salva do mesmo jeito, só não mexe em mais nada).`
    );
    if (!ok) renomeacoes = [];
  } else if (removidos.length) {
    const impacto = removidos
      .map((p) => `${p} (${ESTADO.equipamentos.filter((e) => (e.local || "SEDE") === p).length} equipamento(s))`)
      .join(", ");
    const temImpacto = removidos.some((p) => ESTADO.equipamentos.some((e) => (e.local || "SEDE") === p));
    if (temImpacto) {
      const ok = window.confirm(
        `Remover ${removidos.join(", ")} da lista vai deixar estes equipamentos sem prédio válido: ${impacto}.\n\nEles continuam existindo, mas somem dos filtros por prédio. Quer continuar mesmo assim?`
      );
      if (!ok) return;
    }
  }

  const novaConfig = { mesesCiclo, urlCorretivas, predios, fotoObrigatoria };
  try {
    await setDoc(doc(db, "config", "site"), novaConfig);
    ESTADO.configSite = novaConfig;

    if (renomeacoes.length) {
      await propagarRenomeacaoPredios(renomeacoes);
    }

    await registrarAuditoria("Alterar parâmetros do sistema", `Ciclo: ${mesesCiclo} meses`);
    toast("Configurações salvas com sucesso!");
    carregarChamadosCorretivos(true);

    $("#btnCancelarEdicaoCfg").click();

  } catch (err) {
    console.error(err);
    toast("Erro ao salvar: " + err.message);
  }

  const selectEqLocal = $("#eqLocal");
  if (selectEqLocal) {
    selectEqLocal.innerHTML = ESTADO.configSite.predios.map((p) => `<option value="${p}">${p}</option>`).join("");
  }
});

async function carregarConfig() {
  try {
    const snap = await getDoc(doc(db, "config", "cronograma"));
    if (snap.exists()) {
      ESTADO.config = snap.data();
      if ($("#nEquipes")) $("#nEquipes").value = ESTADO.config.nEquipes;
      if ($("#aparelhosDia")) $("#aparelhosDia").value = ESTADO.config.aparelhosDia;
      if ($("#diasSemana")) $("#diasSemana").value = ESTADO.config.diasSemana;
      if ($("#dataInicio")) $("#dataInicio").value = ESTADO.config.dataInicio;
        renderCapacidadesPorPredio();
    }
  } catch (err) {
    console.error(err);
  }
}
async function carregarCicloAtual() {

    const snap = await getDocs(
        query(
            collection(db, "ciclos"),
            orderBy("criadoEm", "desc"),
            limit(1)
        )
    );

    if (snap.empty) {
        ESTADO.cicloAtual = null;
        return;
    }

    ESTADO.cicloAtual = snap.docs[0].id;
}
function iniciarSincronizacao() {
  if (!ESTADO.cicloAtual) return;
  if (ESTADO.unsubscribe) ESTADO.unsubscribe();
  const q = query( collection(db, "ciclos", ESTADO.cicloAtual, "equipamentos"),orderBy("ordemExecucao")
);
  ESTADO.unsubscribe = onSnapshot(q, (snap) => {
    ESTADO.equipamentos = snap.docs.map((d) => d.data());
    if (!ESTADO.calYear && ESTADO.equipamentos.length) {
      const primeira = new Date(ESTADO.equipamentos[0].dataAgendada + "T12:00:00Z");
      ESTADO.calYear = primeira.getFullYear();
      ESTADO.calMonth = primeira.getMonth();
    }
    renderCalendar();
    renderDashboard();
    renderComProtecaoDeMenu("#equipamentosTable", renderEquipamentosCadastro);
    renderLocalizacao();
    atualizarBannerAtrasados();
    atualizarAlertaDiasVazios();
    renderCiclos();
    verificarFechamentoCiclo();
    renderTodosSeletoresLocal();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler dados do Firebase: " + err.message);
  });
}

async function inicializarApp() {
    await carregarCicloAtual();
    carregarConfig();
    carregarChamadosCorretivos(true);
    setInterval(() => carregarChamadosCorretivos(), INTERVALO_ATUALIZACAO_CORRETIVOS_MS);
    iniciarSincronizacao();
    iniciarSincronizacaoHistorico();
    iniciarSincronizacaoOrdens();
    iniciarSincronizacaoCiclos();
    iniciarSincronizacaoPlantas();
    iniciarSincronizacaoFeriados();
    carregarBackupPlanilha();
}

let modoCadastro = false;

function mostrarErroAuth(msg) {
  const el = $("#authErro");
  if (el) el.textContent = msg;
}

$("#btnAuthCriarConta")?.addEventListener("click", () => {
  modoCadastro = !modoCadastro;
  $("#authTitulo").textContent = modoCadastro ? "Criar conta" : "Entrar";
  $("#btnAuthEntrar").textContent = modoCadastro ? "Criar conta" : "Entrar";
  $("#btnAuthCriarConta").textContent = modoCadastro ? "Já tenho conta, entrar" : "Criar uma conta nova";
  mostrarErroAuth("");
});

$("#btnAuthEntrar")?.addEventListener("click", async () => {
  const usuarioDigitado = $("#authEmail").value.trim();
  const senha = $("#authSenha").value;
  if (!usuarioDigitado || !senha) { mostrarErroAuth("Preencha usuário e senha."); return; }
  const email = usuarioParaEmail(usuarioDigitado);
  mostrarErroAuth("");
  try {
    if (modoCadastro) {
      await createUserWithEmailAndPassword(auth, email, senha);
    } else {
      await signInWithEmailAndPassword(auth, email, senha);
    }
  } catch (err) {
    console.error("Erro de autenticação:", err.code, err.message);
    const mensagens = {
      "auth/email-already-in-use": "Esse e-mail já tem conta. Clique em \"Já tenho conta\".",
      "auth/invalid-email": "E-mail inválido.",
      "auth/weak-password": "Senha muito curta (mínimo 6 caracteres).",
      "auth/user-not-found": "E-mail não encontrado.",
      "auth/wrong-password": "Senha incorreta.",
      "auth/invalid-credential": "E-mail ou senha incorretos.",
    };
    mostrarErroAuth(mensagens[err.code] || ("Erro: " + err.message));
  }
});

$("#btnSair")?.addEventListener("click", () => {
  
  // Desliga todos os "escutadores" do Firestore antes de sair — senão eles
  // continuam tentando sincronizar sem permissão e enchem o console de erro.
  if (ESTADO.unsubscribe) ESTADO.unsubscribe();
  if (ESTADO.unsubscribeFeriados) ESTADO.unsubscribeFeriados();
  if (ESTADO.unsubscribeOrdens) ESTADO.unsubscribeOrdens();
  if (ESTADO.unsubscribeHistorico) ESTADO.unsubscribeHistorico();
  if (ESTADO.unsubscribeCiclos) ESTADO.unsubscribeCiclos();
  appJaInicializado = false; // permite reiniciar tudo se logar de novo sem recarregar a página
  signOut(auth);
});

let appJaInicializado = false;
async function registrarUsuarioLogado(user) {
  const ref = doc(db, "usuarios", user.uid);
  const snap = await getDoc(ref);
  const agora = new Date().toISOString();
  if (!snap.exists()) {
    const dados = {
      usuario: extrairUsuario(user.email),
      permissao: "padrao",
      bloqueado: false,
      criadoEm: agora,
      ultimoLogin: agora,
    };
    await setDoc(ref, dados);
    return dados;
  }
  await updateDoc(ref, { ultimoLogin: agora });
  return snap.data();
}

onAuthStateChanged(auth, async (user) => {
  const overlay = $("#authOverlay");
  const appRoot = $("#appRoot");
  const telaCarregando = $("#telaCarregando");
  if (telaCarregando) telaCarregando.remove();
  if (user) {
    ESTADO.usuarioEmail = user.email;
    ESTADO.usuarioNome = extrairUsuario(user.email);
    try {
      const dadosUsuario = await registrarUsuarioLogado(user);
      if (dadosUsuario && dadosUsuario.bloqueado) {
        mostrarErroAuth("Sua conta está bloqueada. Fale com a administradora.");
        await signOut(auth);
        return;
      }
      ESTADO.permissao = (dadosUsuario && dadosUsuario.permissao) || "padrao";
    } catch (err) {
      console.error("Erro ao verificar usuário:", err);
    }
    if (overlay) overlay.hidden = true;
    if (appRoot) appRoot.hidden = false;
    atualizarVisibilidadeAdmin();
    if (!appJaInicializado) {
          appJaInicializado = true;
          inicializarApp();
          if (ESTADO.permissao === "admin") { iniciarSincronizacaoUsuarios(); iniciarSincronizacaoAuditoria(); iniciarSincronizacaoEquipes(); }
          await carregarConfigSite();
          const abaSalva = localStorage.getItem("ultimaAbaPMOC") || "dashboard";
          irParaAba(abaPermitida(abaSalva, ESTADO.permissao) ? abaSalva : "dashboard");
        }
  } else {
    if (overlay) overlay.hidden = false;
    if (appRoot) appRoot.hidden = true;
  }
});

function atualizarVisibilidadeAdmin() {
  const permissao = ESTADO.permissao;
  const isAdmin = permissao === "admin";
  const isTrabalhador = permissao === "trabalhador";

  const btnCfg = $("#navConfigSite");
  if (btnCfg) btnCfg.hidden = !isAdmin;

  // Trabalhador herda o mesmo travamento visual do padrão (não edita nada
  // fora do previsto), mas com uma exceção: o status do calendário e o
  // formulário de concluir preventiva continuam interativos (ver CSS).
  document.body.classList.toggle("modo-padrao", permissao === "padrao" || isTrabalhador);
  document.body.classList.toggle("modo-trabalhador", isTrabalhador);

  // Levantamento e Cronograma só pra admin
  ["upload", "config"].forEach((view) => {
    const tab = $(`.tab[data-view="${view}"]`);
    if (tab) tab.hidden = !isAdmin;
  });

  // Trabalhador só vê Calendário e Dashboard — some com o resto do menu
  ["ordens", "historico", "equipamentos", "feriados"].forEach((view) => {
    const tab = $(`.tab[data-view="${view}"]`);
    if (tab) tab.hidden = isTrabalhador;
  });
}

function abaPermitida(nome, permissao) {
  if (permissao === "admin") return true;
  if (["upload", "config"].includes(nome)) return false;
  if (permissao === "trabalhador" && ["ordens", "historico", "equipamentos", "feriados"].includes(nome)) return false;
  return true;
}


// ------------------------------------------------------------------
// Administração de usuários (só visível/funcional para permissao=="admin";
// a trava de verdade está nas regras do Firestore, não só aqui)
// ------------------------------------------------------------------
async function criarContaAdmin(usuario, senha, permissao) {
  const nomeAppTemp = "temp_" + Date.now();
  const appTemp = initializeApp(firebaseConfig, nomeAppTemp);
  const authTemp = getAuth(appTemp);

  try {
    await setPersistence(authTemp, inMemoryPersistence);

    const email = usuarioParaEmail(usuario);
    const cred = await createUserWithEmailAndPassword(authTemp, email, senha);
    const uid = cred.user.uid;

    await signOut(authTemp);

    await setDoc(doc(db, "usuarios", uid), {
      usuario: usuario.trim().toLowerCase(),
      permissao,
      bloqueado: false,
      criadoEm: new Date().toISOString(),
      ultimoLogin: "",
      criadoPor: ESTADO.usuarioNome || "",
    });
    await registrarAuditoria("Criar usuário", `${usuario} (${permissao})`);
  } finally {
    await deleteApp(appTemp);
  }
}

$("#btnCriarUsuario")?.addEventListener("click", async () => {
  const usuario = $("#novoUsuarioNome").value.trim();
  const senha = $("#novoUsuarioSenha").value;
  const permissao = $("#novoUsuarioPermissao").value;

  if (!usuario || senha.length < 6) {
    toast("Preencha o usuário e uma senha com 6 ou mais caracteres.");
    return;
  }

  // Muda o botão para mostrar que está carregando
  const btn = $("#btnCriarUsuario");
  btn.disabled = true;
  btn.textContent = "Criando...";

  try {
    await criarContaAdmin(usuario, senha, permissao);
    toast(`Conta "${usuario}" criada com sucesso!`);

    // Limpa os campos
    $("#novoUsuarioNome").value = "";
    $("#novoUsuarioSenha").value = "";

    // FORÇA O SISTEMA A RECARREGAR A TABELA NA MESMA HORA
    iniciarSincronizacaoUsuarios();
    
  } catch (err) {
    console.error(err);
    const msgs = {
      "auth/email-already-in-use": "Esse nome de usuário já existe.",
      "auth/weak-password": "Senha muito curta.",
    };
    toast(msgs[err.code] || ("Erro: " + err.message));
  } finally {
    // Volta o botão ao normal
    btn.disabled = false;
    btn.textContent = "+ Criar conta";
  }
});

function iniciarSincronizacaoUsuarios() {
  const q = query(collection(db, "usuarios"), orderBy("criadoEm", "desc"));
  onSnapshot(q, (snap) => {
    ESTADO.usuarios = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderComProtecaoDeMenu("#usuariosTable", renderUsuarios);
  }, (err) => console.error("Erro ao ler usuários:", err));
}

function iniciarSincronizacaoAuditoria() {
  const q = query(collection(db, "auditoria"), orderBy("registradoEm", "desc"), limit(500));
  onSnapshot(q, (snap) => {
    ESTADO.auditoria = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAuditoria();
  }, (err) => console.error("Erro ao ler auditoria:", err));
}

function renderAuditoria() {
  const table = $("#auditoriaTable");
  if (!table) return;
  const registros = ESTADO.auditoria || [];
  $("#auditoriaCount").textContent = `${registros.length} registros`;
  table.innerHTML = `<thead><tr>
      <th>Data/Hora</th><th>Usuário</th><th>Ação</th><th>Detalhes</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  registros.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(r.registradoEm).toLocaleString("pt-BR")}</td>
      <td>${escapeHtml(r.usuario || "-")}</td>
      <td><strong>${escapeHtml(r.acao)}</strong></td>
      <td>${escapeHtml(r.detalhes || "-")}</td>`;
    tbody.appendChild(tr);
  });
}

function renderUsuarios() {
  const table = $("#usuariosTable");
  if (!table) return;
  
  const usuariosVisiveis = ESTADO.usuarios.filter((u) => !u.excluidoEm);
  $("#usuariosCount").textContent = `${usuariosVisiveis.length} conta(s)`;

  table.innerHTML = `<thead><tr>
      <th>Usuário</th><th>Permissão</th><th>Criado em</th><th>Último login</th><th></th>
    </tr></thead><tbody></tbody>`;

  const tbody = table.querySelector("tbody");

  usuariosVisiveis.forEach((u) => {
    const tr = document.createElement("tr");
    
    // Se o usuário estiver bloqueado, aplicamos um estilo CSS sutil (riscado + cinza)
    const estiloUsuario = u.bloqueado ? 'style="text-decoration: line-through; color: var(--texto-suave);"' : '';

    tr.innerHTML = `
      <td ${estiloUsuario}>${u.usuario} ${u.bloqueado ? '(Bloqueado)' : ''}</td>
      <td>${ROTULOS_PERMISSAO[u.permissao] || "Padrão"}</td>
      <td>${u.criadoEm ? new Date(u.criadoEm).toLocaleDateString("pt-BR") : "-"}</td>
      <td>${u.ultimoLogin ? new Date(u.ultimoLogin).toLocaleString("pt-BR") : "-"}</td>`;

    const tdMenu = document.createElement("td");

    const acaoBloqueio = u.bloqueado ? "Desbloquear" : "Bloquear";
    const outrasPermissoes = Object.keys(ROTULOS_PERMISSAO).filter((p) => p !== (u.permissao || "padrao"));

    tdMenu.innerHTML = `<details class="menu-linha"><summary>⋯</summary>
      <div class="menu-linha-opcoes">
        <button class="menu-linha-item" data-acao="bloqueio">${acaoBloqueio}</button>
        ${outrasPermissoes.map((p) =>
          `<button class="menu-linha-item eq-permissao-btn" data-permissao="${p}">Mudar para ${ROTULOS_PERMISSAO[p]}</button>`
        ).join("")}
        <button class="menu-linha-item menu-linha-excluir" data-acao="excluir">Excluir conta</button>
      </div>
    </details>`;

    // Lógica 1: Bloquear / Desbloquear
    tdMenu.querySelector('[data-acao="bloqueio"]').addEventListener("click", async () => {
      try {
        await updateDoc(doc(db, "usuarios", u.id), { bloqueado: !u.bloqueado });
        await registrarAuditoria(u.bloqueado ? "Desbloquear usuário" : "Bloquear usuário", u.usuario);
        toast(u.bloqueado ? "Usuário desbloqueado." : "Usuário bloqueado.");
      } catch (err) {
        console.error(err);
        toast("Erro: " + err.message);
      }
    });

    // Lógica 2: Mudar Permissão
    tdMenu.querySelectorAll('.eq-permissao-btn').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const novaPermissao = btn.dataset.permissao;
        try {
          await updateDoc(doc(db, "usuarios", u.id), { permissao: novaPermissao });
          await registrarAuditoria("Alterar permissão", `${u.usuario}: ${u.permissao} → ${novaPermissao}`);
          toast(`Permissão alterada com sucesso.`);
        } catch (err) {
          console.error(err);
          toast("Erro ao alterar permissão: " + err.message);
        }
      });
    });

    // Lógica 3: Excluir Conta
    // Não dá pra apagar de verdade o login (Firebase Auth) sem um backend
    // pago — então isso bloqueia a conta permanentemente e some ela da
    // lista. Sem isso, apagar só o perfil deixava a pessoa "ressuscitar"
    // a própria conta (com permissão padrão) só de logar de novo.
    tdMenu.querySelector('[data-acao="excluir"]').addEventListener("click", async () => {
      const ok = window.confirm(`Tem certeza que deseja excluir a conta de ${u.usuario}? Essa pessoa não vai mais conseguir acessar o sistema.`);
      if(!ok) return;

      try {
        await updateDoc(doc(db, "usuarios", u.id), {
          bloqueado: true,
          excluidoEm: new Date().toISOString(),
        });
        await registrarAuditoria("Excluir conta", u.usuario);
        toast("Conta excluída.");
      } catch (err) {
        console.error(err);
        toast("Erro ao excluir: " + err.message);
      }
    });

    tr.appendChild(tdMenu);
    tbody.appendChild(tr);
  });
}

function slugLocal(local) {
  return String(local).replace(/[^a-zA-Z0-9]/g, "_");
}

function locaisParaConfigurar() {
  // No fluxo de "adicionar prédio novo", a tela de Capacidade deve
  // mostrar só o(s) prédio(s) que estão sendo adicionados agora -- não a
  // lista inteira -- senão pareceria que "Gerar Cronograma" ali vai
  // reprocessar tudo de novo (ver confirmarAdicaoPredioNovo).
  if (ESTADO.modoAdicionarPredio && ESTADO.itensParaAdicionarPredio) {
    const setNovo = new Set(ESTADO.itensParaAdicionarPredio.map((e) => e.local || "SEDE"));
    return [...setNovo].sort();
  }
  const origem = ESTADO.equipamentos.length ? ESTADO.equipamentos : ESTADO.itensCarregados;
  const set = new Set(origem.map((e) => e.local || "SEDE"));
  return set.size ? [...set].sort() : ["SEDE"];
}

// Troca os textos/avisos da aba Cronograma entre o modo normal ("Gerar
// Cronograma" reescreve tudo) e o modo "adicionar prédio novo" (só
// acrescenta o(s) prédio(s) de agora, sem tocar no resto) -- mesma tela,
// só avisando com clareza qual dos dois vai acontecer ao clicar no botão.
function atualizarVisualModoAdicionarPredio() {
  const aviso = $("#avisoModoAdicionarPredio");
  const avisoTexto = $("#avisoModoAdicionarPredioTexto");
  const titulo = $("#launchpadTitulo");
  const textoLaunchpad = $("#launchpadAviso");
  const botao = $("#btnGerar");
  if (!aviso || !avisoTexto || !titulo || !textoLaunchpad || !botao) return;

  if (ESTADO.modoAdicionarPredio && ESTADO.itensParaAdicionarPredio) {
    const predios = [...new Set(ESTADO.itensParaAdicionarPredio.map((e) => e.local || "SEDE"))];
    aviso.hidden = false;
    avisoTexto.textContent = `Adicionando prédio novo: ${predios.join(", ")} (${ESTADO.itensParaAdicionarPredio.length} equipamento(s)). Ajuste a capacidade abaixo e clique em "Adicionar ao Cronograma" -- os outros prédios já cadastrados não são tocados.`;
    titulo.textContent = "Pronto para adicionar?";
    textoLaunchpad.innerHTML = `Ao clicar, o sistema agenda só o(s) equipamento(s) de <strong>${escapeHtml(predios.join(", "))}</strong> a partir da data de início acima. <strong>Os outros prédios continuam exatamente como estão.</strong>`;
    botao.textContent = "Adicionar ao Cronograma";
  } else {
    aviso.hidden = true;
    titulo.textContent = "Pronto para processar?";
    textoLaunchpad.innerHTML = `Ao clicar em gerar, o sistema calculará as rotas e datas de todos os equipamentos com base nas regras acima. <strong>Isso reescreverá o cronograma atual.</strong>`;
    botao.textContent = "Gerar Cronograma";
  }
}

function iniciarSincronizacaoEquipes() {
  const q = query(collection(db, "equipes"), orderBy("predio"), orderBy("ordem"));
  onSnapshot(q, (snap) => {
    ESTADO.equipes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderComProtecaoDeMenu("#equipesPorPredio", renderEquipesPorPredio);
  }, (err) => console.error("Erro ao ler equipes:", err));
}

function nomeEquipePorVaga(predio, vaga, nEquipesFallback) {
  const cap = (ESTADO.config && ESTADO.config.capacidades && ESTADO.config.capacidades[predio]);
  
  // MODO NOVO: Se marcou "Definir equipes por nome", usa a lista selecionada
  if (cap && cap.modoRodizio && cap.equipesAtivas && cap.equipesAtivas.length > 0) {
    const index = vaga % cap.equipesAtivas.length;
    return cap.equipesAtivas[index];
  }

  // MODO ANTIGO: Segue puxando pelo número ("Equipes: 2") e a ordem de cadastro
  const ordem = (vaga % (nEquipesFallback || 1)) + 1;
  const encontrada = ESTADO.equipes.find((e) => e.predio === predio && e.ordem === ordem);
  return encontrada ? encontrada.nome : `Equipe ${ordem}`;
}
// Time atribuído em equipamentos é uma cópia do nome, não uma referência —
// então renomear a equipe não reflete sozinho no calendário/dashboard.
// Isso propaga o nome novo pra tudo que já está agendado no ciclo atual.
async function propagarRenomeacaoEquipe(nomeAntigo, nomeNovo) {
  if (!ESTADO.cicloAtual) return;
  const afetados = ESTADO.equipamentos.filter((e) => e.equipeResponsavel === nomeAntigo);
  if (!afetados.length) return;

  const TAMANHO_LOTE = 400;
  for (let inicio = 0; inicio < afetados.length; inicio += TAMANHO_LOTE) {
    const pedaco = afetados.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => {
      batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), {
        equipeResponsavel: nomeNovo,
      });
    });
    await batch.commit();
  }
}

// Quando duas equipes trocam de posição (extra ↔ rotina), o trabalho que já
// estava no calendário também troca de dono — não só as vagas futuras.
async function propagarTrocaDeEquipes(nomeA, nomeB) {
  if (!ESTADO.cicloAtual) return;
  const afetados = ESTADO.equipamentos.filter((e) =>
    e.equipeResponsavel === nomeA || e.equipeResponsavel === nomeB
  );
  if (!afetados.length) return;

  const TAMANHO_LOTE = 400;
  for (let inicio = 0; inicio < afetados.length; inicio += TAMANHO_LOTE) {
    const pedaco = afetados.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => {
      const novoNome = item.equipeResponsavel === nomeA ? nomeB : nomeA;
      batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), {
        equipeResponsavel: novoNome,
      });
    });
    await batch.commit();
  }
}

function renderEquipesPorPredio() {
  const container = $("#equipesPorPredio");
  if (!container) return;

  const predios = ESTADO.configSite.predios;
  const capacidades = (ESTADO.config && ESTADO.config.capacidades) || {};

  container.innerHTML = predios.map((predio) => {
    const cap = capacidades[predio] || { nEquipes: 2, modoRodizio: false, equipesAtivas: [] };
    const nEquipes = cap.nEquipes || 2;
    const equipesDoPredio = ESTADO.equipes.filter((e) => e.predio === predio).sort((a, b) => a.ordem - b.ordem);
    const maiorOrdem = equipesDoPredio.reduce((max, e) => Math.max(max, e.ordem), 0);
    const totalVagas = Math.max(nEquipes, maiorOrdem);

    const modoRodizio = cap.modoRodizio === true;
    const ativasPorNome = cap.equipesAtivas && cap.equipesAtivas.length > 0 ? cap.equipesAtivas : equipesDoPredio.map(e => e.nome);

    const vagasAtivasVazias = [];
    const equipesAcima = [];
    for (let o = 1; o <= nEquipes; o++) {
      const eq = equipesDoPredio.find((e) => e.ordem === o);
      if (eq) equipesAcima.push(eq);
      else vagasAtivasVazias.push(o);
    }

    let linhas = "";
    for (let ordem = 1; ordem <= totalVagas; ordem++) {
      const existente = equipesDoPredio.find((e) => e.ordem === ordem);
      const ehAbaixoDoLimite = ordem > nEquipes;
      const outrosPredios = predios.filter((p) => p !== predio);

      let badgeHtml = "";
      if (existente) {
          if (modoRodizio) {
              badgeHtml = ativasPorNome.includes(existente.nome)
                  // AZUL para quem está no rodízio
                  ? '<span class="status-select" style="font-size: 10px; padding: 2px 6px; cursor:default; flex-shrink:0; white-space:nowrap; background: var(--azul-700); color: white;">No rodízio</span>'
                  // LARANJA para quem está cadastrada mas não participa agora
                  : '<span class="status-select" style="font-size: 10px; padding: 2px 6px; cursor:default; flex-shrink:0; white-space:nowrap; background: #ea580c; color: white;">Reserva</span>';
          } else {
              if (!ehAbaixoDoLimite) {
                  // AMARELO para o modo de Rotina original
                  badgeHtml = '<span class="status-select andamento" style="font-size: 10px; padding: 2px 6px; cursor:default; flex-shrink:0; white-space:nowrap;">Na rotina</span>';
              } else {
                  // CINZA CENTRALIZADO para Reserva
                  badgeHtml = '<span class="status-select" style="font-size: 10px; padding: 2px 6px; cursor:default; flex-shrink:0; white-space:nowrap; background:var(--borda); color:var(--texto-suave); text-align:center; justify-content:center;">Reserva</span>';
              }
          }
      }

      linhas += `
        <div class="eq-linha">
          <span style="color: var(--borda-forte); font-size: 14px; margin-right: 4px;" title="Ordem/Vaga ${ordem}">⋮⋮</span>
          <input type="text" data-predio="${escapeHtml(predio)}" data-ordem="${ordem}" class="eq-nome-input"
            value="${existente ? escapeHtml(existente.nome) : ""}" placeholder="Nome da equipe ${ordem}...">
          ${badgeHtml}
          <details class="menu-linha">
            <summary>⋯</summary>
            <div class="menu-linha-opcoes">
              ${existente && modoRodizio && !ativasPorNome.includes(existente.nome) ? ativasPorNome.map((nomeAtivo) =>
                `<button class="menu-linha-item eq-trocar-rodizio-btn" data-predio="${escapeHtml(predio)}" data-entra="${escapeHtml(existente.nome)}" data-sai="${escapeHtml(nomeAtivo)}">Trocar com "${escapeHtml(nomeAtivo)}" (está no rodízio)</button>`
              ).join("") : ""}
              ${existente && !modoRodizio && ehAbaixoDoLimite ? equipesAcima.map((ativa) =>
                `<button class="menu-linha-item eq-promover-btn" data-id="${existente.id}" data-id-destino="${ativa.id}">Trocar posição com "${escapeHtml(ativa.nome)}"</button>`
              ).join("") : ""}
              ${existente && !modoRodizio && ehAbaixoDoLimite ? vagasAtivasVazias.map((vaga) =>
                `<button class="menu-linha-item eq-promover-vaga-btn" data-id="${existente.id}" data-vaga="${vaga}">Mover para vaga ${vaga} (vazia)</button>`
              ).join("") : ""}
              ${existente ? outrosPredios.map((p) =>
                `<button class="menu-linha-item eq-mover-btn" data-id="${existente.id}" data-destino="${escapeHtml(p)}">Mover para ${escapeHtml(p)}</button>`
              ).join("") : ""}
              ${existente ? `<button class="menu-linha-item menu-linha-excluir eq-excluir" data-id="${existente.id}">Excluir equipe</button>` : ""}
            </div>
          </details>
        </div>`;
    }

    const subtitulo = modoRodizio ? "Sistema de rodízio" : `${nEquipes} vagas por dia`;

    return `
      <div class="eq-predio-card">
        <div class="eq-predio-titulo">
          ${escapeHtml(predio)}
          <span class="badge-capacidade">${subtitulo}</span>
        </div>
        <div style="margin-bottom: 12px; display: flex; flex-direction: column; flex: 1;">
          ${linhas}
        </div>
        <button class="btn ghost btn-adicionar-vaga" data-predio="${escapeHtml(predio)}" style="margin-top:auto">+ Adicionar equipe</button>
      </div>`;
  }).join("");

  // Re-atachando os eventos originais
  container.querySelectorAll(".btn-adicionar-vaga").forEach((btn) => {
    btn.addEventListener("click", () => {
      const predio = btn.dataset.predio;
      const equipesDoPredio = ESTADO.equipes.filter((e) => e.predio === predio);
      const proximaOrdem = equipesDoPredio.reduce((max, e) => Math.max(max, e.ordem), 0) + 1;
      const nomeTemp = window.prompt(`Nome da nova equipe em ${predio}:`);
      if (!nomeTemp || !nomeTemp.trim()) return;
      addDoc(collection(db, "equipes"), { predio, ordem: proximaOrdem, nome: nomeTemp.trim() })
        .then(() => registrarAuditoria("Adicionar equipe", `${nomeTemp.trim()} — ${predio}`))
        .catch((err) => { console.error(err); toast("Erro ao adicionar: " + err.message); });
    });
  });

  container.querySelectorAll(".eq-nome-input").forEach((input) => {
    input.addEventListener("change", async () => {
      const predio = input.dataset.predio;
      const ordem = Number(input.dataset.ordem);
      const nome = input.value.trim();
      const existente = ESTADO.equipes.find((e) => e.predio === predio && e.ordem === ordem);
      try {
        if (!nome) {
          if (existente) await deleteDoc(doc(db, "equipes", existente.id));
          return;
        }
        if (existente) {
          const nomeAntigo = existente.nome;
          await updateDoc(doc(db, "equipes", existente.id), { nome });
          if (nomeAntigo && nomeAntigo !== nome) {
            await propagarRenomeacaoEquipe(nomeAntigo, nome);
          }
        } else {
          await addDoc(collection(db, "equipes"), { predio, ordem, nome });
        }
        await registrarAuditoria("Renomear/definir equipe", `${nome} — ${predio}`);
        toast("Equipe salva.");
      } catch (err) {
        console.error(err);
        toast("Erro ao salvar: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-trocar-rodizio-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const predio = btn.dataset.predio;
      const entra = btn.dataset.entra;
      const sai = btn.dataset.sai;
      try {
        if (!ESTADO.config) ESTADO.config = {};
        if (!ESTADO.config.capacidades) ESTADO.config.capacidades = {};
        const cap = ESTADO.config.capacidades[predio] || { nEquipes: 2, aparelhosDia: 2, modoRodizio: true, equipesAtivas: [] };
        const lista = [...(cap.equipesAtivas || [])];
        const idx = lista.indexOf(sai);
        if (idx !== -1) lista[idx] = entra; else lista.push(entra);
        cap.equipesAtivas = lista;
        ESTADO.config.capacidades[predio] = cap;

        await setDoc(doc(db, "config", "cronograma"), ESTADO.config);
        await propagarRenomeacaoEquipe(sai, entra);
        await registrarAuditoria("Trocar equipe no rodízio", `${sai} → ${entra} — ${predio}`);
        toast(`"${entra}" entrou no rodízio no lugar de "${sai}".`);
        renderEquipesPorPredio();
      } catch (err) {
        console.error(err);
        toast("Erro ao trocar: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-promover-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const extra = ESTADO.equipes.find((e) => e.id === btn.dataset.id);
      const ativa = ESTADO.equipes.find((e) => e.id === btn.dataset.idDestino);
      if (!extra || !ativa) return;
      try {
        const batch = writeBatch(db);
        batch.update(doc(db, "equipes", extra.id), { ordem: ativa.ordem });
        batch.update(doc(db, "equipes", ativa.id), { ordem: extra.ordem });
        await batch.commit();
        await propagarTrocaDeEquipes(extra.nome, ativa.nome);
        await registrarAuditoria("Trocar posição de equipe", `${extra.nome} ↔ ${ativa.nome} — ${extra.predio}`);
        toast(`Posições trocadas com sucesso.`);
      } catch (err) {
        console.error(err);
        toast("Erro ao trocar: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-promover-vaga-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const extra = ESTADO.equipes.find((e) => e.id === btn.dataset.id);
      if (!extra) return;
      const novaOrdem = Number(btn.dataset.vaga);
      const nomeVagaFallback = `Equipe ${novaOrdem}`;
      try {
        await updateDoc(doc(db, "equipes", extra.id), { ordem: novaOrdem });
        await propagarRenomeacaoEquipe(nomeVagaFallback, extra.nome);
        await registrarAuditoria("Mover equipe para vaga vazia", `${extra.nome} — ${extra.predio}`);
        toast(`Posição alterada com sucesso.`);
      } catch (err) {
        console.error(err);
        toast("Erro ao promover: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-mover-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const existente = ESTADO.equipes.find((e) => e.id === btn.dataset.id);
      if (!existente) return;
      const destino = btn.dataset.destino;

      const equipamentosPresos = ESTADO.equipamentos.filter(
        (e) => (e.local || "SEDE") === existente.predio && e.equipeResponsavel === existente.nome
      );
      if (equipamentosPresos.length) {
        const ok = window.confirm(
          `"${existente.nome}" tem ${equipamentosPresos.length} equipamento(s) agendado(s) em ${existente.predio}. Ao mover pra ${destino}, esses equipamentos vão continuar mostrando "${existente.nome}" como responsável. Quer continuar mesmo assim?`
        );
        if (!ok) return;
      }

      const equipesDoDestino = ESTADO.equipes.filter((e) => e.predio === destino);
      const novaOrdem = equipesDoDestino.reduce((max, e) => Math.max(max, e.ordem), 0) + 1;
      try {
        await updateDoc(doc(db, "equipes", existente.id), { predio: destino, ordem: novaOrdem });
        await registrarAuditoria("Mover equipe de prédio", `${existente.nome}: ${existente.predio} → ${destino}`);
        toast(`Equipe movida pra ${destino}.`);
      } catch (err) {
        console.error(err);
        toast("Erro ao mover: " + err.message);
      }
    });
  });

  container.querySelectorAll(".eq-excluir").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const existente = ESTADO.equipes.find((e) => e.id === btn.dataset.id);
      const equipamentosPresos = existente
        ? ESTADO.equipamentos.filter((e) => e.equipeResponsavel === existente.nome)
        : [];
      const aviso = equipamentosPresos.length
        ? `Excluir "${existente.nome}"? Ela tem ${equipamentosPresos.length} equipamento(s) que vão continuar mostrando essa equipe como responsável.`
        : "Excluir essa equipe?";
      const ok = window.confirm(aviso);
      if (!ok) return;
      try {
        await deleteDoc(doc(db, "equipes", btn.dataset.id));
        await registrarAuditoria("Excluir equipe", existente ? existente.nome : btn.dataset.id);
        toast("Equipe excluída.");
      } catch (err) {
        console.error(err);
        toast("Erro ao excluir: " + err.message);
      }
    });
  });
}

function renderCapacidadesPorPredio() {
  const container = $("#capacidadesPorPredio");
  if (!container) return;
  const locais = locaisParaConfigurar();
  const capacidadesAtuais = (ESTADO.config && ESTADO.config.capacidades) || {};

  container.innerHTML = locais.map((local) => {
    const slug = slugLocal(local);
    const cap = capacidadesAtuais[local] || { nEquipes: 2, aparelhosDia: 2, modoRodizio: false, equipesAtivas: [] };
    
    const modoRodizio = cap.modoRodizio === true;
    let painelAvancado = "";
    
    if (modoRodizio) {
        const equipesDoPredio = ESTADO.equipes.filter(e => e.predio === local).sort((a, b) => a.ordem - b.ordem);

        if (equipesDoPredio.length === 0) {
            painelAvancado = `<div style="width:100%; margin-top:10px; color:var(--vermelho);">Nenhuma equipe cadastrada neste prédio. Vá na aba "Configurações > Equipes".</div>`;
        } else {
            const ativas = cap.equipesAtivas && cap.equipesAtivas.length > 0 ? cap.equipesAtivas : equipesDoPredio.map(e => e.nome);

            const htmlEquipes = `<div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:8px;">
              ${equipesDoPredio.map(e => `
                <label style="display:flex; align-items:center; gap:4px; font-weight:normal; text-transform:none;">
                  <input type="checkbox" class="chk-equipe-${slug}" value="${escapeHtml(e.nome)}" ${ativas.includes(e.nome) ? "checked" : ""}>
                  ${escapeHtml(e.nome)}
                </label>
              `).join("")}
            </div>`;

            painelAvancado = `
              <div style="width:100%; margin-top:12px; padding:12px; background:var(--azul-50); border:1px solid var(--borda); border-radius:var(--raio-pequeno);">
                <span style="font-size:11px; color:var(--texto-suave); font-weight:600; text-transform:uppercase;">
                  Equipes que participam do revezamento:
                </span>
                ${htmlEquipes}
              </div>
            `;
        }
    }

    return `
      <div class="capacidade-linha" style="display:flex; flex-direction:column; align-items:flex-start; padding: 16px 0; border-bottom: 1px solid var(--borda);">
        <div style="display:flex; align-items:center; gap: 16px; width: 100%; flex-wrap: wrap;">
          <span class="capacidade-nome" style="font-size:14px; min-width: 100px;">${escapeHtml(local)}</span>

          <label>Vagas por dia (Capacidade)
            <input type="number" min="1" id="nEquipes_${slug}" data-local="${escapeHtml(local)}" class="input-capacidade-equipes" value="${cap.nEquipes}" title="Quantas equipes trabalham simultaneamente por dia neste prédio">
          </label>

          <label>Aparelhos/vaga/dia
            <input type="number" min="1" id="aparelhosDia_${slug}" data-local="${escapeHtml(local)}" class="input-capacidade-aparelhos" value="${cap.aparelhosDia}">
          </label>

          <label style="margin-left: auto; display:flex; align-items:center; gap:6px; cursor:pointer;">
            <input type="checkbox" id="chkModoRodizio_${slug}" data-local="${escapeHtml(local)}" class="toggle-modo-rodizio" ${modoRodizio ? "checked" : ""}>
            Fazer rodízio
          </label>
        </div>
        ${painelAvancado}
      </div>
    `;
  }).join("");

  container.querySelectorAll(".toggle-modo-rodizio").forEach(chk => {
    chk.addEventListener("change", () => {
      const local = chk.dataset.local;
      const capTemporaria = lerCapacidadesDaTela();

      if (!ESTADO.config) ESTADO.config = {};
      if (!ESTADO.config.capacidades) ESTADO.config.capacidades = {};

      // Rede de segurança: se retornar vazio, cria uma configuração padrão
      ESTADO.config.capacidades[local] = capTemporaria[local] || {
          nEquipes: 2, aparelhosDia: 2, modoRodizio: false, equipesAtivas: []
      };

      ESTADO.config.capacidades[local].modoRodizio = chk.checked;
      renderCapacidadesPorPredio();
    });
  });
}

function lerCapacidadesDaTela() {
  const capacidades = {};
  const locais = locaisParaConfigurar();
  
  locais.forEach((local) => {
    const slug = slugLocal(local);
    const aparInput = $(`#aparelhosDia_${slug}`);
    const eqInput = $(`#nEquipes_${slug}`);
    if (!aparInput || !eqInput) return; 
    
    // Agora o número que manda na capacidade diária é SEMPRE o campo de Vagas/Equipes
    const nEquipesFixas = Math.max(1, parseInt(eqInput.value, 10) || 1);
    
    const chkModoRodizio = $(`#chkModoRodizio_${slug}`);
    const modoRodizio = chkModoRodizio ? chkModoRodizio.checked : false;

    const equipesAtivas = [];
    if (modoRodizio) {
        $all(`.chk-equipe-${slug}:checked`).forEach(chk => equipesAtivas.push(chk.value));
    }

    capacidades[local] = {
      aparelhosDia: Math.max(1, parseInt(aparInput.value, 10) || 1),
      nEquipes: nEquipesFixas, 
      modoRodizio: modoRodizio,
      equipesAtivas: equipesAtivas
    };
  });
  
  return capacidades;
}

// Espera a pessoa parar de digitar por 300ms antes de rodar renderFn — sem
// isso, cada tecla refazia a tabela inteira (inclusive o casamento com
// chamados corretivos), o que engasgava a digitação com a base grande.
function debounce(fn, atrasoMs = 300) {
  let temporizador;
  return (...args) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn(...args), atrasoMs);
  };
}

function ligarBusca(inputId, chaveFiltro, renderFn) {
  const input = $(`#${inputId}`);
  if (!input) return;
  const renderComDebounce = debounce(renderFn);
  input.addEventListener("input", () => {
    ESTADO.filtros[chaveFiltro] = input.value.trim().toLowerCase();
    renderComDebounce();
  });
}
ligarBusca("buscaEquipamentos", "equipamentos", renderEquipamentosCadastro);
ligarBusca("buscaFeriados", "feriados", renderFeriados);
ligarBusca("buscaOrdens", "ordens", renderOrdens);
ligarBusca("buscaHistorico", "historico", renderHistorico);
["filtroStatus", "filtroSetorPCM", "filtroOrigem"].forEach((id) => {
  $(`#${id}`)?.addEventListener("change", renderEquipamentosCadastro);
});

$("#prevMonth").addEventListener("click", () => mudarMes(-1));
$("#nextMonth").addEventListener("click", () => mudarMes(1));

function mudarMes(delta) {
  if (ESTADO.calMonth === null) { ESTADO.calMonth = new Date().getMonth(); ESTADO.calYear = new Date().getFullYear(); }
  ESTADO.calMonth += delta;
  if (ESTADO.calMonth < 0) { ESTADO.calMonth = 11; ESTADO.calYear--; }
  if (ESTADO.calMonth > 11) { ESTADO.calMonth = 0; ESTADO.calYear++; }
  renderCalendar();
}

const NOMES_MES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho",
  "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

function renderCalendar() {
  const grid = $("#calendarGrid");
  if (ESTADO.calMonth === null) {
    const hoje = new Date();
    ESTADO.calYear = hoje.getFullYear();
    ESTADO.calMonth = hoje.getMonth();
  }
  $("#calendarTitle").textContent = `${NOMES_MES[ESTADO.calMonth]} de ${ESTADO.calYear}`;

  const hojeISO = formatISO(new Date());
  const porData = {};
  for (const item of aplicarFiltroLocal(ESTADO.equipamentos)) {
    (porData[item.dataAgendada] ||= []).push(item);
  }
  const datasVazias = new Set(
    (ESTADO.diasVaziosCronograma || [])
      .filter((d) => ESTADO.localFiltro === "Todos" || d.local === ESTADO.localFiltro)
      .map((d) => d.data)
  );

  grid.innerHTML = "";
  ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].forEach((d) => {
    const el = document.createElement("div");
    el.className = "cal-dow";
    el.textContent = d;
    grid.appendChild(el);
  });

  const primeiroDia = new Date(ESTADO.calYear, ESTADO.calMonth, 1);
  const offsetInicial = (primeiroDia.getDay() + 6) % 7;
  const diasNoMes = new Date(ESTADO.calYear, ESTADO.calMonth + 1, 0).getDate();

  for (let i = 0; i < offsetInicial; i++) {
    const el = document.createElement("div");
    el.className = "cal-day empty";
    grid.appendChild(el);
  }

  for (let dia = 1; dia <= diasNoMes; dia++) {
    const iso = `${ESTADO.calYear}-${String(ESTADO.calMonth + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
    const itensDoDia = porData[iso] || [];
    const feriadoDoDia = ESTADO.feriados.find((f) => iso >= f.dataInicio && iso <= f.dataFim);
    const ehDiaVazio = datasVazias.has(iso);
    const el = document.createElement("div");
    el.className = "cal-day" + (itensDoDia.length ? " has-tasks" : "") +
      (ESTADO.diaSelecionado === iso ? " selected" : "") + (feriadoDoDia ? " is-holiday" : "") +
      (ehDiaVazio ? " is-gap" : "");

    const num = document.createElement("div");
    num.className = "cal-day-num";
    num.textContent = dia;
    el.appendChild(num);

    if (ehDiaVazio) {
      const tag = document.createElement("div");
      tag.className = "cal-day-badge gap";
      tag.textContent = "Sem agenda";
      el.appendChild(tag);
    }

    if (feriadoDoDia) {
      const tag = document.createElement("div");
      tag.className = "cal-day-badge holiday";
      tag.textContent = feriadoDoDia.label || (feriadoDoDia.tipo === "feriado" ? "Feriado" : "Férias");
      el.appendChild(tag);
    }

    if (itensDoDia.length) {
    // Agrupa os itens do dia por prédio/anexo
    const porPredio = {};
    itensDoDia.forEach(i => {
      const p = i.local || "SEDE";
      (porPredio[p] = porPredio[p] || []).push(i);
    });

    // Cria uma etiqueta (badge) separada para cada prédio no mesmo dia
    // Cria uma etiqueta (badge) separada para cada prédio no mesmo dia
    const ROTULOS_STATUS = { pendente: "pendentes", andamento: "em andamento", concluido: "concluídos", atrasado: "atrasados" };
    Object.entries(porPredio).forEach(([predio, itensPredio]) => {
      const concluidas = itensPredio.filter((i) => i.statusPreventiva === "Concluída").length;
      const andamento = itensPredio.filter((i) => i.statusPreventiva === "Em andamento").length;
      const temAtrasado = iso < hojeISO && concluidas < itensPredio.length;
      
      const badge = document.createElement("div");
      let classe = "pendente";
      if (concluidas === itensPredio.length) classe = "concluido";
      else if (andamento > 0 || concluidas > 0) classe = "andamento";
      if (temAtrasado) classe = "atrasado";
      
      badge.className = "cal-day-badge " + classe + (ESTADO.localFiltro === "Todos" ? "" : " badge-empilhado");
      badge.innerHTML = ESTADO.localFiltro === "Todos"
        ? `<span class="badge-predio">${escapeHtml(predio)}</span><span class="badge-contagem">${itensPredio.length} ${ROTULOS_STATUS[classe]}</span>`
        : itensPredio.map((i) => `<div class="badge-maquina-linha">${escapeHtml(i.patrimonio || i.ambiente)}</div>`).join("");
      badge.addEventListener("mouseenter", (e) => mostrarTooltipCalendario(e.currentTarget, predio, itensPredio));
      badge.addEventListener("mouseleave", ocultarTooltipCalendario);
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        ocultarTooltipCalendario();
        selecionarDiaBadge(iso, predio, itensPredio);
      });
      el.appendChild(badge);
    });
    
    el.addEventListener("click", () => selecionarDia(iso));
  }
    grid.appendChild(el);
  }
}

function mostrarTooltipCalendario(elemento, predio, itens) {
  let tip = document.getElementById("calBadgeTooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "calBadgeTooltip";
    tip.className = "cal-badge-tooltip";
    document.body.appendChild(tip);
  }
  const preview = itens.slice(0, 3)
    .map((i) => `<div>${escapeHtml(i.patrimonio || i.ambiente)}</div>`)
    .join("");
  const resto = itens.length > 3 ? `<div class="cal-badge-tooltip-mais">+${itens.length - 3} mais</div>` : "";
  tip.innerHTML = `<strong>${escapeHtml(predio)}</strong>${preview}${resto}`;
  const rect = elemento.getBoundingClientRect();
  tip.style.left = `${rect.left}px`;
  tip.style.top = `${rect.bottom + 6}px`;
  tip.hidden = false;
}

function ocultarTooltipCalendario() {
  const tip = document.getElementById("calBadgeTooltip");
  if (tip) tip.hidden = true;
}

function selecionarDia(iso) {
  ESTADO.diaSelecionado = iso;
  renderCalendar();
  const itensDoDia = aplicarFiltroLocal(ESTADO.equipamentos).filter((i) => i.dataAgendada === iso);
  const [ano, mes, dia] = iso.split("-");
  $("#dayDetailCard").hidden = false;
  $("#dayDetailTitle").textContent = `${dia}/${mes}/${ano} — ${itensDoDia.length} aparelho(s)`;
  renderTabelaDetalheDia(itensDoDia, () => selecionarDia(iso));
  
  // CORREÇÃO MOBILE: Desliza a tela suavemente para baixo até a tabela
  if (window.innerWidth <= 768) {
    setTimeout(() => $("#dayDetailCard").scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

function selecionarDiaBadge(iso, predio, itensPredio) {
  ESTADO.diaSelecionado = iso;
  renderCalendar();
  const [ano, mes, dia] = iso.split("-");
  $("#dayDetailCard").hidden = false;
  $("#dayDetailTitle").textContent = `${dia}/${mes}/${ano} — ${predio} (${itensPredio.length} aparelho(s))`;
  renderTabelaDetalheDia(itensPredio, () => {
    const itensAtualizados = aplicarFiltroLocal(ESTADO.equipamentos)
      .filter((i) => i.dataAgendada === iso && (i.local || "SEDE") === predio);
    selecionarDiaBadge(iso, predio, itensAtualizados);
  });
  
  // CORREÇÃO MOBILE: Desliza a tela suavemente para baixo até a tabela
  if (window.innerWidth <= 768) {
    setTimeout(() => $("#dayDetailCard").scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
  }
}

function renderTabelaDetalheDia(itensDoDia, aoAtualizar) {
  const table = $("#dayDetailTable");
  table.innerHTML = `<thead><tr><th>Patrimônio</th><th>Prédio</th><th>Setor</th><th>Ambiente</th><th>Equipe</th><th>Status</th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  itensDoDia.forEach((item) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td data-label="Patrimônio">${escapeHtml(item.patrimonio || "-")}</td><td data-label="Prédio">${escapeHtml(item.local || "SEDE")}</td><td data-label="Setor">${escapeHtml(item.setor)}</td><td data-label="Ambiente">${escapeHtml(item.ambiente)}</td><td data-label="Equipe">${escapeHtml(item.equipeResponsavel)}</td>`;

    const tdStatus = document.createElement("td");
    tdStatus.dataset.label = "Status";
    const select = document.createElement("select");
    const atrasado = estaAtrasado(item);
    select.className = "status-select " + (atrasado ? "atrasado" : classeStatus(item.statusPreventiva));
    if (atrasado) {
      select.innerHTML = `
        <option value="${item.statusPreventiva}" hidden selected>Atrasado</option>
        <option value="Concluída">Concluída</option>
        <option value="Em andamento">Em andamento</option>
        <option value="Pendente">Pendente</option>
      `;
    } else {
      select.innerHTML = `
        <option value="Pendente" ${item.statusPreventiva === "Pendente" ? "selected" : ""}>Pendente</option>
        <option value="Em andamento" ${item.statusPreventiva === "Em andamento" ? "selected" : ""}>Em andamento</option>
        <option value="Concluída" ${item.statusPreventiva === "Concluída" ? "selected" : ""}>Concluída</option>
      `;
    }

    select.addEventListener("change", async () => {
      const statusAnterior = item.statusPreventiva;
      const statusNovo = select.value;

      if (statusNovo === "Concluída") {
        abrirModalConclusao(item, select, statusAnterior, aoAtualizar);
        return;
      }

      select.disabled = true;
      try {
        const camposStatus = {
          statusPreventiva: statusNovo,
          dataConclusao: statusNovo === "Concluída" ? formatISO(new Date()) : "",
        };
        if (statusNovo === "Concluída") {
          const proxima = await calcularProximaData({ ...item, dataConclusao: camposStatus.dataConclusao });
          camposStatus.proximaPreventiva = proxima.data;
          camposStatus.proximaPreventivaDia = proxima.dia;
        } else {
          camposStatus.proximaPreventiva = "";
          camposStatus.proximaPreventivaDia = "";
        }
        await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), camposStatus);
        Object.assign(item, camposStatus);

        const promessasLogs = [registrarHistorico(item, statusAnterior, statusNovo)];
        if (statusNovo === "Concluída") {
          promessasLogs.push(registrarOrdemServico(item));
        } else if (statusAnterior === "Concluída" && statusNovo !== "Concluída") {
          promessasLogs.push(removerOrdemServico(item.id));
        }
        await Promise.all(promessasLogs);

        aoAtualizar();
        toast(`Status atualizado com sucesso.`);
      } catch (err) {
        console.error(err);
        select.value = statusAnterior;
        select.className = "status-select " + classeStatus(statusAnterior);
        toast("Erro ao atualizar status: " + err.message);
      } finally {
        select.disabled = false;
      }
    });

    tdStatus.appendChild(select);
    tr.appendChild(tdStatus);
    tbody.appendChild(tr);
  });
}

function classeStatus(status) {
  if (status === "Concluída") return "concluido";
  if (status === "Em andamento") return "andamento";
  return "pendente";
}

function renderVisaoGerencial() {
  const elPredio = $("#visaoPorPredio");
  const elDias = $("#visaoProximosDias");
  const elEquipe = $("#visaoPorEquipe");
  if (!elPredio || !elDias || !elEquipe) return;

  const itens = ESTADO.equipamentos;

  // --- Por prédio ---
  const gruposPredio = new Map();
  itens.forEach((i) => {
    const l = i.local || "SEDE";
    if (!gruposPredio.has(l)) gruposPredio.set(l, []);
    gruposPredio.get(l).push(i);
  });
  const porPredio = [...gruposPredio.entries()]
    .map(([local, lista]) => {
      const concluidas = lista.filter((i) => i.statusPreventiva === "Concluída").length;
      const pct = lista.length ? Math.round((concluidas / lista.length) * 100) : 0;
      return { local, total: lista.length, concluidas, pct };
    })
    .sort((a, b) => a.local.localeCompare(b.local));

  elPredio.innerHTML = porPredio.map((p) => `
    <div class="vg-card">
      <p class="vg-titulo">${escapeHtml(p.local)}</p>
      <p class="vg-pct">${p.pct}%</p>
      <p class="vg-detalhe">${p.concluidas} de ${p.total} concluídos</p>
    </div>`).join("") || `<p class="muted">Nenhum aparelho carregado ainda.</p>`;

  // --- Próximos 7 dias ---
  const porData = {};
  itens.forEach((i) => { if (i.dataAgendada) porData[i.dataAgendada] = (porData[i.dataAgendada] || 0) + 1; });
  const hoje = new Date();
  const nomesCurtos = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
  let htmlDias = "";
  for (let n = 0; n < 7; n++) {
    const d = new Date(hoje);
    d.setDate(d.getDate() + n);
    const iso = formatISO(d);
    const diaSemanaIdx = (d.getDay() + 6) % 7;
    const fimDeSemana = diaSemanaIdx >= 5;
    htmlDias += `
      <div class="vg-dia${fimDeSemana ? " vg-fimdesemana" : ""}">
        <p class="vg-dia-nome">${nomesCurtos[diaSemanaIdx]}</p>
        <p class="vg-dia-num">${porData[iso] || 0}</p>
      </div>`;
  }
  elDias.innerHTML = htmlDias;

  // --- Por equipe, agrupado por prédio ---
  const gruposEquipe = new Map();
  itens.forEach((i) => {
    const l = i.local || "SEDE";
    if (!gruposEquipe.has(l)) gruposEquipe.set(l, new Map());
    const eq = i.equipeResponsavel || "Sem equipe";
    const porEq = gruposEquipe.get(l);
    if (!porEq.has(eq)) porEq.set(eq, []);
    porEq.get(eq).push(i);
  });

  const predios = [...gruposEquipe.keys()].sort();
  elEquipe.innerHTML = predios.map((local) => {
    const equipes = gruposEquipe.get(local);
    const linhas = [...equipes.entries()]
      .map(([equipe, lista]) => {
        const concluidas = lista.filter((i) => i.statusPreventiva === "Concluída").length;
        const pct = lista.length ? Math.round((concluidas / lista.length) * 100) : 0;
        return { equipe, total: lista.length, concluidas, pct };
      })
      .sort((a, b) => a.equipe.localeCompare(b.equipe));

    return `
      <div class="vg-equipe-grupo">
        <p class="vg-equipe-predio-nome">${escapeHtml(local)}</p>
        ${linhas.map((l) => `
          <div class="vg-equipe-linha">
            <span>${escapeHtml(l.equipe)}</span>
            <span style="color:var(--texto-suave)">${l.concluidas} de ${l.total} · ${l.pct}%</span>
          </div>`).join("")}
      </div>`;
  }).join("") || `<p class="muted">Nenhum aparelho carregado ainda.</p>`;
}

function renderResumoAtrasos() {
  const resumoEl = $("#resumoAtrasosResumo");
  const table = $("#atrasosTable");
  if (!resumoEl || !table) return;

  const atrasadosAgora = aplicarFiltroLocal(ESTADO.equipamentos).filter(estaAtrasado).length;

  const reagendamentos = aplicarFiltroLocal(
    ESTADO.historico.filter((h) => h.tipo === "Atraso Reagendado" && h.cicloId === ESTADO.cicloAtual)
  );

  const porPredio = {};
  reagendamentos.forEach((h) => {
    const local = h.local || "SEDE";
    porPredio[local] = (porPredio[local] || 0) + 1;
  });
  const resumoPredio = Object.entries(porPredio).map(([l, q]) => `${l}: ${q}`).join(" · ") || "nenhum";

  resumoEl.textContent = `Atrasos — ${atrasadosAgora} agora · ${reagendamentos.length} reagendado(s) neste ciclo (${resumoPredio})`;
  $("#atrasosCount").textContent = `${reagendamentos.length} registros`;

  table.innerHTML = `<thead><tr>
      <th>Patrimônio</th><th>Prédio</th><th>Setor</th><th>Equipe</th><th>De</th><th>Para</th><th>Quando</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  if (!reagendamentos.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--texto-suave)">Nenhum atraso reagendado neste ciclo ainda.</td></tr>`;
    return;
  }

  [...reagendamentos]
    .sort((a, b) => String(b.registradoEm).localeCompare(String(a.registradoEm)))
    .forEach((h) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${h.patrimonio || "-"}</td>
        <td>${h.local || "SEDE"}</td>
        <td>${h.setor || "-"}</td>
        <td>${h.equipe || "-"}</td>
        <td>${formatarDataBR(h.dataAnterior)}</td>
        <td>${formatarDataBR(h.dataNova)}</td>
        <td>${new Date(h.registradoEm).toLocaleString("pt-BR")}</td>`;
      tbody.appendChild(tr);
    });
}

function renderDashboard() {
  // O aplicarFiltroLocal já garante que os números mudem quando você clica no filtro lá em cima
  const itens = aplicarFiltroLocal(ESTADO.equipamentos);
  const total = itens.length;
  const concluidas = itens.filter((i) => i.statusPreventiva === "Concluída").length;
  const andamento = itens.filter((i) => i.statusPreventiva === "Em andamento").length;
  const pendentes = total - concluidas - andamento;
  const execucao = total ? Math.round((concluidas / total) * 1000) / 10 : 0;

  const cartoes = [
    ["total", total, "Equipamentos"],
    ["concluido", concluidas, "Concluídas"],
    ["andamento", andamento, "Em andamento"],
    ["pendente", pendentes, "Pendentes"],
    ["execucao", `${execucao}%`, "Execução"],
  ];
  
  $("#kpiRow").innerHTML = cartoes.map(([cls, num, label]) =>
    `<div class="kpi-card ${cls}"><div class="num">${num}</div><div class="label">${label}</div></div>`
  ).join("");
  
  const cicloAtual = numeroDoCiclo(ESTADO.cicloAtual);
  const pct = total ? Math.round((concluidas / total) * 100) : 0;
  const elCiclo = $("#cicloResumo");
  if (elCiclo) {
    elCiclo.innerHTML = `
      <strong>Ciclo ${cicloAtual}</strong> — ${concluidas} de ${total} aparelhos concluídos (${pct}%)
      <div class="ciclo-barra"><span style="width:${pct}%"></span></div>`;
  }
  renderResumoAtrasos();
  renderVisaoGerencial();
}

async function registrarHistorico(item, statusAnterior, statusNovo, tipo = "Preventiva", fotoUrl = "") {
  const agora = new Date();
  await addDoc(collection(     db,     "ciclos",     ESTADO.cicloAtual,     "historico" ), {
    equipamentoId: item.id,
    patrimonio: item.patrimonio || "",
    setor: item.setor || "",
    ambiente: item.ambiente || "",
    local: item.local || "SEDE",
    equipe: item.equipeResponsavel || "",
    usuario: ESTADO.usuarioNome || "",
    tipo,
    statusAnterior: statusAnterior || "-",
    statusNovo: statusNovo,
    fotoUrl: fotoUrl || "",
    registradoEm: agora.toISOString()
  });
}

async function registrarAuditoria(acao, detalhes) {
  try {
    await addDoc(collection(db, "auditoria"), {
      acao,
      detalhes: detalhes || "",
      usuario: ESTADO.usuarioNome || "",
      registradoEm: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Erro ao registrar auditoria:", err);
  }
}

async function registrarOrdemServico(item, checklist, avaliacaoEstrelas, tecnico) {
  const agora = new Date();

  // Só apaga ordens duplicadas DENTRO do ciclo atual — ordens de ciclos
  // fechados são histórico e não devem ser tocadas.
  const ordensAntigas = ESTADO.ordens.filter(
    (o) => o.equipamentoId === item.id && o.cicloId === ESTADO.cicloAtual
  );
  if (ordensAntigas.length > 0) {
    const batch = writeBatch(db);
    ordensAntigas.forEach((o) => batch.delete(doc(db, "ciclos", o.cicloId, "ordens", o.id)));
    await batch.commit();
  }

  // Agora ele grava a OS dentro da pasta do ciclo correto!
  await setDoc(doc(db, "ciclos", ESTADO.cicloAtual, "ordens", item.id), {
    equipamentoId: item.id,
    patrimonio: item.patrimonio || "",
    setor: item.setor || "",
    ambiente: item.ambiente || "",
    local: item.local || "SEDE",
    equipe: item.equipeResponsavel || "",
    dataAgendada: item.dataAgendada || "",
    status: "Concluída",
    registradoEm: agora.toISOString(),
    checklist: checklist || [],
    avaliacaoEstrelas: avaliacaoEstrelas || 0,
    tecnico: tecnico || "",
  });
}

async function removerOrdemServico(equipamentoId) {
  // Só remove a ordem do ciclo ATUAL — se esse aparelho já teve ordem em
  // ciclos anteriores (fechados), aquilo é histórico e continua intacto.
  const ordensDoEquipamento = ESTADO.ordens.filter(
    (o) => o.equipamentoId === equipamentoId && o.cicloId === ESTADO.cicloAtual
  );
  if (ordensDoEquipamento.length > 0) {
    const batch = writeBatch(db);
    ordensDoEquipamento.forEach((o) => batch.delete(doc(db, "ciclos", o.cicloId, "ordens", o.id)));
    await batch.commit();
  }
}

let modalConclusaoEstado = null;

function fecharModalConclusao(reverterSelect) {
  const overlay = $("#modalConclusaoOverlay");
  const modal = $("#modalConclusao");
  if (modal) modal.hidden = true;
  if (overlay) overlay.hidden = true;
  if (reverterSelect && modalConclusaoEstado && modalConclusaoEstado.selectEl) {
    modalConclusaoEstado.selectEl.value = modalConclusaoEstado.statusAnterior;
  }
  modalConclusaoEstado = null;
}

$("#modalConclusaoFechar")?.addEventListener("click", () => fecharModalConclusao(true));
$("#modalConclusaoOverlay")?.addEventListener("click", () => fecharModalConclusao(true));

function wireCampoOutro(selectId, wrapId, valorGatilho) {
  const select = $(`#${selectId}`);
  const wrap = $(`#${wrapId}`);
  if (!select || !wrap) return;
  select.addEventListener("change", () => {
    wrap.hidden = select.value !== valorGatilho;
  });
}

async function abrirModalConclusao(item, selectEl, statusAnterior, aoAtualizar) {
  modalConclusaoEstado = { item, selectEl, statusAnterior, aoAtualizar };

  $("#modalConclusaoTitulo").textContent = `Concluir preventiva — ${item.patrimonio || item.ambiente}`;
  $("#modalConclusaoCorpo").innerHTML = `
    <div class="ilha-secao">
      <label>Técnico responsável *<input type="text" id="tecnicoConclusao" placeholder="Seu nome"></label>
    </div>

    <div class="ilha-secao">
      <h3 style="font-size:13px;color:var(--texto-suave);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px">O que foi feito na máquina</h3>
      <div id="checklistPreventiva">
        ${CHECKLIST_PREVENTIVA.map((tarefa, i) => `
          <label class="checklist-item">
            <input type="checkbox" id="chkTarefa${i}" value="${tarefa}">
            ${tarefa}
          </label>
        `).join("")}
      </div>
    </div>

    <div class="ilha-secao">
      <h3 style="font-size:13px;color:var(--texto-suave);text-transform:uppercase;letter-spacing:.04em;margin:0 0 6px">Avaliação do estado da máquina</h3>
      <div class="estrelas-widget" id="estrelasConclusao" data-valor="0">
        ${[1, 2, 3, 4, 5].map((n) => `<span class="estrela" data-valor="${n}">★</span>`).join("")}
      </div>
    </div>

    <div class="ilha-secao">
      <label>Foto da máquina${ESTADO.configSite.fotoObrigatoria ? " *" : " (opcional)"}<input type="file" accept="image/*" capture="environment" id="fotoConclusaoInput"></label>
    </div>

    <div style="display:flex;gap:12px;margin-top:24px">
      <button class="btn primary" id="btnModalConclusaoContinuar">Continuar</button>
      <button class="btn ghost" id="btnModalConclusaoCancelar">Cancelar</button>
    </div>
  `;

  const widget = $("#estrelasConclusao");
  widget.querySelectorAll(".estrela").forEach((estrela) => {
    estrela.addEventListener("click", () => {
      const valor = Number(estrela.dataset.valor);
      widget.dataset.valor = valor;
      widget.querySelectorAll(".estrela").forEach((e) => {
        e.classList.toggle("ativa", Number(e.dataset.valor) <= valor);
      });
    });
  });

  $("#btnModalConclusaoCancelar").addEventListener("click", () => fecharModalConclusao(true));

  $("#btnModalConclusaoContinuar").addEventListener("click", async () => {
    const tecnico = $("#tecnicoConclusao").value.trim();
    if (!tecnico) {
      toast("Preencha o nome do técnico responsável.");
      return;
    }
    const arquivoFoto = $("#fotoConclusaoInput")?.files?.[0] || null;
    if (ESTADO.configSite.fotoObrigatoria && !arquivoFoto) {
      toast("Tire uma foto da máquina pra concluir (obrigatório).");
      return;
    }
    modalConclusaoEstado.tecnico = tecnico;
    modalConclusaoEstado.fotoFile = arquivoFoto;
    modalConclusaoEstado.checklist = CHECKLIST_PREVENTIVA.filter((_, i) => $(`#chkTarefa${i}`).checked);
    modalConclusaoEstado.avaliacaoEstrelas = Number(widget.dataset.valor) || 0;

    let dadosExistentes = null;
    try {
      const snap = await getDoc(doc(db, "infoCondensadoras", item.id));
      if (snap.exists()) dadosExistentes = snap.data();
    } catch (err) {
      console.error("Erro ao verificar info técnica:", err);
    }
    
    // Garante que a estrutura exista
    dadosExistentes = dadosExistentes || {};
    dadosExistentes.condensadora = dadosExistentes.condensadora || {};
    dadosExistentes.evaporadora = dadosExistentes.evaporadora || {};

    // INJEÇÃO AUTOMÁTICA: pré-preenche com o que já veio do levantamento em
    // planilha -- que é sempre a etiqueta da EVAPORADORA (unidade interna,
    // visível na sala; a condensadora costuma ficar em local de difícil
    // acesso e não é o que se lê no levantamento inicial). Só a evaporadora
    // recebe esses valores; a condensadora fica de fato sem informação até
    // alguém confirmar em campo -- antes os dois lados recebiam o mesmo
    // dado, o que fazia o formulário nem perguntar a condensadora de
    // verdade (e registrava, sem querer, um dado errado pra ela).
    if (item.patrimonio) {
      dadosExistentes.evaporadora.tombo = dadosExistentes.evaporadora.tombo || item.patrimonio;
    }
    if (item.tag) {
      dadosExistentes.evaporadora.tag = dadosExistentes.evaporadora.tag || item.tag;
    }
    if (item.marca) {
      dadosExistentes.evaporadora.marca = dadosExistentes.evaporadora.marca || item.marca;
    }
    if (item.modelo) {
      dadosExistentes.evaporadora.modelo = dadosExistentes.evaporadora.modelo || item.modelo;
    }
    if (item.capacidade) {
      dadosExistentes.evaporadora.capacidade = dadosExistentes.evaporadora.capacidade || item.capacidade;
    }

    modalConclusaoEstado.dadosExistentes = dadosExistentes;

    const secaoCond = renderSecaoUnidade("cond", "Condensadora (unidade externa)", dadosExistentes.condensadora, "cond");
    const secaoEvap = renderSecaoUnidade("evap", "Evaporadora (unidade interna)", dadosExistentes.evaporadora, "evap");

    if (!secaoCond.html && !secaoEvap.html && item.tipoGas) {
      await finalizarConclusao();
    } else {
      renderPassoInfoTecnica(secaoCond, secaoEvap, dadosExistentes);
    }
  });

  $("#modalConclusao").hidden = false;
  $("#modalConclusaoOverlay").hidden = false;
}

// Define os campos técnicos de UMA unidade
function definirCamposUnidade(tipoUnidade) {
  const camposBase = [
    { chave: "tombo", tipo: "semOutro", rotulo: "Tombo/Patrimônio", labelSem: "Sem tombo", obrigatorio: false },
    { chave: "tag", tipo: "texto", rotulo: "Tag (se tiver)", obrigatorio: false },
    { chave: "marca", tipo: "select", opcoes: MARCAS_CONDENSADORA, rotulo: "Marca", obrigatorio: true },
    { chave: "capacidade", tipo: "select", opcoes: CAPACIDADES_CONDENSADORA, rotulo: "Capacidade", obrigatorio: true },
    { chave: "espessuraFio", tipo: "select", opcoes: ESPESSURAS_FIO, rotulo: "Espessura do fio de alimentação", obrigatorio: true },
  ];

  // "Modelo" só tem lista fixa (Split Hi-Wall/Inverter/Cassete/Piso-Teto)
  // pra evaporadora — são formatos de unidade interna. Na condensadora
  // continua texto livre, como sempre foi.
  if (tipoUnidade === "evap") {
    camposBase.push({ chave: "modelo", tipo: "select", opcoes: MODELOS_EVAPORADORA, rotulo: "Modelo", obrigatorio: true });
  } else {
    camposBase.push({ chave: "modelo", tipo: "semOutro", rotulo: "Modelo", labelSem: "Sem modelo", obrigatorio: false });
  }

  if (tipoUnidade === "cond") {
    camposBase.unshift({ chave: "numero", tipo: "texto", rotulo: "Nº (Condensadora)", obrigatorio: true });
  }

  return camposBase;
}

function renderSecaoUnidade(prefixo, titulo, dadosExistentes, tipoUnidade) {
  const existentes = dadosExistentes || {};
  const campos = definirCamposUnidade(tipoUnidade).filter((c) => {
    const valor = existentes[c.chave];
    return valor === undefined || valor === null || valor === "";
  });

  if (!campos.length) return { html: "", campos: [] };

  const html = `
    <div class="ilha-secao">
      <h3 style="font-size:13px;color:var(--texto-suave);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px">${titulo}</h3>
      <div class="grid-form">
        ${campos.map((c) => {
          const id = `${prefixo}_${c.chave}`;
          const marcador = c.obrigatorio ? " *" : "";
          if (c.tipo === "texto") {
            return "<label>" + c.rotulo + marcador + '<input type="text" id="' + id + '"></label>';
          }
          const opcoesExtras = c.tipo === "select"
            ? '<option value="">Selecione...</option>' + c.opcoes.map((o) => '<option value="' + o + '">' + o + '</option>').join("") + '<option value="Outro">Outro</option>'
            : '<option value="sem">' + c.labelSem + '</option><option value="outro">Outro</option>';
          return "" +
            "<div>" +
              "<label>" + c.rotulo + marcador +
                '<select id="' + id + '">' + opcoesExtras + "</select>" +
              "</label>" +
              '<div class="campo-outro" id="' + id + 'OutroWrap" hidden>' +
                '<input type="text" id="' + id + 'Outro" placeholder="Especifique">' +
              "</div>" +
            "</div>";
        }).join("")}
      </div>
    </div>
  `;

  return { html, campos };
}
function wireSecaoUnidade(prefixo, campos) {
  campos.forEach((c) => {
    if (c.tipo === "select") wireCampoOutro(`${prefixo}_${c.chave}`, `${prefixo}_${c.chave}OutroWrap`, "Outro");
    if (c.tipo === "semOutro") wireCampoOutro(`${prefixo}_${c.chave}`, `${prefixo}_${c.chave}OutroWrap`, "outro");
  });
}

function lerSecaoUnidade(prefixo, campos, dadosExistentes) {
  const resultado = { ...(dadosExistentes || {}) };
  let faltouObrigatorio = false;

  campos.forEach((c) => {
    const id = `${prefixo}_${c.chave}`;
    const el = $(`#${id}`);
    if (!el) return;

    let valorFinal;
    if (c.tipo === "texto") {
      valorFinal = el.value.trim();
    } else if (c.tipo === "select") {
      valorFinal = el.value === "Outro" ? $(`#${id}Outro`).value.trim() : el.value;
    } else {
      valorFinal = el.value === "outro" ? $(`#${id}Outro`).value.trim() : "";
    }

    if (c.obrigatorio && !valorFinal) faltouObrigatorio = true;
    resultado[c.chave] = valorFinal;
  });

  return { resultado, faltouObrigatorio };
}

function renderPassoInfoTecnica(secaoCond, secaoEvap, dadosExistentes) {
  const { item } = modalConclusaoEstado;
  const precisaTipoGas = !item.tipoGas;
  $("#modalConclusaoTitulo").textContent = "Dados técnicos da máquina";
  $("#modalConclusaoCorpo").innerHTML = `
    <p class="muted">Só está perguntando o que ainda não está registrado pra essa máquina. Da próxima vez, isso não é perguntado de novo.</p>
    <div class="ilha-secao">
      <div class="grid-form">
        <label>Informante<input type="text" value="${escapeHtml(modalConclusaoEstado.tecnico)}" disabled></label>
        <label>Prédio<input type="text" value="${escapeHtml(item.local || "SEDE")}" disabled></label>
        ${precisaTipoGas ? `
        <label>Tipo de gás *
          <select id="infoTipoGas">
            <option value="">Selecione...</option>
            ${GASES_REFRIGERANTES.map((g) => `<option value="${g}">${g}</option>`).join("")}
            <option value="Outro">Outro</option>
          </select>
        </label>
        <div class="campo-outro" id="infoTipoGasOutroWrap" hidden>
          <input type="text" id="infoTipoGasOutro" placeholder="Especifique">
        </div>` : ""}
      </div>
    </div>
    ${secaoCond.html}
    ${secaoEvap.html}

    <div style="display:flex;gap:12px;margin-top:24px">
      <button class="btn primary" id="btnModalConclusaoSalvar">Salvar e concluir</button>
      <button class="btn ghost" id="btnModalConclusaoCancelar2">Cancelar</button>
    </div>
  `;

  wireSecaoUnidade("cond", secaoCond.campos);
  wireSecaoUnidade("evap", secaoEvap.campos);
  if (precisaTipoGas) wireCampoOutro("infoTipoGas", "infoTipoGasOutroWrap", "Outro");

  $("#btnModalConclusaoCancelar2").addEventListener("click", () => fecharModalConclusao(true));

  $("#btnModalConclusaoSalvar").addEventListener("click", async () => {
    const informante = modalConclusaoEstado.tecnico;

    let tipoGasNovo = "";
    if (precisaTipoGas) {
      const selTipoGas = $("#infoTipoGas");
      tipoGasNovo = selTipoGas.value === "Outro" ? $("#infoTipoGasOutro").value.trim() : selTipoGas.value;
      if (!tipoGasNovo) {
        toast("Preencha os campos obrigatórios (*).");
        return;
      }
    }

    const dadosCond = dadosExistentes.condensadora;
    const dadosEvap = dadosExistentes.evaporadora;
    const { resultado: condensadora, faltouObrigatorio: faltouCond } = lerSecaoUnidade("cond", secaoCond.campos, dadosCond);
    const { resultado: evaporadora, faltouObrigatorio: faltouEvap } = lerSecaoUnidade("evap", secaoEvap.campos, dadosEvap);

    if (faltouCond || faltouEvap) {
      toast("Preencha os campos obrigatórios (*).");
      return;
    }

    modalConclusaoEstado.infoTecnica = {
      informante,
      condensadora,
      evaporadora,
      local: item.local || "SEDE",
    };
    if (tipoGasNovo) modalConclusaoEstado.tipoGasNovo = tipoGasNovo;

    await finalizarConclusao();
  });
}

async function finalizarConclusao() {
  const { item, checklist, avaliacaoEstrelas, tecnico, infoTecnica, statusAnterior, aoAtualizar, fotoFile, tipoGasNovo } = modalConclusaoEstado;
  const btnSalvar = $("#btnModalConclusaoSalvar") || $("#btnModalConclusaoContinuar");
  if (btnSalvar) btnSalvar.disabled = true;

  try {
    const camposStatus = {
      statusPreventiva: "Concluída",
      dataConclusao: formatISO(new Date()),
    };
    if (tipoGasNovo) camposStatus.tipoGas = tipoGasNovo;
    const proxima = await calcularProximaData({ ...item, dataConclusao: camposStatus.dataConclusao });
    camposStatus.proximaPreventiva = proxima.data;
    camposStatus.proximaPreventivaDia = proxima.dia;

    // O patrimônio do equipamento tem que vir do tombo da EVAPORADORA
    // (é essa etiqueta que vale como patrimônio oficial) — só cai pro
    // tombo da condensadora se a evaporadora não tiver um informado.
    const tomboInformado = (infoTecnica && infoTecnica.evaporadora && infoTecnica.evaporadora.tombo)
      || (infoTecnica && infoTecnica.condensadora && infoTecnica.condensadora.tombo);
    if (tomboInformado) {
      camposStatus.patrimonio = tomboInformado;
    }

    let fotoUrl = "";
    if (fotoFile) {
      toast("Enviando foto...");
      fotoUrl = await enviarFoto(fotoFile, { folder: `equipamentos/${item.id}/preventivas` });
    }

    await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), camposStatus);
    Object.assign(item, camposStatus);

    const promessas = [
      registrarHistorico(item, statusAnterior, "Concluída", "Preventiva", fotoUrl),
      registrarOrdemServico(item, checklist, avaliacaoEstrelas, tecnico),
    ];

    if (infoTecnica) {
      promessas.push(setDoc(doc(db, "infoCondensadoras", item.id), {
        ...infoTecnica,
        equipamentoId: item.id,
        preenchidoPor: ESTADO.usuarioNome || "",
        preenchidoEm: new Date().toISOString(),
      }, { merge: true }));
    }

    await Promise.all(promessas);

    toast("Preventiva concluída com sucesso.");
    fecharModalConclusao(false);
    if (typeof aoAtualizar === "function") aoAtualizar();
  } catch (err) {
    console.error(err);
    toast("Erro ao concluir: " + err.message);
  } finally {
    if (btnSalvar) btnSalvar.disabled = false;
  }
}

function iniciarSincronizacaoOrdens() {
  if (ESTADO.unsubscribeOrdens) ESTADO.unsubscribeOrdens();
  const q = query(collectionGroup(db, "ordens"), orderBy("registradoEm", "desc"), limit(300));
  ESTADO.unsubscribeOrdens = onSnapshot(q, (snap) => {
    ESTADO.ordens = snap.docs
      .filter((d) => d.ref.parent.parent) // ignora lixo de fora da estrutura de ciclos
      .map((d) => ({
        id: d.id,
        cicloId: d.ref.parent.parent.id,
        ...d.data()
      }));
    renderComProtecaoDeMenu("#ordensTable", renderOrdens);
  }, (err) => {
    console.error(err);
    toast("Erro ao ler ordens de serviço: " + err.message);
  });
}

function iniciarSincronizacaoHistorico(){
  if (ESTADO.unsubscribeHistorico) ESTADO.unsubscribeHistorico();
  const q = query(collectionGroup(db, "historico"), orderBy("registradoEm", "desc"), limit(300));

  ESTADO.unsubscribeHistorico = onSnapshot(q, (snap) => {
    ESTADO.historico = snap.docs
      .filter((d) => d.ref.parent.parent)
      .map((d) => ({
        id: d.id,
        cicloId: d.ref.parent.parent.id,
        ...d.data()
      }));
    renderComProtecaoDeMenu("#historicoTable", renderHistorico);
  }, (err) => {
    console.error(err);
    toast("Erro ao carregar histórico: " + err.message);
  });
}

function renderHistorico(){
  const table = $("#historicoTable");
  if(!table) return;
  const termo = ESTADO.filtros.historico;
  const historico = aplicarFiltroLocal(ESTADO.historico).filter((h) => {
    if (!termo) return true;
    const alvo = `${h.patrimonio || ""} ${h.setor || ""} ${h.equipe || ""}`.toLowerCase();
    return alvo.includes(termo);
  });
  
  $("#historicoCount").textContent = `${historico.length} registros`;
  
  // CORREÇÃO 1: Removida a palavra "Ações" no final do cabeçalho (deixado apenas <th></th>)
  table.innerHTML = `<thead><tr>
      <th style="width:30px"><input type="checkbox" id="checkTodosHistorico"></th>
      <th>Data/Hora</th><th>Patrimônio</th><th>Setor</th>
      <th>Equipe</th><th>Usuário</th><th>Tipo</th><th>De</th><th>Para</th><th></th>
  </tr></thead><tbody></tbody>`;
  
  const tbody = table.querySelector("tbody");

  historico.forEach(h => {
    const tr = document.createElement("tr");
    
    // CORREÇÃO 2: Agora ele reconhece "Reagendamento manual" e mostra as datas corretamente
    const ehReagendamento = h.tipo === "Atraso Reagendado" || h.tipo === "Reagendamento manual";
    
    const colDe = ehReagendamento
      ? `<td>${formatarDataBR(h.dataAnterior)}</td>`
      : `<td><span class="status-select ${classeStatus(h.statusAnterior)}">${h.statusAnterior || "-"}</span></td>`;
      
    const colPara = ehReagendamento
      ? `<td>${formatarDataBR(h.dataNova)}</td>`
      : `<td><span class="status-select ${classeStatus(h.statusNovo)}">${h.statusNovo}</span></td>`;
      
    tr.innerHTML = `
        <td></td>
        <td>${new Date(h.registradoEm).toLocaleString("pt-BR")}</td>
        <td>${escapeHtml(h.patrimonio || "-")}</td>
        <td>${escapeHtml(h.setor)}</td>
        <td>${escapeHtml(h.equipe)}</td>
        <td>${escapeHtml(h.usuario || "-")}</td>
        <td>${h.tipo || "Preventiva"}</td>
        ${colDe}
        ${colPara}
    `;

    const chaveSel = `${h.cicloId}::${h.id}`;
    const tdCheck = tr.children[0];
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = ESTADO.selecaoHistorico.has(chaveSel);
    chk.addEventListener("change", () => {
      if (chk.checked) ESTADO.selecaoHistorico.add(chaveSel);
      else ESTADO.selecaoHistorico.delete(chaveSel);
      atualizarBarraSelecao("selecaoHistorico", "selecaoHistorico", "selecaoHistoricoTexto");
    });
    tdCheck.appendChild(chk);

    const tdAcao = document.createElement("td");
    tdAcao.innerHTML = `<details class="menu-linha"><summary>⋯</summary>
      <div class="menu-linha-opcoes">
        <button class="menu-linha-item menu-linha-excluir" data-acao="excluir">Excluir</button>
      </div>
    </details>`;
    tdAcao.querySelector('[data-acao="excluir"]').addEventListener("click", () => deletarRegistroHistorico(h.cicloId, h.id));
    tr.appendChild(tdAcao);
    tbody.appendChild(tr);
  });

  const checkTodos = $("#checkTodosHistorico");
  if (checkTodos) {
    checkTodos.checked = historico.length > 0 &&
      historico.every((h) => ESTADO.selecaoHistorico.has(`${h.cicloId}::${h.id}`));
    checkTodos.addEventListener("change", () => {
      historico.forEach((h) => {
        const chave = `${h.cicloId}::${h.id}`;
        if (checkTodos.checked) ESTADO.selecaoHistorico.add(chave);
        else ESTADO.selecaoHistorico.delete(chave);
      });
      renderHistorico();
    });
  }

  atualizarBarraSelecao("selecaoHistorico", "selecaoHistorico", "selecaoHistoricoTexto");
}

function renderOrdens() {
  const table = $("#ordensTable");
  if (!table) return;
  const termo = ESTADO.filtros.ordens;
  const ordens = aplicarFiltroLocal(ESTADO.ordens).filter((o) => {
    if (!termo) return true;
    const alvo = `${o.patrimonio || ""} ${o.setor || ""} ${o.ambiente || ""} ${o.equipe || ""}`.toLowerCase();
    return alvo.includes(termo);
  });
  $("#ordensCount").textContent = `${ordens.length} OS Emitidas`;
  table.innerHTML = `<thead><tr>
      <th style="width:30px"><input type="checkbox" id="checkTodosOrdens"></th>
      <th>Data de Conclusão</th><th>Patrimônio</th><th>Setor</th><th>Ambiente</th>
      <th>Equipe</th><th>Ações</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  ordens.forEach((o) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td></td>
      <td>${new Date(o.registradoEm).toLocaleString("pt-BR")}</td>
      <td>${escapeHtml(o.patrimonio || "-")}</td>
      <td>${escapeHtml(o.setor || "")}</td>
      <td>${escapeHtml(o.ambiente || "")}</td>
      <td>${escapeHtml(o.equipe || "")}</td>
    `;

    const chaveSel = `${o.cicloId}::${o.id}`;
    const tdCheck = tr.children[0];
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = ESTADO.selecaoOrdens.has(chaveSel);
    chk.addEventListener("change", () => {
      if (chk.checked) ESTADO.selecaoOrdens.add(chaveSel);
      else ESTADO.selecaoOrdens.delete(chaveSel);
      atualizarBarraSelecao("selecaoOrdens", "selecaoOrdens", "selecaoOrdensTexto");
    });
    tdCheck.appendChild(chk);

    const tdBtn = document.createElement("td");
    tdBtn.innerHTML = `<details class="menu-linha"><summary>⋯</summary>
      <div class="menu-linha-opcoes">
        <button class="menu-linha-item" data-acao="pmoc">Imprimir PMOC</button>
        <button class="menu-linha-item menu-linha-excluir" data-acao="excluir">Excluir</button>
      </div>
    </details>`;
    tdBtn.querySelector('[data-acao="pmoc"]').addEventListener("click", () => gerarPDFPMOC(o));
    tdBtn.querySelector('[data-acao="excluir"]').addEventListener("click", () => deletarRegistroOrdem(o.cicloId, o.id));
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });

  const checkTodos = $("#checkTodosOrdens");
  if (checkTodos) {
    checkTodos.checked = ordens.length > 0 &&
      ordens.every((o) => ESTADO.selecaoOrdens.has(`${o.cicloId}::${o.id}`));
    checkTodos.addEventListener("change", () => {
      ordens.forEach((o) => {
        const chave = `${o.cicloId}::${o.id}`;
        if (checkTodos.checked) ESTADO.selecaoOrdens.add(chave);
        else ESTADO.selecaoOrdens.delete(chave);
      });
      renderOrdens();
    });
  }

  atualizarBarraSelecao("selecaoOrdens", "selecaoOrdens", "selecaoOrdensTexto");
}

$("#btnExcluirSelecionadosOrdens")?.addEventListener("click", async () => {
  const chaves = [...ESTADO.selecaoOrdens];
  if (!chaves.length) return;
  const ok = window.confirm(`Excluir ${chaves.length} ordem(ns) de serviço selecionada(s)?`);
  if (!ok) return;
  try {
    const porCiclo = {};
    chaves.forEach((ch) => {
      const [cicloId, id] = ch.split("::");
      (porCiclo[cicloId] ||= []).push(id);
    });
    const TAMANHO_LOTE = 400;
    for (const [cicloId, ids] of Object.entries(porCiclo)) {
      for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((id) => batch.delete(doc(db, "ciclos", cicloId, "ordens", id)));
        await batch.commit();
      }
    }
    ESTADO.selecaoOrdens.clear();
    toast(`${chaves.length} registro(s) excluído(s).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
});

$("#btnExcluirSelecionadosHistorico")?.addEventListener("click", async () => {
  const chaves = [...ESTADO.selecaoHistorico];
  if (!chaves.length) return;
  const ok = window.confirm(`Excluir ${chaves.length} registro(s) de histórico selecionado(s)?`);
  if (!ok) return;
  try {
    const porCiclo = {};
    chaves.forEach((ch) => {
      const [cicloId, id] = ch.split("::");
      (porCiclo[cicloId] ||= []).push(id);
    });
    const TAMANHO_LOTE = 400;
    for (const [cicloId, ids] of Object.entries(porCiclo)) {
      for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((id) => batch.delete(doc(db, "ciclos", cicloId, "historico", id)));
        await batch.commit();
      }
    }
    ESTADO.selecaoHistorico.clear();
    toast(`${chaves.length} registro(s) excluído(s).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
});

function prepararEdicao(item) {
  idEquipamentoEmEdicao = item.id;
  $("#eqPatrimonio").value = item.patrimonio || "";
  $("#eqSetor").value = item.setor || "";
  $("#eqAmbiente").value = item.ambiente || "";
  if ($("#eqLocal")) $("#eqLocal").value = item.local || "SEDE";
  if ($("#eqTipoGas")) $("#eqTipoGas").value = item.tipoGas || "";
  if ($("#eqObservacao")) $("#eqObservacao").value = item.observacao || "";

  if (btnAdicionarEquipamento) {
    btnAdicionarEquipamento.textContent = "Salvar Alterações";
  }
  $("#eqSetor")?.focus();
  toast("Modo de edição ativado para o item selecionado.");
}

const btnAdicionarEquipamento = $("#btnAdicionarEquipamento");
if (btnAdicionarEquipamento) {
  btnAdicionarEquipamento.addEventListener("click", adicionarEquipamentoManual);
}

// Botão flutuante (mobile): quando a lista de equipamentos já está longa,
// evita ter que rolar a tela de volta lá pra cima só pra achar o formulário
// de cadastro -- pula direto pra ele.
$("#fabAdicionarEquipamento")?.addEventListener("click", () => {
  $("#eqPatrimonio")?.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#eqPatrimonio")?.focus();
});

$("#btnBaixarCondensadoras")?.addEventListener("click", async () => {
  toast("Buscando dados técnicos...");
  try {
    const snap = await getDocs(collection(db, "infoCondensadoras"));
    const infoPorId = new Map();
    snap.docs.forEach((d) => infoPorId.set(d.id, d.data()));

    // Além das máquinas que já passaram pelo formulário de conclusão, inclui
    // as que já vieram completas da planilha (Marca/Modelo/Capacidade) mas
    // nunca foram concluídas — senão elas nunca apareciam nesse relatório,
    // mesmo já tendo o dado técnico disponível.
    const idsParaExportar = new Set(infoPorId.keys());
    ESTADO.equipamentos.forEach((item) => {
      if (!infoPorId.has(item.id) && (item.marca || item.modelo || item.capacidade)) {
        idsParaExportar.add(item.id);
      }
    });

    if (!idsParaExportar.size) {
      toast("Nenhuma máquina com dados técnicos preenchidos ainda.");
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Dados Técnicos");
    sheet.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];

    // Definindo as colunas
    sheet.columns = [
      // DADOS GERAIS (1 a 7)
      { key: "patrimonio", width: 16 },
      { key: "setor", width: 28 },
      { key: "ambiente", width: 28 },
      { key: "local", width: 14 },
      { key: "tipoGas", width: 12 },
      { key: "informante", width: 18 },
      { key: "preenchidoEm", width: 16 },
      // CONDENSADORA (8 a 14)
      { key: "condNumero", width: 10 },
      { key: "condTombo", width: 14 },
      { key: "condTag", width: 14 },
      { key: "condMarca", width: 14 },
      { key: "condModelo", width: 16 },
      { key: "condCapacidade", width: 16 },
      { key: "condFio", width: 16 },
      // EVAPORADORA (15 a 20)
      { key: "evapTombo", width: 14 },
      { key: "evapTag", width: 14 },
      { key: "evapMarca", width: 14 },
      { key: "evapModelo", width: 16 },
      { key: "evapCapacidade", width: 16 },
      { key: "evapFio", width: 16 },
    ];

    // LINHA 1: Super-Cabeçalhos (Mesclados)
    sheet.mergeCells('A1:G1');
    sheet.mergeCells('H1:N1');
    sheet.mergeCells('O1:T1');

    const r1 = sheet.getRow(1);
    r1.height = 25;
    r1.getCell(1).value = "DADOS GERAIS DA MÁQUINA";
    r1.getCell(8).value = "UNIDADE EXTERNA (CONDENSADORA)";
    r1.getCell(15).value = "UNIDADE INTERNA (EVAPORADORA)";

    // Estilo da Linha 1
    r1.eachCell((cell, colNumber) => {
      cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      let cor = "FF1F4E78"; // Azul padrão para Geral
      if (colNumber >= 8 && colNumber <= 14) cor = "FF9C6500"; // Amarelo/Dourado escuro
      if (colNumber >= 15 && colNumber <= 20) cor = "FF375623"; // Verde escuro
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cor } };
    });

    // LINHA 2: Cabeçalhos reais
    const r2 = sheet.getRow(2);
    r2.height = 20;
    r2.values = [
      "Patrimônio", "Setor", "Ambiente", "Prédio", "Tipo de Gás", "Informante", "Preenchido em",
      "Nº", "Tombo", "Tag", "Marca", "Modelo", "Capacidade", "Fio (mm)",
      "Tombo", "Tag", "Marca", "Modelo", "Capacidade", "Fio (mm)"
    ];

    // Estilo da Linha 2
    r2.eachCell((cell, colNumber) => {
      cell.font = { name: "Arial", bold: true, color: { argb: "FF000000" }, size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        top: { style: "thin", color: { argb: "FFBFBFBF" } },
        bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
        left: { style: "thin", color: { argb: "FFBFBFBF" } },
        right: { style: "thin", color: { argb: "FFBFBFBF" } }
      };
      let cor = "FFEEF3F8"; // Fundo claro Geral
      if (colNumber >= 8 && colNumber <= 14) cor = "FFFFE699"; // Fundo claro Condensadora
      if (colNumber >= 15 && colNumber <= 20) cor = "FFC6E0B4"; // Fundo claro Evaporadora
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cor } };
    });

    // Inserindo os Dados
    [...idsParaExportar].forEach((id, index) => {
      const dados = infoPorId.get(id) || null;
      const item = ESTADO.equipamentos.find((e) => e.id === id) || {};

      // Marca/Modelo/Capacidade que vêm só da planilha (levantamento, antes
      // de qualquer formulário preenchido) são sempre da EVAPORADORA -- é a
      // etiqueta que dá pra ler na sala; a condensadora fica em local de
      // difícil acesso e não é o que o levantamento registra. Por isso só a
      // evaporadora herda esse valor quando não há "dados" ainda; a
      // condensadora fica em branco até alguém confirmar em campo.
      const infoPlanilha = { marca: item.marca || "", modelo: item.modelo || "", capacidade: item.capacidade || "" };
      const cond = dados ? (dados.condensadora || {}) : {};
      const evap = dados ? (dados.evaporadora || {}) : infoPlanilha;

      const row = sheet.addRow({
        patrimonio: item.patrimonio || evap.tombo || "-", // Usa o tombo da evap se não tiver no item principal
        setor: item.setor || "-",
        ambiente: item.ambiente || "-",
        local: (dados && dados.local) || item.local || "-",
        tipoGas: item.tipoGas || "-",
        informante: dados ? (dados.informante || "-") : "Planilha (levantamento)",
        preenchidoEm: dados && dados.preenchidoEm ? new Date(dados.preenchidoEm).toLocaleDateString("pt-BR") : "-",
        condNumero: cond.numero || "-", condTombo: cond.tombo || "-", condTag: cond.tag || "-",
        condMarca: cond.marca || "-", condModelo: cond.modelo || "-",
        condCapacidade: cond.capacidade || "-", condFio: cond.espessuraFio || "-",
        evapTombo: evap.tombo || "-", evapTag: evap.tag || "-",
        evapMarca: evap.marca || "-", evapModelo: evap.modelo || "-",
        evapCapacidade: evap.capacidade || "-", evapFio: evap.espessuraFio || "-",
      });

      // Borda fina e cores intercaladas (zebra) para leitura
      row.eachCell((cell) => {
        cell.font = { name: "Arial", size: 10 };
        cell.border = {
          top: { style: "thin", color: { argb: "FFE0E0E0" } },
          bottom: { style: "thin", color: { argb: "FFE0E0E0" } },
          left: { style: "thin", color: { argb: "FFE0E0E0" } },
          right: { style: "thin", color: { argb: "FFE0E0E0" } }
        };
        if (index % 2 !== 0) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9F9F9" } };
        }
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Dados_Tecnicos_PMOC_${formatISO(new Date())}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Planilha baixada com sucesso!");
  } catch (err) {
    console.error(err);
    toast("Erro ao gerar planilha: " + err.message);
  }
});

async function adicionarEquipamentoManual() {
  const patrimonio = $("#eqPatrimonio").value.trim();
  const setor = $("#eqSetor").value.trim();
  const ambiente = $("#eqAmbiente").value.trim();
  const tipoGas = $("#eqTipoGas")?.value || "";
  const observacao = $("#eqObservacao")?.value.trim() || "";
  const arquivoFoto = $("#eqFotoInput")?.files?.[0] || null;

  if (!setor || !ambiente) {
    toast("Preencha pelo menos Setor e Ambiente.");
    return;
  }

  if (patrimonio) {
    const duplicado = ESTADO.equipamentos.find((e) =>
      e.patrimonio && e.patrimonio.trim() === patrimonio && e.id !== idEquipamentoEmEdicao
    );
    if (duplicado) {
      const ok = window.confirm(
        `Já existe um equipamento com o patrimônio "${patrimonio}" (${duplicado.setor} — ${duplicado.ambiente}, ${duplicado.local || "SEDE"}).\n\nQuer continuar mesmo assim?`
      );
      if (!ok) return;
    }
  }

  const setorPCM = identificarSetor(setor, ambiente);
  const prioridadeSetor = PRIORIDADE[setorPCM] || 7;
  const pisoPCM = descobrirPiso(setor);

  if (idEquipamentoEmEdicao) {
    const local = $("#eqLocal")?.value || "SEDE";
    const itemOriginal = ESTADO.equipamentos.find((e) => e.id === idEquipamentoEmEdicao);
    const localMudou = itemOriginal && (itemOriginal.local || "SEDE") !== local;
    // Só limpa e reagenda automaticamente quando o item ainda está Pendente —
    // pra um item Concluída/Em andamento, limpar a data quebraria ele (o
    // reagendarTudo() não recalcula quem não está pendente).
    const podeReagendar = localMudou && itemOriginal.statusPreventiva === "Pendente";
    try {
      const camposAtualizados = { patrimonio, setor, ambiente, local, setorPCM, prioridadeSetor, pisoPCM, tipoGas, observacao };
      if (arquivoFoto) {
        toast("Enviando foto...");
        camposAtualizados.fotoUrl = await enviarFoto(arquivoFoto, { publicId: `equipamentos/${idEquipamentoEmEdicao}/foto`, overwrite: true });
      }
      if (podeReagendar) {
        // Equipe e data eram do prédio antigo — ficariam presas lá se não
        // limpar aqui, já que reagendarTudo() não mexe em quem já tem data.
        camposAtualizados.equipeResponsavel = "";
        camposAtualizados.dataAgendada = "";
        camposAtualizados.diaPlanejado = "";
        camposAtualizados.semanaPlanejada = "";
      }
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", idEquipamentoEmEdicao), camposAtualizados);
      await registrarHistorico(
        { id: idEquipamentoEmEdicao, patrimonio, setor, ambiente, local, equipeResponsavel: "" },
        "-", "Editado", "Cadastro"
      );
      idEquipamentoEmEdicao = null;
      if (btnAdicionarEquipamento) btnAdicionarEquipamento.textContent = "Adicionar Equipamento";
      if (podeReagendar) {
        toast("Prédio alterado — reagendando para a nova rotina...");
        await reagendarTudo();
      } else if (localMudou) {
        toast("Prédio alterado. Como o item já não está mais pendente, a equipe e a data não foram mexidas — confira manualmente se precisa ajustar.");
      } else {
        toast("Equipamento atualizado com sucesso!");
      }
    } catch (err) {
      console.error(err);
      toast("Erro ao atualizar: " + err.message);
      return;
    }
  } else {
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const local = $("#eqLocal")?.value || "SEDE";
    const itensDoMesmoLocal = ESTADO.equipamentos.filter((e) => (e.local || "SEDE") === local);
    const maiorOrdem = itensDoMesmoLocal.reduce((max, e) => Math.max(max, e.ordemExecucao || 0), 0);
    const ordemExecucao = maiorOrdem + 1;
    const capLocal = (ESTADO.config && ESTADO.config.capacidades && ESTADO.config.capacidades[local]) || { nEquipes: 2, aparelhosDia: 2 };

    // Mesma fórmula da "roleta" usada em gerarCronograma() — aproxima em qual
    // dia esse item cairia (pelo tanto de itens que já existem nesse prédio)
    // pra escolher a equipe do rodízio de forma consistente com o resto do
    // cronograma, em vez de uma conta mais simples que ignorava o rodízio.
    let equipeResponsavel;
    if (capLocal.modoRodizio && capLocal.equipesAtivas && capLocal.equipesAtivas.length > 0) {
      const nVagas = Math.max(1, capLocal.nEquipes || 1);
      const capacidadeDia = nVagas * Math.max(1, capLocal.aparelhosDia || 1);
      const diasUteisJaUsados = Math.floor(itensDoMesmoLocal.length / capacidadeDia);
      const slotDaSala = (ordemExecucao - 1) % nVagas;
      const pool = capLocal.equipesAtivas;
      const indiceNoPool = (diasUteisJaUsados * nVagas + slotDaSala) % pool.length;
      equipeResponsavel = pool[indiceNoPool];
    } else {
      equipeResponsavel = nomeEquipePorVaga(local, ordemExecucao - 1, capLocal.nEquipes);
    }

    const item = {
      id, patrimonio, setor, ambiente,
      local,
      statusCondicao: "",
      setorPCM,
      prioridadeSetor,
      pisoPCM,
      statusPreventiva: "Pendente",
      observacao,
      tipoGas,
      origem: "manual",
      ordemExecucao,
      equipeResponsavel,
      dataAgendada: "",
      diaPlanejado: "",
      semanaPlanejada: "",
    };

    try {
      if (arquivoFoto) {
        toast("Enviando foto...");
        item.fotoUrl = await enviarFoto(arquivoFoto, { publicId: `equipamentos/${id}/foto`, overwrite: true });
      }
      await setDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), item);
      ESTADO.equipamentos.push(item);
      await registrarHistorico(item, "-", "Cadastrado", "Cadastro");
      toast("Equipamento adicionado. Agendando automaticamente...");
      await reagendarTudo();
    } catch (err) {
      console.error(err);
      toast("Erro ao adicionar: " + err.message);
      return;
    }
  }

  $("#eqPatrimonio").value = "";
  $("#eqSetor").value = "";
  $("#eqAmbiente").value = "";
  if ($("#eqTipoGas")) $("#eqTipoGas").value = "";
  if ($("#eqObservacao")) $("#eqObservacao").value = "";
  if ($("#eqFotoInput")) $("#eqFotoInput").value = "";
}

async function removerEquipamento(id, descricao) {
  const ok = window.confirm(`Remover "${descricao}"? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id));
    toast("Equipamento removido. Reorganizando cronograma...");
    await reagendarTudo();
  } catch (err) {
    console.error(err);
    toast("Erro ao remover: " + err.message);
  }
}

function atualizarBarraSelecao(nomeSet, containerId, textoId) {
  const set = ESTADO[nomeSet];
  const container = $(`#${containerId}`);
  const texto = $(`#${textoId}`);
  
  if (!container) return;
  
  if (set.size > 0) {
    container.classList.add("visivel");
  } else {
    container.classList.remove("visivel");
  }
  
  if (texto) {
    texto.textContent = `${set.size} selecionado(s)`;
  }
}

// Lógica para o botão "X" limpar a seleção
$("#btnLimparSelecaoEquipamentos")?.addEventListener("click", () => {
  ESTADO.selecaoEquipamentos.clear(); // Limpa o Set
  
  // Desmarca o checkbox "Selecionar Todos" se existir
  const checkTodos = $("#checkTodosEquipamentos");
  if (checkTodos) checkTodos.checked = false;
  
  atualizarBarraSelecao("selecaoEquipamentos", "selecaoEquipamentos", "selecaoEquipamentosTexto");
  renderEquipamentosCadastro(); // Re-renderiza a tabela para desmarcar as linhas
});

// ------------------------------------------------------------------
// Localização na planta — mostra os aparelhos marcados sobre a imagem da
// planta baixa do prédio; admin pode clicar na imagem pra marcar/mover a
// posição de um aparelho (a posição fica salva no próprio equipamento,
// como plantaId/plantaX/plantaY -- por isso ela sobrevive à virada de
// ciclo, já que o item inteiro é copiado pro ciclo novo).
// ------------------------------------------------------------------
const CORES_STATUS_MARCADOR = {
  pendente: "#C00000",
  andamento: "#9C6500",
  concluido: "#375623",
  atrasado: "#10263D",
};

async function renderLocalizacao() {
  const seletor = $("#plantaSeletor");
  if (!seletor) return;

  const isAdmin = ESTADO.permissao === "admin";
  const semPlantas = $("#plantaSemPlantas");
  const area = $("#plantaConteudo");
  const painelUpload = $("#painelUploadPlanta");
  if (!ESTADO.plantas.length) {
    if (semPlantas) semPlantas.hidden = false;
    if (area) area.hidden = true;
    if (painelUpload) painelUpload.hidden = !isAdmin;
    if (isAdmin) renderUploadPlanta();
    return;
  }
  if (semPlantas) semPlantas.hidden = true;
  if (area) area.hidden = false;
  if (painelUpload && !isAdmin) painelUpload.hidden = true;

  if (!ESTADO.plantaSelecionada || !ESTADO.plantas.some((p) => p.id === ESTADO.plantaSelecionada)) {
    ESTADO.plantaSelecionada = ESTADO.plantas[0].id;
  }
  // Agrupa por prédio/anexo (planta.local) -- a Jovanna pediu pra ficar
  // como se fossem "pastas" separadas, pra achar mais fácil quando tem
  // planta de vários anexos misturada. Só um prédio: não precisa de
  // grupo, fica igual antes.
  const prediosComPlanta = [...new Set(ESTADO.plantas.map((p) => p.local || "SEDE"))];
  if (prediosComPlanta.length <= 1) {
    seletor.innerHTML = ESTADO.plantas.map((p) =>
      `<option value="${p.id}" ${p.id === ESTADO.plantaSelecionada ? "selected" : ""}>${escapeHtml(p.nome)}</option>`
    ).join("");
  } else {
    seletor.innerHTML = prediosComPlanta.map((predio) => `
      <optgroup label="${escapeHtml(predio)}">
        ${ESTADO.plantas.filter((p) => (p.local || "SEDE") === predio).map((p) =>
          `<option value="${p.id}" ${p.id === ESTADO.plantaSelecionada ? "selected" : ""}>${escapeHtml(p.nome)}</option>`
        ).join("")}
      </optgroup>`
    ).join("");
  }
  seletor.hidden = ESTADO.plantas.length <= 1;

  const planta = plantaPorId(ESTADO.plantaSelecionada);
  if (!planta) return;

  const svg = $("#plantaSvg");
  if (svg && svg.dataset.plantaId !== planta.id) {
    svg.innerHTML = "";
    svg.dataset.plantaId = "";
    $("#plantaCamadas").innerHTML = "";
    $("#plantaPainel").innerHTML = '<p class="muted">Carregando planta...</p>';
    try {
      const dados = await carregarDadosPlanta(planta);
      montarSvgPlanta(planta, dados);
      svg.dataset.plantaId = planta.id;
      limparPainelPlanta();
    } catch (err) {
      console.error(err);
      $("#plantaPainel").innerHTML = `<p class="muted">Erro ao carregar essa planta: ${escapeHtml(err.message)}</p>`;
      return;
    }
  }

  renderMarcadoresPlanta();

  const btnNovaPlanta = $("#btnMostrarUploadPlanta");
  if (btnNovaPlanta) btnNovaPlanta.hidden = !isAdmin;
  const btnExcluirPlanta = $("#btnExcluirPlanta");
  if (btnExcluirPlanta) btnExcluirPlanta.hidden = !isAdmin;

  atualizarModoMarcacao();

  // Os dois lados precisam do MESMO fallback -- sem isso, uma planta sem
  // "local" definido (undefined) nunca batia com nenhum aparelho (que
  // caem em "SEDE" quando também não têm local).
  const localDaPlanta = planta.local || "SEDE";
  const itensDoPredio = ESTADO.equipamentos
    .filter((e) => (e.local || "SEDE") === localDaPlanta)
    .sort((a, b) => (a.ambiente || "").localeCompare(b.ambiente || ""));

  // Aviso de conferência: cruza o cadastro com o que já tem marcação em
  // ALGUMA planta desse prédio (pode ser essa planta aberta agora ou
  // outro andar do mesmo prédio -- não dá pra saber em qual andar
  // exato cada aparelho cadastrado deveria estar, só o prédio). Pega o
  // problema oposto do limiar de detecção (candidato sobrando): aparelho
  // que existe no cadastro mas nunca foi marcado em planta nenhuma --
  // seja porque a planta ainda não foi conferida, seja porque o desenho
  // dele está numa camada que o sistema não reconhece como equipamento.
  const resumo = $("#plantaResumoDeteccao");
  if (resumo) {
    const semMarcacao = itensDoPredio.filter((e) => !e.plantaId && !e.condensadoraPlantaId);
    if (!itensDoPredio.length) {
      resumo.hidden = true;
    } else if (semMarcacao.length) {
      resumo.hidden = false;
      resumo.textContent = `⚠ ${semMarcacao.length} de ${itensDoPredio.length} equipamento(s) cadastrado(s) em "${localDaPlanta}" ainda sem marcação em planta nenhuma.`;
    } else {
      resumo.hidden = false;
      resumo.textContent = `✓ Todos os ${itensDoPredio.length} equipamento(s) cadastrado(s) em "${localDaPlanta}" já têm marcação em alguma planta.`;
    }
  }

  if (isAdmin) {
    const select = $("#plantaEquipamentoSelect");
    const selecionadoAntes = select.value;
    select.innerHTML = itensDoPredio.map((e) => {
      const marcado = e.plantaId === planta.id ? " ✓ já marcado" : "";
      const rotulo = [e.codigoPlanta, e.patrimonio ? `Pat. ${e.patrimonio}` : null, e.ambiente].filter(Boolean).join(" — ");
      return `<option value="${e.id}">${escapeHtml(rotulo || e.id)}${marcado}</option>`;
    }).join("");
    if (itensDoPredio.some((e) => e.id === selecionadoAntes)) select.value = selecionadoAntes;
    atualizarCodigoPlantaInput();
    select.onchange = atualizarCodigoPlantaInput;
    function atualizarCodigoPlantaInput() {
      const itemSelecionado = itensDoPredio.find((e) => e.id === select.value);
      const codigoInput = $("#plantaCodigoInput");
      if (codigoInput) codigoInput.value = (itemSelecionado && itemSelecionado.codigoPlanta) || "";
    }
  }
}

// Mostra/esconde os campos certos conforme o modo (evaporadora escolhe
// um aparelho da lista; condensadora só pede o código dela) e atualiza
// a dica embaixo explicando como funciona o vínculo automático.
// Marcação só acontece de propósito: o modo de edição fica desligado por
// padrão (lápis apagado no canto da planta) e clicar/arrastar só navega
// (dá pra abrir os painéis dos marcadores já existentes normalmente, isso
// nunca cria nada). Só quando a pessoa clica no lápis é que um clique no
// fundo, num contorno tracejado, ou arrastar um marcador/ícone passa a
// criar/mover algo -- assim não tem risco de marcar sem querer só
// olhando a planta. O painel inteiro de "o que estou marcando" também
// só aparece nesse modo, em vez de ficar sempre visível.
function marcacaoEstaAtiva() {
  return ESTADO.permissao === "admin" && ESTADO.editandoPlanta === true;
}

function atualizarModoMarcacao() {
  const modo = $('input[name="modoMarcacao"]:checked')?.value || "evaporadora";
  const modoCondensadora = modo === "condensadora";
  const campoEquip = $("#campoEquipamentoWrap");
  const campoCodEvap = $("#campoCodigoEvapWrap");
  const campoCodCond = $("#campoCodigoCondWrap");
  if (campoEquip) campoEquip.hidden = modo !== "evaporadora";
  if (campoCodEvap) campoCodEvap.hidden = modo !== "evaporadora";
  if (campoCodCond) campoCodCond.hidden = !modoCondensadora;

  const isAdmin = ESTADO.permissao === "admin";
  const editando = marcacaoEstaAtiva();
  const cardPosicionar = $("#cardPosicionarPlanta");
  if (cardPosicionar) cardPosicionar.hidden = !editando;
  const btnEditar = $("#btnEditarPlanta");
  if (btnEditar) {
    btnEditar.hidden = !isAdmin;
    btnEditar.classList.toggle("ativo", editando);
    btnEditar.title = editando ? "Sair do modo de edição" : "Editar marcações (posicionar/mover equipamentos)";
  }
  $("#plantaSvg")?.classList.toggle("marcacao-ativa", editando);

  const dica = $("#dicaModoMarcacao");
  if (dica) {
    dica.textContent = modo === "descartar"
      ? "Clique numa área tracejada que o sistema identificou errado (não é equipamento) pra descartar ela -- some da lista e não aparece mais como candidato."
      : modoCondensadora
      ? "Clique numa área tracejada: o sistema já chuta o código (pelo padrão de numeração e tentando ler o que está desenhado do lado) -- confira/corrija e clique de novo pra confirmar. Qualquer evaporadora com \"Código na planta\" = algo/C7 vai achar essa condensadora sozinha, sem precisar escolher aparelho aqui."
      : "";
  }
}
$("#btnEditarPlanta")?.addEventListener("click", () => {
  ESTADO.editandoPlanta = !ESTADO.editandoPlanta;
  resetarTipoAcaoMarcacao();
  atualizarModoMarcacao();
  renderMarcadoresPlanta();
});

// Menu do lápis em dois níveis: primeiro escolhe o TIPO (evaporadora ou
// condensadora, empilhados), só depois aparecem os botões + (adicionar
// um aparelho novo) e − (descartar uma área que o sistema apontou errado
// como equipamento) -- a Jovanna achou o menu anterior (tudo junto numa
// linha só) confuso. Por baixo continua sendo os 3 mesmos radios
// escondidos de sempre (evaporadora/condensadora/descartar), só a forma
// de escolher que mudou.
let _tipoMarcacaoAtual = null;

function aplicarTipoAcaoMarcacao(tipo, acao) {
  _tipoMarcacaoAtual = tipo;
  const valorRadio = acao === "descartar" ? "descartar" : tipo;
  const radio = $(`input[name="modoMarcacao"][value="${valorRadio}"]`);
  if (radio) radio.checked = true;

  $all(".planta-tipo-botao").forEach((b) => b.classList.toggle("ativo", b.dataset.tipo === tipo));
  $all(".planta-acao-botao").forEach((b) => b.classList.toggle("ativo", b.dataset.acao === acao));
  const acaoLinha = $("#plantaAcaoLinha");
  if (acaoLinha) acaoLinha.hidden = false;
  const campos = $("#camposAdicionarMarcacao");
  if (campos) campos.hidden = acao !== "adicionar";
  const chips = $("#plantaChipsArrastar");
  if (chips) chips.hidden = acao !== "adicionar";
  $("#chipArrastarEvap")?.toggleAttribute("hidden", tipo !== "evaporadora");
  $("#chipArrastarCond")?.toggleAttribute("hidden", tipo !== "condensadora");

  atualizarModoMarcacao();
}

function resetarTipoAcaoMarcacao() {
  _tipoMarcacaoAtual = null;
  $all(".planta-tipo-botao").forEach((b) => b.classList.remove("ativo"));
  $all(".planta-acao-botao").forEach((b) => b.classList.remove("ativo"));
  const acaoLinha = $("#plantaAcaoLinha");
  if (acaoLinha) acaoLinha.hidden = true;
  const campos = $("#camposAdicionarMarcacao");
  if (campos) campos.hidden = true;
  const chips = $("#plantaChipsArrastar");
  if (chips) chips.hidden = true;
}

$all(".planta-tipo-botao").forEach((btn) => {
  btn.addEventListener("click", () => aplicarTipoAcaoMarcacao(btn.dataset.tipo, "adicionar"));
});
$("#btnAcaoAdicionar")?.addEventListener("click", () => {
  if (_tipoMarcacaoAtual) aplicarTipoAcaoMarcacao(_tipoMarcacaoAtual, "adicionar");
});
$("#btnAcaoRemover")?.addEventListener("click", () => {
  if (_tipoMarcacaoAtual) aplicarTipoAcaoMarcacao(_tipoMarcacaoAtual, "descartar");
});

// Constrói o SVG da planta a partir do desenho vetorial já baixado: um
// <g> por camada do CAD (pra dar pra ligar/desligar) dentro do grupo com a
// transformação de coordenadas, e a lista de checkboxes de camada.
function montarSvgPlanta(planta, dados) {
  const svg = $("#plantaSvg");
  const [xmin, ymin, xmax, ymax] = dados.bbox;
  const pad = Math.max((xmax - xmin) * 0.03, 1);
  const viewInicial = { x: xmin - pad, y: ymin - pad, w: xmax - xmin + pad * 2, h: ymax - ymin + pad * 2 };
  svg.setAttribute("viewBox", `${viewInicial.x} ${viewInicial.y} ${viewInicial.w} ${viewInicial.h}`);
  svg.__viewOriginal = viewInicial;
  ativarZoomPan(svg);
  svg.innerHTML = "";

  const nsSvg = "http://www.w3.org/2000/svg";
  const gRaiz = document.createElementNS(nsSvg, "g");
  gRaiz.setAttribute("transform", `matrix(${dados.matriz.join(",")})`);
  svg.appendChild(gRaiz);

  const gPorCamada = {};
  (dados.layers || []).forEach((camada) => {
    const g = document.createElementNS(nsSvg, "g");
    g.dataset.camada = camada;
    gRaiz.appendChild(g);
    gPorCamada[camada] = g;
  });

  // Cor customizada por camada (opcional) -- a Jovanna pediu pra poder
  // trocar a cor do desenho original do CAD depois de já ter subido a
  // planta (ex: uma camada com cor difícil de enxergar). Fica salva no
  // documento da planta (coresCamadas: {camada: "#hex"}); quando não tem
  // override, usa a cor de verdade que veio do arquivo.
  // Espessura customizada por camada (opcional, mesmo esquema da cor) --
  // multiplica a espessura original de cada linha (ent.sw), não substitui
  // por um valor fixo, então uma camada que já tinha linhas mais grossas
  // que outra continua proporcional depois de ajustar.
  const coresCamadas = planta.coresCamadas || {};
  const espessurasCamadas = planta.espessurasCamadas || {};
  const pathPorNumero = new Map();
  (dados.entities || []).forEach((ent) => {
    const p = document.createElementNS(nsSvg, "path");
    p.setAttribute("d", ent.d);
    if (ent.n != null) { p.dataset.n = ent.n; p.dataset.strokeOriginal = ent.stroke || ""; p.dataset.fillOriginal = ent.fill || ""; }
    const corCamada = coresCamadas[ent.layer];
    const espessuraCamada = espessurasCamadas[ent.layer] || 1;
    if (ent.stroke) {
      p.setAttribute("stroke", corCamada || ent.stroke);
      p.setAttribute("stroke-width", (ent.sw || 1) * espessuraCamada);
      p.setAttribute("fill", "none");
    }
    if (ent.fill) {
      p.setAttribute("fill", corCamada || ent.fill);
      if (!ent.stroke) p.setAttribute("stroke", "none");
    }
    if (!ent.stroke && !ent.fill) {
      p.setAttribute("stroke", "#888");
      p.setAttribute("stroke-width", 4);
      p.setAttribute("fill", "none");
    }
    (gPorCamada[ent.layer] || gRaiz).appendChild(p);
    if (ent.n != null) pathPorNumero.set(ent.n, p);
  });
  svg.__pathPorNumero = pathPorNumero;

  // Fica DENTRO do gRaiz (mesmo espaço de coordenadas dos <path>, antes
  // da transformação) -- é onde entram os destaques desenhados em cima
  // do próprio símbolo original (contorno colorido pelo status, ou
  // tracejado quando ainda não identificado), por cima de todas as
  // camadas.
  const gDestaques = document.createElementNS(nsSvg, "g");
  gDestaques.id = "plantaDestaquesSvg";
  gRaiz.appendChild(gDestaques);

  // Já esse fica FORA do gRaiz, no espaço final -- é onde entram os
  // ícones genéricos (fallback pra quando a posição marcada não bate com
  // nenhum símbolo real detectado no desenho).
  const gMarcadores = document.createElementNS(nsSvg, "g");
  gMarcadores.id = "plantaMarcadoresSvg";
  svg.appendChild(gMarcadores);

  // Cor de verdade da camada, direto do arquivo -- ignora qualquer
  // override, é o que "voltar ao original" restaura.
  function corOriginalDaCamada(camada) {
    const ent = (dados.entities || []).find((e) => e.layer === camada && (e.stroke || e.fill));
    const cor = ent ? (ent.stroke || ent.fill) : "#888888";
    return /^#[0-9a-fA-F]{6}$/.test(cor) ? cor : "#888888"; // <input type=color> só aceita hex de 6 dígitos
  }
  // Cor "atual" de cada camada pra mostrar no seletor de cor -- pega o
  // override salvo, ou senão a cor original.
  function corAtualDaCamada(camada) {
    return coresCamadas[camada] || corOriginalDaCamada(camada);
  }

  const painelCamadas = $("#plantaCamadas");
  painelCamadas.innerHTML = (dados.layers || []).map((camada) => {
    const temOverride = coresCamadas[camada] || espessurasCamadas[camada];
    return `<label class="planta-camada-linha">
      <input type="checkbox" checked data-camada="${escapeHtml(camada)}">
      <span>${escapeHtml(camada)}</span>
      <button type="button" class="planta-camada-resetar" data-resetar-camada="${escapeHtml(camada)}" title="Voltar essa camada pra cor e grossura originais do arquivo" ${temOverride ? "" : "hidden"}>↺</button>
      <input type="range" min="0.5" max="4" step="0.25" data-espessura-camada="${escapeHtml(camada)}" value="${espessurasCamadas[camada] || 1}" title="Grossura desta camada">
      <input type="color" data-cor-camada="${escapeHtml(camada)}" value="${corAtualDaCamada(camada)}" title="Cor desta camada">
    </label>`;
  }
  ).join("");
  painelCamadas.querySelectorAll("input[data-camada]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const g = gPorCamada[inp.dataset.camada];
      if (g) g.style.display = inp.checked ? "" : "none";
    });
  });
  // Botão "voltar ao original" -- some depois de usado (não tem mais
  // override pra desfazer), e reverte cor/grossura na hora, sem precisar
  // recarregar a página.
  painelCamadas.querySelectorAll("button[data-resetar-camada]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const camada = btn.dataset.resetarCamada;
      const corOriginal = corOriginalDaCamada(camada);
      (dados.entities || []).forEach((ent) => {
        if (ent.layer !== camada || ent.n == null) return;
        const p = pathPorNumero.get(ent.n);
        if (!p) return;
        if (ent.stroke) { p.setAttribute("stroke", ent.stroke); p.setAttribute("stroke-width", ent.sw || 1); }
        if (ent.fill) p.setAttribute("fill", ent.fill);
      });
      const linha = btn.closest(".planta-camada-linha");
      const inputCor = linha?.querySelector("input[data-cor-camada]");
      if (inputCor) inputCor.value = corOriginal;
      const inputEspessura = linha?.querySelector("input[data-espessura-camada]");
      if (inputEspessura) inputEspessura.value = 1;
      btn.hidden = true;
      try {
        // updateDoc aceita vários pares campo/valor -- os dois campos
        // (cor e grossura) somem numa escrita só. FieldPath de novo, pelo
        // mesmo motivo de sempre (nome de camada pode ter ponto).
        await updateDoc(
          doc(db, "plantas", planta.id),
          new FieldPath("coresCamadas", camada), deleteField(),
          new FieldPath("espessurasCamadas", camada), deleteField()
        );
      } catch (err) {
        console.error(err);
        toast("Erro ao voltar ao original: " + err.message);
      }
    });
  });
  painelCamadas.querySelectorAll("input[data-espessura-camada]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const camada = inp.dataset.espessuraCamada;
      const fator = Number(inp.value) || 1;
      (dados.entities || []).forEach((ent) => {
        if (ent.layer !== camada || ent.n == null || !ent.stroke) return;
        const p = pathPorNumero.get(ent.n);
        if (!p) return;
        p.setAttribute("stroke-width", (ent.sw || 1) * fator);
      });
    });
    inp.addEventListener("change", async () => {
      const camada = inp.dataset.espessuraCamada;
      const btnResetar = inp.closest(".planta-camada-linha")?.querySelector("button[data-resetar-camada]");
      if (btnResetar) btnResetar.hidden = false;
      try {
        // FieldPath (não string com ponto) -- várias camadas do CAD têm
        // nome começando com "..." (ex: "...ALVENARIA", visto num arquivo
        // real), e usar `espessurasCamadas.${camada}` como string vira
        // "espessurasCamadas....ALVENARIA", que o Firestore rejeita (ponto
        // dentro do nome do campo é interpretado como separador de
        // caminho). Com FieldPath, o nome da camada vai inteiro num só
        // segmento, ponto ou não.
        await updateDoc(doc(db, "plantas", planta.id), new FieldPath("espessurasCamadas", camada), Number(inp.value) || 1);
      } catch (err) {
        console.error(err);
        toast("Erro ao salvar a grossura: " + err.message);
      }
    });
  });
  painelCamadas.querySelectorAll("input[data-cor-camada]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const camada = inp.dataset.corCamada;
      const cor = inp.value;
      // Aplica na hora, sem esperar salvar -- respeita se cada entity
      // tinha stroke, fill, ou os dois (não inventa um fill onde não
      // tinha, por exemplo).
      (dados.entities || []).forEach((ent) => {
        if (ent.layer !== camada || ent.n == null) return;
        const p = pathPorNumero.get(ent.n);
        if (!p) return;
        if (ent.stroke) p.setAttribute("stroke", cor);
        if (ent.fill) p.setAttribute("fill", cor);
      });
    });
    inp.addEventListener("change", async () => {
      const camada = inp.dataset.corCamada;
      const btnResetar = inp.closest(".planta-camada-linha")?.querySelector("button[data-resetar-camada]");
      if (btnResetar) btnResetar.hidden = false;
      try {
        // FieldPath, mesmo motivo do espessurasCamadas acima (camada com
        // ponto no nome quebraria uma string "coresCamadas.NOME").
        await updateDoc(doc(db, "plantas", planta.id), new FieldPath("coresCamadas", camada), inp.value);
      } catch (err) {
        console.error(err);
        toast("Erro ao salvar a cor: " + err.message);
      }
    });
  });
}

// Converte um clique do mouse (coordenadas de tela) pra coordenada do
// espaço interno do SVG -- não dá pra usar só % da caixa na tela porque o
// viewBox pode manter proporção com barras (letterbox); isso aqui acerta
// mesmo quando isso acontece.
function svgPontoDeClique(svg, evento) {
  const pt = svg.createSVGPoint();
  pt.x = evento.clientX;
  pt.y = evento.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x, y: local.y };
}

// Bounding box (no espaço "cru", pré-transformação) que envolve todos os
// elementos passados -- usado pra desenhar um destaque em volta do símbolo
// real inteiro, não só de uma peça dele.
function bboxUniao(elementos) {
  let box = null;
  elementos.forEach((el) => {
    const b = el.getBBox();
    if (!box) box = { x: b.x, y: b.y, x2: b.x + b.width, y2: b.y + b.height };
    else {
      box.x = Math.min(box.x, b.x);
      box.y = Math.min(box.y, b.y);
      box.x2 = Math.max(box.x2, b.x + b.width);
      box.y2 = Math.max(box.y2, b.y + b.height);
    }
  });
  return { x: box.x, y: box.y, width: box.x2 - box.x, height: box.y2 - box.y };
}

// Mesmo critério do filtroStatus da tela de Equipamentos: "Atrasado" é
// calculado (estaAtrasado), não é um valor que fica salvo em
// statusPreventiva, então precisa de uma checagem à parte.
function itemBateFiltroStatusPlanta(item) {
  const filtro = ESTADO.plantaFiltroStatus;
  if (!filtro) return true;
  if (filtro === "Atrasado") return estaAtrasado(item);
  return item.statusPreventiva === filtro;
}

async function renderMarcadoresPlanta() {
  const svg = $("#plantaSvg");
  const gMarcadores = $("#plantaMarcadoresSvg");
  const gDestaques = $("#plantaDestaquesSvg");
  if (!svg || !gMarcadores || !gDestaques) return;
  const planta = plantaPorId(ESTADO.plantaSelecionada);
  if (!planta) return;
  const nsSvg = "http://www.w3.org/2000/svg";
  gMarcadores.innerHTML = "";
  gDestaques.innerHTML = "";

  const raioMarcador = (() => {
    const [xmin, , xmax] = (_dadosPlantaCache.get(planta.id) || {}).bbox || [0, 0, 100];
    return (xmax - xmin) / 110 || 1;
  })();

  const dados = _dadosPlantaCache.get(planta.id);
  // Descarta os candidatos que a Jovanna já marcou como "não é
  // equipamento" (o leitor automático às vezes erra) -- ver
  // descartarCandidato/chaveCandidato.
  const ignorados = new Set(planta.candidatosIgnorados || []);
  // Aprende com os descartes: cada vez que ela descarta um candidato,
  // guarda o "tamanho" dele (qtdPontos) em planta.limiarQtdPontos se for
  // maior que o que já tinha -- daí candidatos parecidos (do mesmo
  // tamanho pra baixo) nem aparecem mais como "detectado, não
  // identificado" pra ela ter que descartar um por um. Limitado a 9
  // (ver descartarCandidato) porque em todo arquivo real já visto,
  // equipamento de verdade nunca teve menos que 10.
  const limiarAprendido = planta.limiarQtdPontos || 0;
  const candidatosCamada = ((planta.camadaEquipamento && dados?.marcadoresPorCamada?.[planta.camadaEquipamento]) || [])
    .filter((c) => !ignorados.has(chaveCandidato(c)))
    .filter((c) => (c.qtdPontos ?? Infinity) > limiarAprendido);
  // Mesma distância "razoável" usada no encaixe do clique (candidatoMaisProximo)
  // -- assim uma posição salva antes desse ajuste (de um clique impreciso)
  // também volta a bater com o símbolo real, sem precisar remarcar nada.
  const TOLERANCIA = dados ? Math.max((dados.bbox[2] - dados.bbox[0]) / 30, 1) : 30;
  const candidatoPerto = (x, y) => {
    let melhor = null, melhorDist = Infinity;
    candidatosCamada.forEach((c) => {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < melhorDist) { melhorDist = d; melhor = c; }
    });
    return melhor && melhorDist <= TOLERANCIA ? melhor : null;
  };

  // Marca o aparelho destacando o PRÓPRIO símbolo desenhado no CAD
  // (recolorindo as formas reais dele conforme o status) quando a posição
  // bate com um símbolo detectado automaticamente -- é o que faz o
  // "quadrado rosa" da planta virar visualmente o marcador, em vez de um
  // ícone genérico por cima. Só cai no ícone quando não há um símbolo
  // real ali (ex: condensadora marcada à mão numa área sem esse desenho).
  function marcarAparelho(x, y, tipo, cor, rotulo, aoClicar, aoMoverPara, tamanhoCustom, aoRedimensionarPara) {
    // Só procura um símbolo real por perto quando ELA NUNCA customizou
    // esse marcador (nem redimensionou, nem girou) -- assim que ela
    // mexe na alcinha de tamanho ou de girar, o valor salvo (largura +
    // altura, sempre os dois juntos -- ver "salvar" mais abaixo) vira a
    // fonte da verdade, e não deve mais ser trocado por um candidato
    // próximo. Sem essa checagem, um marcador colocado (de propósito) em
    // cima do símbolo de verdade -- o caso mais comum, já que é onde o
    // equipamento realmente está desenhado -- perdia o tamanho/ângulo
    // customizado toda vez que a planta recarregava (a posição salva
    // continuava batendo com o candidato, então voltava a cair no
    // destaque em volta do desenho original, sem o giro/tamanho dela).
    // Bug real, relatado como "não fica onde eu coloquei" -- só
    // aparecia depois de recarregar, nunca durante o próprio arrasto,
    // porque dentro da mesma sessão o retângulo já criado é só movido/
    // girado no lugar (marcarAparelho não é chamado de novo).
    const cand = tamanhoCustom ? null : candidatoPerto(x, y);
    const elementos = cand?.nums?.map((n) => svg.__pathPorNumero.get(n)).filter(Boolean) || [];
    if (elementos.length) {
      elementos.forEach((p) => {
        if (p.dataset.strokeOriginal) p.setAttribute("stroke", cor);
        if (p.dataset.fillOriginal) p.setAttribute("fill", cor);
      });
      const bbox = bboxUniao(elementos);
      const pad = Math.max(bbox.width, bbox.height, 1) * 0.2;
      const centroBboxX = bbox.x + bbox.width / 2, centroBboxY = bbox.y + bbox.height / 2;

      // Símbolo de verdade desenhado no CAD pode ser bem pequeno (alguns
      // equipamentos são só um retângulo miúdo) -- o contorno colado nele
      // vira um alvo de clique/toque minúsculo e difícil de acertar
      // ("a peça está pouco sensível"). Em vez de aumentar o contorno
      // visível (mudaria o desenho, e ela já pediu pra não mexer nisso),
      // um retângulo invisível por baixo, com uma área mínima confortável,
      // recebe o clique sem alterar a aparência do destaque.
      const ladoMinimo = raioMarcador * 1.6;
      const larguraClique = Math.max(bbox.width + pad * 2, ladoMinimo);
      const alturaClique = Math.max(bbox.height + pad * 2, ladoMinimo);
      const areaClique = document.createElementNS(nsSvg, "rect");
      areaClique.setAttribute("x", centroBboxX - larguraClique / 2);
      areaClique.setAttribute("y", centroBboxY - alturaClique / 2);
      areaClique.setAttribute("width", larguraClique);
      areaClique.setAttribute("height", alturaClique);
      areaClique.setAttribute("fill", "transparent");
      areaClique.style.cursor = "pointer";
      areaClique.addEventListener("click", (ev) => { ev.stopPropagation(); aoClicar(); });
      gDestaques.appendChild(areaClique);

      const retangulo = document.createElementNS(nsSvg, "rect");
      retangulo.setAttribute("x", bbox.x - pad);
      retangulo.setAttribute("y", bbox.y - pad);
      retangulo.setAttribute("width", bbox.width + pad * 2);
      retangulo.setAttribute("height", bbox.height + pad * 2);
      retangulo.setAttribute("rx", pad * 0.6);
      retangulo.setAttribute("fill", "transparent");
      retangulo.setAttribute("stroke", cor);
      retangulo.setAttribute("stroke-width", pad * 0.35);
      retangulo.dataset.destaque = "1";
      retangulo.style.cursor = "pointer";
      const titulo = document.createElementNS(nsSvg, "title");
      titulo.textContent = rotulo;
      retangulo.appendChild(titulo);
      retangulo.addEventListener("click", (ev) => { ev.stopPropagation(); aoClicar(); });
      gDestaques.appendChild(retangulo);
      return;
    }

    // Clique abre o painel; arrastar (só no modo de edição) reposiciona
    // -- mesma lógica pros dois casos abaixo (contorno de área dividida
    // e ícone genérico), por isso virou uma função à parte. O "click"
    // nativo do navegador dispara no pointerup mesmo depois de um
    // arrasto grande (não existe limite de movimento embutido nele --
    // por isso a flag "arrastou"), senão todo arrasto pra reposicionar
    // também abriria o painel do aparelho logo em seguida.
    function tornarInterativo(elemento, moverPreview) {
      elemento.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (elemento.dataset.arrastou === "1") { elemento.dataset.arrastou = "0"; return; }
        aoClicar();
      });
      if (!aoMoverPara || !marcacaoEstaAtiva()) return;
      elemento.style.cursor = "grab";
      let arrastando = false, moveu = 0, ultimoX = 0, ultimoY = 0;
      elemento.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        elemento.setPointerCapture(ev.pointerId);
        arrastando = true; moveu = 0;
        ultimoX = ev.clientX; ultimoY = ev.clientY;
      });
      elemento.addEventListener("pointermove", (ev) => {
        if (!arrastando) return;
        moveu += Math.abs(ev.clientX - ultimoX) + Math.abs(ev.clientY - ultimoY);
        ultimoX = ev.clientX; ultimoY = ev.clientY;
        if (moveu > 5) {
          const { x: nx, y: ny } = svgPontoDeClique(svg, ev);
          moverPreview(elemento, nx, ny);
        }
      });
      elemento.addEventListener("pointerup", (ev) => {
        if (!arrastando) return;
        arrastando = false;
        if (moveu > 5) {
          elemento.dataset.arrastou = "1";
          // Sem encaixe no candidato mais próximo aqui -- diferente de
          // marcar um aparelho pela primeira vez (onde faz sentido
          // "colar" no símbolo detectado), isso aqui é REPOSICIONAR um
          // aparelho que já está marcado: a pessoa está corrigindo de
          // propósito, e o raio de encaixe (~1/30 da largura da planta)
          // é maior que a distância real entre aparelhos vizinhos em
          // várias plantas -- Jovanna reportou que a máquina "voltava
          // pro lugar anterior" sozinha, porque o encaixe puxava de
          // volta pro candidato de onde ela tinha acabado de tirar. Vai
          // exatamente onde ela soltou.
          const { x: nx, y: ny } = svgPontoDeClique(svg, ev);
          aoMoverPara(Math.round(nx * 100) / 100, Math.round(ny * 100) / 100);
        }
      });
      elemento.addEventListener("pointercancel", () => { arrastando = false; });
    }

    // Marcador único pra tudo que não recolore o desenho original (tanto
    // "marcado à mão" -- arrastando o chip, sem símbolo detectado ali --
    // quanto candidato vindo de um Path dividido em vários aparelhos, ver
    // dwfParser.js): mesmo contorno, mesmo jeito de arrastar/redimensionar/
    // girar. Antes eram dois desenhos diferentes (a Jovanna pediu pra
    // ficarem iguais) e só o "marcado à mão" tinha as alcinhas de ajustar
    // tamanho -- o dividido vinha travado do tamanho calculado (a área dos
    // fragmentos detectados), sem jeito de encolher se esticasse além do
    // aparelho de verdade. Quando existe cand.bboxLocal, ele só define o
    // tamanho INICIAL (antes de qualquer ajuste); depois que ela mexe na
    // alcinha, tamanhoCustom (plantaLargura/Altura/Angulo) vira a fonte da
    // verdade, igual já acontecia pro marcado à mão.
    // x/y (e o que svgPontoDeClique devolve) já são espaço TRANSFORMADO
    // (mesmo espaço do viewBox) -- por isso vai em gMarcadores (fora do
    // gRaiz), não gDestaques (senão a matriz seria aplicada de novo e o
    // retângulo apareceria bem longe de onde a pessoa realmente marcou --
    // era esse o bug real por trás de "sempre vai pro canto").
    {
      const tamanhoPadrao = cand?.bboxLocal
        ? (() => {
            const pad = Math.max(cand.bboxLocal.largura, cand.bboxLocal.altura, 1) * 0.2;
            // Área fundida/detectada pode sair bem pequena -- sem um piso
            // mínimo, o marcador nascia com um alvo de clique/arrasto
            // minúsculo ("peça pouco sensível"). É só o tamanho INICIAL
            // (ver comentário acima); ela ainda pode encolher pela alcinha
            // se quiser um contorno mais justo.
            const ladoMinimo = raioMarcador * 1.6;
            return {
              largura: Math.max(cand.bboxLocal.largura + pad * 2, ladoMinimo),
              altura: Math.max(cand.bboxLocal.altura + pad * 2, ladoMinimo),
              angulo: 0,
            };
          })()
        : { largura: raioMarcador * 2.6, altura: raioMarcador * 1.3, angulo: 0 };
      let { largura, altura, angulo } = { ...tamanhoPadrao, ...(tamanhoCustom || {}) };
      let centroX = x, centroY = y;
      const retanguloMarcador = document.createElementNS(nsSvg, "rect");
      function atualizarRetanguloMarcador() {
        retanguloMarcador.setAttribute("x", centroX - largura / 2);
        retanguloMarcador.setAttribute("y", centroY - altura / 2);
        retanguloMarcador.setAttribute("width", largura);
        retanguloMarcador.setAttribute("height", altura);
        retanguloMarcador.setAttribute("rx", Math.min(largura, altura) * 0.15);
        retanguloMarcador.setAttribute("stroke-width", Math.min(largura, altura) * 0.12);
      }
      // Girar não muda x/y/width/height de cada peça -- só o transform
      // "rotate" delas em volta do mesmo centro (pra ficar reto pra
      // paredes/salas desenhadas inclinadas na planta). As 3 peças
      // (retângulo + as duas alcinhas) precisam girar juntas.
      const elementosRotacionados = [retanguloMarcador];
      function atualizarRotacaoTodos() {
        if (angulo) {
          const t = `rotate(${angulo},${centroX},${centroY})`;
          elementosRotacionados.forEach((el) => el.setAttribute("transform", t));
        } else {
          elementosRotacionados.forEach((el) => el.removeAttribute("transform"));
        }
      }
      retanguloMarcador.setAttribute("fill", "transparent");
      retanguloMarcador.setAttribute("stroke", cor);
      retanguloMarcador.dataset.destaque = "1";
      retanguloMarcador.style.cursor = "pointer";
      atualizarRetanguloMarcador();
      atualizarRotacaoTodos();
      const tituloMarcador = document.createElementNS(nsSvg, "title");
      tituloMarcador.textContent = rotulo;
      retanguloMarcador.appendChild(tituloMarcador);
      // As alcinhas (definidas mais abaixo) precisam acompanhar o
      // retângulo enquanto ele é arrastado pra reposicionar -- senão
      // ficam pra trás, soltas no lugar antigo, até o próximo re-render.
      // Essa referência muda de "não faz nada" pra "reposiciona de
      // verdade" assim que elas existem (só existem no modo de edição).
      let posicionarAlcasSeExistir = () => {};
      tornarInterativo(retanguloMarcador, (el, nx, ny) => {
        centroX = nx; centroY = ny;
        atualizarRetanguloMarcador();
        atualizarRotacaoTodos();
        posicionarAlcasSeExistir();
      });
      gMarcadores.appendChild(retanguloMarcador);

      // Alcinhas de ajustar, só no modo de edição -- uma pra redimensionar
      // (canto inferior direito) e outra pra girar (círculo acima do
      // topo). Salva os três valores juntos, de uma vez só, ao soltar
      // qualquer uma delas -- evita salvar um valor sem o outro.
      if (aoRedimensionarPara && marcacaoEstaAtiva()) {
        const salvar = () => aoRedimensionarPara(Math.round(largura * 100) / 100, Math.round(altura * 100) / 100, Math.round(angulo));

        const alca = document.createElementNS(nsSvg, "rect");
        const tamanhoAlca = Math.max(Math.min(largura, altura) * 0.35, raioMarcador * 0.4);
        function posicionarAlca() {
          alca.setAttribute("x", centroX + largura / 2 - tamanhoAlca / 2);
          alca.setAttribute("y", centroY + altura / 2 - tamanhoAlca / 2);
          alca.setAttribute("width", tamanhoAlca);
          alca.setAttribute("height", tamanhoAlca);
        }
        alca.setAttribute("fill", cor);
        alca.setAttribute("stroke", "#fff");
        alca.setAttribute("stroke-width", tamanhoAlca * 0.15);
        alca.style.cursor = "nwse-resize";
        posicionarAlca();
        elementosRotacionados.push(alca);
        atualizarRotacaoTodos();

        const alcaGirar = document.createElementNS(nsSvg, "circle");
        const distGirar = Math.max(largura, altura) * 0.15 + raioMarcador * 0.5;
        function posicionarAlcaGirar() {
          alcaGirar.setAttribute("cx", centroX);
          alcaGirar.setAttribute("cy", centroY - altura / 2 - distGirar);
          alcaGirar.setAttribute("r", tamanhoAlca * 0.5);
        }
        alcaGirar.setAttribute("fill", cor);
        alcaGirar.setAttribute("stroke", "#fff");
        alcaGirar.setAttribute("stroke-width", tamanhoAlca * 0.15);
        alcaGirar.style.cursor = "grab";
        posicionarAlcaGirar();
        elementosRotacionados.push(alcaGirar);
        atualizarRotacaoTodos();

        posicionarAlcasSeExistir = () => { posicionarAlca(); posicionarAlcaGirar(); atualizarRotacaoTodos(); };

        alca.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          alca.setPointerCapture(ev.pointerId);
          const inicioLargura = largura, inicioAltura = altura;
          const pInicial = svgPontoDeClique(svg, ev);
          function aoMoverAlca(ev2) {
            const pAtual = svgPontoDeClique(svg, ev2);
            const dx = pAtual.x - pInicial.x, dy = pAtual.y - pInicial.y;
            // Desfaz o giro atual no movimento do mouse -- senão, com o
            // retângulo girado, arrastar "pra baixo-direita" na tela não
            // bateria com o canto de verdade dele (que também girou).
            const rad = (-angulo * Math.PI) / 180;
            const dxLocal = dx * Math.cos(rad) - dy * Math.sin(rad);
            const dyLocal = dx * Math.sin(rad) + dy * Math.cos(rad);
            largura = Math.max(inicioLargura + dxLocal * 2, raioMarcador * 0.5);
            altura = Math.max(inicioAltura + dyLocal * 2, raioMarcador * 0.5);
            atualizarRetanguloMarcador();
            posicionarAlca();
            posicionarAlcaGirar();
          }
          function aoSoltarAlca() {
            alca.removeEventListener("pointermove", aoMoverAlca);
            alca.removeEventListener("pointerup", aoSoltarAlca);
            salvar();
          }
          alca.addEventListener("pointermove", aoMoverAlca);
          alca.addEventListener("pointerup", aoSoltarAlca, { once: true });
        });
        gMarcadores.appendChild(alca);

        alcaGirar.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          alcaGirar.setPointerCapture(ev.pointerId);
          alcaGirar.style.cursor = "grabbing";
          // Calcular um ângulo ABSOLUTO do zero a cada quadro (como fazia
          // antes) tem uma descontinuidade: Math.atan2 pula de +180° pra
          // -180° bem na direção "esquerda do centro" -- exatamente uma
          // das 4 direções (reta) que alguém tentaria arrastar pra deixar
          // o retângulo "certinho". Nesse ponto, um tremor mínimo do
          // mouse fazia o ângulo saltar quase 360° de uma vez, dando a
          // impressão de "não importa o que eu faça, sempre volta torta"
          // (bug real, relatado). Em vez disso, acompanha só a VARIAÇÃO
          // do ângulo do mouse desde que começou a arrastar, "desembrulhando"
          // qualquer salto de mais de 180° entre um quadro e o outro --
          // assim não existe mais direção nenhuma onde o giro trava.
          const anguloInicial = angulo;
          const pInicial = svgPontoDeClique(svg, ev);
          const anguloMouseInicial = (Math.atan2(pInicial.y - centroY, pInicial.x - centroX) * 180) / Math.PI;
          let anguloMouseAnterior = anguloMouseInicial;
          let voltas = 0;
          function aoMoverGirar(ev2) {
            const pAtual = svgPontoDeClique(svg, ev2);
            const anguloMouseAtual = (Math.atan2(pAtual.y - centroY, pAtual.x - centroX) * 180) / Math.PI;
            const diferenca = anguloMouseAtual - anguloMouseAnterior;
            if (diferenca > 180) voltas -= 1;
            else if (diferenca < -180) voltas += 1;
            anguloMouseAnterior = anguloMouseAtual;
            const anguloMouseContinuo = anguloMouseAtual + voltas * 360;
            angulo = Math.round(anguloInicial + (anguloMouseContinuo - anguloMouseInicial));
            atualizarRotacaoTodos();
          }
          function aoSoltarGirar() {
            alcaGirar.removeEventListener("pointermove", aoMoverGirar);
            alcaGirar.removeEventListener("pointerup", aoSoltarGirar);
            alcaGirar.style.cursor = "grab";
            salvar();
          }
          alcaGirar.addEventListener("pointermove", aoMoverGirar);
          alcaGirar.addEventListener("pointerup", aoSoltarGirar, { once: true });
        });
        gMarcadores.appendChild(alcaGirar);
      }
    }
  }

  // Evaporadoras já identificadas nesta planta -- coloridas pelo status,
  // igual ao resto do sistema. O filtro de status (mesmo critério do
  // filtroStatus da tela de Equipamentos: "Atrasado" é calculado, não é
  // um valor salvo em statusPreventiva) só esconde marcador da planta,
  // não mexe em nada do cadastro.
  const itens = ESTADO.equipamentos.filter(
    (e) => e.plantaId === planta.id && e.plantaX != null && e.plantaY != null && itemBateFiltroStatusPlanta(e)
  );
  itens.forEach((e) => {
    const classe = estaAtrasado(e) ? "atrasado" : classeStatus(e.statusPreventiva);
    const rotulo = e.codigoPlanta || e.patrimonio || e.ambiente || "";
    const tamanhoEvap = (e.plantaLargura && e.plantaAltura) ? { largura: e.plantaLargura, altura: e.plantaAltura, angulo: e.plantaAngulo || 0 } : null;
    marcarAparelho(e.plantaX, e.plantaY, "evaporadora", CORES_STATUS_MARCADOR[classe] || "#888", rotulo, () => mostrarPainelPlanta(e), (nx, ny) => reposicionarEvaporadora(e, nx, ny), tamanhoEvap, (nl, na, ang) => redimensionarEvaporadora(e, nl, na, ang));
  });

  // Condensadoras marcadas nesta planta (pelo código, não por aparelho --
  // ver condensadoraDoEquipamento/evaporadorasQueApontamPara). A cor
  // reflete o status mais urgente entre as evaporadoras que apontam pra
  // ela (uma condensadora de VRF pode atender várias); sem nenhuma
  // evaporadora vinculada ainda, fica num tom neutro.
  const ORDEM_URGENCIA = ["atrasado", "pendente", "andamento", "concluido"];
  const condensadorasAqui = planta.condensadoras || [];
  const condensadorasComPosicao = ESTADO.equipamentos
    .filter((e) => e.condensadoraPlantaId === planta.id && e.condensadoraX != null && e.condensadoraY != null && !extrairCodigoCondensadora(e.codigoPlanta))
    .map((e) => ({ codigo: null, x: e.condensadoraX, y: e.condensadoraY, __legado: e }));
  [...condensadorasAqui, ...condensadorasComPosicao].forEach((condBruta) => {
    // condBruta não carrega plantaId (nem o objeto {codigo,x,y} salvo em
    // planta.condensadoras, nem o legado) -- sem isso, "Remover marcação"
    // chamava doc(db, "plantas", undefined) e quebrava.
    const cond = { ...condBruta, plantaId: planta.id };
    const vinculadas = cond.codigo ? evaporadorasQueApontamPara(cond.codigo) : (cond.__legado ? [cond.__legado] : []);
    // Com filtro de status ativo, só mostra a condensadora se pelo menos
    // uma evaporadora vinculada bater com o filtro -- senão ela ficaria
    // sozinha na tela sem nenhum aparelho que interessa ligado a ela.
    if (ESTADO.plantaFiltroStatus && !vinculadas.some(itemBateFiltroStatusPlanta)) return;
    let classe = null;
    ORDEM_URGENCIA.forEach((c) => {
      if (classe) return;
      if (vinculadas.some((e) => (estaAtrasado(e) ? "atrasado" : classeStatus(e.statusPreventiva)) === c)) classe = c;
    });
    const cor = classe ? (CORES_STATUS_MARCADOR[classe] || "#888") : "#8B98A6";
    const rotulo = "Condensadora " + (cond.codigo || "") + (vinculadas.length ? ` — ${vinculadas.length} aparelho(s)` : " — sem evaporadora vinculada ainda");
    const tamanhoCond = (cond.largura && cond.altura) ? { largura: cond.largura, altura: cond.altura, angulo: cond.angulo || 0 } : null;
    marcarAparelho(cond.x, cond.y, "condensadora", cor, rotulo, () => mostrarPainelCondensadora(cond), cond.codigo ? (nx, ny) => reposicionarCondensadora(planta, cond.codigo, nx, ny) : null, tamanhoCond, cond.codigo ? (nl, na, ang) => redimensionarCondensadora(planta, cond.codigo, nl, na, ang) : null);
  });

  // Modo admin: mostra também os candidatos detectados automaticamente no
  // arquivo que ainda não foram identificados -- contorno tracejado em
  // volta do próprio símbolo (ou um círculo solto, se por algum motivo a
  // geometria dele não puder ser recuperada); clicar marca de uma vez.
  if (ESTADO.permissao === "admin" && planta.camadaEquipamento) {
    // Mesmo critério "mais próximo dentro da tolerância" usado acima --
    // pra não sobrar um candidato tracejado por cima de um símbolo que já
    // foi destacado como identificado (podia acontecer se a posição
    // salva não fosse EXATAMENTE igual à do candidato).
    const ocupados = new Set(
      [...itens.map((e) => [e.plantaX, e.plantaY]), ...condensadorasAqui.map((c) => [c.x, c.y]), ...condensadorasComPosicao.map((c) => [c.x, c.y])]
        .map(([x, y]) => candidatoPerto(x, y))
        .filter(Boolean)
    );
    candidatosCamada.forEach((cand) => {
      if (ocupados.has(cand)) return;
      const elementos = (cand.nums || []).map((n) => svg.__pathPorNumero.get(n)).filter(Boolean);
      if (elementos.length) {
        const bbox = bboxUniao(elementos);
        const pad = Math.max(bbox.width, bbox.height, 1) * 0.2;
        const retangulo = document.createElementNS(nsSvg, "rect");
        retangulo.setAttribute("x", bbox.x - pad);
        retangulo.setAttribute("y", bbox.y - pad);
        retangulo.setAttribute("width", bbox.width + pad * 2);
        retangulo.setAttribute("height", bbox.height + pad * 2);
        retangulo.setAttribute("rx", pad * 0.6);
        retangulo.setAttribute("fill", "transparent");
        retangulo.setAttribute("stroke", "#8B98A6");
        retangulo.setAttribute("stroke-dasharray", `${pad * 0.6},${pad * 0.6}`);
        retangulo.setAttribute("stroke-width", pad * 0.3);
        retangulo.dataset.destaque = "1";
        retangulo.style.cursor = marcacaoEstaAtiva() ? "pointer" : "default";
        if (candidatoSelecionadoParaConfirmar?.chave === chaveCandidato(cand)) retangulo.classList.add("planta-candidato-selecionado");
        retangulo.addEventListener("click", (ev) => {
          ev.stopPropagation();
          aoClicarCandidatoNaoIdentificado(planta, cand, retangulo);
        });
        gDestaques.appendChild(retangulo);
      } else if (cand.bboxLocal) {
        // Mesmo caso do marcador já confirmado (ver marcarAparelho): um
        // candidato fundido por proximidade ou vindo de um bloco dividido
        // não tem "nums" (não existe um desenho original só dele pra
        // destacar), mas tem a ÁREA calculada -- desenha o contorno dessa
        // área em vez de cair num círculo genérico sem relação nenhuma
        // com o tamanho/posição real do que foi detectado.
        const { x: bx, y: by, largura, altura } = cand.bboxLocal;
        const pad = Math.max(largura, altura, 1) * 0.2;
        const retangulo = document.createElementNS(nsSvg, "rect");
        retangulo.setAttribute("x", bx - pad);
        retangulo.setAttribute("y", by - pad);
        retangulo.setAttribute("width", largura + pad * 2);
        retangulo.setAttribute("height", altura + pad * 2);
        retangulo.setAttribute("rx", pad * 0.6);
        retangulo.setAttribute("fill", "transparent");
        retangulo.setAttribute("stroke", "#8B98A6");
        retangulo.setAttribute("stroke-dasharray", `${pad * 0.6},${pad * 0.6}`);
        retangulo.setAttribute("stroke-width", pad * 0.3);
        retangulo.dataset.destaque = "1";
        retangulo.style.cursor = marcacaoEstaAtiva() ? "pointer" : "default";
        if (candidatoSelecionadoParaConfirmar?.chave === chaveCandidato(cand)) retangulo.classList.add("planta-candidato-selecionado");
        retangulo.addEventListener("click", (ev) => {
          ev.stopPropagation();
          aoClicarCandidatoNaoIdentificado(planta, cand, retangulo);
        });
        // bboxLocal já vem em espaço TRANSFORMADO -- por isso gMarcadores
        // (fora do gRaiz), não gDestaques (mesmo motivo do marcarAparelho).
        gMarcadores.appendChild(retangulo);
      } else {
        const c = document.createElementNS(nsSvg, "circle");
        c.setAttribute("cx", cand.x);
        c.setAttribute("cy", cand.y);
        c.setAttribute("r", raioMarcador);
        // fill "transparent" (não "none"!) -- com "none" o SVG não conta o
        // miolo do círculo como clicável, só a borda tracejada (bem fina),
        // o que tornaria a maior parte da área do marcador "morta" pra clique.
        c.setAttribute("fill", "transparent");
        c.setAttribute("stroke", "#8B98A6");
        c.setAttribute("stroke-dasharray", `${raioMarcador / 4},${raioMarcador / 4}`);
        c.setAttribute("stroke-width", raioMarcador / 5);
        c.style.cursor = marcacaoEstaAtiva() ? "pointer" : "default";
        if (candidatoSelecionadoParaConfirmar?.chave === chaveCandidato(cand)) c.classList.add("planta-candidato-selecionado");
        c.addEventListener("click", (ev) => {
          ev.stopPropagation();
          aoClicarCandidatoNaoIdentificado(planta, cand, c);
        });
        gMarcadores.appendChild(c);
      }
    });
  }
}

// Fica escondido por padrão -- só aparece quando um marcador de
// verdade é clicado, não com uma mensagem fixa tipo "selecione um
// marcador" (a Jovanna não queria nada aparecendo o tempo todo ali).
function limparPainelPlanta() {
  const painel = $("#plantaPainel");
  if (!painel) return;
  painel.innerHTML = "";
  painel.hidden = true;
}

function mostrarPainelPlanta(item) {
  const painel = $("#plantaPainel");
  if (!painel) return;
  painel.hidden = false;
  const condensadora = condensadoraDoEquipamento(item);
  const isAdmin = ESTADO.permissao === "admin";
  painel.innerHTML = `
    <h3 style="margin-top:0">${escapeHtml(item.codigoPlanta || item.patrimonio || item.ambiente || "Aparelho")}</h3>
    ${item.fotoUrl
      ? `<a href="${escapeHtml(item.fotoUrl)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(item.fotoUrl)}" alt="Foto do equipamento" title="Foto do equipamento -- ajuda a confirmar que é o aparelho certo" style="width:100%; max-height:130px; object-fit:cover; border-radius:var(--raio-pequeno); border:1px solid var(--borda); margin-bottom:10px;">
        </a>`
      : ""}
    <div class="drawer-campo"><span class="rotulo">Patrimônio</span><span class="valor">${escapeHtml(item.patrimonio || "-")}</span></div>
    <div class="drawer-campo"><span class="rotulo">Setor</span><span class="valor">${escapeHtml(item.setor || "-")}</span></div>
    <div class="drawer-campo"><span class="rotulo">Ambiente</span><span class="valor">${escapeHtml(item.ambiente || "-")}</span></div>
    <div class="drawer-campo"><span class="rotulo">Marca / Modelo</span><span class="valor">${escapeHtml([item.marca, item.modelo].filter(Boolean).join(" / ") || "-")}</span></div>
    <div class="drawer-campo"><span class="rotulo">Capacidade</span><span class="valor">${escapeHtml(item.capacidade || "-")}</span></div>
    <div class="drawer-campo"><span class="rotulo">Tipo de gás</span><span class="valor">${escapeHtml(item.tipoGas || "-")}</span></div>
    <div class="drawer-campo"><span class="rotulo">Status</span><span class="valor">${estaAtrasado(item) ? "Atrasado" : escapeHtml(item.statusPreventiva || "-")}</span></div>
    ${condensadora ? `<button class="btn ghost" id="btnVerCondensadora" style="margin-top:10px;width:100%">📍 Ver condensadora${condensadora.codigo ? " (" + escapeHtml(condensadora.codigo) + ")" : ""}</button>` : ""}
    <button class="btn ghost" id="btnAbrirDrawerDaPlanta" style="margin-top:${condensadora ? "6" : "10"}px;width:100%">Ver ficha completa</button>
    ${isAdmin ? '<button class="btn ghost" id="btnRemoverMarcacaoEvap" style="margin-top:6px;width:100%;color:var(--vermelho);border-color:var(--vermelho)">Remover marcação nesta planta</button>' : ""}
  `;
  $("#btnAbrirDrawerDaPlanta")?.addEventListener("click", () => abrirDrawerEquipamento(item.id));
  $("#btnVerCondensadora")?.addEventListener("click", () => irParaMarcador(condensadora.plantaId, condensadora.x, condensadora.y, () => mostrarPainelCondensadora(condensadora)));
  $("#btnRemoverMarcacaoEvap")?.addEventListener("click", async () => {
    if (!confirm("Remover a marcação desse aparelho nesta planta?")) return;
    try {
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), {
        // Limpa também o tamanho customizado -- senão, ao marcar esse
        // aparelho de novo (talvez num lugar bem diferente), ele herdava
        // em silêncio o tamanho antigo em vez de começar no padrão.
        plantaId: deleteField(), plantaX: deleteField(), plantaY: deleteField(),
        plantaLargura: deleteField(), plantaAltura: deleteField(), plantaAngulo: deleteField(),
      });
      toast("Marcação removida.");
      limparPainelPlanta();
    } catch (err) {
      console.error(err);
      toast("Erro ao remover: " + err.message);
    }
  });
}

// "cond" aqui é uma entrada do catálogo de condensadoras da planta
// ({codigo, x, y, plantaId}) -- não um equipamento. Uma condensadora
// pode atender mais de uma evaporadora (comum em VRF), por isso o
// painel lista todas as que apontam pra ela, não só uma.
function mostrarPainelCondensadora(cond) {
  const painel = $("#plantaPainel");
  if (!painel) return;
  painel.hidden = false;
  const isAdmin = ESTADO.permissao === "admin";
  const vinculadas = cond.codigo ? evaporadorasQueApontamPara(cond.codigo) : [];
  painel.innerHTML = `
    <h3 style="margin-top:0">Condensadora ${escapeHtml(cond.codigo || "")}</h3>
    <p class="muted" style="margin-top:-6px">${vinculadas.length ? `Atende ${vinculadas.length} evaporadora(s):` : "Nenhuma evaporadora aponta pra esse código ainda."}</p>
    ${vinculadas.map((e) => `
      <div class="drawer-campo">
        <span class="rotulo">${escapeHtml(e.codigoPlanta || e.patrimonio || e.ambiente || "-")}</span>
        <span class="valor"><a href="#" data-ver-evap="${escapeHtml(e.id)}">${escapeHtml(e.ambiente || "-")}</a></span>
      </div>
    `).join("")}
    ${isAdmin ? `<button class="btn ghost" id="btnRemoverMarcacaoCond" style="margin-top:10px;width:100%;color:var(--vermelho);border-color:var(--vermelho)">Remover marcação "${escapeHtml(cond.codigo || "")}"</button>` : ""}
  `;
  painel.querySelectorAll("[data-ver-evap]").forEach((link) => {
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      const item = ESTADO.equipamentos.find((e) => e.id === link.dataset.verEvap);
      if (item) irParaMarcador(item.plantaId, item.plantaX, item.plantaY, () => mostrarPainelPlanta(item));
    });
  });
  $("#btnRemoverMarcacaoCond")?.addEventListener("click", async () => {
    if (!confirm(`Remover a condensadora "${cond.codigo}" desta planta?`)) return;
    const plantaRef = doc(db, "plantas", cond.plantaId);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(plantaRef);
        const listaAtual = (snap.exists() && snap.data().condensadoras) || [];
        const novaLista = listaAtual.filter((c) => normalizarCodigo(c.codigo) !== normalizarCodigo(cond.codigo));
        tx.update(plantaRef, { condensadoras: novaLista });
      });
      toast("Condensadora removida.");
      limparPainelPlanta();
    } catch (err) {
      console.error(err);
      toast("Erro ao remover: " + err.message);
    }
  });
}

// Troca (se preciso) pra planta onde um marcador está, centraliza a
// visão nele, pisca um destaque em volta pra deixar bem claro qual é (é
// fácil se perder entre vários símbolos parecidos) e mostra o painel
// certo -- usado pelos botões "Ver condensadora"/"Ver evaporadora" pra
// pular de um pro outro mesmo quando estão em plantas diferentes (ex:
// evaporadora no andar, condensadora na cobertura).
async function irParaMarcador(plantaId, x, y, aoChegar) {
  if (!plantaId || x == null || y == null) {
    toast("Essa posição ainda não foi marcada.");
    return;
  }
  if (ESTADO.plantaSelecionada !== plantaId) {
    ESTADO.plantaSelecionada = plantaId;
    const svg = $("#plantaSvg");
    if (svg) svg.dataset.plantaId = "";
    await renderLocalizacao();
  }
  const svg = $("#plantaSvg");
  centralizarView(svg, x, y);
  piscarDestaque(svg, x, y);
  aoChegar();
}

// Busca por patrimônio (em TODOS os prédios/plantas, não só a aberta na
// hora) e pula direto pro marcador, do mesmo jeito que "Ver evaporadora"
// já fazia -- útil quando já se sabe o número do aparelho mas não onde
// ele está desenhado, principalmente em andares com muita coisa parecida.
async function buscarEquipamentoNaPlanta() {
  const termoBusca = $("#buscaEquipamentoPlanta")?.value.trim().toLowerCase();
  if (!termoBusca) return;
  const candidatos = ESTADO.equipamentos.filter((e) => (e.patrimonio || "").toLowerCase().includes(termoBusca));
  if (!candidatos.length) {
    toast("Nenhum equipamento encontrado com esse patrimônio.");
    return;
  }
  const item = candidatos.find((e) => (e.patrimonio || "").toLowerCase() === termoBusca) || candidatos[0];

  const temEvaporadora = item.plantaId && item.plantaX != null && item.plantaY != null;
  const temCondensadora = !temEvaporadora && item.condensadoraPlantaId && item.condensadoraX != null && item.condensadoraY != null;
  if (!temEvaporadora && !temCondensadora) {
    toast(`Aparelho "${item.patrimonio || item.ambiente}" encontrado, mas ainda não foi marcado em nenhuma planta.`);
    return;
  }

  // A busca sempre mostra o aparelho, mesmo que o filtro de status ativo
  // escondesse o marcador dele -- senão a pessoa buscava um patrimônio
  // certo e via a planta "vazia", sem entender por quê.
  const plantaAlvo = temEvaporadora ? item.plantaId : item.condensadoraPlantaId;
  if (ESTADO.plantaFiltroStatus) {
    ESTADO.plantaFiltroStatus = "";
    const sel = $("#filtroStatusPlanta");
    if (sel) sel.value = "";
    if (ESTADO.plantaSelecionada === plantaAlvo) await renderMarcadoresPlanta();
  }

  if (temEvaporadora) {
    await irParaMarcador(item.plantaId, item.plantaX, item.plantaY, () => mostrarPainelPlanta(item));
  } else {
    const cond = { codigo: null, x: item.condensadoraX, y: item.condensadoraY, plantaId: item.condensadoraPlantaId, __legado: item };
    await irParaMarcador(item.condensadoraPlantaId, item.condensadoraX, item.condensadoraY, () => mostrarPainelCondensadora(cond));
  }
  if (candidatos.length > 1) toast(`${candidatos.length} equipamentos com "${termoBusca}" -- mostrando Pat. ${item.patrimonio || item.id}.`);
}

$("#btnBuscarEquipamentoPlanta")?.addEventListener("click", buscarEquipamentoNaPlanta);
$("#buscaEquipamentoPlanta")?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") buscarEquipamentoNaPlanta();
});

$("#filtroStatusPlanta")?.addEventListener("change", (ev) => {
  ESTADO.plantaFiltroStatus = ev.target.value;
  renderMarcadoresPlanta();
});

// Anel dourado pulsando por alguns segundos na posição pedida -- só pra
// chamar atenção visual de "é esse aqui", sem mexer em nada dos dados.
function piscarDestaque(svg, x, y) {
  const gMarcadores = $("#plantaMarcadoresSvg");
  if (!svg || !gMarcadores) return;
  const [xmin, , xmax] = svg.__viewOriginal ? [svg.__viewOriginal.x, 0, svg.__viewOriginal.x + svg.__viewOriginal.w] : [0, 0, 100];
  const raio = (xmax - xmin) / 42 || 1;
  const nsSvg = "http://www.w3.org/2000/svg";
  const anel = document.createElementNS(nsSvg, "circle");
  anel.setAttribute("cx", x);
  anel.setAttribute("cy", y);
  anel.setAttribute("r", raio);
  anel.setAttribute("fill", "none");
  anel.setAttribute("stroke", "#E8A317");
  anel.setAttribute("stroke-width", raio / 2.5);
  anel.classList.add("planta-pulso-destaque");
  gMarcadores.appendChild(anel);
  setTimeout(() => anel.remove(), 3900);
}

// Acha o candidato (símbolo real detectado no CAD) mais próximo de um
// ponto, desde que esteja a uma distância razoável -- usado pra "encaixar"
// um clique aproximado no símbolo certo, em vez de exigir acertar o pixel
// exato. Sem isso, um clique alguns pixels ao lado do símbolo real salvava
// uma posição solta, que depois não batia com nenhum candidato e caía no
// ícone genérico -- exatamente o problema que a Jovanna reportou (queria
// que ficasse marcado o próprio desenho da máquina, não uma "figurinha").
function candidatoMaisProximo(planta, x, y) {
  const dados = _dadosPlantaCache.get(planta.id);
  const candidatos = (planta.camadaEquipamento && dados?.marcadoresPorCamada?.[planta.camadaEquipamento]) || [];
  if (!candidatos.length) return null;
  const distanciaMax = ((dados.bbox[2] - dados.bbox[0]) || 1000) / 30;
  let melhor = null, melhorDist = Infinity;
  candidatos.forEach((c) => {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d < melhorDist) { melhorDist = d; melhor = c; }
  });
  return melhor && melhorDist <= distanciaMax ? melhor : null;
}

// Chuta o próximo código provável pelo padrão espacial dos códigos já
// confirmados nessa planta -- ex: se os dois vizinhos confirmados mais
// próximos são "C6" e "C7" (nessa ordem, do mais perto pro mais longe),
// chuta "C8" pra continuar a mesma progressão. É só um palpite rápido
// pra economizar digitação (a Jovanna pediu); se estiver errado, corrige
// o campo antes de confirmar -- não tenta ser perfeito.
function sugerirProximoCodigo(prefixoPadrao, confirmados, x, y) {
  const comNumero = confirmados
    .map((c) => {
      if (c.x == null || c.y == null) return null;
      const m = /^([A-Za-z]*)(\d+)$/.exec(normalizarCodigo(c.codigo));
      if (!m) return null;
      return { x: c.x, y: c.y, prefixo: m[1] || prefixoPadrao, numero: parseInt(m[2], 10) };
    })
    .filter(Boolean)
    .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
  if (!comNumero.length) return "";
  const [maisProximo, segundo] = comNumero;
  if (segundo && Math.abs(maisProximo.numero - segundo.numero) === 1) {
    const direcao = maisProximo.numero > segundo.numero ? 1 : -1;
    return maisProximo.prefixo + (maisProximo.numero + direcao);
  }
  return maisProximo.prefixo + (maisProximo.numero + 1);
}

// Mesma chave usada pra deduplicar posições idênticas no leitor do CAD
// (dwfParser.js) -- reaproveitada aqui pra marcar um candidato como
// "não é equipamento" de um jeito estável, sem depender de nenhum outro
// identificador (os candidatos automáticos não têm id próprio).
function chaveCandidato(c) {
  return Math.round(c.x * 10) + "," + Math.round(c.y * 10);
}

// O leitor automático às vezes acerta uma área que não é equipamento de
// verdade (a Jovanna pediu essa saída). Guarda a chave da posição numa
// lista de "ignorados" no próprio documento da planta -- transação
// porque descartar vários rápido em sequência tem o mesmo risco de
// corrida que já resolvemos pras condensadoras.
//
// Aproveita o descarte pra "aprender": sobe planta.limiarQtdPontos até
// o tamanho (qtdPontos) desse candidato, se for maior que o que já
// tinha -- assim candidatos do mesmo tamanho pra baixo, nessa mesma
// planta, já nem aparecem mais como "detectado, não identificado" (ver
// filtro em renderMarcadoresPlanta). Travado num teto de 9: em todo
// arquivo real já testado, equipamento de verdade nunca teve menos que
// 10 "pontos" -- mesmo que ela descarte algo maior por engano, o limiar
// não sobe a ponto de esconder equipamento de verdade.
const LIMIAR_QTD_PONTOS_TETO = 9;
async function descartarCandidato(planta, cand) {
  const plantaRef = doc(db, "plantas", planta.id);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(plantaRef);
      const dadosAtuais = snap.exists() ? snap.data() : {};
      const listaAtual = dadosAtuais.candidatosIgnorados || [];
      const chave = chaveCandidato(cand);
      const atualizacao = {};
      if (!listaAtual.includes(chave)) atualizacao.candidatosIgnorados = [...listaAtual, chave];
      const limiarAtual = dadosAtuais.limiarQtdPontos || 0;
      const tamanhoCandidato = Math.min(cand.qtdPontos || 0, LIMIAR_QTD_PONTOS_TETO);
      if (tamanhoCandidato > limiarAtual) atualizacao.limiarQtdPontos = tamanhoCandidato;
      if (Object.keys(atualizacao).length === 0) return;
      tx.update(plantaRef, atualizacao);
    });
    toast("Área descartada -- não vai mais aparecer como candidato.");
  } catch (err) {
    console.error(err);
    toast("Erro ao descartar: " + err.message);
  }
}

// ------------------------------------------------------------------
// Leitura automática do código perto de um candidato -- a Jovanna pediu
// pra parar de digitar toda vez o código que já está desenhado do lado
// do símbolo (ex: o hexágono "C7" da planta). Usa OCR (Tesseract.js,
// carregado no index.html) numa imagem recortada só daquela área.
//
// ATENÇÃO: essa parte eu não consegui testar de verdade -- meu ambiente
// aqui não tem acesso à internet pra baixar o Tesseract.js e ler uma
// imagem de teste, só dá pra revisar o código com calma. Funciona sem
// travar nada se o OCR falhar ou não achar nada (só não preenche o
// código sozinho, continua tendo que digitar); mas a taxa de acerto de
// verdade só dá pra saber testando ao vivo.
// ------------------------------------------------------------------

// Recorta só uma área pequena da planta (em volta de x,y) numa imagem,
// numa resolução fixa (não depende do tamanho real do desenho) -- fica
// bem mais rápido pro OCR do que mandar a planta inteira.
function recortarPlantaParaCanvas(svg, x, y, raioRecorte) {
  return new Promise((resolve) => {
    try {
      const clone = svg.cloneNode(true);
      clone.querySelectorAll("#plantaDestaquesSvg, #plantaMarcadoresSvg").forEach((el) => el.remove());
      const TAMANHO_PX = 300;
      clone.setAttribute("viewBox", `${x - raioRecorte} ${y - raioRecorte} ${raioRecorte * 2} ${raioRecorte * 2}`);
      clone.setAttribute("width", TAMANHO_PX);
      clone.setAttribute("height", TAMANHO_PX);
      clone.removeAttribute("style");
      const serializado = new XMLSerializer().serializeToString(clone);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = TAMANHO_PX;
        canvas.height = TAMANHO_PX;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, TAMANHO_PX, TAMANHO_PX);
        ctx.drawImage(img, 0, 0, TAMANHO_PX, TAMANHO_PX);
        resolve(canvas);
      };
      img.onerror = () => resolve(null);
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(serializado);
    } catch (err) {
      console.warn("Erro ao recortar a planta pro OCR:", err);
      resolve(null);
    }
  });
}

// Worker do Tesseract.js reaproveitado entre leituras (criar um novo a
// cada clique seria bem mais lento) -- só cria na primeira vez que
// precisar.
let _tesseractWorkerPromise = null;
function _obterTesseractWorker() {
  if (typeof Tesseract === "undefined") return Promise.resolve(null);
  if (!_tesseractWorkerPromise) {
    _tesseractWorkerPromise = Tesseract.createWorker("eng")
      .then(async (worker) => {
        await worker.setParameters({ tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/" });
        return worker;
      })
      .catch((err) => { console.warn("Tesseract não iniciou:", err); return null; });
  }
  return _tesseractWorkerPromise;
}

// Tenta ler o código desenhado perto de (x,y); devolve o texto lido (só
// se parecer mesmo um código, tipo "C7" ou "E1/C7") ou null se não achar
// nada plausível -- nunca lança erro pra fora, só desiste em silêncio.
async function tentarLerCodigoPorOcr(svg, x, y) {
  try {
    const worker = await _obterTesseractWorker();
    if (!worker) return null;
    const raioMarcadorAtual = (() => {
      const [xmin, , xmax] = (_dadosPlantaCache.get(ESTADO.plantaSelecionada) || {}).bbox || [0, 0, 100];
      return (xmax - xmin) / 110 || 1;
    })();
    // Recorte bem mais generoso que o marcador em si -- o código costuma
    // ficar do lado, ligado por uma linha, não em cima do símbolo.
    const canvas = await recortarPlantaParaCanvas(svg, x, y, raioMarcadorAtual * 8);
    if (!canvas) return null;
    const { data } = await worker.recognize(canvas);
    const texto = (data?.text || "").replace(/\s+/g, "").toUpperCase();
    return /^[A-Z]?\d{1,3}(\/[A-Z]?\d{1,3})?$/.test(texto) && texto.length ? texto : null;
  } catch (err) {
    console.warn("OCR não conseguiu ler o código:", err);
    return null;
  }
}

// ------------------------------------------------------------------
// Fluxo de dois cliques pra marcar um candidato detectado automaticamente
// (a Jovanna pediu): o primeiro clique SELECIONA (sugere um código pelo
// padrão de numeração na hora, e tenta ler o de verdade por OCR em
// segundo plano -- se achar algo plausível, troca a sugestão); o segundo
// clique no MESMO candidato confirma e salva de vez. Clicar num
// candidato diferente troca a seleção. Só existe pra facilitar (não é
// obrigatório usar a sugestão -- pode digitar/corrigir o código livre
// antes de confirmar).
// ------------------------------------------------------------------
let candidatoSelecionadoParaConfirmar = null; // { chave, x, y } ou null

function aoClicarCandidatoNaoIdentificado(planta, cand, elemento) {
  if (!marcacaoEstaAtiva()) return;
  const modo = $('input[name="modoMarcacao"]:checked')?.value || "evaporadora";
  if (modo === "descartar") {
    descartarCandidato(planta, cand);
    candidatoSelecionadoParaConfirmar = null;
    return;
  }

  const chave = chaveCandidato(cand);
  if (candidatoSelecionadoParaConfirmar?.chave === chave) {
    candidatoSelecionadoParaConfirmar = null;
    salvarPosicaoPlanta(planta, cand.x, cand.y);
    return;
  }

  candidatoSelecionadoParaConfirmar = { chave, x: cand.x, y: cand.y };
  elemento?.classList.add("planta-candidato-selecionado");

  const modoCondensadora = modo === "condensadora";
  const campoCodigo = modoCondensadora ? $("#plantaCondensadoraCodigoInput") : $("#plantaCodigoInput");
  if (campoCodigo && !campoCodigo.value.trim()) {
    const prefixoPadrao = modoCondensadora ? "C" : "E";
    const confirmados = modoCondensadora
      ? (planta.condensadoras || []).map((c) => ({ x: c.x, y: c.y, codigo: c.codigo }))
      : ESTADO.equipamentos
          .filter((e) => e.plantaId === planta.id && e.plantaX != null)
          .map((e) => ({ x: e.plantaX, y: e.plantaY, codigo: e.codigoPlanta }));
    const sugestao = sugerirProximoCodigo(prefixoPadrao, confirmados, cand.x, cand.y);
    if (sugestao) {
      campoCodigo.value = sugestao;
      campoCodigo.dataset.sugeridoAutomaticamente = sugestao;
    }
  }
  toast("Clique de novo pra confirmar (ou ajuste o código antes).");

  const svg = $("#plantaSvg");
  if (campoCodigo && svg) {
    tentarLerCodigoPorOcr(svg, cand.x, cand.y).then((lido) => {
      if (!lido) return;
      if (candidatoSelecionadoParaConfirmar?.chave !== chave) return; // já mudou de candidato
      const valorAtual = campoCodigo.value.trim();
      // Só troca se o campo ainda tiver o palpite automático (ou estiver
      // vazio) -- se ela já digitou/corrigiu por conta própria, não
      // sobrescreve o que ela escreveu.
      if (valorAtual && valorAtual !== campoCodigo.dataset.sugeridoAutomaticamente) return;
      campoCodigo.value = lido;
      toast(`Li "${lido}" na planta -- confira antes de confirmar.`);
    });
  }
}

// Reposiciona um marcador já existente (arrastar, não criar) -- usa
// direto o aparelho/código que o marcador já representa, sem depender
// do que estiver selecionado no formulário (que pode ser outro
// aparelho qualquer nem relacionado ao que está sendo arrastado).
async function reposicionarEvaporadora(item, x, y) {
  try {
    await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), { plantaX: x, plantaY: y });
    toast("Posição atualizada.");
  } catch (err) {
    console.error(err);
    toast("Erro ao salvar posição: " + err.message);
  }
}

// Tamanho e ângulo do retângulo marcado à mão (arrastando as alcinhas) --
// mesma ideia da posição, só que guardando largura/altura/ângulo em vez
// de x/y. Ângulo é opcional (0 = sem giro, retângulo reto).
async function redimensionarEvaporadora(item, largura, altura, angulo) {
  try {
    await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", item.id), { plantaLargura: largura, plantaAltura: altura, plantaAngulo: angulo || 0 });
  } catch (err) {
    console.error(err);
    toast("Erro ao salvar tamanho: " + err.message);
  }
}

async function reposicionarCondensadora(planta, codigo, x, y) {
  const plantaRef = doc(db, "plantas", planta.id);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(plantaRef);
      const listaAtual = (snap.exists() && snap.data().condensadoras) || [];
      const novaLista = listaAtual.map((c) => normalizarCodigo(c.codigo) === normalizarCodigo(codigo) ? { ...c, x, y } : c);
      tx.update(plantaRef, { condensadoras: novaLista });
    });
    toast("Posição atualizada.");
  } catch (err) {
    console.error(err);
    toast("Erro ao salvar posição: " + err.message);
  }
}

async function redimensionarCondensadora(planta, codigo, largura, altura, angulo) {
  const plantaRef = doc(db, "plantas", planta.id);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(plantaRef);
      const listaAtual = (snap.exists() && snap.data().condensadoras) || [];
      const novaLista = listaAtual.map((c) => normalizarCodigo(c.codigo) === normalizarCodigo(codigo) ? { ...c, largura, altura, angulo: angulo || 0 } : c);
      tx.update(plantaRef, { condensadoras: novaLista });
    });
  } catch (err) {
    console.error(err);
    toast("Erro ao salvar tamanho: " + err.message);
  }
}

async function salvarPosicaoPlanta(planta, x, y) {
  const modoCondensadora = $('input[name="modoMarcacao"]:checked')?.value === "condensadora";

  if (modoCondensadora) {
    const codigo = $("#plantaCondensadoraCodigoInput")?.value.trim() || "";
    if (!codigo) {
      toast("Digite o código dessa condensadora (ex: C7) antes de clicar na planta.");
      return;
    }
    // Transação, não "lê o que já tenho guardado localmente e regravo" --
    // marcando várias condensadoras em sequência rápida, o snapshot local
    // (ESTADO.plantas) podia não ter voltado a tempo com a gravação
    // anterior ainda, e cada clique novo sobrescrevia o array inteiro só
    // com o que ele via na hora, apagando as marcações de antes. A
    // transação sempre lê o estado atual de verdade no servidor primeiro.
    const plantaRef = doc(db, "plantas", planta.id);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(plantaRef);
        const listaAtual = (snap.exists() && snap.data().condensadoras) || [];
        const novaLista = listaAtual.filter((c) => normalizarCodigo(c.codigo) !== normalizarCodigo(codigo));
        novaLista.push({ codigo, x, y });
        tx.update(plantaRef, { condensadoras: novaLista });
      });
      toast(`Condensadora "${codigo}" marcada.`);
    } catch (err) {
      console.error(err);
      toast("Erro ao salvar posição: " + err.message);
    }
    return;
  }

  const select = $("#plantaEquipamentoSelect");
  if (!select || !select.value) {
    toast("Escolha um aparelho na lista antes de marcar a posição.");
    return;
  }
  const id = select.value;

  // Restrição: duas evaporadoras não podem ocupar o mesmo lugar nesta
  // planta -- sem isso dava pra marcar por cima de um aparelho que já
  // estava lá, os dois "empilhados" na mesma posição sem nenhum aviso.
  const TOLERANCIA_DUPLICATA = candidatoMaisProximo(planta, x, y) ? 0.5 :
    Math.max(((_dadosPlantaCache.get(planta.id) || {}).bbox?.[2] - (_dadosPlantaCache.get(planta.id) || {}).bbox?.[0]) / 60 || 30, 1);
  const outroNoLugar = ESTADO.equipamentos.find((e) =>
    e.id !== id && e.plantaId === planta.id && e.plantaX != null &&
    Math.hypot(e.plantaX - x, e.plantaY - y) < TOLERANCIA_DUPLICATA
  );
  if (outroNoLugar) {
    toast(`Essa posição já é do aparelho "${outroNoLugar.codigoPlanta || outroNoLugar.patrimonio || outroNoLugar.ambiente}". Remova a marcação dele primeiro se quiser usar esse lugar.`);
    return;
  }

  const campos = { plantaId: planta.id, plantaX: x, plantaY: y, codigoPlanta: $("#plantaCodigoInput")?.value.trim() || "" };
  try {
    await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), campos);
    toast("Posição marcada.");
  } catch (err) {
    console.error(err);
    toast("Erro ao salvar posição: " + err.message);
  }
}

// Atualiza só o "Código na planta" do aparelho selecionado, sem precisar
// clicar de novo na planta -- resolve o caso de já estar marcado e só
// querer acrescentar/corrigir o código.
$("#btnSalvarCodigoEvap")?.addEventListener("click", async () => {
  const select = $("#plantaEquipamentoSelect");
  if (!select || !select.value) {
    toast("Escolha um aparelho na lista primeiro.");
    return;
  }
  const codigoPlanta = $("#plantaCodigoInput")?.value.trim() || "";
  try {
    await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", select.value), { codigoPlanta });
    toast("Código salvo.");
  } catch (err) {
    console.error(err);
    toast("Erro ao salvar código: " + err.message);
  }
});

$("#plantaSeletor")?.addEventListener("change", (ev) => {
  ESTADO.plantaSelecionada = ev.target.value;
  const svg = $("#plantaSvg");
  if (svg) svg.dataset.plantaId = ""; // força recarregar o desenho da nova planta
  renderLocalizacao();
});

$("#btnExcluirPlanta")?.addEventListener("click", async () => {
  const planta = plantaPorId(ESTADO.plantaSelecionada);
  if (!planta) return;
  // Excluir só a planta deixava plantaId/plantaX/plantaY (e o
  // equivalente de condensadora) apontando pra um documento que não
  // existe mais -- o aparelho continuava "parecendo marcado" (o botão
  // "Ver na planta" ainda aparecia), só que clicar nele caía em
  // renderLocalizacao(), que sozinho corrige ESTADO.plantaSelecionada
  // pra primeira planta da lista quando o id não bate com nenhuma real,
  // e usava a posição antiga (de outra planta) nessa planta errada --
  // dava a impressão de "ainda marcado" em lugar nenhum de verdade.
  // Agora limpa a marcação de todo mundo afetado junto com a planta,
  // numa escrita só.
  const afetados = ESTADO.equipamentos.filter(
    (e) => e.plantaId === planta.id || e.condensadoraPlantaId === planta.id
  );
  const aviso = afetados.length
    ? ` ${afetados.length} aparelho(s) marcado(s) nela vão ficar sem posição (o cadastro deles não é afetado, só a marcação some).`
    : "";
  if (!confirm(`Excluir a planta "${planta.nome}"?${aviso}`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, "plantas", planta.id));
    afetados.forEach((e) => {
      const campos = {};
      if (e.plantaId === planta.id) {
        campos.plantaId = deleteField(); campos.plantaX = deleteField(); campos.plantaY = deleteField();
        campos.plantaLargura = deleteField(); campos.plantaAltura = deleteField(); campos.plantaAngulo = deleteField();
      }
      if (e.condensadoraPlantaId === planta.id) {
        campos.condensadoraPlantaId = deleteField(); campos.condensadoraX = deleteField(); campos.condensadoraY = deleteField();
      }
      batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", e.id), campos);
    });
    await batch.commit();
    ESTADO.plantaSelecionada = null;
    toast("Planta excluída.");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir planta: " + err.message);
  }
});

$("#btnPlantaZoomIn")?.addEventListener("click", () => $("#plantaSvg")?.__zoomIn?.());
$("#btnPlantaZoomOut")?.addEventListener("click", () => $("#plantaSvg")?.__zoomOut?.());
$("#btnPlantaZoomReset")?.addEventListener("click", () => $("#plantaSvg")?.__zoomReset?.());

$all('input[name="modoMarcacao"]').forEach((radio) => {
  radio.addEventListener("change", () => renderLocalizacao());
});

$("#plantaSvg")?.addEventListener("click", (ev) => {
  const svg = $("#plantaSvg");
  if (svg?.dataset.arrastou === "1") { svg.dataset.arrastou = "0"; return; } // era pan, não clique
  if (ESTADO.permissao !== "admin") return;
  if (!marcacaoEstaAtiva()) return; // toggle desligado -- só navegar, sem risco de marcar
  if (ev.target.closest("circle, g[data-id], g[data-condensadora-de], [data-destaque]")) return; // marcador já tem seu próprio handler
  if ($('input[name="modoMarcacao"]:checked')?.value === "descartar") return; // descartar só clicando numa área tracejada, não cria nada no fundo
  const planta = plantaPorId(ESTADO.plantaSelecionada);
  if (!svg || !planta) return;
  const { x, y } = svgPontoDeClique(svg, ev);
  const cand = candidatoMaisProximo(planta, x, y);
  if (cand) {
    salvarPosicaoPlanta(planta, cand.x, cand.y);
  } else {
    salvarPosicaoPlanta(planta, Math.round(x * 100) / 100, Math.round(y * 100) / 100);
  }
});

// ------------------------------------------------------------------
// Arrastar um ícone da caixinha "Ou arraste pra dentro da planta" --
// alternativa ao clique, pensada pro caso em que o desenho não tem o
// símbolo detectado ali perto (então não existe contorno tracejado pra
// clicar em cima). Feito com Pointer Events (não o drag nativo do
// HTML5, que não funciona direito no toque do celular) pra funcionar
// igual no mouse e no dedo.
// ------------------------------------------------------------------
$all(".planta-chip-arrastavel").forEach((chip) => {
  chip.addEventListener("pointerdown", (ev) => {
    if (!marcacaoEstaAtiva()) { toast("Clique no lápis ✏️ da planta pra entrar no modo de edição antes de arrastar."); return; }
    ev.preventDefault();
    const tipo = chip.dataset.tipo;
    const radio = $(`input[name="modoMarcacao"][value="${tipo}"]`);
    if (radio && !radio.checked) { radio.checked = true; atualizarModoMarcacao(); }

    const fantasma = document.createElement("div");
    fantasma.className = "planta-fantasma-arrasto " + tipo;
    document.body.appendChild(fantasma);
    const mover = (cx, cy) => { fantasma.style.left = (cx - 13) + "px"; fantasma.style.top = (cy - 13) + "px"; };
    mover(ev.clientX, ev.clientY);

    function aoMover(e) { mover(e.clientX, e.clientY); }
    function aoSoltar(e) {
      document.removeEventListener("pointermove", aoMover);
      fantasma.remove();
      const svg = $("#plantaSvg");
      const planta = plantaPorId(ESTADO.plantaSelecionada);
      if (!svg || !planta) return;
      const retSvg = svg.getBoundingClientRect();
      if (e.clientX < retSvg.left || e.clientX > retSvg.right || e.clientY < retSvg.top || e.clientY > retSvg.bottom) return; // soltou fora da planta, cancela
      // O painel do lápis fica desenhado POR CIMA da planta (ancorado
      // naquele canto) -- soltar ainda em cima dele calcularia a posição
      // como se fosse o que tem embaixo do painel, sempre o mesmo canto,
      // não o lugar de verdade que a pessoa mirou. Cancela nesse caso.
      const elementoNoPonto = document.elementFromPoint(e.clientX, e.clientY);
      if (elementoNoPonto && elementoNoPonto.closest("#cardPosicionarPlanta")) {
        toast("Solte fora do painel do lápis, em cima da planta.");
        return;
      }
      const { x, y } = svgPontoDeClique(svg, e);
      const cand = candidatoMaisProximo(planta, x, y);
      if (cand) salvarPosicaoPlanta(planta, cand.x, cand.y);
      else salvarPosicaoPlanta(planta, Math.round(x * 100) / 100, Math.round(y * 100) / 100);
    }
    document.addEventListener("pointermove", aoMover);
    document.addEventListener("pointerup", aoSoltar, { once: true });
  });
});

// ------------------------------------------------------------------
// Zoom e pan da planta -- roda da mouse, arrastar (mouse ou dedo) e
// pinça de dois dedos, tudo em cima do viewBox do SVG (assim os
// marcadores, que já estão no mesmo espaço de coordenadas, continuam
// clicáveis certinho sem nenhuma conta extra).
// ------------------------------------------------------------------
function ativarZoomPan(svg) {
  if (!svg || svg.dataset.zoomPanAtivo === "1") return;
  svg.dataset.zoomPanAtivo = "1";
  svg.style.touchAction = "none";

  function viewAtual() {
    const [x, y, w, h] = (svg.getAttribute("viewBox") || "0 0 100 100").split(" ").map(Number);
    return { x, y, w, h };
  }
  // Limita o quanto dá pra arrastar a planta pros lados -- sem isso, dava
  // pra puxar a visão pra bem longe do desenho e ficar perdida numa área
  // em branco. Deixa uma folga de meia largura/altura original pra fora
  // de cada lado (dá pra "espiar" um pouco além da borda, só não afastar
  // demais).
  function aplicarView(v) {
    const original = svg.__viewOriginal;
    if (original) {
      const folgaX = original.w * 0.5, folgaY = original.h * 0.5;
      const minX = original.x - folgaX, maxX = original.x + original.w + folgaX - v.w;
      const minY = original.y - folgaY, maxY = original.y + original.h + folgaY - v.h;
      v.x = Math.min(Math.max(v.x, minX), maxX);
      v.y = Math.min(Math.max(v.y, minY), maxY);
    }
    svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  }
  function zoomEm(fatorEscala, cxTela, cyTela) {
    const v = viewAtual();
    const original = svg.__viewOriginal || v;
    const pt = svgPontoDeClique(svg, { clientX: cxTela, clientY: cyTela });
    let novaLargura = v.w * fatorEscala;
    // não deixa afastar mais que a visão original nem aproximar demais
    novaLargura = Math.min(Math.max(novaLargura, original.w / 40), original.w * 1.4);
    const novaAltura = novaLargura * (v.h / v.w);
    const novoX = pt.x - (pt.x - v.x) * (novaLargura / v.w);
    const novoY = pt.y - (pt.y - v.y) * (novaAltura / v.h);
    aplicarView({ x: novoX, y: novoY, w: novaLargura, h: novaAltura });
  }

  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    zoomEm(ev.deltaY > 0 ? 1.15 : 1 / 1.15, ev.clientX, ev.clientY);
  }, { passive: false });

  // Arrastar (mouse) e pinça/arrastar (toque) via Pointer Events, que
  // unificam os dois -- cada ponteiro ativo fica guardado por id.
  const ponteiros = new Map();
  let distanciaInicialPinca = null;
  let viewInicialPinca = null;

  svg.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("circle, g[data-id], g[data-condensadora-de], [data-destaque]")) return; // deixa o clique do marcador acontecer
    svg.setPointerCapture(ev.pointerId);
    ponteiros.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, moveu: 0 });
    if (ponteiros.size === 2) {
      const [p1, p2] = [...ponteiros.values()];
      distanciaInicialPinca = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      viewInicialPinca = viewAtual();
    }
  });

  svg.addEventListener("pointermove", (ev) => {
    const p = ponteiros.get(ev.pointerId);
    if (!p) return;
    const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
    p.moveu += Math.abs(dx) + Math.abs(dy);
    if (p.moveu > 4) svg.dataset.arrastou = "1";

    if (ponteiros.size === 2 && distanciaInicialPinca) {
      p.x = ev.clientX; p.y = ev.clientY;
      const [p1, p2] = [...ponteiros.values()];
      const distanciaAtual = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const razaoBruta = distanciaInicialPinca / Math.max(distanciaAtual, 1);
      // Amortece a pinça: sem isso, no celular o gesto "pega" fácil demais
      // e um movimento pequeno de dedo já dispara um zoom enorme, ficando
      // difícil de controlar. Elevar a razão a um expoente < 1 pede mais
      // percurso físico dos dedos pro mesmo tanto de zoom -- 0.5 tava
      // sensível demais, 0.3 ficou sensível de menos, 0.4 e 0.45 ainda
      // ficaram pouco sensíveis (relatos reais); 0.48 sobe mais um pouco,
      // bem perto do 0.5 que já tinha dado problema mas sem chegar nele.
      const fator = Math.pow(razaoBruta, 0.48);
      const meioX = (p1.x + p2.x) / 2, meioY = (p1.y + p2.y) / 2;
      const original = svg.__viewOriginal || viewInicialPinca;
      let novaLargura = viewInicialPinca.w * fator;
      novaLargura = Math.min(Math.max(novaLargura, original.w / 40), original.w * 1.4);
      const novaAltura = novaLargura * (viewInicialPinca.h / viewInicialPinca.w);
      // Mantém o ponto que está embaixo do meio dos dedos NO MESMO lugar
      // da tela -- antes só recentralizava a visão nesse ponto (só ficava
      // certo se a pinça acontecesse bem no centro da tela; em qualquer
      // outro lugar, o desenho "escorregava" pro centro a cada pinça,
      // ficando descentralizado -- relato real). Mesma fórmula (já
      // validada) do zoom da roda do mouse em zoomEm(), aplicada aqui.
      const vAtual = viewAtual();
      const ptMeio = svgPontoDeClique(svg, { clientX: meioX, clientY: meioY });
      const novoX = ptMeio.x - (ptMeio.x - vAtual.x) * (novaLargura / vAtual.w);
      const novoY = ptMeio.y - (ptMeio.y - vAtual.y) * (novaAltura / vAtual.h);
      aplicarView({ x: novoX, y: novoY, w: novaLargura, h: novaAltura });
      return;
    }

    if (ponteiros.size === 1) {
      const v = viewAtual();
      const escala = v.w / svg.getBoundingClientRect().width;
      aplicarView({ x: v.x - dx * escala, y: v.y - dy * escala, w: v.w, h: v.h });
      p.x = ev.clientX; p.y = ev.clientY;
    }
  });

  function soltarPonteiro(ev) {
    ponteiros.delete(ev.pointerId);
    if (ponteiros.size < 2) { distanciaInicialPinca = null; viewInicialPinca = null; }
  }
  svg.addEventListener("pointerup", soltarPonteiro);
  svg.addEventListener("pointercancel", soltarPonteiro);
  svg.addEventListener("pointerleave", soltarPonteiro);

  svg.__zoomIn = () => { const v = viewAtual(); zoomEm(1 / 1.4, svg.getBoundingClientRect().left + svg.getBoundingClientRect().width / 2, svg.getBoundingClientRect().top + svg.getBoundingClientRect().height / 2); };
  svg.__zoomOut = () => { const v = viewAtual(); zoomEm(1.4, svg.getBoundingClientRect().left + svg.getBoundingClientRect().width / 2, svg.getBoundingClientRect().top + svg.getBoundingClientRect().height / 2); };
  svg.__zoomReset = () => { if (svg.__viewOriginal) aplicarView(svg.__viewOriginal); };
}

// Centraliza a visão da planta num ponto específico, aproximando um
// pouco se a visão atual estiver muito aberta -- usado pelos botões
// "Ver condensadora"/"Ver evaporadora" pra deixar bem claro qual é o
// marcador, em vez de só piscar em algum canto da planta inteira.
function centralizarView(svg, x, y) {
  if (!svg) return;
  const original = svg.__viewOriginal;
  if (!original) return;
  const [, , wAtual, hAtual] = (svg.getAttribute("viewBox") || "").split(" ").map(Number);
  const largura = Math.min(wAtual || original.w, original.w / 3);
  const altura = largura * (original.h / original.w);
  svg.setAttribute("viewBox", `${x - largura / 2} ${y - altura / 2} ${largura} ${altura}`);
}

// ------------------------------------------------------------------
// Upload de planta (.dwf/.dwfx) -- lido inteiro no navegador (utils/
// dwfParser.js), sem passar por nenhum servidor nosso. O desenho lido
// vira um preview na hora, a pessoa confirma qual camada é a de
// equipamento, e só então salva (o JSON pesado vai pro Cloudinary como
// arquivo "raw", igual as fotos; o Firestore só guarda o link).
// ------------------------------------------------------------------
let _dadosPlantaPendente = null; // resultado do parseDwf() ainda não salvo

function renderUploadPlanta() {
  const local = $("#uploadPlantaLocal");
  if (local && ESTADO.configSite?.predios) {
    local.innerHTML = ESTADO.configSite.predios.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
  }
}

$("#btnMostrarUploadPlanta")?.addEventListener("click", () => {
  const painel = $("#painelUploadPlanta");
  if (painel) painel.hidden = !painel.hidden;
});

$("#uploadPlantaArquivo")?.addEventListener("change", async (ev) => {
  const arquivo = ev.target.files?.[0];
  if (!arquivo) return;
  const status = $("#uploadPlantaStatus");
  const preview = $("#uploadPlantaPreviewWrap");
  if (preview) preview.hidden = true;
  if (status) status.textContent = "Lendo o arquivo...";
  _dadosPlantaPendente = null;

  try {
    const buffer = await arquivo.arrayBuffer();
    const dados = await parseDwf(buffer);
    _dadosPlantaPendente = dados;

    montarSvgPreviewUpload(dados);

    const selectCamada = $("#uploadPlantaCamadaEquip");
    selectCamada.innerHTML = dados.layers.map((l) =>
      `<option value="${escapeHtml(l)}" ${l === dados.camadaEquipamentoSugerida ? "selected" : ""}>${escapeHtml(l)}</option>`
    ).join("");
    atualizarContagemCandidatos();
    selectCamada.onchange = atualizarContagemCandidatos;
    function atualizarContagemCandidatos() {
      const camada = selectCamada.value;
      const n = (dados.marcadoresPorCamada[camada] || []).length;
      $("#uploadPlantaContagem").textContent = `${n} posição(ões) de equipamento detectada(s) automaticamente nessa camada.`;
    }

    if (!$("#uploadPlantaNome").value) {
      $("#uploadPlantaNome").value = arquivo.name.replace(/\.(dwfx?|DWFX?)$/, "");
    }
    if (preview) preview.hidden = false;
    if (status) status.textContent = `Lido com sucesso: ${dados.layers.length} camadas, ${dados.entities.length} elementos.`;
  } catch (err) {
    console.error(err);
    if (status) status.textContent = "Erro ao ler o arquivo: " + err.message;
  }
});

function montarSvgPreviewUpload(dados) {
  const svg = $("#uploadPlantaSvg");
  const [xmin, ymin, xmax, ymax] = dados.bbox;
  const pad = Math.max((xmax - xmin) * 0.03, 1);
  const viewInicial = { x: xmin - pad, y: ymin - pad, w: xmax - xmin + pad * 2, h: ymax - ymin + pad * 2 };
  svg.setAttribute("viewBox", `${viewInicial.x} ${viewInicial.y} ${viewInicial.w} ${viewInicial.h}`);
  svg.__viewOriginal = viewInicial;
  ativarZoomPan(svg);
  svg.innerHTML = "";
  const nsSvg = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(nsSvg, "g");
  g.setAttribute("transform", `matrix(${dados.matriz.join(",")})`);
  svg.appendChild(g);
  dados.entities.forEach((ent) => {
    const p = document.createElementNS(nsSvg, "path");
    p.setAttribute("d", ent.d);
    if (ent.stroke) { p.setAttribute("stroke", ent.stroke); p.setAttribute("stroke-width", ent.sw || 1); p.setAttribute("fill", "none"); }
    if (ent.fill) { p.setAttribute("fill", ent.fill); if (!ent.stroke) p.setAttribute("stroke", "none"); }
    if (!ent.stroke && !ent.fill) { p.setAttribute("stroke", "#888"); p.setAttribute("stroke-width", 4); p.setAttribute("fill", "none"); }
    g.appendChild(p);
  });
}

// Envia um objeto JSON como arquivo "raw" pro Cloudinary, reaproveitando a
// mesma assinatura/Worker já usados pras fotos de equipamento -- só muda
// o endpoint de destino (raw/upload em vez de image/upload).
async function enviarArquivoPlanta(dadosObjeto, nomeArquivo) {
  const idToken = await auth.currentUser.getIdToken();
  const respAssinatura = await fetch(URL_UPLOAD_FOTO, {
    method: "POST",
    headers: { Authorization: "Bearer " + idToken, "Content-Type": "application/json" },
    body: JSON.stringify({ folder: "plantas", publicId: nomeArquivo, overwrite: true }),
  });
  if (!respAssinatura.ok) {
    const erro = await respAssinatura.json().catch(() => ({}));
    throw new Error(erro.erro || "Não autorizado a enviar planta.");
  }
  const assinatura = await respAssinatura.json();

  const blob = new Blob([JSON.stringify(dadosObjeto)], { type: "application/json" });
  const formData = new FormData();
  formData.append("file", blob, "planta.json");
  formData.append("api_key", assinatura.apiKey);
  formData.append("timestamp", assinatura.timestamp);
  formData.append("signature", assinatura.signature);
  if (assinatura.folder) formData.append("folder", assinatura.folder);
  if (assinatura.publicId) formData.append("public_id", assinatura.publicId);
  if (assinatura.overwrite) formData.append("overwrite", assinatura.overwrite);

  const respUpload = await fetch(`https://api.cloudinary.com/v1_1/${assinatura.cloudName}/raw/upload`, {
    method: "POST",
    body: formData,
  });
  if (!respUpload.ok) throw new Error("Falha ao enviar o desenho da planta.");
  const dadosResp = await respUpload.json();
  return dadosResp.secure_url;
}

$("#btnSalvarPlanta")?.addEventListener("click", async () => {
  if (!_dadosPlantaPendente) { toast("Escolha um arquivo primeiro."); return; }
  const nome = $("#uploadPlantaNome").value.trim();
  const local = $("#uploadPlantaLocal").value;
  const camadaEquipamento = $("#uploadPlantaCamadaEquip").value;
  if (!nome) { toast("Dê um nome pra essa planta."); return; }

  const btn = $("#btnSalvarPlanta");
  btn.disabled = true;
  btn.textContent = "Salvando...";
  const status = $("#uploadPlantaStatus");
  try {
    const publicId = "planta_" + Date.now();
    if (status) status.textContent = "Enviando o desenho...";
    const dadosUrl = await enviarArquivoPlanta(_dadosPlantaPendente, publicId);

    const novaRef = doc(collection(db, "plantas"));
    await setDoc(novaRef, {
      nome, local,
      layers: _dadosPlantaPendente.layers,
      camadaEquipamento,
      dadosUrl,
      criadoEm: new Date().toISOString(),
      criadoPor: ESTADO.usuarioNome || "",
    });

    toast("Planta salva.");
    _dadosPlantaPendente = null;
    $("#uploadPlantaArquivo").value = "";
    $("#uploadPlantaNome").value = "";
    $("#uploadPlantaPreviewWrap").hidden = true;
    $("#painelUploadPlanta").hidden = true;
    ESTADO.plantaSelecionada = novaRef.id;
  } catch (err) {
    console.error(err);
    if (status) status.textContent = "Erro ao salvar: " + err.message;
    toast("Erro ao salvar planta: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar planta";
  }
});

function renderEquipamentosCadastro() {
  const table = $("#equipamentosTable");
  if (!table) return;
  const termo = ESTADO.filtros.equipamentos;
  const statusFiltro = $("#filtroStatus")?.value || "";
  const setorPCMFiltro = $("#filtroSetorPCM")?.value || "";
  const origemFiltro = $("#filtroOrigem")?.value || "";
  const filtrados = aplicarFiltroLocal(ESTADO.equipamentos).filter((item) => {
    if (termo) {
      const alvo = `${item.patrimonio || ""} ${item.tag || ""} ${item.setor || ""} ${item.ambiente || ""} ${item.setorPCM || ""} ${item.equipeResponsavel || ""}`.toLowerCase();
      if (!alvo.includes(termo)) return false;
    }
    if (statusFiltro) {
      if (statusFiltro === "Atrasado") { if (!estaAtrasado(item)) return false; }
      else if (item.statusPreventiva !== statusFiltro) return false;
    }
    if (setorPCMFiltro && item.setorPCM !== setorPCMFiltro) return false;
    if (origemFiltro) {
      const origemItem = item.origem === "manual" ? "manual" : "planilha";
      if (origemItem !== origemFiltro) return false;
    }
    return true;
  });

  let itensComCorretivas = filtrados.map((item) => {
    const { exatos, aproximados } = chamadosDoEquipamento(item);
    return { item, totalCorretivas: exatos.length + aproximados.length };
  });
  if (ESTADO.ordenacaoEquipamentos === "corretivas_desc") {
    itensComCorretivas.sort((a, b) => b.totalCorretivas - a.totalCorretivas);
  } else if (ESTADO.ordenacaoEquipamentos === "corretivas_asc") {
    itensComCorretivas.sort((a, b) => a.totalCorretivas - b.totalCorretivas);
  }

  $("#equipamentosCount").textContent = `${itensComCorretivas.length} itens`;
  const setaOrdenacao = ESTADO.ordenacaoEquipamentos === "corretivas_desc" ? " ▼"
    : ESTADO.ordenacaoEquipamentos === "corretivas_asc" ? " ▲" : " ⇅";
  table.innerHTML = `<thead><tr>
      <th style="width:30px"><input type="checkbox" id="checkTodosEquipamentos"></th>
      <th>Patrimônio</th><th>Setor</th><th>Ambiente</th><th>Prédio</th><th>Setor PCM</th>
      <th>Status</th><th>Origem</th><th>Marca/Modelo/Capacidade</th>
      <th id="thCorretivas" style="cursor:pointer" title="Clique para ordenar">Corretivas${setaOrdenacao}</th>
      <th></th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  itensComCorretivas.forEach(({ item, totalCorretivas }) => {
    const dadosTecnicos = escapeHtml([item.tag && `Tag: ${item.tag}`, item.marca, item.modelo, item.capacidade, item.tipoGas && `Gás: ${item.tipoGas}`].filter(Boolean).join(" • ") || "-");
    const tr = document.createElement("tr");
    tr.innerHTML = `<td></td><td data-label="Patrimônio">${escapeHtml(item.patrimonio || "-")}</td><td data-label="Setor">${escapeHtml(item.setor)}</td><td data-label="Ambiente">${escapeHtml(item.ambiente)}</td>
      <td data-label="Prédio">${escapeHtml(item.local || "SEDE")}</td>
      <td data-label="Setor PCM">${item.setorPCM}</td>
      <td data-label="Status">
        ${estaAtrasado(item)
          ? '<span class="status-select atrasado" style="cursor:default">Atrasado</span>'
          : `<span class="status-select ${classeStatus(item.statusPreventiva)}" style="cursor:default">${item.statusPreventiva}</span>`}
      </td>
      <td data-label="Origem">${item.origem === "manual" ? "Manual" : "Planilha"}</td>
      <td data-label="Marca/Modelo/Cap." style="font-size:12px">${dadosTecnicos}</td>
      <td data-label="Corretivas" style="text-align:center">${totalCorretivas > 0 ? `<strong>${totalCorretivas}</strong>` : "-"}</td>`;

    const tdCheck = tr.children[0];
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = ESTADO.selecaoEquipamentos.has(item.id);
    chk.addEventListener("click", (e) => e.stopPropagation());
    chk.addEventListener("change", () => {
      if (chk.checked) ESTADO.selecaoEquipamentos.add(item.id);
      else ESTADO.selecaoEquipamentos.delete(item.id);
      atualizarBarraSelecao("selecaoEquipamentos", "selecaoEquipamentos", "selecaoEquipamentosTexto");
    });
    tdCheck.appendChild(chk);

    const tdMenu = document.createElement("td");
    const btnMenu = document.createElement("button");
    btnMenu.className = "btn-menu";
    btnMenu.textContent = "⋯";
    btnMenu.title = "Ver detalhes";
    btnMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      abrirDrawerEquipamento(item.id);
    });
    tdMenu.appendChild(btnMenu);
    tr.appendChild(tdMenu);
    tbody.appendChild(tr);
  });

  const checkTodos = $("#checkTodosEquipamentos");
  if (checkTodos) {
    checkTodos.checked = itensComCorretivas.length > 0 &&
      itensComCorretivas.every(({ item }) => ESTADO.selecaoEquipamentos.has(item.id));
    checkTodos.addEventListener("change", () => {
      itensComCorretivas.forEach(({ item }) => {
        if (checkTodos.checked) ESTADO.selecaoEquipamentos.add(item.id);
        else ESTADO.selecaoEquipamentos.delete(item.id);
      });
      renderEquipamentosCadastro();
    });
  }

  const thCorretivas = $("#thCorretivas");
  if (thCorretivas) {
    thCorretivas.addEventListener("click", () => {
      ESTADO.ordenacaoEquipamentos = ESTADO.ordenacaoEquipamentos === "corretivas_desc" ? "corretivas_asc" : "corretivas_desc";
      renderEquipamentosCadastro();
    });
  }

  atualizarBarraSelecao("selecaoEquipamentos", "selecaoEquipamentos", "selecaoEquipamentosTexto");
  renderChamadosOrfaos();
}

$("#btnExcluirSelecionadosEquipamentos")?.addEventListener("click", async () => {
  const ids = [...ESTADO.selecaoEquipamentos];
  if (!ids.length) return;
  const ok = window.confirm(`Excluir ${ids.length} equipamento(s) selecionado(s)? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  try {
    for (const id of ids) {
      const item = ESTADO.equipamentos.find((e) => e.id === id);
      if (item) await registrarHistorico(item, "-", "Excluído", "Cadastro");
    }
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
      const batch = writeBatch(db);
      ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((id) =>
        batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id))
      );
      await batch.commit();
    }
    ESTADO.selecaoEquipamentos.clear();
    await registrarAuditoria("Excluir equipamentos (em massa)", `${ids.length} itens`);
    toast(`${ids.length} equipamento(s) excluído(s). Reorganizando cronograma...`);
    await reagendarTudo();
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
});
// ------------------------------------------------------------------
// Painel lateral com detalhes do equipamento
// ------------------------------------------------------------------
function fecharDrawer() {
  $("#drawerEquipamento").hidden = true;
  $("#drawerOverlay").hidden = true;
}

$("#drawerFechar")?.addEventListener("click", fecharDrawer);
$("#drawerOverlay")?.addEventListener("click", fecharDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") fecharDrawer();
});

// Fecha qualquer menu "⋯" (details.menu-linha) aberto ao clicar fora dele —
// antes só fechava clicando de novo nos "⋯", o que confundia.
document.addEventListener("click", (e) => {
  let fechouAlgum = false;
  document.querySelectorAll("details.menu-linha[open]").forEach((det) => {
    if (!det.contains(e.target)) { det.open = false; fechouAlgum = true; }
  });
  if (fechouAlgum && _renderesAdiados.size) {
    const pendentes = [..._renderesAdiados];
    _renderesAdiados.clear();
    pendentes.forEach((fn) => fn());
  }
});

// Os re-renders automáticos (disparados por onSnapshot, quando QUALQUER
// pessoa muda algo no sistema) reconstroem a tabela inteira via innerHTML.
// Se um técnico está com um menu "⋯" aberto naquela tabela no momento em
// que isso acontece, o menu simplesmente some da tela sem aviso. Em vez de
// reconstruir na hora, adia até o menu fechar (ver o listener de click acima).
const _renderesAdiados = new Set();
function renderComProtecaoDeMenu(containerSeletor, renderFn) {
  const container = document.querySelector(containerSeletor);
  if (container && container.querySelector("details.menu-linha[open]")) {
    _renderesAdiados.add(renderFn);
    return;
  }
  renderFn();
}

async function abrirDrawerEquipamento(id) {
  await carregarChamadosCorretivos();
  const item = ESTADO.equipamentos.find((e) => e.id === id);
  if (!item) return;

  // Busca o histórico desse aparelho em TODOS os ciclos, não só no atual —
  // senão, ao virar de ciclo, parecia que nunca tinha sido feita preventiva.
  let conclusoes = [];
  try {
    const qHist = query(collectionGroup(db, "historico"), where("equipamentoId", "==", id));
    const snapHist = await getDocs(qHist);
    conclusoes = snapHist.docs
      .map((d) => d.data())
      .filter((h) => h.statusNovo === "Concluída")
      .sort((a, b) => String(b.registradoEm).localeCompare(String(a.registradoEm)));
  } catch (err) {
    console.error("Erro ao buscar histórico completo:", err);
    conclusoes = ESTADO.historico
      .filter((h) => h.equipamentoId === id && h.statusNovo === "Concluída")
      .sort((a, b) => String(b.registradoEm).localeCompare(String(a.registradoEm)));
  }
  const ultimaPreventiva = conclusoes.length
    ? new Date(conclusoes[0].registradoEm).toLocaleString("pt-BR")
    : "Nunca registrada";

  const totalPreventivas = conclusoes.length;
  const fotosPreventivas = conclusoes.filter((c) => c.fotoUrl);
  const { exatos, aproximados } = chamadosDoEquipamento(item);
  const linhaChamado = (c) =>
    `<div class="drawer-campo"><span class="rotulo">${escapeHtml(c.dataFormatada || "-")}</span>
     <span class="valor">${escapeHtml(c.solucionado || "-")} — ${escapeHtml(c.descricaoProblema || c.pecaFaltante || "sem descrição")} (${escapeHtml(c.equipe || "-")})</span></div>`;

  let infoTecnica = null;
  try {
    const snapInfo = await getDoc(doc(db, "infoCondensadoras", id));
    if (snapInfo.exists()) infoTecnica = snapInfo.data();
  } catch (err) {
    console.error("Erro ao buscar dados técnicos:", err);
  }
  const linhaInfoUnidade = (rotulo, dados) => {
    if (!dados) return `<div class="drawer-campo"><span class="rotulo">${rotulo}</span><span class="valor">Ainda não preenchido</span></div>`;
    return [
      ["Nº", dados.numero], ["Tombo", dados.tombo], ["Tag", dados.tag],
      ["Marca", dados.marca], ["Modelo", dados.modelo],
      ["Capacidade", dados.capacidade], ["Espessura do fio", dados.espessuraFio],
    ].map(([r, v]) => `<div class="drawer-campo"><span class="rotulo">${rotulo} — ${r}</span><span class="valor">${escapeHtml(v || "-")}</span></div>`).join("");
  };

  $("#drawerTitulo").textContent = item.patrimonio ? `Patrimônio ${item.patrimonio}` : item.ambiente;

  $("#drawerCorpo").innerHTML = `
    <details class="drawer-secao" open>
      <summary>Situação</summary>
      <div class="drawer-campo"><span class="rotulo">Status</span>
        <span class="valor">${estaAtrasado(item)
          ? '<span class="status-select atrasado" style="cursor:default">Atrasado</span>'
          : `<span class="status-select ${classeStatus(item.statusPreventiva)}" style="cursor:default">${item.statusPreventiva}</span>`}</span></div>
      <div class="drawer-campo"><span class="rotulo">${item.statusPreventiva === "Concluída" ? "Próximo ciclo previsto" : "Próxima preventiva"}</span><span class="valor">${formatarDataBR(item.statusPreventiva === "Concluída" ? item.proximaPreventiva : item.dataAgendada)} ${(item.statusPreventiva === "Concluída" ? item.proximaPreventivaDia : item.diaPlanejado) ? "(" + (item.statusPreventiva === "Concluída" ? item.proximaPreventivaDia : item.diaPlanejado) + ")" : ""}</span></div>
      <div class="drawer-campo"><span class="rotulo">Semana planejada</span><span class="valor">${item.semanaPlanejada || "-"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Equipe responsável</span><span class="valor">${escapeHtml(item.equipeResponsavel || "-")}</span></div>
      <div class="drawer-campo"><span class="rotulo">Última preventiva concluída</span><span class="valor">${ultimaPreventiva}</span></div>
      <div class="drawer-campo"><span class="rotulo">Total de preventivas feitas</span><span class="valor">${totalPreventivas}</span></div>
    </details>

    <details class="drawer-secao" open>
      <summary>Fotos</summary>
      <div class="drawer-campo" style="flex-direction:column; align-items:flex-start; gap:8px;">
        <span class="rotulo">Foto atual do equipamento</span>
        ${item.fotoUrl
          ? `<img src="${escapeHtml(item.fotoUrl)}" alt="Foto do equipamento" style="width:100%; border-radius:var(--raio-pequeno); border:1px solid var(--borda);">`
          : '<span class="valor" style="color:var(--texto-suave)">Nenhuma foto cadastrada ainda.</span>'}
      </div>
      ${fotosPreventivas.length ? `
        <div style="padding:0 var(--sp-4) var(--sp-3);">
          <div style="font-size:11px; color:var(--texto-suave); text-transform:uppercase; letter-spacing:.03em; margin-bottom:8px;">Histórico por preventiva</div>
          <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(90px, 1fr)); gap:8px;">
            ${fotosPreventivas.map((f) => `
              <a href="${escapeHtml(f.fotoUrl)}" target="_blank" rel="noopener" title="${new Date(f.registradoEm).toLocaleDateString("pt-BR")}">
                <img src="${escapeHtml(f.fotoUrl)}" style="width:100%; aspect-ratio:1; object-fit:cover; border-radius:var(--raio-pequeno); border:1px solid var(--borda);">
                <div style="font-size:10px; text-align:center; color:var(--texto-suave); margin-top:2px;">${new Date(f.registradoEm).toLocaleDateString("pt-BR")}</div>
              </a>
            `).join("")}
          </div>
        </div>
      ` : ""}
    </details>

    <details class="drawer-secao">
      <summary>Localização e classificação</summary>
      <div class="drawer-campo"><span class="rotulo">Prédio</span><span class="valor">${escapeHtml(item.local || "SEDE")}</span></div>
      <div class="drawer-campo"><span class="rotulo">Setor</span><span class="valor">${escapeHtml(item.setor || "-")}</span></div>
      <div class="drawer-campo"><span class="rotulo">Ambiente</span><span class="valor">${escapeHtml(item.ambiente || "-")}</span></div>
      <div class="drawer-campo"><span class="rotulo">Tag</span><span class="valor">${escapeHtml(item.tag || "-")}</span></div>
      <div class="drawer-campo"><span class="rotulo">Setor PCM</span><span class="valor">${item.setorPCM || "-"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Piso</span><span class="valor">${item.pisoPCM === 99 ? "Não identificado" : item.pisoPCM}</span></div>
      <div class="drawer-campo"><span class="rotulo">Condição (levantamento)</span><span class="valor">${escapeHtml(item.statusCondicao || "-")}</span></div>
      <div class="drawer-campo"><span class="rotulo">Origem do cadastro</span><span class="valor">${item.origem === "manual" ? "Manual" : "Planilha"}</span></div>
      <div class="drawer-campo"><span class="rotulo">Tipo de gás</span><span class="valor">${escapeHtml(item.tipoGas || "-")}</span></div>
      <div class="drawer-campo"><span class="rotulo">Observações</span><span class="valor">${escapeHtml(item.observacao || "-")}</span></div>
      <div class="drawer-campo"><span class="rotulo">Código na planta</span><span class="valor">${escapeHtml(item.codigoPlanta || "-")}</span></div>
      ${item.plantaId ? `
        <div class="drawer-acoes">
          <button class="btn ghost" id="drawerVerNaPlanta">Ver na planta</button>
        </div>
      ` : ""}
    </details>

    <details class="drawer-secao">
      <summary>Chamados corretivos (planilha)</summary>
      ${exatos.length ? exatos.map(linhaChamado).join("") : '<div class="drawer-campo"><span class="rotulo">Vinculados por patrimônio</span><span class="valor">Nenhum</span></div>'}
      ${aproximados.length ? `
        <div style="margin-top:8px;font-size:11px;color:var(--texto-suave);text-transform:uppercase;letter-spacing:.03em">Prováveis (mesmo local, sem patrimônio no chamado)</div>
        ${aproximados.map(linhaChamado).join("")}
      ` : ""}
    </details>

    <details class="drawer-secao">
      <summary>Dados técnicos</summary>
      ${infoTecnica ? `
        <div class="drawer-campo"><span class="rotulo">Informante</span><span class="valor">${escapeHtml(infoTecnica.informante || "-")}</span></div>
        <div class="drawer-campo"><span class="rotulo">Preenchido em</span><span class="valor">${infoTecnica.preenchidoEm ? new Date(infoTecnica.preenchidoEm).toLocaleString("pt-BR") : "-"}</span></div>
        ${linhaInfoUnidade("Condensadora", infoTecnica.condensadora)}
        ${linhaInfoUnidade("Evaporadora", infoTecnica.evaporadora)}
      ` : '<div class="drawer-campo"><span class="rotulo">Status</span><span class="valor">Ainda não preenchido</span></div>'}
    </details>

    <details class="drawer-secao drawer-form">
      <summary>Editar cadastro</summary>
      <label>Patrimônio<input type="text" id="drawerPatrimonio" value="${escapeHtml(item.patrimonio || "")}"></label>
      <label>Tag<input type="text" id="drawerTag" value="${escapeHtml(item.tag || "")}" placeholder="Vem da planilha, se tiver"></label>
      <label>Setor<input type="text" id="drawerSetor" value="${escapeHtml(item.setor || "")}"></label>
      <label>Ambiente<input type="text" id="drawerAmbiente" value="${escapeHtml(item.ambiente || "")}"></label>
      <label>Prédio
        <select id="drawerLocal">
          ${ESTADO.configSite.predios.map((l) =>
            `<option value="${escapeHtml(l)}" ${(item.local || ESTADO.configSite.predios[0]) === l ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}
        </select>
      </label>
      <label>Marca<input type="text" id="drawerMarca" value="${escapeHtml(item.marca || "")}" placeholder="Vem da planilha, se tiver"></label>
      <label>Modelo<input type="text" id="drawerModelo" value="${escapeHtml(item.modelo || "")}" placeholder="Vem da planilha, se tiver"></label>
      <label>Capacidade<input type="text" id="drawerCapacidade" value="${escapeHtml(item.capacidade || "")}" placeholder="Vem da planilha, se tiver"></label>
      <label>Tipo de gás
        <select id="drawerTipoGas">
          <option value="">Não informado</option>
          ${GASES_REFRIGERANTES.map((g) => `<option value="${g}" ${item.tipoGas === g ? "selected" : ""}>${g}</option>`).join("")}
          <option value="Outro" ${item.tipoGas && !GASES_REFRIGERANTES.includes(item.tipoGas) ? "selected" : ""}>Outro</option>
        </select>
      </label>
      <label>Observações (ex: contato da sala, restrições de horário...)<input type="text" id="drawerObservacao" value="${escapeHtml(item.observacao || "")}" placeholder="Ex: falar com Fulano, ramal 1234"></label>
      <label>Código na planta (ex: E2/C4)<input type="text" id="drawerCodigoPlanta" value="${escapeHtml(item.codigoPlanta || "")}" placeholder="Ex: E2/C4"></label>
      <div class="drawer-acoes">
        <button class="btn primary" id="drawerSalvarCadastro">Salvar cadastro</button>
      </div>
      <label>Foto do equipamento<input type="file" accept="image/*" capture="environment" id="drawerFotoInput"></label>
      <div class="drawer-acoes">
        <button class="btn ghost" id="drawerEnviarFoto">Enviar foto</button>
      </div>
    </details>

    <details class="drawer-secao drawer-form">
      <summary>Reagendar</summary>
      <label>Nova data da preventiva<input type="date" id="drawerNovaData" value="${item.dataAgendada || ""}"></label>
      <div class="drawer-acoes">
        <button class="btn primary" id="drawerSalvarData">Salvar nova data</button>
      </div>
    </details>

    <details class="drawer-secao drawer-form">
      <summary style="color:var(--vermelho)">Excluir</summary>
      <div class="drawer-acoes">
        <button class="btn ghost" id="drawerExcluir" style="color:var(--vermelho);border-color:var(--vermelho)">Excluir equipamento</button>
      </div>
    </details>
  `;

  $("#drawerSalvarCadastro").addEventListener("click", async () => {
    const patrimonio = $("#drawerPatrimonio").value.trim();
    const tag = $("#drawerTag")?.value.trim() || "";
    const setor = $("#drawerSetor").value.trim();
    const ambiente = $("#drawerAmbiente").value.trim();
    const local = $("#drawerLocal").value;
    const marca = $("#drawerMarca").value.trim();
    const modelo = $("#drawerModelo").value.trim();
    const capacidade = $("#drawerCapacidade").value.trim();
    const tipoGas = $("#drawerTipoGas")?.value || "";
    const observacao = $("#drawerObservacao")?.value.trim() || "";
    const codigoPlanta = $("#drawerCodigoPlanta")?.value.trim() || "";
    if (!setor || !ambiente) {
      toast("Preencha pelo menos Setor e Ambiente.");
      return;
    }
    const setorPCM = identificarSetor(setor, ambiente);
    try {
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), {
        patrimonio, tag, setor, ambiente, local, setorPCM, marca, modelo, capacidade, tipoGas, observacao, codigoPlanta,
        prioridadeSetor: PRIORIDADE[setorPCM] || 7,
        pisoPCM: descobrirPiso(setor),
      });
      await registrarHistorico(
        { id, patrimonio, setor, ambiente, local, equipeResponsavel: item.equipeResponsavel },
        "-", "Editado", "Cadastro"
      );
      toast("Cadastro atualizado.");
      fecharDrawer();
    } catch (err) {
      console.error(err);
      toast("Erro ao salvar: " + err.message);
    }
  });

  $("#drawerVerNaPlanta")?.addEventListener("click", async () => {
    fecharDrawer();
    irParaAba("localizacao");
    // Mesmo caminho do botão "Ver condensadora": troca de planta se
    // precisar, centraliza e aproxima a visão, e pisca o anel dourado --
    // antes esse botão procurava um <circle data-id> que não existe mais
    // desde que o marcador virou o próprio símbolo do CAD (ou um ícone
    // <g>), então na prática não fazia nada além de trocar de aba.
    await irParaMarcador(item.plantaId, item.plantaX, item.plantaY, () => mostrarPainelPlanta(item));
  });

  $("#drawerEnviarFoto")?.addEventListener("click", async () => {
    const arquivo = $("#drawerFotoInput")?.files?.[0];
    if (!arquivo) { toast("Escolha uma foto primeiro."); return; }
    const btn = $("#drawerEnviarFoto");
    btn.disabled = true;
    btn.textContent = "Enviando...";
    try {
      const fotoUrl = await enviarFoto(arquivo, { publicId: `equipamentos/${id}/foto`, overwrite: true });
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), { fotoUrl });
      item.fotoUrl = fotoUrl;
      toast("Foto salva.");
      abrirDrawerEquipamento(id);
    } catch (err) {
      console.error(err);
      toast("Erro ao enviar foto: " + err.message);
      btn.disabled = false;
      btn.textContent = "Enviar foto";
    }
  });

  $("#drawerSalvarData").addEventListener("click", async () => {
    const novaData = $("#drawerNovaData").value;
    if (!novaData) {
      toast("Escolha uma data.");
      return;
    }
    const [a, m, d] = novaData.split("-");
    const dataObj = new Date(a, parseInt(m, 10) - 1, d, 12, 0, 0);
    const novoDia = NOMES_DIAS[(dataObj.getDay() + 6) % 7];

    // Avisa se o dia escolhido já está no limite da capacidade daquele prédio
    const localItem = item.local || "SEDE";
    const cap = (ESTADO.config?.capacidades || {})[localItem] || { nEquipes: 1, aparelhosDia: 2 };
    const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);
    const feriadoNoDia = ESTADO.feriados.find((f) => novaData >= f.dataInicio && novaData <= f.dataFim);
    if (feriadoNoDia) {
      const ok = window.confirm(
        `Esse dia é ${feriadoNoDia.tipo === "feriado" ? "feriado" : "período de férias"} (${feriadoNoDia.label}). Agendar mesmo assim?`
      );
      if (!ok) return;
    }

    const jaNoDia = ESTADO.equipamentos.filter(
      (e) => e.id !== id && (e.local || "SEDE") === localItem && e.dataAgendada === novaData
    ).length;

    if (jaNoDia >= capacidadeDia) {
      const ok = window.confirm(
        `Esse dia já tem ${jaNoDia} aparelho(s) em ${localItem}, no limite da capacidade (${capacidadeDia}/dia). Agendar mesmo assim?`
      );
      if (!ok) return;
    }

    try {
      await updateDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id), {
        dataAgendada: novaData,
        diaPlanejado: novoDia,
        fixadoManualmente: true 
      });
      await addDoc(collection(     db,     "ciclos",     ESTADO.cicloAtual,     "historico" ), {
        equipamentoId: id,
        patrimonio: item.patrimonio || "",
        setor: item.setor || "",
        ambiente: item.ambiente || "",
        local: item.local || "SEDE",
        usuario: ESTADO.usuarioNome || "",
        equipe: item.equipeResponsavel || "",
        tipo: "Reagendamento manual",
        dataAnterior: item.dataAgendada || "",
        dataNova: novaData,
        registradoEm: new Date().toISOString(),
      });
      toast(`Reagendado para ${formatarDataBR(novaData)}. Reorganizando o resto do cronograma...`);
      fecharDrawer();
      await reagendarTudo();
    } catch (err) {
      console.error(err);
      toast("Erro ao reagendar: " + err.message);
    }
  });

  $("#drawerExcluir").addEventListener("click", async () => {
    const ok = window.confirm(`Remover "${item.patrimonio || item.ambiente}"? Essa ação não pode ser desfeita.`);
    if (!ok) return;
    try {
      await registrarHistorico(item, "-", "Excluído", "Cadastro");
      await deleteDoc(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id));
      toast("Equipamento removido. Reorganizando cronograma...");
      fecharDrawer();
      await reagendarTudo();
    } catch (err) {
      console.error(err);
      toast("Erro ao remover: " + err.message);
    }
  });

  $("#drawerEquipamento").hidden = false;
  $("#drawerOverlay").hidden = false;
}

const feriadoTipoSelect = $("#feriadoTipo");
if (feriadoTipoSelect) {
  feriadoTipoSelect.addEventListener("change", () => {
    $("#labelFeriadoFim").style.display = feriadoTipoSelect.value === "ferias" ? "flex" : "none";
  });
  feriadoTipoSelect.dispatchEvent(new Event("change"));
}

const btnAdicionarFeriado = $("#btnAdicionarFeriado");
if (btnAdicionarFeriado) {
  btnAdicionarFeriado.addEventListener("click", adicionarFeriado);
}

async function adicionarFeriado() {
  const tipo = $("#feriadoTipo").value;
  const label = $("#feriadoLabel").value.trim();
  const dataInicio = $("#feriadoInicio").value;
  const dataFimInput = $("#feriadoFim").value;
  if (!dataInicio) {
    toast("Escolha a data início.");
    return;
  }
  const dataFim = tipo === "feriado" ? dataInicio : (dataFimInput || dataInicio);
  if (dataFim < dataInicio) {
    toast("A data fim não pode ser antes da data início.");
    return;
  }
  try {
    const novoFeriado = { tipo, label: label || (tipo === "feriado" ? "Feriado" : "Férias"), dataInicio, dataFim };
    const refDoc = await addDoc(collection(db, "feriados"), novoFeriado);
    const snapFeriadosAtual = await getDocs(query(collection(db, "feriados"), orderBy("dataInicio")));
    ESTADO.feriados = snapFeriadosAtual.docs.map((d) => ({ id: d.id, ...d.data() }));
    await registrarAuditoria("Adicionar feriado/férias", `${novoFeriado.label} (${novoFeriado.dataInicio} a ${novoFeriado.dataFim})`);
    $("#feriadoLabel").value = "";
    $("#feriadoInicio").value = "";
    $("#feriadoFim").value = "";
    toast("Data cadastrada. Reorganizando cronograma...");
    await reagendarTudo();
  } catch (err) {
    console.error(err);
    toast("Erro ao cadastrar: " + err.message);
  }
}

async function removerFeriado(id, label) {
  const ok = window.confirm(`Remover "${label}"?`);
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "feriados", id));
    ESTADO.feriados = ESTADO.feriados.filter((f) => f.id !== id);
    await registrarAuditoria("Remover feriado/férias", label);
    toast("Removido. Reorganizando cronograma...");
    await reagendarTudo(true);
  } catch (err) {
    console.error(err);
    toast("Erro ao remover: " + err.message);
  }
}

function iniciarSincronizacaoFeriados() {
  if (ESTADO.unsubscribeFeriados) ESTADO.unsubscribeFeriados();
  const q = query(collection(db, "feriados"), orderBy("dataInicio"));
  ESTADO.unsubscribeFeriados = onSnapshot(q, (snap) => {
    ESTADO.feriados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderFeriados();
    renderCalendar();
  }, (err) => {
    console.error(err);
    toast("Erro ao ler feriados: " + err.message);
  });
}

function renderFeriados() {
  const table = $("#feriadosTable");
  if (!table) return;

  const termo = ESTADO.filtros.feriados;
  const feriados = ESTADO.feriados.filter((f) => {
    if (!termo) return true;
    const alvo = `${f.label || ""} ${f.tipo || ""}`.toLowerCase();
    return alvo.includes(termo);
  });

  $("#feriadosCount").textContent = `${feriados.length} datas`;
  table.innerHTML = `<thead><tr><th>Tipo</th><th>Descrição</th><th>Início</th><th>Fim</th><th></th></tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  feriados.forEach((f) => {
    const tr = document.createElement("tr");
    const [ai, am, ad] = f.dataInicio.split("-");
    const [bi, bm, bd] = f.dataFim.split("-");
    tr.innerHTML = `<td>${f.tipo === "feriado" ? "Feriado" : "Férias"}</td><td>${escapeHtml(f.label)}</td>
      <td>${ad}/${am}/${ai}</td><td>${bd}/${bm}/${bi}</td>`;
    const tdBtn = document.createElement("td");
    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost";
    btnDel.textContent = "Remover";
    btnDel.addEventListener("click", () => removerFeriado(f.id, f.label));
    tdBtn.appendChild(btnDel);
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });
}

const FONT_NAME = "Arial";
const COR_HEADER = "FF1F4E78";
const COR_BANDA = "FFEEF3F8";
const COR_BORDA = "FFBFBFBF";
const STATUS_COND_COLORS = { RUIM: "FFF8CBAD", RAZOAVEL: "FFFFE699", BOM: "FFC6E0B4" };
const STATUS_PREV_COLORS = {
  Pendente: { fill: "FFF8CBAD", font: "FFC00000" },
  "Em andamento": { fill: "FFFFE699", font: "FF9C6500" },
  "Concluída": { fill: "FFC6E0B4", font: "FF375623" },
};
const NOME_ORGAO = "ASSEMBLEIA LEGISLATIVA DO ESTADO DO CEARÁ";
const NOME_SISTEMA = "Sistema de Planejamento da Manutenção Preventiva";
const NOME_MARCA = "PCM ALCE";

function colLetra(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function bordaFina() {
  const b = { style: "thin", color: { argb: COR_BORDA } };
  return { top: b, left: b, right: b, bottom: b };
}

function normalizarStatusPreventiva(valor) {
  const t = String(valor || "").trim().toUpperCase();
  if (t.includes("CONCL")) return "Concluída";
  if (t.includes("ANDAMENTO") || t.includes("EXECU")) return "Em andamento";
  return "Pendente";
}

function adicionarCabecalho(ws, ultimaColuna) {
  ultimaColuna = Math.max(ultimaColuna, 2);
  const linhas = [
    [NOME_ORGAO, 13, true],
    [NOME_SISTEMA, 11, false],
    [NOME_MARCA, 17, true],
  ];
  linhas.forEach(([texto, tam, negrito], i) => {
    const linha = i + 1;
    ws.mergeCells(linha, 1, linha, ultimaColuna);
    for (let c = 1; c <= ultimaColuna; c++) {
      const cell = ws.getCell(linha, c);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_HEADER } };
    }
    const cell = ws.getCell(linha, 1);
    cell.value = texto;
    cell.font = { name: FONT_NAME, size: tam, bold: negrito, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(linha).height = linha === 3 ? 30 : 24;
  });
  return 5;
}

function calcularKpis(itens) {
  const total = itens.length;
  const concluidas = itens.filter((i) => normalizarStatusPreventiva(i.statusPreventiva) === "Concluída").length;
  const andamento = itens.filter((i) => normalizarStatusPreventiva(i.statusPreventiva) === "Em andamento").length;
  const pendentes = total - concluidas - andamento;
  const execucaoPct = total ? Math.round((concluidas / total) * 1000) / 10 : 0;
  const pisos = new Set(itens.filter((i) => i.pisoPCM !== 99).map((i) => i.pisoPCM)).size;
  const criticos = itens.filter((i) => String(i.statusCondicao || "").toUpperCase().includes("RUIM")).length;
  const equipes = new Set(itens.filter((i) => i.equipeResponsavel).map((i) => i.equipeResponsavel)).size;
  return { total, concluidas, andamento, pendentes, execucaoPct, pisos, criticos, equipes };
}

function formulasStatus(referencias) {
  if (!referencias) return null;
  const { colStatusPrev, colAmbiente, primeiraLinha, ultimaLinha } = referencias;
  const faixaStatus = `Cronograma!$${colStatusPrev}$${primeiraLinha}:$${colStatusPrev}$${ultimaLinha}`;
  const faixaTotal = `Cronograma!$${colAmbiente}$${primeiraLinha}:$${colAmbiente}$${ultimaLinha}`;
  return {
    total: `COUNTA(${faixaTotal})`,
    concluidas: `COUNTIF(${faixaStatus},"Concluída")`,
    andamento: `COUNTIF(${faixaStatus},"Em andamento")`,
    pendentes: `COUNTIF(${faixaStatus},"Pendente")`,
    execucao: `IFERROR(COUNTIF(${faixaStatus},"Concluída")/COUNTA(${faixaTotal}),0)`,
  };
}

function escreverKpis(ws, linhaInicio, kpis, referencias) {
  const formulas = formulasStatus(referencias);
  const cartoes = [
    ["Equipamentos", formulas ? formulas.total : kpis.total, "FF1F4E78"],
    ["Concluídas", formulas ? formulas.concluidas : kpis.concluidas, "FF548235"],
    ["Em andamento", formulas ? formulas.andamento : kpis.andamento, "FFBF8F00"],
    ["Pendentes", formulas ? formulas.pendentes : kpis.pendentes, "FFC00000"],
  ];
  let col = 1;
  const largura = 3, espaco = 1;
  const linhaNum = linhaInicio, linhaMeio = linhaInicio + 1, linhaLabel = linhaInicio + 2;

  cartoes.forEach(([label, valor, cor]) => {
    const c1 = col, c2 = col + largura - 1;
    for (const r of [linhaNum, linhaMeio, linhaLabel]) {
      for (let c = c1; c <= c2; c++) {
        const cell = ws.getCell(r, c);
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cor } };
        cell.border = bordaFina();
      }
    }
    ws.mergeCells(linhaNum, c1, linhaMeio, c2);
    const cellNum = ws.getCell(linhaNum, c1);
    cellNum.value = typeof valor === "string" ? { formula: valor } : valor;
    cellNum.font = { name: FONT_NAME, size: 24, bold: true, color: { argb: "FFFFFFFF" } };
    cellNum.alignment = { horizontal: "center", vertical: "middle" };

    ws.mergeCells(linhaLabel, c1, linhaLabel, c2);
    const cellLab = ws.getCell(linhaLabel, c1);
    cellLab.value = label;
    cellLab.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cellLab.alignment = { horizontal: "center", vertical: "middle" };

    col = c2 + 1 + espaco;
  });

  ws.getRow(linhaNum).height = 34;
  ws.getRow(linhaMeio).height = 10;
  ws.getRow(linhaLabel).height = 20;

  const linhaExec = linhaLabel + 2;
  const cellLabelExec = ws.getCell(linhaExec, 1);
  cellLabelExec.value = "Execução:";
  cellLabelExec.font = { name: FONT_NAME, size: 13, bold: true, color: { argb: "FF1F4E78" } };
  const cellValExec = ws.getCell(linhaExec, 2);
  cellValExec.value = formulas ? { formula: formulas.execucao } : kpis.execucaoPct / 100;
  cellValExec.font = { name: FONT_NAME, size: 13, bold: true, color: { argb: "FF1F4E78" } };
  cellValExec.numFmt = "0.0%";

  return linhaExec + 2;
}

function escreverTabelaContagem(ws, colInicio, linhaInicio, titulo, entradas) {
  const c1 = colInicio;
  if (titulo) {
    ws.getCell(linhaInicio, c1).value = titulo;
    ws.getCell(linhaInicio, c1).font = { name: FONT_NAME, bold: true, size: 11 };
  }
  let r = linhaInicio + 1;
  ws.getCell(r, c1).value = "Categoria";
  ws.getCell(r, c1 + 1).value = "Quantidade";
  for (const c of [c1, c1 + 1]) {
    const cell = ws.getCell(r, c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_HEADER } };
    cell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  }
  r++;
  const primeiraLinhaDados = r;
  entradas.forEach(([label, qtd], i) => {
    const cellL = ws.getCell(r, c1);
    cellL.value = String(label);
    const cellQ = ws.getCell(r, c1 + 1);
    cellQ.value = qtd;
    cellL.border = bordaFina();
    cellQ.border = bordaFina();
    cellQ.alignment = { horizontal: "center" };
    if (i % 2 === 0) {
      cellL.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
      cellQ.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
    }
    r++;
  });
  return [primeiraLinhaDados, r - 1];
}

function contarPor(itens, chave) {
  const mapa = new Map();
  itens.forEach((i) => {
    const k = i[chave];
    mapa.set(k, (mapa.get(k) || 0) + 1);
  });
  return mapa;
}

function rotuloPiso(v) {
  if (v === 99) return "Não identificado";
  if (v === 0) return "Térreo/Subsolo";
  return `${v}º Piso`;
}


async function montarPlanilhaOrganizada(itens) {
  const kpis = calcularKpis(itens);
  const workbook = new ExcelJS.Workbook();

  const colunas = [
    ["patrimonio", "Patrimônio"], ["setor", "Setor"], ["ambiente", "Ambiente"],
    ["statusCondicao", "Status Condição"], ["setorPCM", "Setor PCM"], ["pisoPCM", "Piso"],
    ["semanaPlanejada", "Semana Planejada"], ["diaPlanejado", "Dia Planejado"],
    ["equipeResponsavel", "Equipe Responsável"], ["ordemExecucao", "Ordem Execução"],
    ["prioridadeSetor", "Prioridade"], ["statusPreventiva", "Status Preventiva"],
    ["tipoGas", "Tipo de Gás"], ["observacao", "Observação"],
  ];
  const statusPrevIdx = colunas.findIndex(([k]) => k === "statusPreventiva") + 1;
  const ambienteIdx = colunas.findIndex(([k]) => k === "ambiente") + 1;
  const linhaCabecalhoTabela = 5;
  const primeiraLinhaDados = linhaCabecalhoTabela + 1;
  const ultimaLinha = primeiraLinhaDados + itens.length - 1;
  const referencias = {
    primeiraLinha: primeiraLinhaDados,
    ultimaLinha,
    colAmbiente: colLetra(ambienteIdx),
    colStatusPrev: colLetra(statusPrevIdx),
  };
  const formulasResumo = formulasStatus(referencias);

  const ws1 = workbook.addWorksheet("Resumo", { properties: { tabColor: { argb: "FF1F4E78" } } });
  ws1.views = [{ showGridLines: false }];
  let r = adicionarCabecalho(ws1, 2);
  ws1.getCell(r, 1).value = `Gerado em ${new Date().toLocaleString("pt-BR")}`;
  ws1.getCell(r, 1).font = { name: FONT_NAME, italic: true, size: 10, color: { argb: "FF808080" } };
  r += 2;

  const linhasResumo = [
    ["Total de equipamentos", formulasResumo ? { formula: formulasResumo.total } : kpis.total, null],
    ["Pisos atendidos", kpis.pisos, null],
    ["Equipamentos críticos", kpis.criticos, null],
    ["Concluídas", formulasResumo ? { formula: formulasResumo.concluidas } : kpis.concluidas, null],
    ["Em andamento", formulasResumo ? { formula: formulasResumo.andamento } : kpis.andamento, null],
    ["Pendentes", formulasResumo ? { formula: formulasResumo.pendentes } : kpis.pendentes, null],
    ["Execução (%)", formulasResumo ? { formula: formulasResumo.execucao } : kpis.execucaoPct / 100, "0.0%"],
    ["Equipes envolvidas", kpis.equipes, null],
  ];
  linhasResumo.forEach(([label, val, formato], i) => {
    const lc = ws1.getCell(r, 1);
    lc.value = label;
    lc.font = { name: FONT_NAME, size: 11 };
    lc.border = bordaFina();
    const c = ws1.getCell(r, 2);
    c.value = val;
    c.font = { name: FONT_NAME, size: 12, bold: true, color: { argb: "FF1F4E78" } };
    c.alignment = { horizontal: "center" };
    c.border = bordaFina();
    if (i % 2 === 0) {
      lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
    }
    if (formato) c.numFmt = formato;
    r++;
  });

  r += 1;
  const contagemSetor = [...contarPor(itens, "setorPCM").entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  escreverTabelaContagem(ws1, 1, r, "Equipamentos por prioridade", contagemSetor);

  ws1.getColumn(1).width = 48;
  ws1.getColumn(2).width = 20;
  ws1.getColumn(3).width = 4;

  const ws2 = workbook.addWorksheet("Cronograma", { properties: { tabColor: { argb: "FF2E8B7F" } } });
  ws2.views = [{ showGridLines: false, state: "frozen", ySplit: primeiraLinhaDados - 1 }];

  adicionarCabecalho(ws2, colunas.length);
  ws2.getRow(linhaCabecalhoTabela).height = 30;
  colunas.forEach(([, rotulo], i) => {
    const cell = ws2.getCell(linhaCabecalhoTabela, i + 1);
    cell.value = rotulo;
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_HEADER } };
    cell.font = { name: FONT_NAME, size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = bordaFina();
  });

  itens.forEach((item, offset) => {
    const rIdx = primeiraLinhaDados + offset;
    colunas.forEach(([chave], cIdx) => {
      let val = item[chave];
      if (chave === "statusPreventiva") val = normalizarStatusPreventiva(val);
      if (chave === "pisoPCM") val = val === 99 ? "" : val;
      const cell = ws2.getCell(rIdx, cIdx + 1);
      cell.value = val === undefined || val === null ? "" : val;
      cell.font = { name: FONT_NAME, size: 10 };
      cell.border = bordaFina();
      if (offset % 2 === 0) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COR_BANDA } };
      }
    });
  });

  const larguras = { 1: 14, 2: 24, 3: 30, 4: 14, 5: 22, 6: 8, 7: 14, 8: 12, 9: 14, 10: 10, 11: 12, 12: 14, 13: 14, 14: 24 };
  Object.entries(larguras).forEach(([i, w]) => {
    if (Number(i) <= colunas.length) ws2.getColumn(Number(i)).width = w;
  });

  const ultimaColunaLetra = colLetra(colunas.length);
  ws2.autoFilter = `A${linhaCabecalhoTabela}:${ultimaColunaLetra}${ultimaLinha}`;

  const ws3 = workbook.addWorksheet("Dashboard", { properties: { tabColor: { argb: "FFC9A34E" } } });
  ws3.views = [{ showGridLines: false }];
  let r3 = adicionarCabecalho(ws3, 15);
  r3 = escreverKpis(ws3, r3, kpis, referencias);
  r3 += 1;

  const contagemPiso = [...contarPor(itens, "pisoPCM").entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([v, qtd]) => [rotuloPiso(v), qtd]);
  const [, uSetor] = escreverTabelaContagem(ws3, 1, r3, "Equipamentos por prioridade", contagemSetor);
  let proxima = uSetor + 3;
  const [, uPiso] = escreverTabelaContagem(ws3, 1, proxima, "Equipamentos por andar", contagemPiso);

  ws3.getColumn(1).width = 26;
  ws3.getColumn(2).width = 14;

  return workbook;
}

$("#btnExport").addEventListener("click", async () => {
  if (!ESTADO.equipamentos.length) {
    toast("Gere o cronograma primeiro.");
    return;
  }
  toast("Montando planilha...");
  try {
    const workbook = await montarPlanilhaOrganizada(ESTADO.equipamentos);
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const agora = new Date();
    a.href = url;
    a.download = `PCM_ALCE_${agora.getFullYear()}_${String(agora.getMonth() + 1).padStart(2, "0")}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Planilha baixada!");
  } catch (err) {
    console.error(err);
    toast("Erro ao gerar planilha: " + err.message);
  }
});

const btnExportarPDF = $("#btnExportarPDF");
if (btnExportarPDF) {
  btnExportarPDF.addEventListener("click", () => {
    if (!ESTADO.equipamentos.length) {
      toast("Gere o cronograma primeiro.");
      return;
    }
    toast("Gerando relatório PDF...");
    baixarRelatorioPDF(ESTADO.equipamentos, ESTADO.cicloAtual, ESTADO.historico);
  });
}

const btnApagarCronograma = $("#btnApagarCronograma");
if (btnApagarCronograma) {
  btnApagarCronograma.addEventListener("click", apagarCronograma);
}

async function apagarCronograma() {
  if (!ESTADO.equipamentos.length) {
    toast("Não há cronograma para apagar.");
    return;
  }

  const confirmado = window.confirm(
    `Isso vai apagar TODOS os ${ESTADO.equipamentos.length} equipamentos do cronograma atual. Continuar?`
  );
  if (!confirmado) return;

  btnApagarCronograma.disabled = true;
  toast("Apagando cronograma...");
  try {
    await registrarAuditoria("Apagar cronograma", `${ESTADO.equipamentos.length} equipamentos removidos`);
    const ids = ESTADO.equipamentos.map(eq => eq.id);

    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
      const pedaco = ids.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((id) => batch.delete(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", id)));
      await batch.commit();
    }

    ESTADO.equipamentos = [];
    ESTADO.itensCarregados = [];
    ESTADO.diaSelecionado = null;
    ESTADO.config = null;
    try {
      await deleteDoc(doc(db, "config", "cronograma"));
    } catch (e) {
      // pode não existir ainda, tudo bem
    }

    $("#previewCard").hidden = true;
    $("#resumoCapacidade").textContent = "";
    $("#dayDetailCard").hidden = true;

    ESTADO.diasVaziosCronograma = [];
    renderCalendar();
    renderDashboard();
    atualizarBannerAtrasados();
    atualizarAlertaDiasVazios();

    toast(`Cronograma apagado (${ids.length} itens removidos).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar cronograma: " + err.message);
  } finally {
    btnApagarCronograma.disabled = false;
  }
}
const btnApagarDadosTecnicos = $("#btnApagarDadosTecnicos");
if (btnApagarDadosTecnicos) {
  btnApagarDadosTecnicos.addEventListener("click", apagarDadosTecnicos);
}

async function apagarDadosTecnicos() {
  const confirmado = window.confirm(
    "Isso vai apagar TODOS os dados técnicos (Marca, Modelo, Capacidade, Fio, etc.) salvos de TODAS as máquinas permanentemente, voltando o sistema ao estado zero. Continuar?"
  );
  if (!confirmado) return;

  btnApagarDadosTecnicos.disabled = true;
  toast("Apagando dados técnicos do banco...");
  try {
    await registrarAuditoria("Apagar dados técnicos", "Limpou toda a base de informações técnicas");
    
    // Busca todos os documentos salvos na pasta infoCondensadoras
    const snap = await getDocs(collection(db, "infoCondensadoras"));
    const ids = snap.docs.map(d => d.id);

    if (!ids.length) {
      toast("Não há dados técnicos salvos para apagar.");
      btnApagarDadosTecnicos.disabled = false;
      return;
    }

    // Apaga em lotes para não sobrecarregar o Firebase
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
      const pedaco = ids.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((id) => batch.delete(doc(db, "infoCondensadoras", id)));
      await batch.commit();
    }

    toast(`Limpeza concluída! ${ids.length} registros técnicos foram apagados.`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar dados técnicos: " + err.message);
  } finally {
    btnApagarDadosTecnicos.disabled = false;
  }
}

// Corrige aparelhos que ficaram apontando pra uma planta que já não
// existe mais -- de exclusões feitas ANTES da correção de excluir
// planta ter passado a limpar isso junto. Não apaga nada do cadastro,
// só os campos de posição/marcação (plantaId/plantaX/plantaY e o
// equivalente de condensadora).
const btnLimparMarcacoesOrfas = $("#btnLimparMarcacoesOrfas");
if (btnLimparMarcacoesOrfas) {
  btnLimparMarcacoesOrfas.addEventListener("click", limparMarcacoesOrfas);
}

async function limparMarcacoesOrfas() {
  const statusEl = $("#statusLimparOrfas");
  const idsValidos = new Set(ESTADO.plantas.map((p) => p.id));
  const afetados = ESTADO.equipamentos.filter(
    (e) => (e.plantaId && !idsValidos.has(e.plantaId)) || (e.condensadoraPlantaId && !idsValidos.has(e.condensadoraPlantaId))
  );

  if (!afetados.length) {
    toast("Nenhuma marcação órfã encontrada -- está tudo certo.");
    if (statusEl) statusEl.textContent = "Última verificação: nada encontrado.";
    return;
  }

  const confirmado = window.confirm(
    `Encontrei ${afetados.length} aparelho(s) marcado(s) numa planta que já foi excluída. Limpar só a marcação deles (o cadastro não é afetado)?`
  );
  if (!confirmado) return;

  btnLimparMarcacoesOrfas.disabled = true;
  toast("Limpando marcações órfãs...");
  try {
    await registrarAuditoria("Limpar marcações órfãs", `${afetados.length} aparelho(s) corrigido(s)`);
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < afetados.length; inicio += TAMANHO_LOTE) {
      const pedaco = afetados.slice(inicio, inicio + TAMANHO_LOTE);
      const batch = writeBatch(db);
      pedaco.forEach((e) => {
        const campos = {};
        if (e.plantaId && !idsValidos.has(e.plantaId)) {
          campos.plantaId = deleteField(); campos.plantaX = deleteField(); campos.plantaY = deleteField();
          campos.plantaLargura = deleteField(); campos.plantaAltura = deleteField(); campos.plantaAngulo = deleteField();
        }
        if (e.condensadoraPlantaId && !idsValidos.has(e.condensadoraPlantaId)) {
          campos.condensadoraPlantaId = deleteField(); campos.condensadoraX = deleteField(); campos.condensadoraY = deleteField();
        }
        batch.update(doc(db, "ciclos", ESTADO.cicloAtual, "equipamentos", e.id), campos);
      });
      await batch.commit();
    }
    toast(`Corrigido! ${afetados.length} marcação(ões) órfã(s) limpa(s).`);
    if (statusEl) statusEl.textContent = `Última limpeza: ${afetados.length} corrigido(s).`;
  } catch (err) {
    console.error(err);
    toast("Erro ao limpar marcações órfãs: " + err.message);
  } finally {
    btnLimparMarcacoesOrfas.disabled = false;
  }
}

async function apagarColecaoCompleta(nomeColecao, mensagem) {

  if (!ESTADO.cicloAtual) {
    toast("Nenhum ciclo selecionado.");
    return;
  }

  const confirmado = window.confirm(mensagem);
  if (!confirmado) return;

  try {

    const colecaoRef = collection(
      db,
      "ciclos",
      ESTADO.cicloAtual,
      nomeColecao
    );

    const snap = await getDocs(colecaoRef);

    const ids = snap.docs.map((d) => d.id);

    if (!ids.length) {
      toast("Não há registros para apagar.");
      return;
    }

    const TAMANHO_LOTE = 400;

    for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {

      const batch = writeBatch(db);

      ids
        .slice(inicio, inicio + TAMANHO_LOTE)
        .forEach((id) => {

          batch.delete(
            doc(
              db,
              "ciclos",
              ESTADO.cicloAtual,
              nomeColecao,
              id
            )
          );

        });

      await batch.commit();

    }

    toast(`${ids.length} registro(s) apagado(s).`);

  } catch (err) {

    console.error(err);
    toast("Erro ao apagar: " + err.message);

  }
}

const btnLimparHistorico = $("#btnLimparHistorico");
if (btnLimparHistorico) {
  btnLimparHistorico.addEventListener("click", apagarTodoHistoricoTodosOsCiclos);
}

async function apagarTodoHistoricoTodosOsCiclos() {
  const ok = window.confirm(
    "Isso vai apagar TODO o histórico de manutenção de TODOS os ciclos, permanentemente. Continuar?"
  );
  if (!ok) return;
  try {
    const snap = await getDocs(collectionGroup(db, "historico"));
    const refs = snap.docs.map((d) => d.ref);
    if (!refs.length) {
      toast("Não há registros para apagar.");
      return;
    }
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < refs.length; inicio += TAMANHO_LOTE) {
      const batch = writeBatch(db);
      refs.slice(inicio, inicio + TAMANHO_LOTE).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    await registrarAuditoria("Apagar histórico completo", `${refs.length} registros`);
    toast(`${refs.length} registro(s) apagado(s).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar: " + err.message);
  }
}
const btnLimparOrdens = $("#btnLimparOrdens");
if (btnLimparOrdens) {
  btnLimparOrdens.addEventListener("click", apagarTodasOrdensTodosOsCiclos);
}

async function apagarTodasOrdensTodosOsCiclos() {
  const ok = window.confirm(
    "Isso vai apagar TODAS as ordens de serviço de TODOS os ciclos, permanentemente. Continuar?"
  );
  if (!ok) return;
  try {
    const snap = await getDocs(collectionGroup(db, "ordens"));
    const refs = snap.docs.map((d) => d.ref);
    if (!refs.length) {
      toast("Não há registros para apagar.");
      return;
    }
    const TAMANHO_LOTE = 400;
    for (let inicio = 0; inicio < refs.length; inicio += TAMANHO_LOTE) {
      const batch = writeBatch(db);
      refs.slice(inicio, inicio + TAMANHO_LOTE).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    await registrarAuditoria("Apagar todas as ordens", `${refs.length} registros`);
    toast(`${refs.length} registro(s) apagado(s).`);
  } catch (err) {
    console.error(err);
    toast("Erro ao apagar: " + err.message);
  }
}
function gerarPDFPMOC(ordem) {
  const eqFull = ESTADO.equipamentos.find(e => e.id === ordem.equipamentoId) || {};

  const idEquip = escapeHtml(eqFull.patrimonio || ordem.patrimonio || "Sem Patrimônio");
  const setor = eqFull.setorPCM || ordem.setor || "Não informado";
  const ambiente = escapeHtml(eqFull.ambiente || ordem.ambiente || "-");
  const prioridade = eqFull.prioridadeSetor || "-";
  const equipe = escapeHtml(ordem.equipe || eqFull.equipeResponsavel || "-");
  const tecnico = escapeHtml(ordem.tecnico || "");
  const tipoGas = escapeHtml(eqFull.tipoGas || "Não informado");
  const observacao = escapeHtml(eqFull.observacao || "");

  const dataExecucao = ordem.registradoEm
    ? new Date(ordem.registradoEm).toLocaleDateString("pt-BR")
    : (ordem.dataAgendada ? ordem.dataAgendada.split("-").reverse().join("/") : "____/____/20___");

  const checklistFeito = new Set(ordem.checklist || []);
  const nota = Number(ordem.avaliacaoEstrelas) || 0;
  const estrelasHtml = [1, 2, 3, 4, 5]
    .map((n) => `<span style="color:${n <= nota ? "#163A5B" : "#DCE3EA"}">★</span>`)
    .join("");

  const htmlDoc = `
    <html>
      <head>
        <title>OS PMOC - Patrimônio ${idEquip}</title>
        <style>
          @page { 
            size: A4; 
            margin: 10mm; /* Força o navegador a ignorar margens extras onde aparecem os rodapés */
          }
          * { box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            color: #1e293b; 
            margin: 0; 
            background: #fff; 
            font-size: 11.5px; 
            line-height: 1.4;
          }
          .os-page { 
            max-width: 800px; 
            margin: 0 auto; 
            padding: 5mm; /* Respiro interno para o conteúdo não colar nas bordas da folha */
          }
          
          .os-topline { 
            display: flex; 
            justify-content: space-between; 
            border-bottom: 1px solid #cbd5e1; 
            padding-bottom: 12px; 
            margin-bottom: 15px; 
          }
          .org { font-size: 14px; font-weight: 700; color: #0f172a; text-transform: uppercase; letter-spacing: 0.5px; }
          .dept { font-size: 10px; color: #64748b; margin-top: 2px; }
          .title-block { text-align: right; }
          .doc-type { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; }
          .chamado-id { font-family: monospace; font-size: 14px; font-weight: bold; color: #0f172a; }
        
          .os-band { 
            background: #f8fafc; 
            border-left: 3px solid #0f172a;
            padding: 8px 12px; 
            font-weight: 600; 
            margin-bottom: 15px; 
            font-size: 11px;
            color: #334155;
          }
        
          .section-title { 
            font-size: 12px; 
            font-weight: 700; 
            text-transform: uppercase;
            color: #475569;
            border-bottom: 1px solid #f1f5f9; 
            padding-bottom: 4px; 
            margin: 18px 0 10px; 
            letter-spacing: 0.3px;
          }
        
          .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
          .item { background: #fafafa; padding: 6px 8px; border-radius: 4px; border: 1px solid #f1f5f9; }
          .lbl { display: block; font-size: 9px; text-transform: uppercase; color: #64748b; font-weight: 600; }
          .val { font-size: 12px; font-weight: 600; color: #0f172a; margin-top: 2px; }
        
          .checklist { width: 100%; border-collapse: collapse; margin-top: 5px; }
          .checklist th { background: #f8fafc; color: #475569; font-weight: 600; font-size: 10.5px; text-transform: uppercase; }
          .checklist th, .checklist td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
          
          .footer-box {
            margin-top: 30px;
            border-top: 1px solid #e2e8f0;
            padding-top: 15px;
            display: flex;
            justify-content: space-between;
            font-size: 11px;
            color: #475569;
          }
        </style>
      </head>
      <body>
        <div class="os-page">

          <div class="os-topline">
            <div>
              <div class="org">Núcleo de Manutenção Predial</div>
              <div class="dept">Controle PMOC</div>
            </div>
            <div class="title-block">
              <div class="doc-type">Ordem de Serviço (PMOC)</div>
              <div class="chamado-id">Patrimônio: ${idEquip}</div>
            </div>
          </div>

          <div class="section-title">1. Dados do Equipamento e Localização</div>
          <div class="grid">
            <div class="item"><span class="lbl">Patrimônio</span><span class="val">${idEquip}</span></div>
            <div class="item"><span class="lbl">Ambiente</span><span class="val">${ambiente}</span></div>
            <div class="item"><span class="lbl">Prioridade do Setor</span><span class="val">${prioridade}</span></div>
            <div class="item"><span class="lbl">Equipe Responsável</span><span class="val">${equipe}</span></div>
            <div class="item"><span class="lbl">Técnico responsável</span><span class="val">${tecnico || "Não informado"}</span></div>
            <div class="item"><span class="lbl">Data de conclusão</span><span class="val">${dataExecucao}</span></div>
            <div class="item"><span class="lbl">Tipo de Gás</span><span class="val">${tipoGas}</span></div>
          </div>

          <div class="section-title">2. Rotina de Manutenção PMOC — o que foi feito</div>
          <table class="checklist">
            <tr><th style="width: 50px; text-align:center;">OK</th><th>Descrição da Tarefa</th></tr>
            ${CHECKLIST_PREVENTIVA.map((tarefa) => `
              <tr>
                <td style="text-align:center;">${checklistFeito.has(tarefa) ? "✔" : ""}</td>
                <td>${tarefa}</td>
              </tr>
            `).join("")}
          </table>

          <div class="section-title">3. Avaliação do estado da máquina</div>
          <div style="font-size: 18px; letter-spacing: 3px;">${estrelasHtml}</div>

          <div class="section-title">4. Observações e Peças Pendentes</div>
          <div style="border: 1px solid #DCE3EA; min-height: 50px; background: #F6F8FA; padding: 8px 10px; font-size: 12px; color: #334155;">${observacao || "&nbsp;"}</div>

          <div style="margin-top: 18px; font-size: 12px; text-align: right; color: #5B6B7A;">
            Técnico(a): ${tecnico || "_______________________"} &nbsp;&nbsp;&nbsp; Assinatura: _______________________
          </div>

        </div>
      </body>
    </html>
  `;

  const janela = window.open('', '', 'width=800,height=600');
  janela.document.write(htmlDoc);
  janela.document.close();

  janela.setTimeout(function() {
    janela.print();
  }, 250);
}

// Apaga TODOS os ciclos (e suas subcoleções) — usado quando um levantamento
// novo é gerado, já que cada levantamento começa do zero (Ciclo 1).
async function apagarTodosOsCiclos() {
  const snap = await getDocs(collection(db, "ciclos"));
  const TAMANHO_LOTE = 400;
  for (const cicloDoc of snap.docs) {
    for (const sub of ["equipamentos", "historico", "ordens"]) {
      const subSnap = await getDocs(collection(db, "ciclos", cicloDoc.id, sub));
      const ids = subSnap.docs.map((d) => d.id);
      for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((docId) =>
          batch.delete(doc(db, "ciclos", cicloDoc.id, sub, docId))
        );
        await batch.commit();
      }
    }
    await deleteDoc(doc(db, "ciclos", cicloDoc.id));
  }
}

async function deletarCiclo(id) {
  const ok = window.confirm(
    "Excluir este ciclo permanentemente? Isso também apaga os equipamentos, o histórico e as ordens de serviço salvos dentro dele."
  );
  if (!ok) return;
  await registrarAuditoria("Apagar ciclo", `Ciclo ${numeroDoCiclo(id)}`);
  try {
    // Apaga as subcoleções primeiro — apagar o documento do ciclo NÃO apaga
    // o que está dentro dele sozinho, ficaria órfão no Firestore pra sempre.
    for (const sub of ["equipamentos", "historico", "ordens"]) {
      const snap = await getDocs(collection(db, "ciclos", id, sub));
      const ids = snap.docs.map((d) => d.id);
      const TAMANHO_LOTE = 400;
      for (let inicio = 0; inicio < ids.length; inicio += TAMANHO_LOTE) {
        const batch = writeBatch(db);
        ids.slice(inicio, inicio + TAMANHO_LOTE).forEach((docId) =>
          batch.delete(doc(db, "ciclos", id, sub, docId))
        );
        await batch.commit();
      }
    }

    await deleteDoc(doc(db, "ciclos", id));
    toast("Ciclo excluído!");

    // Se apagou o ciclo que estava aberto no momento, troca pra outro válido
    if (id === ESTADO.cicloAtual) {
      await carregarCicloAtual();
      iniciarSincronizacao();
      iniciarSincronizacaoHistorico();
      iniciarSincronizacaoOrdens();
    }
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir ciclo: " + err.message);
  }
}

async function deletarRegistroOrdem(cicloId, id) {
  const ok = window.confirm("Excluir este registro permanentemente?");
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "ciclos", cicloId, "ordens", id));
    toast("Registro excluído!");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
}

async function deletarRegistroHistorico(cicloId, id) {
  const ok = window.confirm("Excluir este registro permanentemente?");
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "ciclos", cicloId, "historico", id));
    toast("Registro excluído!");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
}

async function deletarRegistro(colecao, id) {
  const ok = window.confirm("Excluir este registro permanentemente?");
  if (!ok) return;
  try {
    // Agora ele exclui o item de dentro do ciclo atual!
    await deleteDoc(doc(db, "ciclos", ESTADO.cicloAtual, colecao, id));
    toast("Registro excluído!");
  } catch (err) {
    console.error(err);
    toast("Erro ao excluir: " + err.message);
  }
}

// CONTROLE DO BOTÃO DE REAGENDAR ATRASADOS MANUALMENTE

async function executarReagendamento(btn, textoNormal) {
  btn.disabled = true;
  btn.textContent = "Reagendando...";
  toast("Recalculando rotas e datas. Aguarde...");
  try {
    await reagendarTudo();
    toast("Aparelhos atrasados foram realocados com sucesso!");
    atualizarBannerAtrasados();
  } catch (err) {
    console.error(err);
    toast("Erro ao reagendar: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = textoNormal;
  }
}

const btnReagendar = document.getElementById("btnReagendarAtrasados");
if (btnReagendar) {
  btnReagendar.addEventListener("click", () => executarReagendamento(btnReagendar, "Reagendar Agora"));
}

const btnReagendarCalendario = document.getElementById("btnReagendarCalendario");
if (btnReagendarCalendario) {
  btnReagendarCalendario.addEventListener("click", () => executarReagendamento(btnReagendarCalendario, "↻ Reagendar atrasados"));
}

function numeroDoCiclo(id) {
  const ordenado = [...ESTADO.ciclos].sort((a, b) =>
    String(a.criadoEm || a.dataInicio || "").localeCompare(String(b.criadoEm || b.dataInicio || "")));
  const idx = ordenado.findIndex((c) => c.id === id);
  return idx === -1 ? ordenado.length + 1 : idx + 1;
}

// ------------------------------------------------------------------
// Ciclos de 4 meses — fecha quando todos concluem e reagenda o próximo
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// Ciclos de 4 meses — fecha quando todos concluem e reagenda o próximo
// ------------------------------------------------------------------
function iniciarSincronizacaoCiclos() {
  if (ESTADO.unsubscribeCiclos) ESTADO.unsubscribeCiclos();
  
  const q = query(collection(db, "ciclos"));
  
  ESTADO.unsubscribeCiclos = onSnapshot(q, (snap) => {
    ESTADO.ciclos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const dataA = a.dataFechamento || a.criadoEm || a.dataInicio || "";
        const dataB = b.dataFechamento || b.criadoEm || b.dataInicio || "";
        return dataB.localeCompare(dataA);
      });
    renderCiclos();
  }, (err) => {
    console.error("Erro na busca de ciclos:", err);
    toast("Erro ao ler ciclos: " + err.message);
  });
}

function renderCiclos() {
  const table = $("#ciclosTable");
  if (!table) return;
  
  const encerrados = ESTADO.ciclos.filter(c => c.dataFechamento);
  const ativos = ESTADO.ciclos.filter(c => !c.dataFechamento);

  $("#ciclosCount").textContent = `${encerrados.length} ciclo(s) encerrado(s) | ${ativos.length} ativo(s)`;

  // Adicionamos a coluna "Ações" no cabeçalho
  table.innerHTML = `<thead><tr>
      <th>Ciclo</th><th>Status</th><th>Início</th><th>Encerramento</th><th>Aparelhos</th>
      <th>No prazo</th><th>Em atraso</th><th>Por prédio</th><th>Ações</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");

  if (!ESTADO.ciclos.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--texto-suave)">Nenhum ciclo encontrado.</td></tr>`;
    return;
  }

  ESTADO.ciclos.forEach((c) => {
    const porPredio = c.porPredio
      ? Object.entries(c.porPredio).map(([local, qtd]) => `${escapeHtml(local)}: ${qtd}`).join(" · ")
      : "-";
      
    const isAtivo = !c.dataFechamento;
    const statusLabel = isAtivo 
      ? `<span class="status-select andamento" style="cursor:default">Em andamento</span>` 
      : `<span class="status-select concluido" style="cursor:default">Encerrado</span>`;
    
    const numeroCiclo = numeroDoCiclo(c.id);
    const dataDeInicio = c.dataInicio || (c.criadoEm ? c.criadoEm.split('T')[0] : '');

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>Ciclo ${numeroCiclo}</strong></td>
      <td>${statusLabel}</td>
      <td>${formatarDataBR(dataDeInicio)}</td>
      <td>${c.dataFechamento ? formatarDataBR(c.dataFechamento) : "-"}</td>
      <td>${c.total || ESTADO.equipamentos.length}</td>
      <td>${c.noPrazo !== undefined ? c.noPrazo : "-"}</td>
      <td>${c.emAtraso !== undefined ? c.emAtraso : "-"}</td>
      <td style="font-size:12px;color:var(--texto-suave)">${porPredio}</td>`;
      
    // CRIANDO A COLUNA DE AÇÕES (ABRIR E APAGAR)
    const tdAcoes = document.createElement("td");
    
    const btnLoad = document.createElement("button");
    btnLoad.className = "btn ghost";
    btnLoad.textContent = "Abrir";
    btnLoad.addEventListener("click", () => {
        selecionarCiclo(c.id);
        irParaAba("dashboard"); // Pula direto pro dashboard quando carregar!
    });
    
    const btnDel = document.createElement("button");
    btnDel.className = "btn ghost";
    btnDel.textContent = "Apagar Tudo";
    btnDel.addEventListener("click", () => deletarCiclo(c.id));
    
    tdAcoes.appendChild(btnLoad);
    tdAcoes.appendChild(btnDel);
    tr.appendChild(tdAcoes);

    tbody.appendChild(tr);
  });
}
async function selecionarCiclo(id) {

    ESTADO.cicloAtual = id;

    iniciarSincronizacao();

    iniciarSincronizacaoHistorico();

    iniciarSincronizacaoOrdens();

    toast("Ciclo carregado.");

}

async function verificarFechamentoCiclo() {
  if (ESTADO.fechandoCiclo) return;
  const itens = ESTADO.equipamentos;
  if (!itens.length) return;

  // Só fecha se o ciclo carregado agora for o ATIVO de verdade — sem essa
  // checagem, abrir um ciclo já encerrado (onde todo mundo já está
  // "Concluída") disparava um fechamento novo só de consultar.
  const cicloInfo = ESTADO.ciclos.find((c) => c.id === ESTADO.cicloAtual);
  if (cicloInfo && cicloInfo.dataFechamento) return;

  if (!itens.every((i) => i.statusPreventiva === "Concluída")) return;

  ESTADO.fechandoCiclo = true;
  try {
    await fecharCicloEIniciarProximo();
  } catch (err) {
    console.error(err);
    toast("Erro ao fechar o ciclo: " + err.message);
  } finally {
    ESTADO.fechandoCiclo = false;
  }
}

function ehDiaUtilConfigAtual(data) {
  const diasSemana = (ESTADO.config && ESTADO.config.diasSemana) || 5;
  const DIAS_UTEIS = NOMES_DIAS.slice(0, diasSemana);
  return DIAS_UTEIS.includes(NOMES_DIAS[(data.getDay() + 6) % 7]) && !estaEmFeriado(data);
}

// Percorre, prédio por prédio, do primeiro ao último dia agendado, e aponta
// dias úteis sem nenhum item — normalmente sobra de feriados cadastrados
// depois que cada aparelho já tinha sua próxima data calculada individualmente.
function detectarDiasVaziosNoCronograma(itens) {
  if (!itens.length) return [];

  const porPredio = new Map();
  itens.forEach((item) => {
    const local = item.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(item);
  });

  const diasVazios = [];
  porPredio.forEach((itensDoPredio, local) => {
    const datasComItem = new Set(itensDoPredio.map((i) => i.dataAgendada).filter(Boolean));
    if (datasComItem.size === 0) return;
    const datasOrdenadas = [...datasComItem].sort();
    const [aI, mI, dI] = datasOrdenadas[0].split("-");
    const [aF, mF, dF] = datasOrdenadas[datasOrdenadas.length - 1].split("-");
    const cursor = new Date(aI, parseInt(mI, 10) - 1, dI, 12, 0, 0);
    const fim = new Date(aF, parseInt(mF, 10) - 1, dF, 12, 0, 0);

    while (cursor <= fim) {
      if (ehDiaUtilConfigAtual(cursor) && !datasComItem.has(formatISO(cursor))) {
        diasVazios.push({ local, data: formatISO(cursor) });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  });

  return diasVazios;
}

// Reorganiza os itens (em memória, ainda não salvos) prédio por prédio,
// preenchendo cada dia útil até a capacidade antes de avançar — igual à
// lógica do gerarCronograma — pra fechar os buracos deixados por feriados.
function compactarCronograma(itens) {
  const capacidades = (ESTADO.config && ESTADO.config.capacidades) || {};

  const primeiraData = itens.reduce((min, i) =>
    (i.dataAgendada && (!min || i.dataAgendada < min)) ? i.dataAgendada : min, null);
  if (!primeiraData) return itens;
  const [aI, mI, dI] = primeiraData.split("-");
  const dataBase = new Date(aI, parseInt(mI, 10) - 1, dI, 12, 0, 0);
  while (!ehDiaUtilConfigAtual(dataBase)) dataBase.setDate(dataBase.getDate() + 1);

  const porPredio = new Map();
  itens.forEach((item) => {
    const local = item.local || "SEDE";
    if (!porPredio.has(local)) porPredio.set(local, []);
    porPredio.get(local).push(item);
  });

  porPredio.forEach((itensDoPredio, local) => {
    const cap = capacidades[local] || { nEquipes: 1, aparelhosDia: 2 };
    const capacidadeDia = Math.max(1, cap.nEquipes) * Math.max(1, cap.aparelhosDia);
    itensDoPredio.sort((a, b) => (a.dataAgendada || "").localeCompare(b.dataAgendada || ""));

    const dataCursor = new Date(dataBase);
    let contador = 0;
    itensDoPredio.forEach((item) => {
      item.dataAgendada = formatISO(dataCursor);
      item.diaPlanejado = NOMES_DIAS[(dataCursor.getDay() + 6) % 7];
      contador++;
      if (contador >= capacidadeDia) {
        contador = 0;
        do { dataCursor.setDate(dataCursor.getDate() + 1); } while (!ehDiaUtilConfigAtual(dataCursor));
      }
    });
  });

  itens.forEach((item) => {
    const [a, m, d] = item.dataAgendada.split("-");
    const dt = new Date(a, parseInt(m, 10) - 1, d, 12, 0, 0);
    const diffDias = Math.floor((dt - dataBase) / 86400000);
    item.semanaPlanejada = `Semana ${Math.max(1, Math.floor(diffDias / 7) + 1)}`;
  });

  itens.sort((a, b) => (a.dataAgendada || "").localeCompare(b.dataAgendada || ""));
  itens.forEach((item, idx) => { item.ordemExecucao = idx + 1; });
  return itens;
}

async function fecharCicloEIniciarProximo() {
  const itens = ESTADO.equipamentos;
  const hojeISO = formatISO(new Date());
  const cicloAntigoId = ESTADO.cicloAtual;

  const porPredio = {};
  let noPrazo = 0, emAtraso = 0;
  itens.forEach((i) => {
    const local = i.local || "SEDE";
    porPredio[local] = (porPredio[local] || 0) + 1;
    const concl = i.dataConclusao || hojeISO;
    if (i.dataAgendada && concl > i.dataAgendada) emAtraso++; else noPrazo++;
  });

  await updateDoc(doc(db, "ciclos", cicloAntigoId), {
    status: "Encerrado", dataFechamento: hojeISO, total: itens.length, noPrazo, emAtraso, porPredio,
  });

  // Usa a próxima data já calculada individualmente pra cada aparelho (na
  // hora que ele foi concluído) — não recalcula tudo em bloco aqui.
  const datasProximas = itens.map((i) => i.proximaPreventiva).filter(Boolean).sort();
  const menorData = datasProximas.length ? datasProximas[0] : hojeISO;

  const novosItens = itens.map((item) => {
    const dataFinal = item.proximaPreventiva || hojeISO;
    const diffDias = Math.floor((new Date(dataFinal) - new Date(menorData)) / 86400000);
    return {
      ...item,
      dataAgendada: dataFinal,
      diaPlanejado: item.proximaPreventivaDia || item.diaPlanejado,
      semanaPlanejada: `Semana ${Math.max(1, Math.floor(diffDias / 7) + 1)}`,
      statusPreventiva: "Pendente",
      dataConclusao: "",
      proximaPreventiva: "",
      proximaPreventivaDia: "",
    };
  });
  novosItens.sort((a, b) => (a.dataAgendada || "").localeCompare(b.dataAgendada || ""));
  novosItens.forEach((item, idx) => { item.ordemExecucao = idx + 1; });

  ESTADO.diasVaziosCronograma = detectarDiasVaziosNoCronograma(novosItens);

  const novoCicloRef = doc(collection(db, "ciclos"));
  await setDoc(novoCicloRef, { criadoEm: new Date().toISOString(), dataInicio: menorData, status: "Ativo" });

  const TAMANHO_LOTE = 400;
  for (let inicio = 0; inicio < novosItens.length; inicio += TAMANHO_LOTE) {
    const pedaco = novosItens.slice(inicio, inicio + TAMANHO_LOTE);
    const batch = writeBatch(db);
    pedaco.forEach((item) => batch.set(doc(db, "ciclos", novoCicloRef.id, "equipamentos", item.id), item));
    await batch.commit();
  }

  ESTADO.cicloAtual = novoCicloRef.id;
  ESTADO.config = { ...(ESTADO.config || {}), dataInicio: menorData };
  await setDoc(doc(db, "config", "cronograma"), ESTADO.config);

  iniciarSincronizacao();
  iniciarSincronizacaoHistorico();
  iniciarSincronizacaoOrdens();

  toast(`Ciclo encerrado! Novo ciclo iniciado com as datas individuais de cada aparelho.`);

  if (ESTADO.diasVaziosCronograma.length > 0) {
    irParaAba("calendar");
  }
}

// Limpar seleção: Ordens
$("#btnLimparSelecaoOrdens")?.addEventListener("click", () => {
  ESTADO.selecaoOrdens.clear();
  
  const checkTodos = $("#checkTodosOrdens");
  if (checkTodos) checkTodos.checked = false;
  
  atualizarBarraSelecao("selecaoOrdens", "selecaoOrdens", "selecaoOrdensTexto");
  renderOrdens(); 
});

// Limpar seleção: Histórico
$("#btnLimparSelecaoHistorico")?.addEventListener("click", () => {
  ESTADO.selecaoHistorico.clear();
  
  const checkTodos = $("#checkTodosHistorico");
  if (checkTodos) checkTodos.checked = false;
  
  atualizarBarraSelecao("selecaoHistorico", "selecaoHistorico", "selecaoHistoricoTexto");
  renderHistorico(); 
});
