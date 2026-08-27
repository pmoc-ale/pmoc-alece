// Lê um pacote .dwf/.dwfx (exportado do AutoCAD, "Plotar" -> DWF/DWFx)
// inteiramente no navegador e devolve o desenho vetorial pronto pra
// desenhar em SVG: linhas/formas reais (não é imagem), já separadas por
// camada (layer) do CAD original.
//
// Como funciona, resumido: um .dwfx é um .zip (formato XPS por baixo).
// Duas partes internas nos interessam:
//   - um "FixedPage.fpage" com a geometria completa de cada objeto (um
//     <Path> por objeto, com a cor/traço certos);
//   - um recurso "W2X" (XML) que é o único lugar onde sobra a informação
//     de CAMADA de cada objeto -- sem ele, dá pra desenhar a planta, mas
//     não dá pra saber o que é parede, o que é tubulação, o que é
//     equipamento.
// Os dois usam o mesmo esquema de identificador (ex: "..._650") pra cada
// objeto, então cruzamos um com o outro por esse número.
//
// Isso não é um formato documentado publicamente -- foi descoberto abrindo
// um arquivo real exportado do AutoCAD 2026. Pode variar entre versões do
// AutoCAD ou entre arquivos sem os recursos esperados (nesse caso as
// funções abaixo lançam um erro explicando o que faltou, em vez de
// desenhar algo errado silenciosamente). Um .dwf "simples" (sem o recurso
// W2X) ainda é lido, só que sem separação por camada -- tudo cai numa
// camada só ("SEM_CAMADA").

const DWF_EQUIP_LAYER_HINTS = ["EQUIP", "AC0", "ARC_", "CLIMA", "EVAP", "COND"];

function dwfNumeroDoRefName(refName) {
  const m = /_(\d+)$/.exec(refName || "");
  return m ? parseInt(m[1], 10) : null;
}

function dwfParseXml(texto) {
  return new DOMParser().parseFromString(texto, "application/xml");
}

