require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const LOGIN_URL = 'https://rosie.artit.com.br/auth/login';
const SCREENSHOT_ERRO = path.join('screenshots', 'erro-apontamento.png');

const ALMOCO_DURACAO_MIN = parseInt(process.env.ALMOCO_DURACAO_MIN || '60', 10);

const APONTAMENTO_PADRAO = {
  entrada: process.env.HORA_ENTRADA || '08:00',
  almocoInicio: process.env.ALMOCO_INICIO || '12:00',
  saida: process.env.HORA_SAIDA || '17:00',
  observacao: process.env.OBSERVACAO || 'Apontamento automático - ROSIE',
  cliente: process.env.CLIENTE || 'UNIMED CAMPINAS COOPERATIVA',
  projeto: process.env.PROJETO || '[BS] JONATHAN DA SILVA',
  edt: process.env.EDT || 'ALOCAÇÃO DE HORAS',
  atividade: process.env.ATIVIDADE || 'BODY SHOP',
};

function calcularAlmocoFim(almocoInicio) {
  const [h, m] = almocoInicio.split(':').map(Number);
  const fimMin = h * 60 + m + ALMOCO_DURACAO_MIN;
  return `${String(Math.floor(fimMin / 60)).padStart(2, '0')}:${String(fimMin % 60).padStart(2, '0')}`;
}

const hoje = new Date();
const anoAtual = hoje.getFullYear();
const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');
const ultimoDiaMes = new Date(anoAtual, hoje.getMonth() + 1, 0).getDate();

/** Fallback usado apenas quando CLI e .env não informam a configuração */
const FALLBACK_DEV = {
  janelaInicio: `${anoAtual}-${mesAtual}-01`,
  janelaFim: `${anoAtual}-${mesAtual}-${ultimoDiaMes}`,
  feriados: '',
};

/** Configuração em runtime (CLI > .env > auto-janela > fallback) */
let CONFIG = null;

const MESES_PT = {
  janeiro: 1,
  fevereiro: 2,
  março: 3,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

const NOMES_MESES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

function parseArgs() {
  const args = process.argv.slice(2);
  let dias = null;
  let diasInformadosViaCli = false;
  let dryRun = false;
  let janelaInicio = null;
  let janelaFim = null;
  let feriados = null;
  let detectarJanela = false;
  let autoJanela = false;

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--detectar-janela') {
      detectarJanela = true;
    } else if (arg === '--auto-janela') {
      autoJanela = true;
    } else if (arg.startsWith('--dia=')) {
      const valor = Number(arg.split('=')[1]);
      if (!Number.isInteger(valor) || valor < 1 || valor > 31) {
        throw new Error(`Dia inválido em ${arg}. Use um número entre 1 e 31.`);
      }
      dias = [valor];
      diasInformadosViaCli = true;
    } else if (arg.startsWith('--dias=')) {
      dias = arg
        .split('=')[1]
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => item !== '');
      if (dias.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) {
        throw new Error(`Lista de dias inválida em ${arg}.`);
      }
      diasInformadosViaCli = true;
    } else if (arg.startsWith('--janela-inicio=')) {
      janelaInicio = arg.split('=')[1].trim();
    } else if (arg.startsWith('--janela-fim=')) {
      janelaFim = arg.split('=')[1].trim();
    } else if (arg.startsWith('--feriados=')) {
      feriados = arg.split('=')[1].trim();
    }
  }

  return {
    dias,
    diasInformadosViaCli,
    dryRun,
    janelaInicio,
    janelaFim,
    feriados,
    detectarJanela,
    autoJanela,
  };
}

function parseDataIso(texto, nomeCampo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    throw new Error(`${nomeCampo} inválido: "${texto}". Use formato YYYY-MM-DD.`);
  }

  const [ano, mes, dia] = texto.split('-').map(Number);
  const data = new Date(ano, mes - 1, dia);

  if (data.getFullYear() !== ano || data.getMonth() !== mes - 1 || data.getDate() !== dia) {
    throw new Error(`${nomeCampo} inválido: "${texto}".`);
  }

  return data;
}

function parseListaFeriados(texto) {
  if (!texto || !String(texto).trim()) {
    return [];
  }

  return String(texto)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      parseDataIso(item, 'Feriado');
      return item;
    });
}

function origemConfiguracao(valorCli, valorEnv) {
  if (valorCli) return 'CLI';
  if (valorEnv) return '.env';
  return 'fallback (desenvolvimento)';
}

function janelaInformadaViaCli(opcoes) {
  return !!(opcoes.janelaInicio || opcoes.janelaFim);
}

function janelaInformadaViaEnv() {
  return !!(process.env.JANELA_INICIO && process.env.JANELA_FIM);
}

function montarConfiguracaoJanela({
  inicio,
  fim,
  feriadosExcluidos,
  origemJanelaInicio,
  origemJanelaFim,
  origemFeriados,
  diasLiberados = null,
}) {
  if (inicio > fim) {
    throw new Error('Janela início não pode ser posterior à janela fim.');
  }

  return {
    janelaAberta: { inicio, fim },
    feriadosExcluidos,
    origemJanelaInicio,
    origemJanelaFim,
    origemFeriados,
    diasLiberados,
  };
}

function carregarFeriados(opcoes) {
  const feriadosStr = opcoes.feriados ?? process.env.FERIADOS_EXCLUIDOS ?? FALLBACK_DEV.feriados;

  return {
    feriadosExcluidos: parseListaFeriados(feriadosStr),
    origemFeriados: origemConfiguracao(opcoes.feriados, process.env.FERIADOS_EXCLUIDOS),
  };
}

