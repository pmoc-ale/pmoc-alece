// Helpers puros de identidade de usuário (login <-> e-mail sintético do
// Firebase Auth, rótulo de permissão) -- sem ESTADO/DOM/Firebase.
// Extraído do app.js; ver utils/formatacao.js pro resto das funções puras.
export const SUFIXO_LOGIN = "@pcm-alece.local";
export function usuarioParaEmail(usuario) {
  return usuario.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "") + SUFIXO_LOGIN;
}
export function extrairUsuario(email) {
  return String(email || "").split("@")[0];
}

export const ROTULOS_PERMISSAO = { admin: "Administrador", padrao: "Padrão", trabalhador: "Trabalhador" };
