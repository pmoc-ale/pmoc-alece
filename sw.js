// Service worker do PMOC ALECE -- guarda uma cópia do site no aparelho
// pra ele continuar abrindo mesmo numa sala/subsolo sem sinal nenhum.
//
// IMPORTANTE sobre CACHE_VERSAO: mude essa string sempre que publicar
// uma correção que precisa chegar em quem está offline (o normal já
// acontece sozinho -- toda vez que tem sinal, o site busca a versão nova
// na rede antes de qualquer cache, ver estratégia "rede primeiro" abaixo
// -- isso aqui só limpa versões antigas que sobraram no aparelho).
const CACHE_VERSAO = "pmoc-alece-v1";

// SEM os "?v=NN" de cache-busting -- index.html/app.js mudam esse número
// toda vez que o código muda, e escrever o número aqui de novo (fácil de
// esquecer) deixaria essa lista desatualizada sozinha. A busca por
// arquivo (ver chavePorCaminho) ignora a "?v=" tanto pra guardar quanto
// pra achar no cache, então funciona do mesmo jeito não importa a versão.
const ARQUIVOS_ESSENCIAIS = [
  "./",
  "./index.html",
  "./styles.css",
  "./firebase-config.js",
  "./app.js",
  "./utils/qrcode.js",
  "./utils/pdfGenerator.js",
  "./utils/dwfParser.js",
  "./site-header-mobile.png",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

// Guarda/acha no cache pelo CAMINHO só, sem a "?v=NN" -- assim uma
// mudança de versão do arquivo não vira um cache "perdido" (que nunca
// bate com o que a página está pedindo de verdade) nem precisa de
// nenhuma edição aqui no service worker.
function chavePorCaminho(url) {
  return new Request(url.origin + url.pathname);
}

self.addEventListener("install", (event) => {
  // Um por um (não cache.addAll, que é tudo ou nada) -- se UM arquivo
  // falhar (rede instável bem na hora de instalar, um link quebrado no
  // futuro etc.), os outros continuam sendo guardados normalmente, em
  // vez do modo offline inteiro ficar desativado até alguém notar.
  event.waitUntil(
    caches.open(CACHE_VERSAO).then((cache) =>
      Promise.all(
        ARQUIVOS_ESSENCIAIS.map((url) =>
          cache.add(url).catch((err) => console.warn("Não consegui guardar em cache:", url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(chaves.filter((c) => c !== CACHE_VERSAO).map((c) => caches.delete(c)))
    )
  );
  self.clients.claim();
});

// Nunca guarda em cache (nem intercepta) chamadas pro Firebase/Firestore,
// Cloudinary ou os Workers da Cloudflare -- essas já têm sua própria
// lógica de rede/fila offline (ver ESTADO no app.js e a fila de fotos
// pendentes), e um service worker no meio delas só aumentaria o risco de
// bug estranho (ex: parecer "salvo" sem ter sido de verdade).
const ORIGENS_IGNORADAS = [
  "firestore.googleapis.com",
  "identitytoolkit.googleapis.com",
  "googleapis.com",
  "google.com",
  "cloudinary.com",
  "workers.dev",
];

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // nunca mexe em POST (upload de foto, etc.)

  const url = new URL(req.url);
  if (ORIGENS_IGNORADAS.some((o) => url.hostname.includes(o))) return;

  if (url.origin === self.location.origin) {
    // Arquivos do próprio site: tenta a rede primeiro (assim, com sinal,
    // sempre pega a versão mais nova -- nunca fica "preso" numa versão
    // antiga por causa do cache). Só usa o que está guardado se a rede
    // falhar de verdade (sem sinal).
    const chave = chavePorCaminho(url);
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copia = resp.clone();
          caches.open(CACHE_VERSAO).then((cache) => cache.put(chave, copia));
          return resp;
        })
        .catch(() =>
          caches.match(chave).then((resp) => resp || caches.match("./index.html"))
        )
    );
  } else if (url.hostname === "www.gstatic.com" && url.pathname.includes("/firebasejs/")) {
    // SDK do Firebase: o link já inclui a versão exata (10.12.2) no
    // caminho -- o conteúdo nunca muda pra essa URL, então não tem risco
    // de ficar desatualizado guardando ele. Usa do cache se já tiver;
    // busca e guarda na primeira vez.
    event.respondWith(
      caches.match(req).then(
        (cacheado) =>
          cacheado ||
          fetch(req).then((resp) => {
            const copia = resp.clone();
            caches.open(CACHE_VERSAO).then((cache) => cache.put(req, copia));
            return resp;
          })
      )
    );
  }
  // Qualquer outra coisa (CDN de planilha/PDF/OCR, link de corretivas
  // externo etc.) passa direto, sem mexer -- não é essencial pro
  // técnico continuar marcando preventiva numa sala sem sinal, e mexer
  // nelas só aumentaria o risco sem necessidade.
});
