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
      // Mesmo fallback usado pra camada das entities (linha ~289) -- sem
      // isso, um cluster formado antes de qualquer Layer aparecer no fluxo
      // ficava com layer=null, uma chave diferente de "SEM_CAMADA" (a que
      // aparece de verdade no dropdown de camadas), e os candidatos
      // desse cluster nunca apareciam pra seleção nenhuma.
      const layerNormalizado = camadaAtual || "SEM_CAMADA";
      if (clusterAtual && clusterAtual.layer === layerNormalizado && clusterAtual.lastNum === n) {
        clusterAtual.nums.push(n);
      } else {
        if (clusterAtual) clusters.push(clusterAtual);
        clusterAtual = { layer: layerNormalizado, nums: [n], lastNum: n };
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

// Interpretador (bem simples) da mesma gramática de "d" do SVG/XPS: em vez
// de olhar só o primeiro M (como o DWF_START_RE acima, usado pro bbox
// geral), percorre o "d" inteiro mantendo a posição ABSOLUTA da caneta
// através de M/m,H/h,V/v,L/l,A/a,Z/z (com repetição implícita de pares,
// igual SVG) e devolve o ponto de início de CADA subpath (cada comando
// novo de moveto). Precisa disso porque um objeto do CAD às vezes não é
// um símbolo só -- é um bloco/desenho compondo VÁRIOS aparelhos dentro
// de um <Path> só (confirmado num arquivo real: uma "caixa d'água" com
// várias condensadoras desenhadas juntas como um Path gigante), e sem
// olhar TODOS os subpaths não tem como separar cada aparelho de verdade.
function dwfSubpathsDoD(d) {
  const tokens = d.match(/[MmHhVvLlAaZzCcSsQqTt]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) || [];
  let i = 0;
  let x = 0, y = 0, spX = 0, spY = 0;
  const inicios = [];
  let cmd = null;
  const num = () => parseFloat(tokens[i++]);
  const ARGS_POR_COMANDO = { c: 6, s: 4, q: 4, t: 2 };
  while (i < tokens.length) {
    if (/^[MmHhVvLlAaZzCcSsQqTt]$/.test(tokens[i])) { cmd = tokens[i]; i++; }
    switch (cmd) {
      case "M": x = num(); y = num(); spX = x; spY = y; inicios.push([x, y]); cmd = "L"; break;
      case "m": x += num(); y += num(); spX = x; spY = y; inicios.push([x, y]); cmd = "l"; break;
      case "L": x = num(); y = num(); break;
      case "l": x += num(); y += num(); break;
      case "H": x = num(); break;
      case "h": x += num(); break;
      case "V": y = num(); break;
      case "v": y += num(); break;
      case "A": case "a": {
        num(); num(); num(); num(); num();
        if (cmd === "A") { x = num(); y = num(); } else { x += num(); y += num(); }
        break;
      }
      case "Z": case "z": x = spX; y = spY; break;
      case "C": case "c": case "S": case "s": case "Q": case "q": case "T": case "t": {
        const letra = cmd.toLowerCase();
        const n = ARGS_POR_COMANDO[letra];
        const vals = [];
        for (let k = 0; k < n; k++) vals.push(num());
        if (cmd === cmd.toUpperCase()) { x = vals[n - 2]; y = vals[n - 1]; } else { x += vals[n - 2]; y += vals[n - 1]; }
        break;
      }
      default: i++; break; // token inesperado -- evita loop infinito
    }
  }
  return inicios;
}

// Agrupa itens (cada um com um campo .ponto = [x,y]) por proximidade
// espacial usando union-find ("single linkage": basta UM par próximo o
// suficiente pra unir dois grupos) -- não dá pra andar em sequência
// olhando só o ponto anterior porque o desenho pode visitar as partes
// de um mesmo aparelho fora de ordem.
function dwfAgruparPorProximidade(itens, limiar) {
  const n = itens.length;
  const pai = Array.from({ length: n }, (_, i) => i);
  const acha = (i) => { while (pai[i] !== i) { pai[i] = pai[pai[i]]; i = pai[i]; } return i; };
  const une = (i, j) => { const ri = acha(i), rj = acha(j); if (ri !== rj) pai[ri] = rj; };
  const limiar2 = limiar * limiar;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = itens[i].ponto[0] - itens[j].ponto[0], dy = itens[i].ponto[1] - itens[j].ponto[1];
      if (dx * dx + dy * dy <= limiar2) une(i, j);
    }
  }
  const porRaiz = new Map();
  for (let i = 0; i < n; i++) {
    const r = acha(i);
    if (!porRaiz.has(r)) porRaiz.set(r, []);
    porRaiz.get(r).push(itens[i]);
  }
  return [...porRaiz.values()];
}

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
  //
  // Cada cluster referencia normalmente UM objeto (Path) só, ainda que
  // repetido várias vezes no fluxo do W2X -- por isso olhar só o
  // primeiro "M" de cada referência (comportamento original) é
  // suficiente pro caso comum. Só que às vezes esse Path não é um
  // símbolo -- é um bloco/desenho compondo VÁRIOS aparelhos juntos num
  // "d" só (confirmado num arquivo real: uma cobertura com uma fileira
  // de 11 condensadoras desenhadas dentro de um único Path, referenciado
  // 110x no W2X contra as ~10x de um símbolo comum na mesma camada).
  //
  // Só vale a pena (e só é seguro) tentar separar um cluster assim
  // quando ele é claramente um OUTLIER perto dos vizinhos da mesma
  // camada -- comparar só o tamanho espacial de CADA símbolo (sem
  // comparar com os irmãos primeiro) já se mostrou perigoso: testado
  // contra o arquivo original das evaporadoras (26 já validadas antes),
  // aplicar a divisão em TODO mundo fragmentou até os símbolos normais
  // (que tem folgas internas maiores que a metade do próprio tamanho).
  // Por isso agora só entra em ação quando a contagem de referências no
  // W2X (nums.length) é bem maior que a mediana da própria camada --
  // pros símbolos comuns (tamanho uniforme, caso раro de verdade) nada
  // muda; só dispara pro bloco realmente fora do padrão.
  const FATOR_OUTLIER = 2.5;
  const tamanhosPorCamada = new Map(); // layer -> [nums.length de cada cluster]
  clusters.forEach((cl) => {
    if (!tamanhosPorCamada.has(cl.layer)) tamanhosPorCamada.set(cl.layer, []);
    tamanhosPorCamada.get(cl.layer).push(cl.nums.length);
  });
  const medianaPorCamada = new Map();
  for (const [layer, tamanhos] of tamanhosPorCamada.entries()) {
    const ordenado = [...tamanhos].sort((a, b) => a - b);
    medianaPorCamada.set(layer, ordenado[Math.floor(ordenado.length / 2)]);
  }

  const candidatosPorCamada = new Map();
  for (const cl of clusters) {
    const mediana = medianaPorCamada.get(cl.layer) || 0;
    const ehOutlier = mediana > 0 && cl.nums.length >= mediana * FATOR_OUTLIER && cl.nums.length - mediana >= 5;

    if (!ehOutlier) {
      // Caminho original, sem mudança nenhuma: um ponto por cluster,
      // olhando só o primeiro "M" de cada referência.
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
      continue;
    }

    // Outlier confirmado: lê TODOS os subpaths do(s) Path(s) desse
    // cluster. O "tamanho normal de um símbolo" não dá pra medir pelos
    // vizinhos da camada -- eles colapsam num ponto só (é assim que o
    // caminho comum sempre funcionou, olhando só o primeiro M de cada
    // referência). Em vez disso, estima quantos aparelhos esse bloco
    // deve ter pela PROPORÇÃO entre as referências desse cluster e a
    // mediana da camada (ex: 110 contra uma mediana de 10 -> ~11
    // aparelhos), e busca (busca binária simples) o limiar de distância
    // que separa os subpaths em aproximadamente essa quantidade de
    // grupos -- assim funciona em qualquer escala de arquivo, sem
    // número fixo. Validado contra um arquivo real: separa certinho os
    // 11 pontos de um bloco que juntava 11 condensadoras num só.
    const numerosUnicos = [...new Set(cl.nums)];
    const pontosComNum = [];
    for (const n of numerosUnicos) {
      const rec = pathOf.get(n);
      if (!rec) continue;
      for (const p of dwfSubpathsDoD(rec.d)) pontosComNum.push({ ponto: dwfAplica(matriz, p), n });
    }
    if (!pontosComNum.length) continue;

    const aparelhosEsperados = Math.max(1, Math.round(cl.nums.length / mediana));
    const todosPontos = pontosComNum.map((p) => p.ponto);
    const xsC = todosPontos.map((p) => p[0]), ysC = todosPontos.map((p) => p[1]);
    let lo = 0.01, hi = Math.max(Math.max(...xsC) - Math.min(...xsC), Math.max(...ysC) - Math.min(...ysC));
    let melhorGrupos = [pontosComNum];
    for (let iter = 0; iter < 25 && hi - lo > 0.01; iter++) {
      const meio = (lo + hi) / 2;
      const grupos = dwfAgruparPorProximidade(pontosComNum, meio);
      if (grupos.length >= aparelhosEsperados) {
        melhorGrupos = grupos;
        lo = meio; // ainda separando o suficiente, tenta um limiar maior (mais folga)
      } else {
        hi = meio; // já juntou demais, precisa de um limiar menor
      }
    }
    const gruposComNum = melhorGrupos;
    if (!candidatosPorCamada.has(cl.layer)) candidatosPorCamada.set(cl.layer, []);
    gruposComNum.forEach((g) => {
      const cx = g.reduce((s, p) => s + p.ponto[0], 0) / g.length;
      const cy = g.reduce((s, p) => s + p.ponto[1], 0) / g.length;
      // Só guarda "nums" (pra destacar o desenho original) quando o
      // cluster acabou NÃO precisando ser dividido de verdade --
      // destacar um Path que na real desenha várias unidades juntas
      // recoloriria todas de uma vez, enganoso pra uma marcação
      // individual. Quando dividiu de verdade, guarda em vez disso a
      // ÁREA (bbox) só dessa unidade -- sem isso, o app não tinha outro
      // jeito de indicar "essa aqui foi marcada" a não ser um ícone
      // genérico por cima do próprio desenho original (virava uma
      // "figurinha" grudada em cima do símbolo de verdade). Com a área
      // certa, dá pra desenhar só um contorno ao redor dela, sem
      // recolorir nem empilhar nada.
      const dividiuDeVerdade = gruposComNum.length > 1;
      const nums = dividiuDeVerdade ? [] : cl.nums;
      let bboxLocal = null;
      if (dividiuDeVerdade) {
        const gxs = g.map((p) => p.ponto[0]), gys = g.map((p) => p.ponto[1]);
        bboxLocal = { x: Math.min(...gxs), y: Math.min(...gys), largura: Math.max(...gxs) - Math.min(...gxs), altura: Math.max(...gys) - Math.min(...gys) };
      }
      candidatosPorCamada.get(cl.layer).push({ x: cx, y: cy, qtdPontos: g.length, nums, bboxLocal });
    });
  }
  // Descarta candidatos pequenos demais pra serem um símbolo de
  // equipamento de verdade. Em todos os arquivos reais já testados, um
  // símbolo de equipamento de verdade sempre tem 10 "pontos" ou mais (10,
  // 15, 16, 18, 20, 24, 28, 30, 108); ruído (parafuso, conexão, ponto de
  // hachura, cota) nunca passou de 8 -- confirmado inclusive num arquivo
  // real (ANEXO_II 4º piso) onde a própria camada de equipamento
  // misturava 4 detalhes de 5 pontos com 2 aparelhos de verdade (18 e
  // 30). O limiar fica no teto seguro (mesmo valor já usado como teto do
  // aprendizado por descarte em app.js -- LIMIAR_QTD_PONTOS_TETO) em vez
  // de bem no meio da folga, pra pegar esse tipo de ruído já na primeira
  // vez que a planta é aberta, sem precisar descartar manualmente antes.
  const QTD_PONTOS_MINIMA = 9;

  const marcadoresPorCamada = {};
  for (const [layer, pontos] of candidatosPorCamada.entries()) {
    const vistos = new Set();
    const unicos = [];
    for (const p of pontos) {
      if (p.qtdPontos < QTD_PONTOS_MINIMA) continue;
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
