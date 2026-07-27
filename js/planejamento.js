import {
  auth, signOut, onAuthStateChanged,
  db, collection, onSnapshot
} from "./firebase-config.js";

document.getElementById('logout-btn').addEventListener('click', () => {
  signOut(auth).catch(err => console.error('Erro ao sair:', err));
});

const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const STORAGE_KEY = 'livro_caixa_planejamento';
const EMPTY_PLAN_COUNTER = 'Plano sem nome';

const money = (v) => v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const pct = (v) => (v*100).toFixed(1).replace('.',',') + '%';

let currentUserUid = null;
let appCurrentBalance = 0;

// Store de múltiplos planos
let store = {
  currentId: null,
  plans: []
};

// Plano atualmente aberto (referência a store.plans)
let plan = emptyPlan();
let editingId = null;
let editingCache = {};
let viewingId = null;

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  currentUserUid = user.uid;
  loadStore();
  if (store.plans.length === 0){
    const first = emptyPlan();
    first.id = genId();
    first.name = 'Plano inicial';
    store.plans.push(first);
    store.currentId = first.id;
    saveStore();
  }
  if (!store.currentId || !store.plans.find(p=>p.id===store.currentId)){
    store.currentId = store.plans[0].id;
    saveStore();
  }
  plan = store.plans.find(p=>p.id===store.currentId);
  startFirestoreListener();
  bindStaticEvents();
  renderPlanSelector();
  syncUIWithPlan();
  renderAll();
});

function genId(){ return String(Math.random().toString(36).slice(2,10)) + Date.now().toString(36); }

function emptyPlan(){
  return {
    id: genId(),
    name: '',
    useCustomBalance: false,
    customBalance: 0,
    rows: [],
    createdAt: Date.now()
  };
}

function storageKey(){
  return `${STORAGE_KEY}_${currentUserUid || 'anon'}`;
}

function saveStore(){
  try { localStorage.setItem(storageKey(), JSON.stringify(store)); }
  catch (e) { console.error('Erro ao salvar store planejamento:', e); }
}

function loadStore(){
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw){ store = { currentId: null, plans: [] }; return; }
    const obj = JSON.parse(raw);

    // Migração 1: formato velho = só 1 plano / array ou objeto {name,...,rows}
    if (!obj || !Array.isArray(obj.plans)){
      const single = extractPlanLegacy(obj);
      store = { currentId: single.id, plans: [single] };
      saveStore();
      return;
    }

    // Formato novo
    store = {
      currentId: obj.currentId,
      plans: obj.plans.map(p => normalizePlan(p))
    };
  } catch (e) {
    console.error('Erro ao carregar store planejamento:', e);
    store = { currentId: null, plans: [] };
  }
}

function extractPlanLegacy(obj){
  const rows = Array.isArray(obj) ? obj : (Array.isArray(obj?.rows) ? obj.rows : []);
  return normalizePlan({
    id: genId(),
    name: typeof obj?.name === 'string' ? obj.name : (rows.length>0 ? 'Plano importado' : 'Plano inicial'),
    useCustomBalance: !!obj?.useCustomBalance,
    customBalance: Number(obj?.customBalance) || 0,
    rows: rows.map(r => ({
      id: r?.id || genId(),
      monthLabel: r?.monthLabel || nextMonthLabelFromDate(new Date(), 0),
      receita: Number(r?.receita) || 0,
      gastos: Number(r?.gastos) || 0,
      investimentos: Number(r?.investimentos) || 0
    })),
    createdAt: Date.now()
  });
}

function normalizePlan(p){
  if (!p) return emptyPlan();
  return {
    id: p.id || genId(),
    name: typeof p.name === 'string' ? p.name : '',
    useCustomBalance: !!p.useCustomBalance,
    customBalance: Number(p.customBalance) || 0,
    rows: Array.isArray(p.rows) ? p.rows.map(r => ({
      id: r?.id || genId(),
      monthLabel: r?.monthLabel || nextMonthLabelFromDate(new Date(), 0),
      receita: Number(r?.receita) || 0,
      gastos: Number(r?.gastos) || 0,
      investimentos: Number(r?.investimentos) || 0
    })) : [],
    createdAt: Number(p.createdAt) || Date.now()
  };
}

function getStartingBalance(){
  return plan.useCustomBalance ? (Number(plan.customBalance)||0) : appCurrentBalance;
}

function syncUIWithPlan(){
  const nameEl = document.getElementById('plan-name');
  const rAtual = document.getElementById('radio-saldo-atual');
  const rCustom = document.getElementById('radio-saldo-custom');
  const customEl = document.getElementById('saldo-custom');
  if (nameEl) nameEl.value = plan.name || '';
  if (rAtual)  rAtual.checked  = !plan.useCustomBalance;
  if (rCustom) rCustom.checked =  plan.useCustomBalance;
  if (customEl){
    customEl.disabled = !plan.useCustomBalance;
    customEl.value = plan.customBalance ? Number(plan.customBalance) : '';
  }
}

function renderPlanSelector(){
  const sel = document.getElementById('plan-selector');
  const count = document.getElementById('plan-count');
  if (!sel) return;
  sel.innerHTML = '';
  store.plans.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    const display = p.name ? p.name : EMPTY_PLAN_COUNTER;
    opt.textContent = `${display}${p.rows.length ? ` · ${p.rows.length} m` : ''}`;
    if (p.id === store.currentId) opt.selected = true;
    sel.appendChild(opt);
  });
  if (count) count.textContent = `${store.plans.length} plano(s) salvo(s)`;
}

function startFirestoreListener(){
  const txCol = collection(db, 'transactions');
  onSnapshot(txCol, (snapshot) => {
    const allTx = snapshot.docs.map(d => d.data());
    const totalIn  = allTx.filter(t=>t.type==='entrada').reduce((s,t)=>s+(+t.value||0),0);
    const totalOut = allTx.filter(t=>t.type==='saida').reduce((s,t)=>s+(+t.value||0),0);
    appCurrentBalance = totalIn - totalOut;
    const lbl = document.getElementById('lbl-saldo-atual');
    if (lbl) lbl.textContent = money(appCurrentBalance);
    renderHeaderStats();
    renderReverseCalc();
    renderViewPanel();
  }, (err) => console.error('Erro ao ler transações:', err));
}

