// Protege contra HTML/script escondido em texto vindo de fora (planilha
// importada, nome de equipe etc.) antes de colar no HTML do relatório --
// esse arquivo é separado do app.js e não enxerga o escapeHtml() de lá.
function escapeHtml(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
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

        /* CABEÇALHO: Float ao invés de Flexbox */
        .header {
          width: 100%;
          border-bottom: 2px solid #2c3e50;
          padding-bottom: 15px;
          margin-bottom: 25px;
          overflow: hidden; /* Força o elemento a conter os floats */
        }
        .header-left { float: left; width: 60%; }
        .header-right { float: right; width: 40%; text-align: right; }
        
        .header-left h1 {
          font-size: 18px;
          text-transform: uppercase;
          margin: 0 0 5px 0;
          color: #2c3e50;
        }
        .header-left p { margin: 0; color: #555; font-size: 11px; }
        .header-right p { margin: 0 0 4px 0; color: #555; }

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
          color: #2c3e50;
        }

        /* TÍTULOS DE SEÇÃO */
        .section-title {
          font-size: 13px;
          font-weight: bold;
          text-transform: uppercase;
          color: #2c3e50;
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
          background-color: #f4f6f8;
          color: #333;
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
      <div class="header">
        <div class="header-left">
          <h1>Relatório de Manutenção PMOC</h1>
          <p>Assembleia Legislativa do Estado do Ceará (ALECE)</p>
        </div>
        <div class="header-right">
          <p><strong>Emissão:</strong> ${dataFormatada}</p>
          <p><strong>Período:</strong> ${seteDiasAtras.toLocaleDateString('pt-BR')} a ${dataFormatada}</p>
        </div>
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
          <div class="summary-label">Pendentes</div>
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

// Relatório no formato que a fiscalização (ANVISA/vigilância sanitária)
// espera ver -- diferente do relatório gerencial acima (que é pra
// acompanhar KPI). Estrutura baseada no Anexo I da Portaria 3.523/GM/98,
// hoje orientado pela ABNT NBR 17037:2023 e NBR 13971: identificação do
// estabelecimento e do responsável técnico, lista dos ambientes
// climatizados, e o registro de execução (data, técnico, atividades) de
// cada preventiva já concluída.
function gerarRelatorioAnexoI(equipamentos, ordens, configSite, numeroCiclo) {
  const hoje = new Date();
  const dataEmissao = hoje.toLocaleDateString('pt-BR');
  const estabelecimento = (configSite && configSite.estabelecimento) || 'Assembleia Legislativa do Estado do Ceará';
  const endereco = (configSite && configSite.endereco) || '';
  const responsavelTecnico = (configSite && configSite.responsavelTecnico) || '';
  const registroTecnico = (configSite && configSite.registroTecnico) || '';

  const porPredio = {};
  equipamentos.forEach((e) => {
    const predio = e.local || 'SEDE';
    if (!porPredio[predio]) porPredio[predio] = [];
    porPredio[predio].push(e);
  });

  const ordensPorEquipamento = {};
  (ordens || []).forEach((o) => {
    if (!ordensPorEquipamento[o.equipamentoId]) ordensPorEquipamento[o.equipamentoId] = [];
    ordensPorEquipamento[o.equipamentoId].push(o);
  });

  const rotuloAvaliacao = (n) => {
    const map = { 1: 'Crítica', 2: 'Ruim', 3: 'Regular', 4: 'Boa', 5: 'Ótima' };
    return map[n] || '-';
  };

  let identificacaoHTML = '';
  let execucaoHTML = '';

  Object.keys(porPredio).sort().forEach((predio) => {
    const itensDoPredio = porPredio[predio];

    identificacaoHTML += `
      <h3 class="secao-predio">${escapeHtml(predio)}</h3>
      <table class="tabela-anexo">
        <thead><tr>
          <th>Setor</th><th>Ambiente</th><th>Patrimônio</th><th>Tag</th><th>Marca/Modelo</th><th>Capacidade</th><th>Gás</th>
        </tr></thead>
        <tbody>
          ${itensDoPredio.map((e) => `
            <tr>
              <td>${escapeHtml(e.setor || '-')}</td>
              <td>${escapeHtml(e.ambiente || '-')}</td>
              <td>${escapeHtml(e.patrimonio || '-')}</td>
              <td>${escapeHtml(e.tag || '-')}</td>
              <td>${escapeHtml([e.marca, e.modelo].filter(Boolean).join(' / ') || '-')}</td>
              <td>${escapeHtml(e.capacidade || '-')}</td>
              <td>${escapeHtml(e.tipoGas || '-')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;

    const linhasExecucao = itensDoPredio
      .flatMap((e) => (ordensPorEquipamento[e.id] || []).map((o) => ({ item: e, ordem: o })))
      .sort((a, b) => String(b.ordem.registradoEm).localeCompare(String(a.ordem.registradoEm)));

    execucaoHTML += `<h3 class="secao-predio">${escapeHtml(predio)}</h3>`;
    if (!linhasExecucao.length) {
      execucaoHTML += `<p class="sem-registro">Nenhuma preventiva concluída registrada neste prédio ainda.</p>`;
    } else {
      execucaoHTML += `
        <table class="tabela-anexo">
          <thead><tr>
            <th>Data</th><th>Patrimônio / Ambiente</th><th>Técnico</th><th>Atividades executadas</th><th>Avaliação</th>
          </tr></thead>
          <tbody>
            ${linhasExecucao.map(({ item, ordem }) => `
              <tr>
                <td>${new Date(ordem.registradoEm).toLocaleDateString('pt-BR')}</td>
                <td>${escapeHtml(item.patrimonio || '-')} — ${escapeHtml(item.ambiente || '-')}</td>
                <td>${escapeHtml(ordem.tecnico || '-')}</td>
                <td class="col-atividades">${(ordem.checklist || []).map(escapeHtml).join('; ') || '-'}</td>
                <td>${escapeHtml(rotuloAvaliacao(ordem.avaliacaoEstrelas))}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  });

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', Helvetica, Arial, sans-serif; margin: 30px; color: #1a1a1a; font-size: 10.5px; line-height: 1.4; }
        .header { width: 100%; border-bottom: 2px solid #2c3e50; padding-bottom: 12px; margin-bottom: 18px; overflow: hidden; }
        .header h1 { font-size: 16px; text-transform: uppercase; margin: 0 0 4px; color: #2c3e50; }
        .header .base-legal { font-size: 9.5px; color: #555; }
        .ficha { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
        .ficha td { padding: 4px 6px; border: 1px solid #ccc; vertical-align: top; }
        .ficha td.rotulo { background: #f4f4f4; font-weight: 600; width: 22%; }
        .secao-titulo { font-size: 13px; text-transform: uppercase; color: #2c3e50; border-bottom: 1px solid #2c3e50; padding-bottom: 4px; margin: 22px 0 10px; }
        .secao-predio { font-size: 11.5px; color: #2c3e50; margin: 14px 0 6px; }
        .tabela-anexo { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
        .tabela-anexo th, .tabela-anexo td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; font-size: 9.5px; }
        .tabela-anexo th { background: #2c3e50; color: #fff; text-transform: uppercase; font-size: 8.5px; }
        .col-atividades { max-width: 160px; }
        .sem-registro { font-style: italic; color: #777; font-size: 10px; }
        .assinatura { margin-top: 50px; overflow: hidden; }
        .assinatura .linha { width: 60%; border-top: 1px solid #1a1a1a; margin-top: 40px; padding-top: 4px; font-size: 10px; }
        .footer { margin-top: 30px; font-size: 8.5px; color: #777; border-top: 1px solid #ccc; padding-top: 6px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Plano de Manutenção, Operação e Controle (PMOC)</h1>
        <div class="base-legal">Lei Federal nº 13.589/2018 &middot; ABNT NBR 17037:2023 &middot; ABNT NBR 13971</div>
      </div>

      <table class="ficha">
        <tr><td class="rotulo">Estabelecimento</td><td>${escapeHtml(estabelecimento)}</td></tr>
        ${endereco ? `<tr><td class="rotulo">Endereço</td><td>${escapeHtml(endereco)}</td></tr>` : ''}
        <tr><td class="rotulo">Responsável técnico</td><td>${escapeHtml(responsavelTecnico) || '<em>Não preenchido — ver Configurações &gt; Sistema</em>'}</td></tr>
        <tr><td class="rotulo">Registro profissional</td><td>${escapeHtml(registroTecnico) || '-'}</td></tr>
        <tr><td class="rotulo">Ciclo de referência</td><td>Ciclo ${numeroCiclo || '-'}</td></tr>
        <tr><td class="rotulo">Data de emissão</td><td>${dataEmissao}</td></tr>
      </table>

      <div class="secao-titulo">1. Identificação dos ambientes climatizados</div>
      ${identificacaoHTML}

      <div class="secao-titulo">2. Registro de execução</div>
      ${execucaoHTML}

      <div class="assinatura">
        <div class="linha">${escapeHtml(responsavelTecnico) || 'Responsável técnico'}${registroTecnico ? ' — ' + escapeHtml(registroTecnico) : ''}</div>
      </div>

      <div class="footer">PMOC ALECE — Relatório gerado automaticamente em ${dataEmissao}.</div>
    </body>
    </html>
  `;
}

function baixarRelatorioAnexoI(equipamentos, ordens, configSite, numeroCiclo) {
  const html = gerarRelatorioAnexoI(equipamentos, ordens, configSite, numeroCiclo);
  const opt = {
    margin: [10, 10, 10, 10],
    filename: `PMOC_ALECE_Relatorio_Anexo_I_${new Date().toISOString().split('T')[0]}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { orientation: 'portrait', unit: 'mm', format: 'a4' },
    pagebreak: { mode: ['css', 'legacy'] },
  };
  html2pdf().set(opt).from(html).save();
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