async function resolverJanelaOperacional(page, opcoes) {
  const { feriadosExcluidos, origemFeriados } = carregarFeriados(opcoes);

  if (janelaInformadaViaCli(opcoes)) {
    const janelaInicioStr =
      opcoes.janelaInicio || process.env.JANELA_INICIO || FALLBACK_DEV.janelaInicio;
    const janelaFimStr = opcoes.janelaFim || process.env.JANELA_FIM || FALLBACK_DEV.janelaFim;

    return montarConfiguracaoJanela({
      inicio: parseDataIso(janelaInicioStr, 'Janela início'),
      fim: parseDataIso(janelaFimStr, 'Janela fim'),
      feriadosExcluidos,
      origemJanelaInicio: origemConfiguracao(opcoes.janelaInicio, process.env.JANELA_INICIO),
      origemJanelaFim: origemConfiguracao(opcoes.janelaFim, process.env.JANELA_FIM),
      origemFeriados,
    });
  }

  if (janelaInformadaViaEnv()) {
    return montarConfiguracaoJanela({
      inicio: parseDataIso(process.env.JANELA_INICIO, 'Janela início'),
      fim: parseDataIso(process.env.JANELA_FIM, 'Janela fim'),
      feriadosExcluidos,
      origemJanelaInicio: '.env',
      origemJanelaFim: '.env',
      origemFeriados,
    });
  }

  console.log('[INFO] Nenhuma janela configurada. Detectando automaticamente no ROSIE...');
  const detectada = await descobrirJanelaOperacional(page);

  if (detectada.diasLiberados.length === 0) {
    throw new Error('Nenhum dia liberado foi detectado no ROSIE.');
  }

  const { calendario, primeiroDiaLiberado, ultimoDiaLiberado, diasLiberados } = detectada;
  const inicio = criarData(calendario.ano, calendario.mes, primeiroDiaLiberado);
  const fim = criarData(calendario.ano, calendario.mes, ultimoDiaLiberado);

  console.log('[INFO] Janela operacional detectada automaticamente.');
  console.log(`[INFO] Dias liberados: ${diasLiberados.join(',')}`);

  return montarConfiguracaoJanela({
    inicio,
    fim,
    feriadosExcluidos,
    origemJanelaInicio: 'ROSIE (auto-janela)',
    origemJanelaFim: 'ROSIE (auto-janela)',
    origemFeriados,
    diasLiberados,
  });
}