function nextMonthLabelFromDate(base, offsetFromIndex){
  const now = new Date(base.getFullYear(), base.getMonth(), 1);
  now.setMonth(now.getMonth() + offsetFromIndex);
  return `${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}

function nextMonthLabelFromLast(lastLabel){
  const parts = lastLabel.split(' ');
  const monthName = parts.slice(0, -1).join(' ');
  const year = parseInt(parts[parts.length-1]) || new Date().getFullYear();
  let idx = MONTHS.indexOf(monthName);
  if (idx === -1) idx = new Date().getMonth();
  idx++;
  const y = year + Math.floor(idx / 12);
  const m = idx % 12;
  return `${MONTHS[m]} ${y}`;
}

function avgFromRows(){
  if (plan.rows.length === 0) return { receita:0, gastos:0, invest:0 };
  return {
    receita: plan.rows.reduce((s,r)=> s + (Number(r.receita)||0), 0) / plan.rows.length,
    gastos:  plan.rows.reduce((s,r)=> s + (Number(r.gastos)||0), 0)  / plan.rows.length,
    invest:  plan.rows.reduce((s,r)=> s + (Number(r.investimentos)||0), 0) / plan.rows.length
  };
}

function bindStaticEvents(){
  ['rev-meses','rev-receita','rev-gastos'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderReverseCalc);
  });
  const btnSave = document.getElementById('btn-rev-save');
  if (btnSave) btnSave.addEventListener('click', saveReverseWithChoice);
  const btnClose = document.getElementById('view-close');
  if (btnClose) btnClose.addEventListener('click', () => { viewingId = null; renderViewPanel(); });

  // --- Campo nome do plano (atual)
  const nameEl = document.getElementById('plan-name');
  if (nameEl) nameEl.addEventListener('input', () => {
    plan.name = nameEl.value;
    saveStore();
    renderPlanSelector();
    renderTable();
    renderViewPanel();
  });

  // --- Rádios Saldo inicial
  const rAtual = document.getElementById('radio-saldo-atual');
  const rCustom = document.getElementById('radio-saldo-custom');
  const customEl = document.getElementById('saldo-custom');
  if (rAtual) rAtual.addEventListener('change', () => {
    plan.useCustomBalance = false;
    customEl.disabled = true;
    saveStore();
    renderAll();
  });
  if (rCustom) rCustom.addEventListener('change', () => {
    plan.useCustomBalance = true;
    customEl.disabled = false;
    customEl.focus();
    saveStore();
    renderAll();
  });
  if (customEl) customEl.addEventListener('input', () => {
    const n = parseFloat(customEl.value);
    plan.customBalance = isNaN(n) ? 0 : n;
    saveStore();
    renderAll();
  });

  // --- Botão "Usar saldo atual" (não toca nas linhas)
  document.getElementById('btn-use-saldo').addEventListener('click', () => {
    plan.useCustomBalance = false;
    plan.customBalance = 0;
    saveStore();
    syncUIWithPlan();
    renderAll();
  });

  // --- Botão Limpar meses (só linhas do plano atual)
  const btnClear = document.getElementById('btn-clear-rows');
  if (btnClear) btnClear.addEventListener('click', () => {
    if (plan.rows.length === 0) return;
    if (!confirm(`Limpar TODOS os ${plan.rows.length} meses do plano atual?\nNome e saldo inicial permanecem.`)) return;
    plan.rows = [];
    saveStore();
    viewingId = null;
    editingId = null;
    renderAll();
  });

  // --- Selector de planos
  const sel = document.getElementById('plan-selector');
  if (sel) sel.addEventListener('change', () => {
    const id = sel.value;
    const p = store.plans.find(x=>x.id===id);
    if (!p) return;
    store.currentId = id;
    plan = p;
    editingId = null; viewingId = null; editingCache = {};
    saveStore();
    syncUIWithPlan();
    renderAll();
  });

  // --- Novo plano
  const btnNew = document.getElementById('btn-plan-new');
  if (btnNew) btnNew.addEventListener('click', createNewPlan);

  // --- Duplicar plano atual
  const btnDup = document.getElementById('btn-plan-duplicate');
  if (btnDup) btnDup.addEventListener('click', duplicateCurrentPlan);

  // --- Excluir plano atual
  const btnDel = document.getElementById('btn-plan-delete');
  if (btnDel) btnDel.addEventListener('click', deleteCurrentPlan);

  // --- Navegação entre meses DENTRO do painel de visualização
  const vPrev = document.getElementById('view-prev');
  const vNext = document.getElementById('view-next');
  const vFirst = document.getElementById('view-first');
  const vLast  = document.getElementById('view-last');
  if (vPrev)  vPrev.addEventListener('click', () => navigateViewMonth(-1));
  if (vNext)  vNext.addEventListener('click', () => navigateViewMonth(+1));
  if (vFirst) vFirst.addEventListener('click', () => navigateViewMonth('first'));
  if (vLast)  vLast.addEventListener('click', () => navigateViewMonth('last'));

  // Teclado: ← → Home End quando o painel estiver aberto
  document.addEventListener('keydown', (e) => {
    const panel = document.getElementById('view-panel');
    if (!panel || panel.style.display === 'none') return;
    if (e.key === 'ArrowLeft')  { navigateViewMonth(-1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { navigateViewMonth(+1); e.preventDefault(); }
    if (e.key === 'Home')       { navigateViewMonth('first'); e.preventDefault(); }
    if (e.key === 'End')        { navigateViewMonth('last'); e.preventDefault(); }
  });
}

// ===============================
//   MULTI PLAN ACTIONS
// ===============================
function findPlanByName(name){
  const n = (name || '').trim();
  return store.plans.find(p => (p.name || '').trim() === n) || null;
}

function createNewPlan(){
  const p = emptyPlan();
  const suggestion = store.plans.length === 0 ? 'Plano inicial' : `Plano ${store.plans.length + 1}`;
  const typed = prompt('Nome do novo planejamento (opcional):', suggestion);
  if (typed === null) return;
  const finalName = (typed || '').trim();
  const existing = findPlanByName(finalName);
  if (existing){
    if (!confirm(`Já existe um plano com o nome "${finalName}" (${existing.rows.length} mês(es)).\n\nDeseja SOBRESCREVER esse plano? Os meses existentes serão PERDIDOS e substituídos por um plano vazio.`)) return;
    // Sobrescreve o existente (mesmo ID) — mantemos o histórico do ID, substituímos os valores
    existing.useCustomBalance = p.useCustomBalance;
    existing.customBalance = p.customBalance;
    existing.rows = [];
    existing.name = finalName;
    store.currentId = existing.id;
    plan = existing;
  } else {
    p.name = finalName;
    store.plans.push(p);
    store.currentId = p.id;
    plan = p;
  }
  editingId = null; viewingId = null;
  saveStore();
  renderPlanSelector();
  syncUIWithPlan();
  renderAll();
}

function duplicateCurrentPlan(){
  if (!plan) return;
  const copy = JSON.parse(JSON.stringify(plan));
  copy.id = genId();
  copy.createdAt = Date.now();
  copy.name = (plan.name || 'Plano sem nome') + ' (cópia)';
  copy.rows = copy.rows.map(r => ({ ...r, id: genId() }));
  store.plans.push(copy);
  store.currentId = copy.id;
  plan = copy;
  saveStore();
  renderPlanSelector();
  syncUIWithPlan();
  renderAll();
}

function deleteCurrentPlan(){
  if (store.plans.length <= 1){
    alert('É preciso manter pelo menos 1 plano. Crie um novo antes de excluir este.');
    return;
  }
  const display = plan.name || EMPTY_PLAN_COUNTER;
  if (!confirm(`Excluir o plano "${display}" e TODOS os seus meses? Esta ação NÃO pode ser desfeita.`)) return;
  const idx = store.plans.findIndex(p => p.id === plan.id);
  if (idx === -1) return;
  store.plans.splice(idx, 1);
  // Seleciona o próximo existente
  store.currentId = store.plans[Math.min(idx, store.plans.length-1)].id;
  plan = store.plans.find(p => p.id === store.currentId);
  viewingId = null; editingId = null;
  saveStore();
  renderPlanSelector();
  syncUIWithPlan();
  renderAll();
}

// ===============================
//   SAVE REVERSE (NOVO / ATUAL)
// ===============================
function saveReverseWithChoice(){
  const mesesEl = document.getElementById('rev-meses');
  const m = parseInt(mesesEl.value);
  if (!m || m <= 0){
    alert('Informe a quantidade de meses na calculadora.');
    mesesEl.focus();
    return;
  }
  const choice = chooseSaveAction();
  if (!choice) return;

  if (choice === 'new'){
    const p = emptyPlan();
    const suggestion = (plan.name ? plan.name + ' — ' : '') + `Nova simulação · ${m}m`;
    const typed = prompt('Nome do NOVO planejamento:', suggestion);
    if (typed === null) return;
    const finalName = (typed || '').trim();
    // Pega configs de saldo do plano atual (copia)
    p.useCustomBalance = plan.useCustomBalance;
    p.customBalance = plan.customBalance;
    p.name = finalName;

    const existing = findPlanByName(finalName);
    if (existing){
      if (!confirm(`Já existe um plano chamado "${finalName}" (${existing.rows.length} mês(es)).\n\nDeseja SOBRESCREVER com o resultado da calculadora? Os meses e valores existentes serão substituídos.`)) return;
      existing.useCustomBalance = p.useCustomBalance;
      existing.customBalance = p.customBalance;
      existing.name = finalName;
      store.currentId = existing.id;
      plan = existing;
    } else {
      store.plans.push(p);
      store.currentId = p.id;
      plan = p;
    }
  }

  // Popula as linhas (com a regra "só 1 mês se vazio, não gera vários")
  populateReverseIntoCurrent(m, choice==='new');
  if (choice === 'new'){
    renderPlanSelector();
    syncUIWithPlan();
  }
  saveStore();
  renderAll();
}

function chooseSaveAction(){
  const display = (plan.name || EMPTY_PLAN_COUNTER);
  const msg =
`Escolha uma ação para o resultado da calculadora:

[1] Salvar no plano ATUAL  →  "${display}"
     - Se o plano já tiver meses, NÃO recria a lista (apenas simulação mantida).
     - Se estiver vazio, cria apenas o 1º mês.

[2] CRIAR como NOVO plano
     - Gera um novo planejamento independente e o abre.
     - Cria apenas o 1º mês na lista.

Cancelar = não fazer nada.`;

  // Usa 3 prompts simples? Não — usaremos confirm em duas etapas.
  // Primeiro pergunta se quer novo ou atual.
  if (confirm(msg.replace(/^\s+/gm,''))){
    if (confirm(`OK = Criar NOVO plano  |  Cancelar = Salvar no plano ATUAL "${display}"`)){
      return 'new';
    }
    return 'current';
  }
  return null;
}

function populateReverseIntoCurrent(qtd, isNewPlan){
  const receitaEl = document.getElementById('rev-receita');
  const gastosEl = document.getElementById('rev-gastos');
  const rec = parseFloat(receitaEl.value) ? parseFloat(receitaEl.value) : (avgFromRows().receita || 0);
  const gasInformado = parseFloat(gastosEl.value);
  const starting = getStartingBalance();
  const gastoPorMes = gasInformado > 0 ? gasInformado : Math.max(0, (starting + (rec * Math.max(1,qtd))) / Math.max(1,qtd));
  const now = new Date();

  if (!isNewPlan && plan.rows.length > 0){
    alert('O plano ATUAL já contém meses — a lista NÃO será alterada.\nA calculadora permanece apenas como simulação.\n\nPara gerar um plano novo, use a opção "Criar como NOVO plano".');
    return;
  }

  // Cria SÓ 1 mês (nunca vários)
  plan.rows = [{
    id: genId(),
    monthLabel: nextMonthLabelFromDate(now, 0),
    receita: rec,
    gastos: gastoPorMes,
    investimentos: 0
  }];
  viewingId = null;
  editingId = null;
}

// ===============================
//   NAVEGAÇÃO DE MÊS NO PAINEL DE VISÃO
// ===============================
function navigateViewMonth(dir){
  const rows = plan.rows;
  if (rows.length === 0) return;
  let idx = rows.findIndex(r => r.id === viewingId);
  if (idx === -1) idx = 0;
  if (dir === 'first') idx = 0;
  else if (dir === 'last') idx = rows.length - 1;
  else idx = (idx + dir + rows.length) % rows.length;
  viewingId = rows[idx].id;
  renderAll();
  requestAnimationFrame(() => {
    const panel = document.getElementById('view-panel');
    if (panel) panel.scrollIntoView({ behavior:'smooth', block:'start' });
    setTimeout(() => {
      const target = document.querySelector(`[data-timeline-id="${viewingId}"]`);
      if (target){
        target.animate(
          [
            { boxShadow: '0 0 0 2px rgba(212,168,87,.25)' },
            { boxShadow: '0 0 0 5px rgba(212,168,87,.55)' },
            { boxShadow: '0 0 0 2px rgba(212,168,87,.25)' }
          ],
          { duration: 900, easing: 'ease-out' }
        );
      }
    }, 320);
  });
}

// ===============================
//   CALC / STATS
// ===============================
function calculate(){
  const withCalc = plan.rows.map(r => ({ ...r }));
  let running = getStartingBalance();
  for (let i=0;i<withCalc.length;i++){
    const r = withCalc[i];
    r.saldoInicial = running;
    r.saldoFinal = r.saldoInicial + (Number(r.receita)||0) - (Number(r.gastos)||0) - (Number(r.investimentos)||0);
    running = r.saldoFinal;
  }
  return withCalc;
}

function calculateRunwayMonths(calcRows){
  const startBal = getStartingBalance();
  if (startBal <= 0) return 0;
  const avgGastos = calcRows.reduce((s,r)=> s + (Number(r.gastos)||0), 0) / Math.max(1, calcRows.length);
  const avgReceita = calcRows.reduce((s,r)=> s + (Number(r.receita)||0), 0) / Math.max(1, calcRows.length);
  const avgInvest = calcRows.reduce((s,r)=> s + (Number(r.investimentos)||0), 0) / Math.max(1, calcRows.length);
  const burn = (avgGastos + avgInvest) - avgReceita;
  if (burn <= 0) return Infinity;
  return Math.floor(startBal / burn);
}

function renderHeaderStats(){
  const calc = calculate();
  const totalInvestido = calc.reduce((s,r)=> s + (Number(r.investimentos)||0), 0);
  const saldoProjetado = calc.length > 0 ? calc[calc.length-1].saldoFinal : getStartingBalance();
  const mesesDura = calculateRunwayMonths(calc);

  document.getElementById('stat-patrimonio').textContent = money(getStartingBalance()) + (plan.useCustomBalance ? ' *' : '');
  document.getElementById('stat-investido').textContent = money(totalInvestido);
  document.getElementById('stat-projetado').textContent = money(saldoProjetado);
  document.getElementById('stat-meses').textContent = mesesDura === Infinity ? '∞' : mesesDura;

  const totalReceita = calc.reduce((s,r)=> s + (Number(r.receita)||0), 0);
  const totalGastos  = calc.reduce((s,r)=> s + (Number(r.gastos)||0), 0);
  document.getElementById('soma-receita').textContent = money(totalReceita);
  document.getElementById('soma-gastos').textContent = money(totalGastos);
  document.getElementById('soma-acumulado').textContent = money(saldoProjetado - getStartingBalance());
  document.getElementById('soma-meses').textContent = calc.length;
}

function renderAll(){
  renderHeaderStats();
  renderReverseCalc();
  renderTable();
  renderViewPanel();
}

function renderReverseCalc(){
  const mesesEl    = document.getElementById('rev-meses');
  const receitaEl  = document.getElementById('rev-receita');
  const gastosEl   = document.getElementById('rev-gastos');
  const resultEl   = document.getElementById('rev-result');
  const resLblEl   = document.getElementById('rev-result-label');
  const noteEl     = document.getElementById('rev-note');
  if (!mesesEl || !receitaEl || !gastosEl || !resultEl || !noteEl) return;

  const avg = avgFromRows();
  if (receitaEl.value === '' && plan.rows.length > 0) receitaEl.value = avg.receita > 0 ? parseFloat(avg.receita.toFixed(2)) : '';
  if (gastosEl.value === '' && plan.rows.length > 0)  gastosEl.value  = avg.gastos  > 0 ? parseFloat(avg.gastos.toFixed(2))  : '';
  if (mesesEl.value === '' && plan.rows.length > 0)   mesesEl.value   = plan.rows.length;

  const m = parseFloat(mesesEl.value);
  const rec = parseFloat(receitaEl.value) || 0;
  const gas = parseFloat(gastosEl.value) || 0;

  const modoMeses = !m && gas > 0;

  if (!m && !gas){
    resultEl.textContent = money(0);
    resultEl.style.color = 'var(--text-dim)';
    resLblEl.textContent = 'Gasto médio mensal permitido';
    noteEl.textContent = 'Informe meses OU gastos para calcular. Clique em "💾 Salvar planejamento" para guardar como plano ATUAL ou criar um NOVO.';
    return;
  }

  if (modoMeses){
    const disponivel = getStartingBalance();
    const fluxoMes = gas - rec;
    let mesesDuram = Infinity;
    if (fluxoMes > 0) mesesDuram = Math.max(0, Math.floor(disponivel / fluxoMes));
    resultEl.textContent = mesesDuram === Infinity ? '∞' : String(mesesDuram);
    resultEl.style.color = mesesDuram === 0 ? 'var(--red)' : (mesesDuram === Infinity ? 'var(--green)' : 'var(--gold)');
    resLblEl.textContent = 'Meses que duraria';
    noteEl.innerHTML = `Com gasto de <strong>${money(gas)}</strong>/mês e receita de <strong>${money(rec)}</strong>/mês, o saldo inicial de <strong>${money(disponivel)}</strong>${plan.useCustomBalance?' (personalizado)':''} dura aproximadamente <strong>${mesesDuram === Infinity ? '∞ (você tem sobra mensal)' : mesesDuram + ' mês(es)'}</strong>.`;
    return;
  }

  const totalDisponivel = getStartingBalance() + (rec * m);
  const gastoMedio = totalDisponivel / m;
  const mediaReal = plan.rows.length > 0
    ? plan.rows.reduce((s,r)=> s + (Number(r.gastos)||0), 0) / plan.rows.length
    : 0;

  resLblEl.textContent = 'Gasto médio mensal permitido';
  if (gastoMedio < 0){
    resultEl.textContent = money(gastoMedio);
    resultEl.style.color = 'var(--red)';
    noteEl.innerHTML = `Com esse cenário o saldo inicial <strong style="color:var(--red);">não dura ${m} mês(es)</strong>. Aumente a receita ou reduza o prazo.`;
  } else {
    resultEl.textContent = money(gastoMedio);
    resultEl.style.color = 'var(--green)';
    const perDay = gastoMedio / 30;
    let extra = '';
    if (plan.rows.length > 0){
      extra = `<br>Média de gasto real dos <strong>${plan.rows.length}</strong> meses cadastrados: <strong style="color:var(--gold);">${money(mediaReal)}</strong>/mês`;
      if (mediaReal > gastoMedio){
        extra += ` — <span style="color:var(--red);">você está gastando ${money(mediaReal - gastoMedio)} acima do limite!</span>`;
      } else if (mediaReal > 0){
        extra += ` — <span style="color:var(--green);">você está dentro do orçamento (${money(gastoMedio - mediaReal)} de folga).</span>`;
      }
    }
    noteEl.innerHTML = `Para durar <strong>${m} mês(es)</strong> com saldo inicial ${money(getStartingBalance())}${plan.useCustomBalance?' (personalizado)':''} + receita ${money(rec)}/mês: gasto permitido = <strong>${money(gastoMedio)}</strong>/mês ≈ <strong>${money(perDay)}</strong>/dia.${extra}`;
  }
}

// ===============================
//   TABLE
// ===============================
function renderTable(){
  const tbody = document.getElementById('plan-body');
  const empty = document.getElementById('empty-plan');
  tbody.innerHTML = '';
  const calc = calculate();

  if (calc.length === 0){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  calc.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.dataset.id = r.id;
    const first = i === 0;
    const isEditing = editingId === r.id;
    const isViewing = viewingId === r.id;

    if (isEditing){
      const state = editingCache;
      tr.style.background = 'rgba(212,168,87,.05)';
      tr.innerHTML = `
        <td style="text-align:left;">
          ${plan.name ? `<span style="font-size:11px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px;letter-spacing:.3px;">${escapeHtml(plan.name)}</span>` : ''}
          <input type="text" class="editable-input" name="monthLabel" value="${escapeHtml(state.monthLabel)}" placeholder="Ex: Janeiro 2026" autocomplete="off" spellcheck="false" style="width:100%;">
        </td>
        <td><div class="mono" style="padding:7px 10px;color:var(--gold);font-weight:600;">${money(r.saldoInicial)}</div></td>
        <td><input type="number" step="0.01" min="0" class="editable-input mono" name="receita" value="${formatInputNum(state.receita)}" placeholder="0,00" autocomplete="off" inputmode="decimal" spellcheck="false"></td>
        <td><input type="number" step="0.01" min="0" class="editable-input mono" name="gastos" value="${formatInputNum(state.gastos)}" placeholder="0,00" autocomplete="off" inputmode="decimal" spellcheck="false"></td>
        <td><input type="number" step="0.01" min="0" class="editable-input mono" name="investimentos" value="${formatInputNum(state.investimentos)}" placeholder="0,00" autocomplete="off" inputmode="decimal" spellcheck="false"></td>
        <td><div class="mono" style="padding:7px 10px;font-weight:700;color:${r.saldoFinal<0?'var(--red)':r.saldoFinal>0?'var(--green)':'var(--text-dim)'};">${(r.saldoFinal>=0?'+':'')+money(r.saldoFinal)}</div></td>
        <td style="text-align:left;">
          <div class="row-actions" style="justify-content:flex-start;">
            <button class="icon-btn save" title="Salvar alterações">✓</button>
            <button class="icon-btn cancel" title="Cancelar edição">↶</button>
          </div>
        </td>
      `;
      tr.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', () => {
          if (inp.name === 'monthLabel') editingCache.monthLabel = inp.value;
          else {
            const n = parseFloat(inp.value);
            editingCache[inp.name] = isNaN(n) ? 0 : n;
          }
        });
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') tr.querySelector('.icon-btn.save').click();
          if (e.key === 'Escape') tr.querySelector('.icon-btn.cancel').click();
        });
      });
      tr.querySelector('.icon-btn.save').addEventListener('click', () => saveRowEdit(r.id));
      tr.querySelector('.icon-btn.cancel').addEventListener('click', () => { editingId = null; editingCache = {}; renderAll(); });
    } else {
      if (isViewing) tr.style.boxShadow = 'inset 3px 0 0 var(--gold)';
      tr.innerHTML = `
        <td style="text-align:left;font-weight:600;">
          ${plan.name ? `<span style="font-size:11px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px;letter-spacing:.3px;">${escapeHtml(plan.name)}</span>` : ''}
          <span>${escapeHtml(r.monthLabel)}</span>
          ${first ? '<div style="font-size:10px;color:var(--gold);margin-top:2px;">(mês atual)</div>' : ''}
        </td>
        <td class="mono" style="color:var(--gold);font-weight:600;">${money(r.saldoInicial)}</td>
        <td class="mono tx-value entrada" style="font-weight:700;">+${money(r.receita)}</td>
        <td class="mono tx-value saida" style="font-weight:700;">-${money(r.gastos)}</td>
        <td class="mono" style="font-weight:700;color:#b087ff;">${money(r.investimentos)}</td>
        <td class="mono" style="font-weight:700;color:${r.saldoFinal<0?'var(--red)':r.saldoFinal>0?'var(--green)':'var(--text-dim)'};">${(r.saldoFinal>=0?'+':'')+money(r.saldoFinal)}</td>
        <td style="text-align:left;">
          <div class="row-actions" style="justify-content:flex-start;">
            <button class="icon-btn view" title="Visão detalhada">👁</button>
            <button class="icon-btn edit" title="Editar mês">✎</button>
            <button class="icon-btn delete" title="Remover mês">🗑</button>
          </div>
        </td>
      `;
      tr.querySelector('.icon-btn.view').addEventListener('click', () => {
        viewingId = viewingId === r.id ? null : r.id;
        renderAll();
      });
      tr.querySelector('.icon-btn.edit').addEventListener('click', () => {
        editingId = r.id;
        editingCache = {
          id: r.id,
          monthLabel: r.monthLabel,
          receita: r.receita,
          gastos: r.gastos,
          investimentos: r.investimentos
        };
        renderAll();
        setTimeout(() => document.querySelector(`tr[data-id="${r.id}"] input[name="receita"]`)?.focus(), 40);
      });
      tr.querySelector('.icon-btn.delete').addEventListener('click', () => {
        if (!confirm(`Remover mês "${r.monthLabel}" do plano atual?`)) return;
        plan.rows = plan.rows.filter(x => x.id !== r.id);
        saveStore();
        renderAll();
      });
    }

    tbody.appendChild(tr);
  });
}

function saveRowEdit(id){
  const state = editingCache;
  const value = parseFloat(state.receita);
  const gasto = parseFloat(state.gastos);
  const inv   = parseFloat(state.investimentos);
  const label = (state.monthLabel || '').trim();
  const date  = label || 'Mês';
  if (!date){ alert('Informe o nome do mês.'); return; }

  const idx = plan.rows.findIndex(r => r.id === id);
  if (idx === -1) return;
  plan.rows[idx].monthLabel = date;
  plan.rows[idx].receita = isNaN(value) ? 0 : value;
  plan.rows[idx].gastos  = isNaN(gasto) ? 0 : gasto;
  plan.rows[idx].investimentos = isNaN(inv) ? 0 : inv;

  saveStore();
  editingId = null;
  editingCache = {};
  renderAll();
}

// ===============================
//   VIEW PANEL (DETALHES)
// ===============================
function renderViewPanel(){
  const panel = document.getElementById('view-panel');
  if (!panel) return;
  if (!viewingId){ panel.style.display = 'none'; return; }
  const calc = calculate();
  const row = calc.find(r => r.id === viewingId);
  if (!row){ viewingId = null; panel.style.display = 'none'; return; }

  panel.style.display = 'block';
  document.getElementById('view-title-inner').textContent = (plan.name ? `${plan.name} · ` : '') + row.monthLabel;

  // ---------- Nav estado (botões e contador) ----------
  const idx = calc.findIndex(r => r.id === row.id);
  const countEl = document.getElementById('view-nav-count');
  const vPrev = document.getElementById('view-prev');
  const vNext = document.getElementById('view-next');
  const vFirst = document.getElementById('view-first');
  const vLast  = document.getElementById('view-last');
  const subEl  = document.getElementById('view-nav-subtitle');
  if (countEl) countEl.textContent = `${idx + 1} / ${calc.length}`;
  const many = calc.length > 1;
  if (vPrev) { vPrev.disabled = !many; vPrev.style.opacity = many ? '1' : '.35'; vPrev.style.cursor = many ? 'pointer' : 'not-allowed'; }
  if (vNext) { vNext.disabled = !many; vNext.style.opacity = many ? '1' : '.35'; vNext.style.cursor = many ? 'pointer' : 'not-allowed'; }
  if (vFirst){ vFirst.disabled = !many; vFirst.style.opacity = many ? '1' : '.35'; vFirst.style.cursor = many ? 'pointer' : 'not-allowed'; }
  if (vLast) { vLast.disabled  = !many; vLast.style.opacity = many ? '1' : '.35'; vLast.style.cursor  = many ? 'pointer' : 'not-allowed'; }
  if (subEl)  subEl.textContent = many
    ? `◀ / ▶ navega · teclas ← → Home End também funcionam`
    : `Apenas 1 mês no planejamento. Adicione mais para navegar entre eles.`;

  document.getElementById('view-inicial').textContent = money(row.saldoInicial);
  document.getElementById('view-receita').textContent = money(row.receita);
  document.getElementById('view-gastos').textContent  = money(row.gastos);
  document.getElementById('view-invest').textContent  = money(row.investimentos);
  document.getElementById('view-final').textContent   = money(row.saldoFinal);

  const totalSaidas = (row.gastos||0) + (row.investimentos||0);
  const gastoSobreReceita = row.receita > 0 ? (row.gastos / row.receita) : 0;
  const investSobreReceita = row.receita > 0 ? (row.investimentos / row.receita) : 0;
  const saldoDelta = row.saldoFinal - row.saldoInicial;
  const idx = plan.rows.findIndex(r => r.id === row.id);
  const projecaoFinal = calc[calc.length-1].saldoFinal;

  const indicadores = document.getElementById('view-indicators');
  indicadores.innerHTML = `
    <div>• <strong>Total de saídas do mês:</strong> <span class="mono" style="color:var(--red);">${money(totalSaidas)}</span> (gastos + investimentos)</div>
    <div>• <strong>Gasto / Receita:</strong> <span class="mono">${pct(gastoSobreReceita)}</span> ${gastoSobreReceita > 0.7 ? '<span style="color:var(--red);">(alto)</span>' : gastoSobreReceita > 0.5 ? '<span style="color:var(--gold);">(moderado)</span>' : '<span style="color:var(--green);">(saudável)</span>'}</div>
    <div>• <strong>Investimento / Receita:</strong> <span class="mono">${pct(investSobreReceita)}</span> ${investSobreReceita > 0.2 ? '<span style="color:var(--green);">(acima de 20% — excelente!)</span>' : investSobreReceita > 0 ? '<span style="color:var(--gold);">(invista mais)</span>' : ''}</div>
    <div>• <strong>Variação do mês:</strong> <span class="mono" style="color:${saldoDelta<0?'var(--red)':saldoDelta>0?'var(--green)':'var(--text-dim)'};font-weight:700;">${saldoDelta>=0?'+':''}${money(saldoDelta)}</span></div>
    <div>• <strong>Impacto no saldo final:</strong> mês #${idx+1} de ${calc.length} — projeção final: <span class="mono" style="color:${projecaoFinal<0?'var(--red)':'var(--gold)'};">${money(projecaoFinal)}</span></div>
  `;

  // Timeline
  const wrap = document.getElementById('view-timeline-wrap');
  const list = document.getElementById('view-timeline');
  const titleEl = document.getElementById('timeline-title');
  if (wrap && list){
    if (calc.length <= 1){
      wrap.style.display = 'none';
    } else {
      wrap.style.display = 'block';
      titleEl.textContent = `Resumo dos ${calc.length} meses do planejamento · clique para ver detalhes abaixo`;
      list.innerHTML = '';
      const restantes = calc.filter(r => r.id !== viewingId);
      const primeiro = [row, ...restantes];
      primeiro.forEach(r => {
        const isSel = r.id === viewingId;
        const delta = r.saldoFinal - r.saldoInicial;
        const card = document.createElement('div');
        card.dataset.timelineId = r.id;
        card.style.cssText = `
          background:${isSel ? 'var(--bg)' : 'var(--surface-2)'};
          border:1px solid ${isSel ? 'var(--gold)' : 'var(--border)'};
          border-radius:var(--radius);
          padding:12px 14px 10px;
          cursor:pointer;
          transition:all .15s ease;
          box-shadow:${isSel ? '0 0 0 2px rgba(212,168,87,.25)' : 'none'};
        `;
        card.onmouseenter = () => { card.style.borderColor = 'var(--gold)'; card.style.transform = 'translateY(-1px)'; };
        card.onmouseleave = () => { card.style.borderColor = isSel ? 'var(--gold)' : 'var(--border)'; card.style.transform = 'translateY(0)'; };
        card.addEventListener('click', () => {
          viewingId = r.id;
          renderAll();
          // Scroll foca na timeline, com um offset para o usuário ver os cards + relatório abaixo
          requestAnimationFrame(() => {
            const panel = document.getElementById('view-panel');
            if (panel){
              panel.scrollIntoView({ behavior:'smooth', block:'start' });
            }
            // Flash visual no card selecionado
            setTimeout(() => {
              const target = document.querySelector(`[data-timeline-id="${r.id}"]`);
              if (target){
                target.animate(
                  [
                    { boxShadow: '0 0 0 2px rgba(212,168,87,.25)' },
                    { boxShadow: '0 0 0 5px rgba(212,168,87,.55)' },
                    { boxShadow: '0 0 0 2px rgba(212,168,87,.25)' }
                  ],
                  { duration: 900, easing: 'ease-out' }
                );
              }
            }, 320);
          });
        });
        card.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span style="font-weight:700;font-size:13px;">${escapeHtml(r.monthLabel)}</span>
            ${isSel ? '<span style="font-size:11px;background:var(--gold);color:#1a1815;padding:2px 8px;border-radius:999px;">atual</span>' : ''}
          </div>
          <div class="mono" style="font-size:11px;color:var(--text-dim);">Inicial ${money(r.saldoInicial)}</div>
          <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:12px;">
            <span class="mono" style="color:var(--green);">+${money(r.receita||0)}</span>
            <span class="mono" style="color:var(--red);">-${money((r.gastos||0)+(r.investimentos||0))}</span>
          </div>
          <div class="mono" style="margin-top:8px;font-weight:700;font-size:14px;color:${delta<0?'var(--red)':delta>0?'var(--green)':'var(--text-dim)'};">
            Final: ${money(r.saldoFinal)}
            <span style="font-size:10px;font-weight:400;opacity:.7;display:block;">Δ ${delta>=0?'+':''}${money(delta)}</span>
          </div>
          <div style="margin-top:8px;display:flex;align-items:center;gap:5px;font-size:10.5px;color:${isSel ? 'var(--gold)' : 'var(--text-dim)'};">
            <span style="font-size:11px;">⌄</span>
            <span>${isSel ? 'Detalhes embaixo ✓' : 'Clique · detalhes embaixo'}</span>
          </div>
        `;
        list.appendChild(card);
      });
    }
  }

  // ============ RELATÓRIO EM LISTA MÊS A MÊS (DESTAQUE) ============
  const rWrap = document.getElementById('view-report-wrap');
  const rEl = document.getElementById('view-report');
  if (rWrap && rEl){
    if (calc.length === 0){
      rWrap.style.display = 'none';
    } else {
      rWrap.style.display = 'block';

      const saldo0 = getStartingBalance();
      const totalReceita = calc.reduce((s,r)=>s+(+r.receita||0),0);
      const totalGastos  = calc.reduce((s,r)=>s+(+r.gastos||0),0);
      const totalInvest  = calc.reduce((s,r)=>s+(+r.investimentos||0),0);
      const saldoF = calc[calc.length-1].saldoFinal;
      const deltaTotal = saldoF - saldo0;

      const header = [];
      header.push(`<div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px dashed var(--border);">`);
      header.push(`<div style="font-family:'Fraunces',serif;font-size:14.5px;color:var(--gold);margin-bottom:6px;">📘 ${plan.name ? escapeHtml(plan.name) : 'Planejamento sem nome'} · Resumo de todos os ${calc.length} meses</div>`);
      header.push(`<div style="color:var(--text-dim);">`);
      header.push(`• Saldo inicial base: <strong class="mono">${money(saldo0)}</strong>${plan.useCustomBalance ? ' <span style="color:#7a9eff;">(personalizado)</span>' : ' <span style="color:var(--gold);">(do app)</span>'}</div>`);
      header.push(`• Total de receitas: <strong class="mono" style="color:var(--green);">${money(totalReceita)}</strong> · Total de gastos: <strong class="mono" style="color:var(--red);">${money(totalGastos)}</strong> · Total investido: <strong class="mono" style="color:#b087ff;">${money(totalInvest)}</strong></div>`);
      header.push(`• Resultado final após ${calc.length} mês(es): <strong class="mono" style="color:${saldoF<0?'var(--red)':saldoF>0?'var(--green)':'var(--text-dim)'};">${money(saldoF)}</strong> (${deltaTotal>=0?'+':''}${money(deltaTotal)})</div>`);
      header.push(`</div></div>`);

      const lines = [];
      calc.forEach((r, i) => {
        const delta = r.saldoFinal - r.saldoInicial;
        const totalSaidasMes = (+r.gastos||0) + (+r.investimentos||0);
        const isSel = r.id === viewingId;
        lines.push(`
          <div style="padding:10px 12px;border-radius:8px;margin-bottom:8px;background:${isSel ? 'rgba(212,168,87,.07)' : 'transparent'};border:${isSel ? '1px solid rgba(212,168,87,.35)' : '1px solid transparent'};">
            <div style="margin-bottom:3px;">
              <span style="font-weight:700;">${i+1}.</span>
              <span style="font-weight:700;color:var(--gold);margin-left:4px;">${escapeHtml(r.monthLabel)}</span>
              ${isSel ? '<span style="font-size:10.5px;background:var(--gold);color:#1a1815;padding:1px 8px;border-radius:999px;margin-left:6px;">selecionado</span>' : ''}
              ${i===0 ? '<span style="font-size:10.5px;color:var(--gold);margin-left:6px;">· 1º mês</span>' : ''}
              ${i===calc.length-1 ? '<span style="font-size:10.5px;color:var(--green);margin-left:6px;">· último mês</span>' : ''}
            </div>
            <div style="color:var(--text-dim);padding-left:14px;">
              Começa com <strong class="mono">${money(r.saldoInicial)}</strong>, recebe
              <strong class="mono" style="color:var(--green);">${money(r.receita||0)}</strong> de receita e gasta
              <strong class="mono" style="color:var(--red);">${money(r.gastos||0)}</strong> ${(+r.investimentos||0) > 0
                ? `+ investe <strong class="mono" style="color:#b087ff;">${money(r.investimentos||0)}</strong> (saídas do mês: <strong class="mono" style="color:var(--red);">${money(totalSaidasMes)}</strong>)`
                : `(sem investimentos no mês)`};
              fecha com saldo <strong class="mono" style="color:${r.saldoFinal<0?'var(--red)':r.saldoFinal>0?'var(--green)':'var(--text-dim)'};">${money(r.saldoFinal)}</strong>,
              variação de <strong class="mono" style="color:${delta<0?'var(--red)':delta>0?'var(--green)':'var(--text-dim)'};">${delta>=0?'+':''}${money(delta)}</strong>.
            </div>
          </div>
        `);
      });

      const mesesTexto = calc.length === 1 ? 'este único mês' : `todos os ${calc.length} meses`;
      const conclusao = [];
      conclusao.push(`<div style="margin-top:10px;padding:12px 14px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border);">`);
      conclusao.push(`<div style="font-weight:700;font-family:'Fraunces',serif;margin-bottom:4px;">📌 Conclusão</div>`);
      if (deltaTotal >= 0){
        conclusao.push(`<div>Passando por ${mesesTexto}, o saldo evolui de <strong class="mono">${money(saldo0)}</strong> para <strong class="mono" style="color:var(--green);">${money(saldoF)}</strong>, resultado positivo de <strong class="mono" style="color:var(--green);">+${money(deltaTotal)}</strong>.</div>`);
      } else {
        conclusao.push(`<div>Passando por ${mesesTexto}, o saldo cai de <strong class="mono">${money(saldo0)}</strong> para <strong class="mono" style="color:var(--red);">${money(saldoF)}</strong>, resultado negativo de <strong class="mono" style="color:var(--red);">${money(deltaTotal)}</strong>.</div>`);
      }
      const mediaGasto = totalGastos / Math.max(1, calc.length);
      const mediaReceita = totalReceita / Math.max(1, calc.length);
      const mediaInvest = totalInvest / Math.max(1, calc.length);
      conclusao.push(`<div style="margin-top:6px;color:var(--text-dim);">Média mensal: receita <strong class="mono">${money(mediaReceita)}</strong> · gasto <strong class="mono">${money(mediaGasto)}</strong> · investimento <strong class="mono">${money(mediaInvest)}</strong>.</div>`);
      conclusao.push(`</div>`);

      rEl.innerHTML = header.join('') + lines.join('') + conclusao.join('');
    }
  }
}

function formatInputNum(v){
  const n = Number(v) || 0;
  if (n === 0) return '';
  return n;
}

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
