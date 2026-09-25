// Protege contra HTML/script escondido em texto vindo de fora (planilha
// importada, nome de equipe etc.) antes de colar no HTML do relatório --
// esse arquivo é separado do app.js e não enxerga o escapeHtml() de lá.
function escapeHtml(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// Mesmo logo (PNG) já usado nas etiquetas de QR code em app.js -- duplicado
// aqui de propósito: esse arquivo é carregado sozinho, antes do app.js (que
// é um <script type="module">, com escopo próprio), então não dá pra
// simplesmente reaproveitar a constante de lá. Se um dia trocar o logo,
// troca nos dois lugares (aqui e em app.js, função marcaAleceHtml()).
const LOGO_ALECE_BASE64_PDF = "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";

// Mesmo path (viewBox 0 0 500.0 610.1) do assets/ceara-silhueta.svg -- copiado
// direto aqui (em vez de <img src="assets/ceara-silhueta.svg">) porque o
// html2pdf/html2canvas às vezes falha em carregar uma imagem SVG externa a
// tempo de render, e um SVG inline não tem esse risco. Aqui o preenchimento
// é a cor da marca (azul-marinho) numa opacidade bem baixa -- é só uma marca
// d'água discreta atrás do cabeçalho, não pra chamar atenção.
const SILHUETA_CEARA_PATH_D = "M 0.0,68.0 L 11.4,43.4 L 19.0,36.5 L 17.1,22.4 L 11.0,19.8 L 18.7,12.0 L 37.6,14.0 L 66.4,8.6 L 68.6,12.1 L 78.7,7.9 L 98.9,7.1 L 110.0,0.0 L 171.6,7.0 L 215.8,29.1 L 219.4,34.4 L 244.1,48.1 L 260.0,52.6 L 280.3,73.3 L 290.9,73.7 L 301.1,86.5 L 312.9,91.0 L 330.4,107.1 L 350.6,113.1 L 353.1,110.2 L 366.8,132.0 L 378.0,139.8 L 396.4,163.7 L 424.1,188.7 L 438.2,194.4 L 443.1,206.0 L 453.9,216.7 L 462.7,223.1 L 470.8,221.4 L 489.7,229.4 L 497.1,236.9 L 500.0,246.9 L 453.8,257.6 L 449.4,272.9 L 443.8,274.8 L 438.9,283.2 L 436.7,301.9 L 428.9,307.3 L 422.4,326.5 L 411.8,333.3 L 400.6,347.3 L 400.0,354.1 L 404.9,354.3 L 390.8,380.3 L 373.9,397.1 L 368.9,394.8 L 366.7,397.3 L 364.5,393.0 L 356.8,396.9 L 340.9,420.3 L 342.8,429.5 L 338.3,433.6 L 348.3,435.8 L 337.0,448.4 L 329.6,470.5 L 336.8,480.8 L 329.4,490.3 L 318.6,496.2 L 321.3,503.9 L 318.6,506.2 L 330.0,512.7 L 327.9,529.8 L 335.5,530.0 L 339.0,536.6 L 344.2,536.2 L 346.3,542.3 L 340.2,559.2 L 333.0,562.3 L 331.8,575.0 L 325.1,577.5 L 321.3,586.4 L 312.0,586.9 L 311.7,592.9 L 297.6,598.2 L 294.9,608.5 L 288.2,604.7 L 279.4,610.1 L 274.0,593.9 L 265.3,589.9 L 260.0,591.7 L 257.8,586.3 L 253.4,586.9 L 256.9,579.9 L 252.2,572.1 L 210.6,544.2 L 180.3,547.6 L 174.7,553.7 L 140.4,559.1 L 131.7,552.0 L 104.1,554.2 L 111.2,521.2 L 121.2,507.6 L 118.5,506.3 L 118.6,490.6 L 125.5,483.3 L 118.1,484.5 L 112.7,474.8 L 83.8,467.4 L 74.8,448.4 L 76.1,425.7 L 67.6,413.7 L 65.1,393.5 L 61.0,391.7 L 65.0,383.5 L 57.2,347.4 L 61.7,340.5 L 56.8,317.0 L 60.5,315.4 L 57.5,310.4 L 58.8,288.3 L 34.0,272.3 L 33.3,264.7 L 23.3,259.0 L 19.8,250.8 L 24.8,239.6 L 19.8,237.1 L 28.9,226.4 L 20.7,214.9 L 26.9,208.2 L 35.4,185.9 L 33.5,174.3 L 38.9,166.7 L 32.6,161.1 L 36.1,151.3 L 27.8,148.4 L 19.2,150.5 L 23.3,139.1 L 16.5,125.2 L 13.7,125.3 L 21.0,111.6 L 8.7,107.8 L 10.0,101.0 L 5.2,94.2 L 13.8,85.0 L 10.7,85.2 L 8.4,76.4 L 3.1,75.6 L 0.0,68.0 Z";

function marcaDaguaCearaHtml() {
  return `<svg class="marca-dagua-ceara" viewBox="0 0 500.0 610.1" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="${SILHUETA_CEARA_PATH_D}" fill="#10263D"/>
  </svg>`;
}

// Cabeçalho institucional -- o MESMO em todo relatório que o sistema gera
// (esse aqui e o Anexo I; as duas planilhas .xlsx usam o equivalente em
// Excel, ver adicionarCabecalho() no app.js), pra não parecer 4 documentos
// de sistemas diferentes. Brasão de verdade (mesmo arquivo das etiquetas de
// QR) + nome por extenso da Casa, sem cor "genérica de IA" -- usa as MESMAS
// cores da identidade visual do sistema (azul-marinho e dourado).
function cabecalhoOficialHtml(tituloRelatorio) {
  return `
    <div class="cabecalho-oficial">
      ${marcaDaguaCearaHtml()}
      <img class="cabecalho-brasao" src="data:image/png;base64,${LOGO_ALECE_BASE64_PDF}" alt="Brasão da ALECE">
      <div class="cabecalho-texto">
        <div class="cabecalho-orgao">Assembleia Legislativa do Estado do Ceará</div>
        <div class="cabecalho-sistema">Sistema de Gestão de Manutenção Preventiva &mdash; PMOC ALECE</div>
        <div class="cabecalho-titulo">${tituloRelatorio}</div>
      </div>
    </div>`;
}

// CSS do cabeçalho institucional -- uma função em vez de deixar direto no
// <style> de cada relatório porque os dois (gerencial e Anexo I) usam a
// MESMA regra, e repetir esse bloco duas vezes já foi a causa de um
// (cabeçalho azul-marinho aqui, cinza-ardósia genérico no Anexo I).
function cssCabecalhoOficial() {
  return `
    .cabecalho-oficial {
      position: relative;
      display: flex;
      align-items: center;
      gap: 14px;
      overflow: hidden;
      border-bottom: 3px solid #C9A34E;
      padding-bottom: 12px;
      margin-bottom: 18px;
    }
    .marca-dagua-ceara {
      position: absolute;
      top: -30px;
      right: -20px;
      width: 150px;
      height: auto;
      opacity: 0.05;
      pointer-events: none;
    }
    .cabecalho-brasao { width: 46px; height: auto; flex-shrink: 0; position: relative; }
    .cabecalho-texto { position: relative; }
    .cabecalho-orgao { font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; color: #10263D; }
    .cabecalho-sistema { font-size: 9.5px; color: #5B6B7A; margin-top: 2px; }
    .cabecalho-titulo { font-size: 15px; font-weight: 700; color: #10263D; text-transform: uppercase; margin-top: 6px; }
  `;
}

function gerarRelatorioPDF(equipamentos, cicloInfo, historico) {
  const hoje = new Date();
  const dataFormatada = hoje.toLocaleDateString('pt-BR');
  const hojeISO = hoje.toISOString().split('T')[0];

  const seteDiasAtras = new Date(hoje);
  seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
  const seteDiasAtrasISO = seteDiasAtras.toISOString();
  const seteDiasAtrasData = seteDiasAtras.toISOString().split('T')[0];

  const catorzeDiasAtras = new Date(hoje);
  catorzeDiasAtras.setDate(catorzeDiasAtras.getDate() - 14);
  const catorzeDiasAtrasISO = catorzeDiasAtras.toISOString();

  const concluidas = equipamentos.filter(e => e.statusPreventiva === 'Concluída').length;
  const andamento = equipamentos.filter(e => e.statusPreventiva === 'Em andamento').length;
  const pendentes = equipamentos.filter(e => e.statusPreventiva === 'Pendente').length;
  const execucao = equipamentos.length ? (concluidas / equipamentos.length * 100).toFixed(1) : '0.0';

  const historicoSeguro = historico || [];
  const concluidosSemana = historicoSeguro.filter(h =>
    h.statusNovo === 'Concluída' && h.registradoEm >= seteDiasAtrasISO
  ).length;
  const concluidosSemanaAnterior = historicoSeguro.filter(h =>
    h.statusNovo === 'Concluída' && h.registradoEm >= catorzeDiasAtrasISO && h.registradoEm < seteDiasAtrasISO
  ).length;
  
  const deltaSemana = concluidosSemana - concluidosSemanaAnterior;
  const deltaTexto = deltaSemana > 0 ? `▲ ${deltaSemana}` : deltaSemana < 0 ? `▼ ${Math.abs(deltaSemana)}` : `-`;

  const porSetor = {};
  equipamentos.forEach(e => {
    const setor = e.setorPCM || 'Não classificado';
    if (!porSetor[setor]) porSetor[setor] = [];
    porSetor[setor].push(e);
  });

  const atrasados = equipamentos.filter(e =>
    e.dataAgendada < hojeISO && e.statusPreventiva !== 'Concluída'
  );
  const atrasaramSemana = atrasados.filter(e => e.dataAgendada >= seteDiasAtrasData).length;

  let conteudoHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        /* Reset para evitar margens fantasma */
        * { box-sizing: border-box; }
        
        body {
          font-family: 'Segoe UI', Helvetica, Arial, sans-serif;
          margin: 30px;
          color: #1a1a1a;
          font-size: 11px;
          line-height: 1.4;
        }

        ${cssCabecalhoOficial()}
        .meta-emissao {
          text-align: right;
          font-size: 10px;
          color: #5B6B7A;
          margin: -10px 0 20px;
        }
        .meta-emissao strong { color: #10263D; }

        /* KPI / RESUMO: Display Table ao invés de Flexbox */
        .summary-box {
          width: 100%;
          display: table;
          border: 1px solid #d2d6de;
          background-color: #fcfcfc;
          margin-bottom: 25px;
        }
        .summary-item {
          display: table-cell;
          width: 20%; /* 5 itens = 20% cada */
          text-align: center;
          vertical-align: middle;
          padding: 15px 10px;
          border-right: 1px solid #eee;
        }
        .summary-item:last-child { border-right: none; }
        
        .summary-label {
          font-size: 10px;
          color: #666;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 5px;
        }
        .summary-value {
          font-size: 20px;
          font-weight: bold;
          color: #10263D;
        }

        /* TÍTULOS DE SEÇÃO */
        .section-title {
          font-size: 13px;
          font-weight: bold;
          text-transform: uppercase;
          color: #10263D;
          border-bottom: 1px solid #d2d6de;
          padding-bottom: 5px;
          margin: 30px 0 15px 0;
          page-break-after: avoid; /* Evita quebra de página logo após o título */
        }

        /* TABELAS COM LARGURA FIXA */
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 20px;
          table-layout: fixed; /* Impede que colunas longas espremam as curtas */
        }
        th {
          background-color: #EEF3F8;
          color: #10263D;
          font-weight: bold;
          text-transform: uppercase;
          font-size: 10px;
          padding: 8px;
          border-bottom: 2px solid #d2d6de;
        }
        td {
          padding: 8px;
          border-bottom: 1px solid #eee;
          font-size: 11px;
          word-wrap: break-word;
        }
        
        /* ALINHAMENTOS UTILITÁRIOS */
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .text-left { text-align: left; }

        /* ETIQUETAS DE STATUS */
        .status-badge {
          padding: 3px 6px;
          border-radius: 3px;
          font-size: 10px;
          font-weight: bold;
          display: inline-block; /* Evita que a tag quebre de linha no meio */
        }
        .concluida { color: #1e7e34; background: #e8f5e9; }
        .andamento { color: #856404; background: #fff3cd; }
        .pendente { color: #c82333; background: #f8d7da; }
        
        .delta-pos { color: #1e7e34; font-weight: bold; }
        .delta-neg { color: #c82333; font-weight: bold; }
        
        .footer {
          margin-top: 40px;
          padding-top: 15px;
          border-top: 1px solid #d2d6de;
          font-size: 9px;
          color: #777;
          overflow: hidden;
        }
      </style>
    </head>
    <body>
      ${cabecalhoOficialHtml('Relatório de Manutenção PMOC')}
      <div class="meta-emissao">
        <strong>Emissão:</strong> ${dataFormatada} &nbsp;&middot;&nbsp;
        <strong>Período:</strong> ${seteDiasAtras.toLocaleDateString('pt-BR')} a ${dataFormatada}
      </div>

      <div class="summary-box">
        <div class="summary-item">
          <div class="summary-label">Total de Equip.</div>
          <div class="summary-value">${equipamentos.length}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Concluídas</div>
          <div class="summary-value">${concluidas}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Pendentes + Andamento</div>
          <div class="summary-value">${pendentes + andamento}</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Execução</div>
          <div class="summary-value">${execucao}%</div>
        </div>
        <div class="summary-item">
          <div class="summary-label">Avanço (7 dias)</div>
          <div class="summary-value">${concluidosSemana} OS</div>
          <div style="font-size: 9px; margin-top: 4px;" class="${deltaSemana > 0 ? 'delta-pos' : deltaSemana < 0 ? 'delta-neg' : ''}">
            ${deltaTexto} vs sem. anterior
          </div>
        </div>
      </div>

      <div class="section-title">1. Resumo por Setor de Atuação</div>
      <table>
        <thead>
          <tr>
            <th style="width: 40%;" class="text-left">Setor PCM</th>
            <th style="width: 12%;" class="text-center">Total</th>
            <th style="width: 12%;" class="text-center">Concluídas</th>
            <th style="width: 12%;" class="text-center">Andamento</th>
            <th style="width: 12%;" class="text-center">Pendentes</th>
            <th style="width: 12%;" class="text-right">Avanço</th>
          </tr>
        </thead>
        <tbody>
  `;

  Object.entries(porSetor).forEach(([setor, itens]) => {
    const setorConcluidas = itens.filter(e => e.statusPreventiva === 'Concluída').length;
    const setorAndamento = itens.filter(e => e.statusPreventiva === 'Em andamento').length;
    const setorPendentes = itens.filter(e => e.statusPreventiva === 'Pendente').length;
    const setorProgresso = (setorConcluidas / itens.length * 100).toFixed(0);

    conteudoHTML += `
      <tr>
        <td class="text-left"><strong>${escapeHtml(setor)}</strong></td>
        <td class="text-center">${itens.length}</td>
        <td class="text-center">${setorConcluidas}</td>
        <td class="text-center">${setorAndamento}</td>
        <td class="text-center">${setorPendentes}</td>
        <td class="text-right">${setorProgresso}%</td>
      </tr>
    `;
  });

  conteudoHTML += `
        </tbody>
      </table>

      <div class="section-title">2. Equipamentos com Vencimento Expirado</div>
  `;

  if (atrasados.length > 0) {
    const porEquipe = {};
    atrasados.forEach(e => {
      const equipe = e.equipeResponsavel || 'Não alocada';
      porEquipe[equipe] = (porEquipe[equipe] || 0) + 1;
    });

    conteudoHTML += `
      <p style="font-size: 10px; color: #555; margin-bottom: 15px;">
        <strong>Distribuição do passivo:</strong> ${
        Object.entries(porEquipe).map(([equipe, qtd]) => `${escapeHtml(equipe)} (${qtd})`).join(' | ')
      }</p>
      <table>
        <thead>
          <tr>
            <th style="width: 15%;" class="text-left">Patrimônio</th>
            <th style="width: 25%;" class="text-left">Setor</th>
            <th style="width: 25%;" class="text-left">Ambiente</th>
            <th style="width: 12%;" class="text-left">Equipe</th>
            <th style="width: 11%;" class="text-center">Prazo</th>
            <th style="width: 12%;" class="text-center">Status</th>
          </tr>
        </thead>
        <tbody>
    `;

    atrasados.forEach(eq => {
      const classeStatus = eq.statusPreventiva === 'Concluída' ? 'concluida'
        : eq.statusPreventiva === 'Em andamento' ? 'andamento'
        : 'pendente';

      const dataFormatadaStr = eq.dataAgendada ? eq.dataAgendada.split('-').reverse().join('/') : '-';

      conteudoHTML += `
        <tr>
          <td class="text-left">${escapeHtml(eq.patrimonio || 'S/N')}</td>
          <td class="text-left">${escapeHtml(eq.setor)}</td>
          <td class="text-left">${escapeHtml(eq.ambiente)}</td>
          <td class="text-left">${escapeHtml(eq.equipeResponsavel || '-')}</td>
          <td class="text-center">${dataFormatadaStr}</td>
          <td class="text-center"><span class="status-badge ${classeStatus}">${eq.statusPreventiva}</span></td>
        </tr>
      `;
    });

    conteudoHTML += `
        </tbody>
      </table>
    `;
  } else {
    conteudoHTML += '<p style="font-style: italic; color: #1e7e34;">Nenhuma não-conformidade de prazo detectada neste ciclo.</p>';
  }

  conteudoHTML += `
      <div class="footer">
        <div style="float: left;">Sistema de Manutenção Preventiva — Gerado automaticamente.</div>
        <div style="float: right;">Página 1</div>
      </div>
    </body>
    </html>
  `;

  return conteudoHTML;
}


function baixarRelatorioPDF(equipamentos, cicloInfo, historico) {
  // 1. Chama a sua função para gerar o HTML
  const html = gerarRelatorioPDF(equipamentos, cicloInfo, historico);

  // 2. Configura as margens e a qualidade do PDF
  const opt = {
    margin: [10, 10, 10, 10], 
    filename: `Relatorio_PMOC_ALECE_${new Date().toISOString().split('T')[0]}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { orientation: 'portrait', unit: 'mm', format: 'a4' }
  };

  // 3. Converte e baixa o arquivo
  html2pdf().set(opt).from(html).save();
}