function gerarDiasDaJanela(janelaInicio, janelaFim) {
  const inicio = normalizarData(janelaInicio);
  const fim = normalizarData(janelaFim);
  const dias = [];
  const cursor = new Date(inicio);
  while (cursor <= fim) {
    dias.push({
      dia: cursor.getDate(),
      mes: cursor.getMonth() + 1,
      ano: cursor.getFullYear(),
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}

function resolverDiasParaProcessar(diasExplicitos, diasInformadosViaCli) {
  const calendario = CONFIG.calendarioAtual || {
    mes: new Date().getMonth() + 1,
    ano: new Date().getFullYear(),
  };

  if (diasInformadosViaCli) {
    console.log(`[INFO] Dias informados via CLI: ${diasExplicitos.join(',')}`);
    return diasExplicitos.map((d) => ({ dia: d, mes: calendario.mes, ano: calendario.ano }));
  }

  if (CONFIG.diasLiberados) {
    console.log(`[INFO] Dias gerados automaticamente pela janela: ${CONFIG.diasLiberados.join(',')}`);
    return CONFIG.diasLiberados.map((d) => ({ dia: d, mes: calendario.mes, ano: calendario.ano }));
  }

  const diasGerados = gerarDiasDaJanela(CONFIG.janelaAberta.inicio, CONFIG.janelaAberta.fim);
  console.log(
    `[INFO] Dias gerados automaticamente pela janela: ${diasGerados.map((d) => d.dia).join(',')}`
  );
  return diasGerados;
}

function criarStats() {
  return {
    processados: 0,
    salvos: 0,
    dryRun: 0,
    puladosFeriado: 0,
    puladosFinalSemana: 0,
    puladosDuplicidade: 0,
    puladosForaJanela: 0,
    falhas: 0,
  };
}

function imprimirResumoExecucao(stats) {
  console.log('');
  console.log('========== RESUMO DA EXECUÇÃO ==========');
  console.log(`Processados: ${stats.processados}`);
  console.log(`Salvos: ${stats.salvos}`);
  console.log(`Dry-run: ${stats.dryRun}`);
  console.log(`Pulados por feriado: ${stats.puladosFeriado}`);
  console.log(`Pulados por final de semana: ${stats.puladosFinalSemana}`);
  console.log(`Pulados por duplicidade: ${stats.puladosDuplicidade}`);
  console.log(`Pulados fora da janela: ${stats.puladosForaJanela}`);
  console.log(`Falhas: ${stats.falhas}`);
  console.log('========================================');
}

function salvarRelatorioExecucao({ dryRun, stats, relatorio184 }) {
  if (!process.env.REPORT_FILE) {
    return;
  }

  const LIMITE_HORAS_MES = relatorio184?.limite ?? parseFloat(process.env.LIMITE_HORAS || '184');
  const horasJaApontadas = relatorio184?.horasJaApontadas ?? null;
  const distribuicao = relatorio184?.distribuicao ?? {};

  const report = {
    executadoEm: new Date().toISOString(),
    dryRun,
    janela: CONFIG?.janelaAberta
      ? {
          inicio: formatarDataIso(CONFIG.janelaAberta.inicio),
          fim: formatarDataIso(CONFIG.janelaAberta.fim),
        }
      : null,
    stats: {
      processados: stats.processados,
      salvos: stats.salvos,
      dryRun: stats.dryRun,
      puladosFeriado: stats.puladosFeriado,
      puladosFinalSemana: stats.puladosFinalSemana,
      puladosDuplicidade: stats.puladosDuplicidade,
      puladosForaJanela: stats.puladosForaJanela,
      falhas: stats.falhas,
    },
    horas: {
      jaApontadasMesVisivel: horasJaApontadas,
      limiteConfigured: LIMITE_HORAS_MES,
      intervaloA: relatorio184?.intervaloA ?? null,
      intervaloB: relatorio184?.intervaloB ?? null,
      porDia: distribuicao.horasPorDia ?? null,
      restantes: distribuicao.horasRestantes ?? null,
      saidaCalculada: distribuicao.saidaCalculada ?? null,
      almocoInicioAjustado: distribuicao.almocoInicioAjustado ?? null,
    },
  };

  fs.writeFileSync(process.env.REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`[INFO] Relatório salvo em ${process.env.REPORT_FILE}`);
}

function normalizarData(data) {
  return new Date(data.getFullYear(), data.getMonth(), data.getDate());
}

function estaDentroDaJanelaAberta(data) {
  const dia = normalizarData(data);
  const inicio = normalizarData(CONFIG.janelaAberta.inicio);
  const fim = normalizarData(CONFIG.janelaAberta.fim);
  return dia >= inicio && dia <= fim;
}

function formatarDataIso(data) {
  const d = normalizarData(data);
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function calcularPascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, month - 1, day);
}

function calcularSextaFeiraSanta(ano) {
  const pascoa = calcularPascoa(ano);
  const sexta = new Date(pascoa);
  sexta.setDate(sexta.getDate() - 2);
  return formatarDataIso(sexta);
}

function calcularCorpusChristi(ano) {
  const pascoa = calcularPascoa(ano);
  const corpus = new Date(pascoa);
  corpus.setDate(corpus.getDate() + 60);
  return formatarDataIso(corpus);
}

function feriadosNacionaisBrasileiros(ano) {
  return [
    `${ano}-01-01`,
    calcularSextaFeiraSanta(ano),
    `${ano}-04-21`,
    calcularCorpusChristi(ano),
    `${ano}-05-01`,
    `${ano}-09-07`,
    `${ano}-10-12`,
    `${ano}-11-02`,
    `${ano}-11-15`,
    `${ano}-11-20`,
    `${ano}-12-25`,
  ];
}

function isFeriadoExcluido(data) {
  const iso = formatarDataIso(data);
  const ano = data.getFullYear();

  if (CONFIG?.feriadosExcluidos?.includes(iso)) return true;
  if (feriadosNacionaisBrasileiros(ano).includes(iso)) return true;

  return false;
}

function formatarJanelaAberta() {
  return `${formatarData(CONFIG.janelaAberta.inicio)} a ${formatarData(CONFIG.janelaAberta.fim)}`;
}

function isDiaUtil(data) {
  const diaSemana = data.getDay();
  return diaSemana !== 0 && diaSemana !== 6;
}

function formatarData(data) {
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const ano = data.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

function criarData(ano, mes, dia) {
  return new Date(ano, mes - 1, dia);
}

function parsearTituloMes(texto) {
  const normalizado = texto.trim().toLowerCase();
  const match = normalizado.match(
    /(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*[/\-\sde]*\s*(\d{4})/i
  );

  if (!match) return null;

  const chave = match[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const mesChave = match[1].toLowerCase();
  const mes = MESES_PT[mesChave] || MESES_PT[chave];
  const ano = Number(match[2]);

  if (!mes || !ano) return null;

  return {
    mes,
    ano,
    nomeMes: NOMES_MESES[mes - 1],
  };
}

async function obterMesAnoCalendario(page) {
  const regexTituloCalendario =
    /^(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+\d{4}$/i;

  const tituloCalendario = page.locator('div, span, h1, h2, h3, h4').filter({ hasText: regexTituloCalendario });
  const totalTitulos = await tituloCalendario.count();

  for (let i = 0; i < totalTitulos; i++) {
    const texto = (await tituloCalendario.nth(i).innerText()).trim();
    const linha = texto.split('\n').map((l) => l.trim()).find((l) => regexTituloCalendario.test(l)) || texto;
    const parsed = parsearTituloMes(linha);
    if (parsed) return parsed;
  }

  const candidatos = page.locator('h1, h2, h3, h4, [class*="title"], [class*="Title"]');
  const total = await candidatos.count();

  for (let i = 0; i < total; i++) {
    const texto = (await candidatos.nth(i).innerText()).trim();
    const parsed = parsearTituloMes(texto);
    if (parsed) return parsed;
  }

  const agora = new Date();
  const nomeFallback = NOMES_MESES[agora.getMonth()];
  return { mes: agora.getMonth() + 1, ano: agora.getFullYear(), nomeMes: nomeFallback };
}

async function garantirPastaScreenshots() {
  fs.mkdirSync(path.dirname(SCREENSHOT_ERRO), { recursive: true });
}

async function salvarScreenshotErro(page) {
  await garantirPastaScreenshots();
  await page.screenshot({ path: SCREENSHOT_ERRO, fullPage: true });
  console.log(`[INFO] Screenshot salvo em ${SCREENSHOT_ERRO}`);
}

async function fecharModalNotificacoes(page) {
  try {
    const fechar = page.getByRole('button', { name: 'Fechar' });
    if (await fechar.isVisible({ timeout: 5000 })) {
      await fechar.click();
      console.log('[INFO] Modal de notificações fechado.');
    }
  } catch {
    console.log('[INFO] Nenhum modal de notificações encontrado.');
  }
}

async function fecharModalNotificacoesSeExistir(page) {
  await fecharModalNotificacoes(page);
}

async function prepararTelaParaDia(page) {
  console.log('[INFO] Preparando tela para próximo dia...');
  await page.waitForTimeout(1000);

  const calendario = await obterMesAnoCalendario(page);
  const textoEsperado = `${calendario.nomeMes} ${calendario.ano}`;
  const calendarioVisivel = await page
    .getByText(new RegExp(textoEsperado, 'i'))
    .isVisible()
    .catch(() => false);

  if (!calendarioVisivel) {
    console.log('[INFO] Calendário não visível. Navegando novamente para Apontar Horas...');
    await page.getByRole('link', { name: 'Apontar Horas' }).nth(1).click();
    await page.waitForTimeout(1500);
  }

  await fecharModalNotificacoesSeExistir(page);
  await page.locator('td').first().waitFor({ state: 'visible', timeout: 10000 });
}

async function resetarTelaApontamentos(page) {
  console.log('[INFO] Recarregando tela de apontamentos para atualizar calendário...');
  await page.reload();
  await page.waitForTimeout(2500);
  await fecharModalNotificacoesSeExistir(page);
  await page.locator('td').first().waitFor({ state: 'visible', timeout: 10000 });
}

function extrairNumeroDiaDasLinhas(linhas) {
  return linhas.find((linha) => /^\d{1,2}$/.test(linha));
}

function diaCorresponde(numeroCelula, diaTexto) {
  if (numeroCelula === undefined || numeroCelula === null) return false;
  return String(numeroCelula).padStart(2, '0') === diaTexto;
}

async function celulaPertenceAoMesAtual(celula) {
  const classes = (await celula.getAttribute('class')) || '';
  if (/outside|other-month|off-range|prev|next|inactive|disabled/i.test(classes)) {
    return false;
  }

  if ((await celula.getAttribute('aria-disabled')) === 'true') {
    return false;
  }

  return celula.evaluate((el) => {
    const style = window.getComputedStyle(el);
    const opacity = parseFloat(style.opacity);
    if (!Number.isNaN(opacity) && opacity < 0.55) {
      return false;
    }
    return true;
  });
}

async function localizarCelulaDia(page, dia) {
  const diaTexto = String(dia).padStart(2, '0');
  const celulas = page.locator('td');
  const total = await celulas.count();

  for (let i = 0; i < total; i++) {
    const celula = celulas.nth(i);
    const visivel = await celula.isVisible().catch(() => false);
    if (!visivel) continue;

    if (!(await celulaPertenceAoMesAtual(celula))) {
      continue;
    }

    const linhas = (await celula.innerText())
      .split('\n')
      .map((linha) => linha.trim())
      .filter(Boolean);

    const numeroDia = extrairNumeroDiaDasLinhas(linhas);
    if (diaCorresponde(numeroDia, diaTexto)) {
      return { celula, diaTexto };
    }
  }

  return null;
}

async function listarCelulasDiasDoMes(page) {
  const celulas = page.locator('td');
  const total = await celulas.count();
  const diasEncontrados = [];

  for (let i = 0; i < total; i++) {
    const celula = celulas.nth(i);
    const visivel = await celula.isVisible().catch(() => false);
    if (!visivel) continue;

    if (!(await celulaPertenceAoMesAtual(celula))) {
      continue;
    }

    const linhas = (await celula.innerText())
      .split('\n')
      .map((linha) => linha.trim())
      .filter(Boolean);

    const numeroDia = extrairNumeroDiaDasLinhas(linhas);
    if (numeroDia === undefined) continue;

    diasEncontrados.push({
      celula,
      numeroDia: Number(numeroDia),
    });
  }

  return diasEncontrados.sort((a, b) => a.numeroDia - b.numeroDia);
}

async function celulaTemBotaoCriar(page, celula) {
  await celula.scrollIntoViewIfNeeded();
  await celula.hover({ force: true });
  await page.waitForTimeout(400);

  const botaoCriar = celula.getByRole('button', { name: /criar/i });
  if ((await botaoCriar.count()) === 0) {
    return false;
  }

  return botaoCriar.first().isVisible().catch(() => false);
}

async function descobrirJanelaOperacional(page) {
  await page.locator('td').first().waitFor({ state: 'visible', timeout: 10000 });

  const calendario = await obterMesAnoCalendario(page);
  const celulasDias = await listarCelulasDiasDoMes(page);
  const diasLiberados = [];

  for (const { celula, numeroDia } of celulasDias) {
    const temBotaoCriar = await celulaTemBotaoCriar(page, celula);

    if (temBotaoCriar) {
      diasLiberados.push(numeroDia);
    }

    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);
  }

  diasLiberados.sort((a, b) => a - b);

  if (diasLiberados.length === 0) {
    return {
      primeiroDiaLiberado: null,
      ultimoDiaLiberado: null,
      diasLiberados,
      calendario,
    };
  }

  return {
    primeiroDiaLiberado: diasLiberados[0],
    ultimoDiaLiberado: diasLiberados[diasLiberados.length - 1],
    diasLiberados,
    calendario,
  };
}

function imprimirJanelaDetectada(resultado) {
  const { primeiroDiaLiberado, ultimoDiaLiberado, diasLiberados, calendario } = resultado;

  console.log('[INFO] Janela detectada automaticamente:');

  if (diasLiberados.length === 0) {
    console.log('[INFO] Dias liberados: nenhum');
    console.log('[INFO] Janela: nenhum dia liberado detectado');
    return;
  }

  console.log(`[INFO] Dias liberados: ${diasLiberados.join(',')}`);

  const inicio = criarData(calendario.ano, calendario.mes, primeiroDiaLiberado);
  const fim = criarData(calendario.ano, calendario.mes, ultimoDiaLiberado);
  console.log(`[INFO] Janela: ${formatarData(inicio)} a ${formatarData(fim)}`);
}

function detectarJaApontado(texto) {
  const temHorario = /\b\d{2}:\d{2}\b/.test(texto);
  const temProjeto = texto.includes(APONTAMENTO_PADRAO.projeto);
  const temAtividade = texto.includes(APONTAMENTO_PADRAO.atividade);
  return temHorario || temProjeto || temAtividade;
}

async function diaJaTemApontamento(page, dia) {
  const resultado = await localizarCelulaDia(page, dia);

  if (!resultado) {
    return false;
  }

  const texto = await resultado.celula.innerText();
  return detectarJaApontado(texto);
}

async function abrirModalPorDia(page, dia) {
  const diaTexto = String(dia).padStart(2, '0');
  console.log(`[INFO] Abrindo célula do dia ${diaTexto}`);

  const resultado = await localizarCelulaDia(page, dia);

  if (!resultado) {
    throw new Error(`Dia ${diaTexto} não encontrado no calendário visível`);
  }

  const { celula: celulaDia } = resultado;

  await celulaDia.scrollIntoViewIfNeeded();
  await celulaDia.hover({ force: true });
  await page.waitForTimeout(500);

  console.log('[INFO] Clicando em Criar');
  const botaoCriar = celulaDia.getByRole('button', { name: /criar/i });
  await botaoCriar.waitFor({ state: 'visible', timeout: 5000 });
  await botaoCriar.click();

  await page.locator('#mui-component-select-client_code').waitFor({ state: 'visible' });
}

async function preencherApontamento(page, dados, turno) {
  const almocoFim = calcularAlmocoFim(dados.almocoInicio);
  const horaInicial = turno === 'manha' ? dados.entrada : almocoFim;
  const horaFinal = turno === 'manha' ? dados.almocoInicio : dados.saida;

  console.log(`[INFO] Preenchendo apontamento ${turno}: ${horaInicial} - ${horaFinal}`);

  await page.locator('#mui-component-select-client_code').waitFor({ state: 'visible' });
  await page.locator('input[name="hour_initial"]').waitFor({ state: 'visible' });
  await page.locator('textarea[name="observation"]').waitFor({ state: 'visible' });

  await page.locator('#mui-component-select-client_code').click();
  await page.getByRole('option', { name: dados.cliente }).click();

  await page.locator('#mui-component-select-project_code').click();
  await page.getByRole('option', { name: dados.projeto }).click();

  await page.locator('#mui-component-select-demand_code').click();
  await page.getByRole('option', { name: dados.edt }).click();

  await page.getByLabel('', { exact: true }).click();
  await page.getByRole('option', { name: dados.atividade }).click();

  await page.locator('input[name="hour_initial"]').fill(horaInicial);
  await page.locator('input[name="hour_final"]').fill(horaFinal);
  await page.getByRole('button', { name: 'neutral face' }).click();
  await page.locator('textarea[name="observation"]').fill(dados.observacao);
}

async function salvarApontamento(page) {
  console.log('[INFO] Salvando apontamento');

  await page.getByRole('button', { name: 'Novo Apontamento' }).click();
  await page.getByRole('button', { name: 'Ok' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Ok' }).click();

  await page.locator('#mui-component-select-client_code').waitFor({ state: 'hidden' }).catch(() => {});
  await page.waitForTimeout(500);
}

async function descartarModalApontamento(page) {
  const seletoresCancelar = [
    () => page.getByRole('button', { name: /cancelar/i }),
    () => page.getByRole('button', { name: /^fechar$/i }),
    () => page.locator('[aria-label="Close"]'),
    () => page.locator('[aria-label="Fechar"]'),
  ];

  for (const obterBotao of seletoresCancelar) {
    const botao = obterBotao().first();
    if ((await botao.count()) > 0 && (await botao.isVisible().catch(() => false))) {
      await botao.click();
      await page
        .locator('#mui-component-select-client_code')
        .waitFor({ state: 'hidden', timeout: 5000 })
        .catch(() => {});
      return;
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const modalAberto = await page
    .locator('#mui-component-select-client_code')
    .isVisible()
    .catch(() => false);

  if (modalAberto) {
    await resetarTelaApontamentos(page);
  }
}

async function processarDiaComRetentativa(page, numeroDia, dataFormatada, dados, dryRun = false) {
  for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
    try {
      if (tentativa === 2) {
        console.log(`[INFO] Retentando dia ${dataFormatada} após reset da tela...`);
        await resetarTelaApontamentos(page);
      }

      await abrirModalPorDia(page, numeroDia);
      await preencherApontamento(page, dados, 'manha');
      if (!dryRun) {
        await salvarApontamento(page);
        await resetarTelaApontamentos(page);
        console.log(`[OK] Manhã salva — dia ${numeroDia}`);
      } else {
        await descartarModalApontamento(page);
        console.log(`[DRY-RUN] Manhã descartada — dia ${numeroDia}`);
      }

      await abrirModalPorDia(page, numeroDia);
      await preencherApontamento(page, dados, 'tarde');
      if (!dryRun) {
        await salvarApontamento(page);
        await resetarTelaApontamentos(page);
        console.log(`[OK] Tarde salva — dia ${numeroDia}`);
      } else {
        await descartarModalApontamento(page);
        console.log(`[DRY-RUN] Tarde descartada — dia ${numeroDia}`);
      }

      return true;
    } catch (err) {
      console.log(`[WARN] Falha ao processar dia ${dataFormatada} (tentativa ${tentativa}): ${err.message}`);
      await salvarScreenshotErro(page);

      if (tentativa === 2) {
        console.log(`[WARN] Não foi possível concluir dia ${dataFormatada}. Pulando.`);
        return false;
      }
    }
  }

  return false;
}

function minutosDesdeMeiaNoite(horaStr) {
  const [h, m] = horaStr.split(':').map(Number);
  return h * 60 + m;
}

function formatarMinutosComoHora(minutos) {
  const clamped = Math.min(Math.max(minutos, 0), 23 * 60 + 59);
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

function criarFiltroIntervalo(diaInicio, mesInicio, anoInicio, diaFim, mesFim, anoFim) {
  const inicio = normalizarData(criarData(anoInicio, mesInicio, diaInicio));
  const fim = normalizarData(criarData(anoFim, mesFim, diaFim));

  return (data) => {
    const dia = normalizarData(data);
    return dia >= inicio && dia <= fim;
  };
}

function obterIntervalos184(calendario) {
  const { mes, ano } = calendario;
  const mesAnterior = mes === 1 ? 12 : mes - 1;
  const anoAnterior = mes === 1 ? ano - 1 : ano;
  const ultimoDiaMes = new Date(ano, mes, 0).getDate();

  return {
    intervaloA: {
      label: `21/${String(mesAnterior).padStart(2, '0')}/${anoAnterior} → 20/${String(mes).padStart(2, '0')}/${ano}`,
      filtro: criarFiltroIntervalo(21, mesAnterior, anoAnterior, 20, mes, ano),
    },
    intervaloB: {
      label: `01/${String(mes).padStart(2, '0')}/${ano} → ${String(ultimoDiaMes).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`,
      filtro: criarFiltroIntervalo(1, mes, ano, ultimoDiaMes, mes, ano),
    },
  };
}

async function calcularHorasNoCalendario(page, filtroData = null) {
  let totalMinutos = 0;

  try {
    await page.locator('td').first().waitFor({ state: 'visible', timeout: 8000 });
    const calendario = CONFIG.calendarioAtual || (await obterMesAnoCalendario(page));
    const celulas = page.locator('td');
    const total = await celulas.count();

    for (let i = 0; i < total; i++) {
      const celula = celulas.nth(i);
      const visivel = await celula.isVisible().catch(() => false);
      if (!visivel) continue;

      if (!(await celulaPertenceAoMesAtual(celula))) {
        continue;
      }

      const linhas = (await celula.innerText())
        .split('\n')
        .map((linha) => linha.trim())
        .filter(Boolean);

      const numeroDia = extrairNumeroDiaDasLinhas(linhas);
      if (numeroDia === undefined) continue;

      if (filtroData) {
        const data = criarData(calendario.ano, calendario.mes, Number(numeroDia));
        if (!filtroData(data)) continue;
      }

      const texto = linhas.join('\n');
      const matches = [...texto.matchAll(/(\d{2}):(\d{2})\s*[-–]\s*(\d{2}):(\d{2})/g)];
      for (const m of matches) {
        const inicioMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        const fimMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
        if (fimMin > inicioMin) totalMinutos += fimMin - inicioMin;
      }
    }
  } catch (err) {
    console.log(`[WARN] Não foi possível calcular horas apontadas: ${err.message}`);
    return 0;
  }

  return totalMinutos / 60;
}

async function calcularHorasJaApontadasNoMes(page) {
  console.log('[INFO] Calculando horas já apontadas no mês...');
  const totalHoras = await calcularHorasNoCalendario(page);
  console.log(`[INFO] Horas já apontadas no mês (calendário visível): ${totalHoras.toFixed(2)}h`);
  return totalHoras;
}

function calcularDistribuicaoHoras(horasJaApontadas, diasUteis, limiteHoras) {
  const horasRestantes = Math.max(0, limiteHoras - horasJaApontadas);
  const MAX_HORAS_DIA = parseFloat(process.env.HORAS_DIA_MAX || '8');

  if (horasRestantes <= 0) {
    console.log(`[INFO] Limite de ${limiteHoras}h já atingido. Nenhum apontamento necessário.`);
    return { podeApontar: false, horasPorDia: 0, horasRestantes: 0 };
  }

  const qtdDias = diasUteis.length;
  if (qtdDias === 0) {
    console.log('[WARN] Nenhum dia útil disponível para distribuição.');
    return { podeApontar: false, horasPorDia: 0, horasRestantes };
  }

  const horasIdeaisPorDia = horasRestantes / qtdDias;
  const horasPorDia = Math.min(horasIdeaisPorDia, MAX_HORAS_DIA);

  if (horasIdeaisPorDia > MAX_HORAS_DIA) {
    const horasMaximasPossiveis = qtdDias * MAX_HORAS_DIA;
    console.log(
      `[WARN] Impossível atingir ${limiteHoras}h com ${qtdDias} dias úteis e máx ${MAX_HORAS_DIA}h/dia ` +
        `(capacidade: ${horasMaximasPossiveis.toFixed(2)}h). Será usado ${MAX_HORAS_DIA}h/dia.`
    );
  }

  const entradaMin = minutosDesdeMeiaNoite(APONTAMENTO_PADRAO.entrada);
  const almocoInicioPadraoMin = minutosDesdeMeiaNoite(
    process.env.ALMOCO_INICIO || APONTAMENTO_PADRAO.almocoInicio
  );
  const manhaMaxMin = Math.max(0, almocoInicioPadraoMin - entradaMin);
  const tardeMaxMin = Math.max(0, 23 * 60 + 59 - (almocoInicioPadraoMin + ALMOCO_DURACAO_MIN));
  const minutosTrabalhoDia = Math.min(Math.round(horasPorDia * 60), manhaMaxMin + tardeMaxMin);

  const manhaMin = Math.min(manhaMaxMin, minutosTrabalhoDia);
  const tardeMin = minutosTrabalhoDia - manhaMin;
  const almocoInicioAjustado = formatarMinutosComoHora(entradaMin + manhaMin);
  const almocoFimMin = entradaMin + manhaMin + ALMOCO_DURACAO_MIN;
  let saidaCalculada = formatarMinutosComoHora(almocoFimMin + tardeMin);

  if (minutosDesdeMeiaNoite(saidaCalculada) > 23 * 60 + 59) {
    console.log('[WARN] Horário de saída calculado excede 23:59. Limitando ao máximo do dia.');
    saidaCalculada = '23:59';
  }

  console.log(
    `[INFO] Horas restantes: ${horasRestantes.toFixed(2)}h | Dias úteis: ${qtdDias} | ` +
      `Por dia: ${horasPorDia.toFixed(2)}h | Manhã até ${almocoInicioAjustado} | Saída: ${saidaCalculada}`
  );

  return {
    podeApontar: true,
    horasPorDia,
    horasRestantes,
    almocoInicioAjustado,
    saidaCalculada,
  };
}

async function fecharDialogsAbertos(page) {
  await fecharModalNotificacoesSeExistir(page);

  for (let i = 0; i < 3; i += 1) {
    const dialog = page.locator('[role="dialog"]').first();
    if (!(await dialog.isVisible().catch(() => false))) {
      break;
    }

    const fechar = page.getByRole('button', { name: /fechar|cancelar|ok|close/i }).first();
    if ((await fechar.count()) > 0 && (await fechar.isVisible().catch(() => false))) {
      await fechar.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape');
    }

    await page.waitForTimeout(300);
  }
}

function calcularMesAnterior(mes, ano) {
  if (mes === 1) return { mes: 12, ano: ano - 1 };
  return { mes: mes - 1, ano };
}

function calcularMesProximo(mes, ano) {
  if (mes === 12) return { mes: 1, ano: ano + 1 };
  return { mes: mes + 1, ano };
}

async function navegarCalendario(page, direcao) {
  await fecharDialogsAbertos(page);

  const rotulos =
    direcao === 'anterior'
      ? ['Mês anterior', 'Mes anterior']
      : ['Próximo mês', 'Proximo mes'];

  for (const rotulo of rotulos) {
    const botao = page.getByRole('button', { name: rotulo, exact: true });
    if ((await botao.count()) > 0 && (await botao.first().isVisible().catch(() => false))) {
      await botao.first().click({ force: true });
      await page.waitForTimeout(1500);
      await page.locator('td').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      return;
    }
  }

  throw new Error(`Botão de navegação "${direcao === 'anterior' ? 'Mês anterior' : 'Próximo mês'}" não encontrado`);
}

async function navegarParaMesAnterior(page, mesReferencia, anoReferencia) {
  console.log('[INFO] Navegando para o mês anterior...');
  const esperado = calcularMesAnterior(mesReferencia, anoReferencia);

  await navegarCalendario(page, 'anterior');

  const cal = await obterMesAnoCalendario(page);
  if (cal.mes !== esperado.mes || cal.ano !== esperado.ano) {
    throw new Error(
      `Navegação incorreta: esperado ${esperado.mes}/${esperado.ano}, obtido ${cal.mes}/${cal.ano}`
    );
  }

  console.log(`[INFO] Calendário atual após navegação: ${cal.nomeMes}/${cal.ano}`);
  return cal;
}

async function voltarParaMesAtual(page, mesEsperado, anoEsperado) {
  console.log('[INFO] Voltando para o mês atual...');
  let tentativas = 0;

  while (tentativas < 6) {
    await fecharDialogsAbertos(page);

    const cal = await obterMesAnoCalendario(page);
    if (cal.mes === mesEsperado && cal.ano === anoEsperado) {
      console.log(`[INFO] Calendário atual após retorno: ${cal.nomeMes}/${cal.ano}`);
      return;
    }

    await navegarCalendario(page, 'proximo');
    tentativas += 1;
  }

  throw new Error(`Não foi possível retornar ao mês ${mesEsperado}/${anoEsperado}`);
}

async function calcularHorasPeriodoPrev(page, diaInicio, diaFim) {
  console.log(`[INFO] Lendo horas do período ${diaInicio}–${diaFim} do mês visível...`);
  let totalMinutos = 0;

  try {
    await page.locator('td').first().waitFor({ state: 'visible', timeout: 8000 });
    const celulas = page.locator('td');
    const total = await celulas.count();

    for (let i = 0; i < total; i++) {
      const celula = celulas.nth(i);
      const visivel = await celula.isVisible().catch(() => false);
      if (!visivel) continue;

      if (!(await celulaPertenceAoMesAtual(celula))) {
        continue;
      }

      const texto = await celula.innerText().catch(() => '');
      const linhas = texto
        .split('\n')
        .map((linha) => linha.trim())
        .filter(Boolean);
      const numeroDia = extrairNumeroDiaDasLinhas(linhas);
      if (numeroDia === undefined) continue;

      const diaCelula = Number(numeroDia);
      if (diaCelula < diaInicio || diaCelula > diaFim) continue;

      const matches = [...texto.matchAll(/(\d{2}):(\d{2})\s*[-–]\s*(\d{2}):(\d{2})/g)];
      for (const m of matches) {
        const inicioMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        const fimMin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
        if (fimMin > inicioMin) totalMinutos += fimMin - inicioMin;
      }
    }
  } catch (err) {
    console.log(`[WARN] Erro ao ler horas do período: ${err.message}`);
  }

  const totalHoras = totalMinutos / 60;
  console.log(`[INFO] Horas encontradas no período ${diaInicio}–${diaFim}: ${totalHoras.toFixed(2)}h`);
  return totalHoras;
}

async function main() {
  const usuario = process.env.ROSIE_USUARIO;
  const senha = process.env.ROSIE_SENHA;

  if (!usuario || !senha) {
    console.error('[ERROR] Defina ROSIE_USUARIO e ROSIE_SENHA no arquivo .env');
    process.exit(1);
  }

  let diasParaProcessar;
  let dryRun = false;
  let diasExplicitos = null;
  let diasInformadosViaCli = false;
  let janelaInicio = null;
  let janelaFim = null;
  let feriados = null;
  let detectarJanela = false;
  let autoJanela = false;
  let relatorio184 = null;
  const stats = criarStats();

  try {
    ({
      dias: diasExplicitos,
      diasInformadosViaCli,
      dryRun,
      janelaInicio,
      janelaFim,
      feriados,
      detectarJanela,
      autoJanela,
    } = parseArgs());
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }

  if (detectarJanela) {
    console.log('[INFO] Modo detectar-janela ativo — apenas diagnóstico, sem apontamentos.');
  } else if (dryRun) {
    console.log('[INFO] Modo dry-run ativo — nenhum apontamento será salvo.');
  }

  let browser;
  let page;

  try {
    browser = await chromium.launch({ headless: process.env.CI === 'true' });
    page = await browser.newPage();
    page.setDefaultTimeout(30000);

    console.log('[INFO] Acessando login...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    console.log('[INFO] Preenchendo credenciais...');
    await page.getByRole('textbox', { name: 'Qual é o seu usuário?' }).waitFor({ state: 'visible' });
    await page.getByRole('textbox', { name: 'Qual é o seu usuário?' }).fill(usuario);
    await page.getByRole('textbox', { name: 'Qual é a sua senha?' }).fill(senha);
    await page.getByRole('button', { name: 'Vamos lá!' }).click();

    await page.waitForTimeout(1500);
    console.log('[INFO] Login realizado');

    console.log('[INFO] Navegando para Apontar Horas...');
    await page.getByRole('link', { name: 'Apontar Horas' }).nth(1).click();
    await page.waitForTimeout(1500);
    console.log('[INFO] Tela de apontamentos carregada');

    await fecharModalNotificacoes(page);
    await page.locator('td').first().waitFor({ state: 'visible', timeout: 10000 });

    const calendario = await obterMesAnoCalendario(page);
    console.log(`[INFO] Calendário atual: ${calendario.nomeMes}/${calendario.ano}`);

    if (detectarJanela) {
      const janelaOperacional = await descobrirJanelaOperacional(page);
      imprimirJanelaDetectada(janelaOperacional);
      console.log('[INFO] Detecção de janela concluída');
      return;
    }

    try {
      CONFIG = await resolverJanelaOperacional(page, { janelaInicio, janelaFim, feriados, autoJanela });
      CONFIG.calendarioAtual = calendario;
      diasParaProcessar = resolverDiasParaProcessar(diasExplicitos, diasInformadosViaCli);
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      `[INFO] Janela aberta (${CONFIG.origemJanelaInicio}/${CONFIG.origemJanelaFim}): ${formatarJanelaAberta()}`
    );
    console.log(
      `[INFO] Feriados excluídos (${CONFIG.origemFeriados}): ${
        CONFIG.feriadosExcluidos.length ? CONFIG.feriadosExcluidos.join(', ') : 'nenhum'
      }`
    );

    // --- 184h rule ---
    const LIMITE_HORAS_MES = parseFloat(process.env.LIMITE_HORAS || '184');

    const calendarioAtual = await obterMesAnoCalendario(page);
    const mesAtual = calendarioAtual.mes;
    const anoAtual = calendarioAtual.ano;

    await navegarParaMesAnterior(page, mesAtual, anoAtual);
    const ultimoDiaMesAnterior = new Date(anoAtual, mesAtual - 1, 0).getDate();
    const horasPeriodoPrev = await calcularHorasPeriodoPrev(page, 21, ultimoDiaMesAnterior);
    console.log(
      `[INFO] Intervalo A — horas no período 21–${ultimoDiaMesAnterior} do mês anterior: ${horasPeriodoPrev.toFixed(2)}h`
    );

    await voltarParaMesAtual(page, mesAtual, anoAtual);

    const horasRestantes = Math.max(0, LIMITE_HORAS_MES - horasPeriodoPrev);
    console.log(
      `[INFO] Horas restantes para completar ${LIMITE_HORAS_MES}h: ${horasRestantes.toFixed(2)}h`
    );

    const diasUteisRestantes = diasParaProcessar.filter(({ dia, mes, ano }) => {
      if (dia > 20) return false;
      const data = criarData(ano, mes, dia);
      return isDiaUtil(data) && !isFeriadoExcluido(data);
    });

    const distribuicao = calcularDistribuicaoHoras(
      horasPeriodoPrev,
      diasUteisRestantes,
      LIMITE_HORAS_MES
    );

    if (!distribuicao.podeApontar && horasRestantes <= 0) {
      console.log(
        `[INFO] Período 21/prev→20/curr já totaliza ${LIMITE_HORAS_MES}h. Nenhum apontamento necessário.`
      );
      return;
    }

    if (!distribuicao.podeApontar) {
      console.log('[INFO] Encerrando — nenhum apontamento necessário.');
      return;
    }

    if (!process.env.ALMOCO_INICIO && distribuicao.almocoInicioAjustado) {
      APONTAMENTO_PADRAO.almocoInicio = distribuicao.almocoInicioAjustado;
    }
    if (!process.env.HORA_SAIDA && distribuicao.saidaCalculada) {
      APONTAMENTO_PADRAO.saida = distribuicao.saidaCalculada;
      console.log(
        `[INFO] Horário de saída ajustado para ${APONTAMENTO_PADRAO.saida} (distribuição ${LIMITE_HORAS_MES}h)`
      );
    }

    relatorio184 = {
      limite: LIMITE_HORAS_MES,
      horasPeriodoPrev,
      horasRestantes,
      horasJaApontadas: horasPeriodoPrev,
      distribuicao,
    };
    // --- end 184h rule ---

    for (const diaObj of diasParaProcessar) {
      const { dia, mes, ano } = diaObj;

      const calendarioVisivel = await obterMesAnoCalendario(page);
      if (calendarioVisivel.mes !== mes || calendarioVisivel.ano !== ano) {
        console.log(`[WARN] Dia ${dia}/${mes}/${ano} não pertence ao calendário visível. Pulando.`);
        continue;
      }

      await prepararTelaParaDia(page);

      const data = criarData(ano, mes, dia);
      const dataFormatada = formatarData(data);

      if (!estaDentroDaJanelaAberta(data)) {
        console.log(
          `[WARN] Dia ${dataFormatada} está fora da janela aberta do ROSIE: ${formatarJanelaAberta()}. Pulando.`
        );
        stats.puladosForaJanela += 1;
        continue;
      }

      if (!isDiaUtil(data)) {
        console.log(`[INFO] Dia ${dataFormatada} é final de semana. Pulando.`);
        stats.puladosFinalSemana += 1;
        continue;
      }

      if (isFeriadoExcluido(data)) {
        console.log(`[INFO] Dia ${dataFormatada} é feriado. Automação ignorada.`);
        stats.puladosFeriado += 1;
        continue;
      }

      if (await diaJaTemApontamento(page, dia)) {
        console.log(`[INFO] Dia ${dataFormatada} já possui apontamento. Pulando.`);
        stats.puladosDuplicidade += 1;
        continue;
      }

      console.log(`[INFO] Processando dia ${dataFormatada}`);
      stats.processados += 1;

      const sucesso = await processarDiaComRetentativa(
        page,
        dia,
        dataFormatada,
        APONTAMENTO_PADRAO,
        dryRun
      );

      if (sucesso) {
        if (dryRun) {
          stats.dryRun += 1;
        } else {
          stats.salvos += 1;
        }
      } else {
        stats.falhas += 1;
      }
    }

    console.log('[INFO] Execução concluída');
    imprimirResumoExecucao(stats);
    salvarRelatorioExecucao({ dryRun, stats, relatorio184 });
  } catch (err) {
    console.error('[ERROR] Falha na automação:', err.message);
    if (page && !page.isClosed()) {
      try {
        await salvarScreenshotErro(page);
      } catch (screenshotErr) {
        console.error('[ERROR] Não foi possível salvar screenshot:', screenshotErr.message);
      }
    }
    process.exitCode = 1;
  } finally {
    if (browser) {
      if (process.env.CI !== 'true') {
        console.log('[INFO] Aguardando 10s antes de fechar o navegador...');
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
      await browser.close();
    }
  }
}

main();
