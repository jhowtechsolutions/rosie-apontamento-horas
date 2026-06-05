# ROSIE Apontamento de Horas

Automação Playwright para lançamento de horas no [ROSIE](https://rosie.artit.com.br).

## Requisitos

- Node.js 20+
- `npm install`
- `npx playwright install chromium`

## Configuração local

Copie `.env.example` para `.env` e preencha as variáveis:

```bash
cp .env.example .env
```

Credenciais obrigatórias: `ROSIE_USUARIO`, `ROSIE_SENHA`

## Uso local

```bash
# Ver dias liberados no ROSIE
node apontar.js --detectar-janela

# Simular sem salvar
node apontar.js --dry-run

# Executar de verdade
node apontar.js

# Dias específicos
node apontar.js --dias=1,2,3 --dry-run

# Janela manual
node apontar.js --janela-inicio=2026-06-01 --janela-fim=2026-06-05
```

## GitHub Actions

O workflow `.github/workflows/apontar.yml` executa:

- **Agendamento automático**: toda segunda-feira às 09:00 BRT (12:00 UTC) em dry-run
- **Execução manual** via `workflow_dispatch` com opções:
  - `dry_run`: true/false
  - `dias`: lista de dias (ex: `1,2,3`)
  - `limite_horas`: limite mensal (padrão: 184)
- **Relatório por email** enviado automaticamente para art_jonathan@unimedcampinas.com.br

### Secrets obrigatórios (Settings → Secrets → Actions)

| Secret | Descrição |
|--------|-----------|
| `ROSIE_USUARIO` | Login ROSIE |
| `ROSIE_SENHA` | Senha ROSIE |
| `CLIENTE` | Nome do cliente |
| `PROJETO` | Nome do projeto |
| `EDT` | Nome do EDT/WBS |
| `ATIVIDADE` | Nome da atividade |
| `MAIL_USERNAME` | Email Gmail para envio |
| `MAIL_PASSWORD` | App password do Gmail (não a senha normal) |

### Variables opcionais (Settings → Variables → Actions)

| Variable | Padrão |
|----------|--------|
| `HORA_ENTRADA` | `08:00` |
| `ALMOCO_INICIO` | `12:00` |
| `HORA_SAIDA` | `17:00` |
| `HORAS_DIA_MAX` | `8` |
| `LIMITE_HORAS` | `184` |
| `OBSERVACAO` | `Desenvolvimento de atividades alocadas no cliente Unimed` |

## Regras de negócio

- Dois apontamentos por dia (manhã + tarde) com 1h de almoço obrigatório
- Regra 184h verificada em dois intervalos:
  - Intervalo A: dia 21 do mês anterior → dia 20 do mês atual
  - Intervalo B: dia 01 → último dia do mês atual
- Feriados, finais de semana e duplicidades são pulados automaticamente
- Janela operacional detectada automaticamente se não configurada no `.env`