// Acha, dentro do zip, o par (FixedPage, recurso W2X) do desenho -- usando
// o manifest.xml pra localizar os caminhos de verdade, em vez de supor
// nomes fixos (cada arquivo tem GUIDs diferentes).
async function dwfLocalizarRecursos(zip) {
  const nomes = Object.keys(zip.files);
  const manifestNome = nomes.find((n) => /manifest\.xml$/i.test(n) && !n.includes("_rels"));
  if (!manifestNome) throw new Error("Não encontrei o manifest.xml dentro do arquivo.");
  const manifestTexto = await zip.files[manifestNome].async("string");
  const manifestDoc = dwfParseXml(manifestTexto);

  const secoesEPlot = [...manifestDoc.getElementsByTagName("dwf:Section")].filter(
    (s) => s.getAttribute("type") === "com.autodesk.dwf.ePlot"
  );
  if (!secoesEPlot.length) throw new Error("Esse arquivo não tem nenhuma folha de desenho (seção ePlot) reconhecível.");

  // Usa a primeira seção -- os arquivos que recebemos até agora sempre
  // trazem uma folha por planta. Tanto a página do desenho quanto o
  // recurso de camadas (W2X) já aparecem aqui como dwf:Resource,
  // identificados pelo atributo "role".
  const secao = secoesEPlot[0];
  const recursos = [...secao.getElementsByTagName("dwf:Resource")];
  const achar = (role) => recursos.find((r) => r.getAttribute("role") === role);

  const recFixedPage = achar("2d streaming graphics");
  if (!recFixedPage) throw new Error("Não encontrei a página com o desenho (2d streaming graphics) nesse arquivo.");
  let fpageHref = recFixedPage.getAttribute("href") || "";
  fpageHref = fpageHref.split("?")[0].replace(/^\//, "");

  // O recurso W2X (camadas) só existe se o AutoCAD exportou com esse extra
  // -- em arquivos .dwf mais antigos (não .dwfx) costuma não existir.
  const recExtensao = achar("2d graphics extension");
  const w2xHref = recExtensao ? recExtensao.getAttribute("href").replace(/^\//, "") : null;

  const acharArquivo = (href) => {
    const alvo = href.replace(/\\/g, "/");
    return nomes.find((n) => n.replace(/\\/g, "/") === alvo || n.replace(/\\/g, "/").endsWith(alvo.split("/").pop()));
  };

  const fpageNome = acharArquivo(fpageHref);
  if (!fpageNome) throw new Error("O arquivo indicado como página do desenho não está dentro do pacote.");

  const w2xNome = w2xHref ? acharArquivo(w2xHref) : null;

  return { fpageNome, w2xNome };
}

// Percorre o W2X (que é um fluxo sequencial, tipo um "player" de comandos)
// mantendo a camada "atual" -- cada RenditionSync muda o que vem depois,
// até o próximo. Camadas repetidas vêm só como número (Number=), sem
// repetir o nome, então é preciso lembrar nome<->número também.
function dwfAnalisarW2X(texto) {
  const doc = dwfParseXml(texto);
  const root = doc.documentElement;

  const layerOf = new Map(); // numero do objeto -> nome da camada
  const numeroParaNome = new Map();
  let camadaAtual = null;

  const clusters = []; // agrupamentos de círculos/arcos consecutivos (candidatos a símbolo de equipamento)
  let clusterAtual = null;

  for (const el of Array.from(root.childNodes)) {
    if (el.nodeType !== 1) continue; // só elementos
    if (el.tagName === "RenditionSync") {
      for (const c of Array.from(el.childNodes)) {
        if (c.nodeType !== 1 || c.tagName !== "Layer") continue;
        const nome = c.getAttribute("Name");
        const numero = c.getAttribute("Number");
        if (nome !== null && numero !== null) {
          numeroParaNome.set(numero, nome);
          camadaAtual = nome;
        } else if (numero !== null) {
          camadaAtual = numeroParaNome.has(numero) ? numeroParaNome.get(numero) : camadaAtual;
        } else if (nome !== null) {
          camadaAtual = nome;
        }
      }
      continue;
    }
    const refName = el.getAttribute("refName");
    if (!refName) continue;
    const n = dwfNumeroDoRefName(refName);
    if (n === null) continue;
    layerOf.set(n, camadaAtual);

    if (el.tagName === "Outline_Ellipse" || el.tagName === "Filled_Ellipse") {
      if (clusterAtual && clusterAtual.layer === camadaAtual && clusterAtual.lastNum === n) {
        clusterAtual.nums.push(n);
      } else {
        if (clusterAtual) clusters.push(clusterAtual);
        clusterAtual = { layer: camadaAtual, nums: [n], lastNum: n };
      }
      clusterAtual.lastNum = n;
    }
  }
  if (clusterAtual) clusters.push(clusterAtual);

  return { layerOf, clusters };
}

// Lê o FixedPage.fpage: pega os dois RenderTransform aninhados (a página
// inteira vem dentro de dois <Canvas> com transform, sempre nessa ordem) e
// cada <Path> (um por objeto do desenho).
function dwfAnalisarFixedPage(texto) {
  const canvasRe = /<Canvas[^>]*RenderTransform="([^"]*)"[^>]*>/g;
  const transforms = [];
  let m;
  while ((m = canvasRe.exec(texto)) && transforms.length < 2) {
    transforms.push(m[1].split(",").map(Number));
  }
  if (transforms.length < 2) throw new Error("Não encontrei a transformação de coordenadas da planta.");

  const pathRe = /<Path Name="[^"]*_(\d+)"([^>]*)Data="([^"]*)"/g;
  const attrRe = /(Stroke|Fill|StrokeThickness)="([^"]*)"/g;
  const pathOf = new Map();
  let pm;
  while ((pm = pathRe.exec(texto))) {
    const n = parseInt(pm[1], 10);
    const attrsStr = pm[2];
    const d = pm[3];
    let stroke = null, fill = null, sw = null;
    attrRe.lastIndex = 0;
    let am;
    while ((am = attrRe.exec(attrsStr))) {
      if (am[1] === "Stroke") stroke = am[2];
      if (am[1] === "Fill") fill = am[2];
      if (am[1] === "StrokeThickness") sw = am[2];
    }
    pathOf.set(n, { stroke, fill, sw, d });
  }

  return { transformOuter: transforms[0], transformInner: transforms[1], pathOf };
}

