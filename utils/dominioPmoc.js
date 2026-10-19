// Regras de classificação específicas do PMOC ALECE (prioridade de setor,
// piso, achar coluna de planilha) -- puras, sem ESTADO/DOM/Firebase.
// Extraído do app.js; ver utils/formatacao.js pro resto das funções puras.
import { normalizarBusca, normalizarTexto } from "./formatacao.js";

export const PRIORIDADE = {
  "1 - Presidência": 1, "2 - Primeiro Secretário": 2, "3 - Gabinetes": 3,
  "4 - TI/Racks": 4, "5 - Plenário": 5, "6 - Administração": 6, "7 - Todo o resto": 7,
};
export const NOMES_DIAS = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

export function identificarSetor(setorTxt, ambienteTxt) {
  const texto = `${setorTxt || ""} ${ambienteTxt || ""}`.toUpperCase();
  if (/PRESID/.test(texto)) return "1 - Presidência";
  if (/1[ºªA]?\s*SECRETARIA|SECRETARI[OA]/.test(texto)) return "2 - Primeiro Secretário";
  if (/\bGABINETE\b/.test(texto)) return "3 - Gabinetes";
  if (/\bSERVIDOR\b|\bREDE\b|INFRAESTRUTURA|\bRACK\b|\bCPD\b|DESENVOLVIMENTO/.test(texto)) return "4 - TI/Racks";
  if (/PLEN[ÁA]RIO/.test(texto)) return "5 - Plenário";
  if (/PROTOCOLO|REPROGRAFIA|ADMINISTR/.test(texto)) return "6 - Administração";
  return "7 - Todo o resto";
}

export function descobrirPiso(setorTxt) {
  if (!setorTxt) return 99;
  const texto = String(setorTxt).toUpperCase();
  if (texto.includes("SUBSOLO") || texto.includes("TÉRREO") || texto.includes("TERREO")) return 0;
  const m = texto.match(/(\d+)\s*[ºÂ°]?\s*PISO/);
  if (m) return parseInt(m[1], 10);
  return 99;
}

// Consolida grafias diferentes do mesmo tipo de equipamento -- cada
// prédio escreveu a coluna "Tipo Equip." do levantamento do jeito que
// quis (maiúscula, sinônimo em português tipo "parede" pra "Hi-Wall"
// etc.). Só junta os casos onde dá pra ter certeza que é a mesma coisa;
// o que não reconhece (um "Split" genérico, condensadora de VRF,
// equipamento de ventilação...) fica como veio, só sem espaço duplicado
// -- melhor mostrar cru do que arriscar juntar tipos diferentes.
const MAPA_TIPO_EQUIPAMENTO = {
  "SPLIT HI-WALL": "Split Hi-Wall",
  "HIWALL INVERTER": "Split Hi-Wall",
  "SPLIT PAREDE": "Split Hi-Wall", // "parede" = montado na parede = Hi-Wall
  "CASSETE": "Cassete",
  "SPLIT PISO/TETO": "Split Piso/Teto",
  "SPLIT TETO": "Split Piso/Teto",
  "SPLIT PISO": "Split Piso/Teto",
  "DUTO": "Duto",
};
export function normalizarTipoEquipamento(valorCru) {
  const texto = String(valorCru || "").trim().replace(/\s+/g, " ");
  if (!texto) return "";
  return MAPA_TIPO_EQUIPAMENTO[texto.toUpperCase()] || texto;
}

