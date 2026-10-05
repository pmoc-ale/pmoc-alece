// Regras de classificação específicas do PMOC ALECE (prioridade de setor,
// piso, achar coluna de planilha) -- puras, sem ESTADO/DOM/Firebase.
// Extraído do app.js; ver utils/formatacao.js pro resto das funções puras.
import { normalizarBusca } from "./formatacao.js";

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
