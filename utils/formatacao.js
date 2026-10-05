// Funções puras de texto/data, sem nenhuma dependência de ESTADO, DOM ou
// Firebase -- por isso dá pra mover pra fora do app.js em segurança (são
// só entrada -> saída, sempre o mesmo resultado pro mesmo argumento).
// Extraído do app.js pra ele não continuar crescendo como um arquivo só;
// ver mais extrações assim em utils/dominioPmoc.js e utils/identidadeUsuario.js.

// Protege contra HTML/script escondido em texto vindo de fora (planilha
// importada, formulário público de chamados, campos digitados por usuários)
// antes de inserir na tela via innerHTML. Sem isso, alguém poderia escrever
// algo tipo <script> num campo de texto e rodar código no navegador de quem
// visse aquele dado depois.
export function escapeHtml(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function normalizarTexto(v) {
  return String(v || "").trim().toUpperCase();
}

// Usado nas caixas de busca (equipamentos, condensadoras, feriados, ordens,
// histórico) -- sem isso, buscar "secretaria" não achava "Secretária" e
// "administracao" não achava "Administração" (o .toLowerCase() sozinho já
// ignora maiúscula/minúscula, mas não ignora acento nenhum). O
// normalize("NFD") separa a letra do acento (é́ em vez de é) e o
// replace tira só a parte do acento, sobrando a letra "pelada".
export function normalizarBusca(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function formatISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
export function formatarDataBR(iso) {
  if (!iso) return "-";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

export function adicionarMeses(date, meses) {
  const d = new Date(date.getTime());
  const diaOriginal = d.getDate();
  d.setMonth(d.getMonth() + meses);
  if (d.getDate() !== diaOriginal) d.setDate(0);
  return d;
}