function dwfCompoe(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function dwfAplica(matriz, ponto) {
  const [a, b, c, d, e, f] = matriz;
  return [a * ponto[0] + c * ponto[1] + e, b * ponto[0] + d * ponto[1] + f];
}

const DWF_START_RE = /^M(-?[\d.eE+-]+),(-?[\d.eE+-]+)/;

// Função principal: recebe o ArrayBuffer do arquivo .dwf/.dwfx enviado
// (window.JSZip precisa estar carregado). Devolve:
//   { matriz, bbox, layers, entities, marcadoresPorCamada, camadaEquipamentoSugerida }
async function parseDwf(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const { fpageNome, w2xNome } = await dwfLocalizarRecursos(zip);

  const fpageTexto = await zip.files[fpageNome].async("string");
  const { transformOuter, transformInner, pathOf } = dwfAnalisarFixedPage(fpageTexto);
  const matriz = dwfCompoe(transformOuter, transformInner);

  let layerOf = new Map();
  let clusters = [];
  if (w2xNome) {
    const w2xTexto = await zip.files[w2xNome].async("string");
    const analisado = dwfAnalisarW2X(w2xTexto);
    layerOf = analisado.layerOf;
    clusters = analisado.clusters;
  }

  const entities = [];
  const xs = [];
  const ys = [];
  for (const [n, rec] of pathOf.entries()) {
    const layer = layerOf.get(n) || "SEM_CAMADA";
    entities.push({ n, layer, stroke: rec.stroke, fill: rec.fill, sw: rec.sw, d: rec.d });
    const sm = DWF_START_RE.exec(rec.d);
    if (sm) {
      const [fx, fy] = dwfAplica(matriz, [parseFloat(sm[1]), parseFloat(sm[2])]);
      xs.push(fx);
      ys.push(fy);
    }
  }
  if (!entities.length) throw new Error("Não encontrei nenhum desenho dentro desse arquivo.");

  // Marcadores candidatos: centróide de cada cluster de arcos/círculos,
  // deduplicando posições idênticas (alguns exports duplicam o símbolo
  // inteiro sobreposto -- confirmado num arquivo real). Guarda também os
  // números dos objetos que formam o símbolo (nums) -- é o que permite
  // depois destacar o próprio desenho original (não um ícone por cima)
  // quando aquele candidato for identificado como um equipamento.
  const candidatosPorCamada = new Map();
  for (const cl of clusters) {
    const pts = [];
    for (const n of cl.nums) {
      const rec = pathOf.get(n);
      if (!rec) continue;
      const sm = DWF_START_RE.exec(rec.d);
      if (sm) pts.push(dwfAplica(matriz, [parseFloat(sm[1]), parseFloat(sm[2])]));
    }
    if (!pts.length) continue;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    if (!candidatosPorCamada.has(cl.layer)) candidatosPorCamada.set(cl.layer, []);
    candidatosPorCamada.get(cl.layer).push({ x: cx, y: cy, qtdPontos: pts.length, nums: cl.nums });
  }
  const marcadoresPorCamada = {};
  for (const [layer, pontos] of candidatosPorCamada.entries()) {
    const vistos = new Set();
    const unicos = [];
    for (const p of pontos) {
      const chave = Math.round(p.x * 10) + "," + Math.round(p.y * 10);
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      unicos.push(p);
    }
    marcadoresPorCamada[layer] = unicos;
  }

  const layers = [...new Set(entities.map((e) => e.layer))].sort();
  const camadaEquipamentoSugerida =
    layers.find((l) => DWF_EQUIP_LAYER_HINTS.some((h) => l.toUpperCase().includes(h))) || null;

  const bbox = xs.length
    ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    : [0, 0, 100, 100];

  return { matriz, bbox, layers, entities, marcadoresPorCamada, camadaEquipamentoSugerida };
}