// Acha patrimônio repetido ANTES de importar, pra avisar em vez de
// silenciosamente criar um cadastro duplicado (ver contagemPorPatrimonio
// em linhasParaItens, que só desempata o ID -- continua desempatando
// normalmente, isso aqui é só o aviso, não muda esse comportamento).
// Duas listas separadas: patrimônio que se repete DENTRO da própria
// planilha (provável erro de digitação) e patrimônio que já existe no
// cadastro só que num prédio diferente do que a planilha está trazendo
// agora (o mesmo prédio é o caminho normal de "atualizar quem já existe",
// não um conflito). Campo vazio nunca conta como duplicidade.
export function detectarPatrimoniosDuplicados(itens, equipamentosExistentes = []) {
  const porPatrimonio = new Map();
  itens.forEach((item, idx) => {
    if (!item.patrimonio) return;
    const chave = normalizarTexto(item.patrimonio);
    if (!chave) return;
    if (!porPatrimonio.has(chave)) porPatrimonio.set(chave, []);
    porPatrimonio.get(chave).push({
      linha: idx + 2, // +2: header ocupa a linha 1 da planilha
      patrimonio: item.patrimonio,
      setor: item.setor,
      ambiente: item.ambiente,
      local: item.local,
    });
  });

  const duplicadosNaPlanilha = [];
  for (const ocorrencias of porPatrimonio.values()) {
    if (ocorrencias.length > 1) duplicadosNaPlanilha.push({ patrimonio: ocorrencias[0].patrimonio, ocorrencias });
  }

  const porPatrimonioExistente = new Map();
  equipamentosExistentes.forEach((e) => {
    if (!e.patrimonio) return;
    const chave = normalizarTexto(e.patrimonio);
    if (!porPatrimonioExistente.has(chave)) porPatrimonioExistente.set(chave, []);
    porPatrimonioExistente.get(chave).push(e);
  });

  const conflitosComCadastro = [];
  for (const [chave, ocorrencias] of porPatrimonio.entries()) {
    const existentes = porPatrimonioExistente.get(chave) || [];
    const prediosDiferentes = existentes.filter((e) =>
      !ocorrencias.some((o) => normalizarTexto(o.local) === normalizarTexto(e.local))
    );
    if (prediosDiferentes.length) {
      conflitosComCadastro.push({
        patrimonio: ocorrencias[0].patrimonio,
        prediosNaPlanilha: [...new Set(ocorrencias.map((o) => o.local || "SEDE"))],
        prediosNoCadastro: [...new Set(prediosDiferentes.map((e) => e.local || "SEDE"))],
      });
    }
  }

  return { duplicadosNaPlanilha, conflitosComCadastro };
}

// Agrupa preventivas por mês de agendamento (dataAgendada), pro gráfico
// "Status das preventivas por mês" do Dashboard -- cada aparelho conta
// uma vez só, no status de HOJE (não um histórico de status passado, que
// o sistema não guarda por mês). hojeISO é parâmetro (não "new Date()"
// direto) só pra essa função dar pra testar sem depender da data real da
// máquina. A mesma regra de "atrasado" do estaAtrasado() em app.js
// (dataAgendada no passado e ainda não concluída), só reescrita aqui
// porque essa função é pura (sem ESTADO/DOM) e aquela não.
export function agruparPreventivasPorMes(itens, hojeISO) {
  const porMes = new Map();
  itens.forEach((item) => {
    if (!item.dataAgendada) return;
    const mes = item.dataAgendada.slice(0, 7); // "AAAA-MM"
    if (!porMes.has(mes)) porMes.set(mes, { mes, concluidas: 0, atrasadas: 0, pendentes: 0 });
    const bucket = porMes.get(mes);
    if (item.statusPreventiva === "Concluída") bucket.concluidas++;
    else if (item.dataAgendada < hojeISO) bucket.atrasadas++;
    else bucket.pendentes++;
  });
  return [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes)).slice(-12);
}

export function localizarColuna(nomesPossiveis, headers) {
  // normalizarBusca tira acento além de maiúscula/minúscula -- sem isso,
  // um cabeçalho tipo "Potencia (BTU)" (sem acento) não batia com
  // "Potência" e a coluna inteira ficava em branco sem avisar nada
  // (só "Patrimônio"/"Gás" tinham as duas grafias cadastradas à mão;
  // qualquer outra coluna acentuada tinha o mesmo risco).
  const normalizados = headers.map((h) => normalizarBusca(h));
  for (const nome of nomesPossiveis) {
    const idx = normalizados.indexOf(normalizarBusca(nome));
    if (idx !== -1) return headers[idx];
  }
  for (let i = 0; i < headers.length; i++) {
    for (const nome of nomesPossiveis) {
      if (normalizados[i].includes(normalizarBusca(nome))) return headers[i];
    }
  }
  return null;
}
