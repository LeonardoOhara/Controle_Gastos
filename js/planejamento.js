import {
  auth, signOut, onAuthStateChanged,
  db, collection, onSnapshot, doc, setDoc, getDoc, serverTimestamp
} from "./firebase-config.js";

const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) logoutBtn.addEventListener('click', () => {
  signOut(auth).catch(err => console.error('Erro ao sair:', err));
});

const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const STORAGE_KEY = 'livro_caixa_planejamento';
const EMPTY_PLAN_COUNTER = 'Plano sem nome';

const money = (v) => v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const pct = (v) => (v*100).toFixed(1).replace('.',',') + '%';

// =========================================================
//  SIMULADOR: gera N meses de cálculo a partir de 1 simulação salva
//  (usado no painel de visualização 👁 e nos stats de cabeçalho)
// =========================================================
function simulatePlano(row, startingBalance){
  const n = Math.max(1, parseInt(row?.qtdMeses) || 1);
  const rec = Number(row?.receita) || 0;
  const gas = Number(row?.gastos) || 0;
  const inv = Number(row?.investimentos) || 0;
  const months = [];
  let running = Number(startingBalance) || 0;
  for (let i = 0; i < n; i++){
    const label = (row?.startMonthLabel)
      ? nextMonthLabelFromLastWithOffset(row.startMonthLabel, i)
      : nextMonthLabelFromDate(new Date(), i);
    const saldoInicial = running;
    const saldoFinal = saldoInicial + rec - gas - inv;
    months.push({
      id: `${row?.id || 'sim'}_m${i}`,
      monthLabel: label,
      receita: rec,
      gastos: gas,
      investimentos: inv,
      saldoInicial,
      saldoFinal
    });
    running = saldoFinal;
  }
  return months;
}

function nextMonthLabelFromLastWithOffset(lastLabel, offset){
  const parts = lastLabel.split(' ');
  const monthName = parts.slice(0, -1).join(' ');
  const year = parseInt(parts[parts.length-1]) || new Date().getFullYear();
  let idx = MONTHS.indexOf(monthName);
  if (idx === -1) idx = new Date().getMonth();
  idx += offset;
  const y = year + Math.floor(idx / 12);
  const m = ((idx % 12) + 12) % 12;
  return `${MONTHS[m]} ${y}`;
}

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
let viewingId = null;       // id da simulação (row da tabela) selecionada para 👁
let viewingMonthIdx = 0;    // índice do mês (0..N-1) DENTRO da simulação selecionada

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  currentUserUid = user.uid;
  // 1) Carrega do localStorage como cache rápido (usado enquanto Firestore carrega)
  loadStore();
  // 2) Garante que exista pelo menos 1 plano (usado antes do Firestore responder)
  if (store.plans.length === 0){
    const first = emptyPlan();
    first.id = genId();
    first.name = 'Plano inicial';
    store.plans.push(first);
    store.currentId = first.id;
    try { localStorage.setItem(storageKey(), JSON.stringify(store)); } catch (_) {}
  }
  if (!store.currentId || !store.plans.find(p=>p.id===store.currentId)){
    store.currentId = store.plans[0].id;
    try { localStorage.setItem(storageKey(), JSON.stringify(store)); } catch (_) {}
  }
  plan = store.plans.find(p=>p.id===store.currentId);
  bindStaticEvents();
  renderPlanSelector();
  syncUIWithPlan();
  renderAll();
  // 3) Liga listeners do Firestore em background (transactions + planning)
  startFirestoreListener();
  startPlanningFirestoreListener();
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

// =========================================================
//  PERSISTÊNCIA: localStorage (cache) + Firestore (fonte)
// =========================================================
let _firestoreUnsubPlanning = null;
let _firestoreLoadedOnce = false;
let _writingToFirestore = false;

function planningDocRef(){
  if (!currentUserUid) return null;
  return doc(db, 'planning', currentUserUid);
}

function saveStore(){
  // Salva sempre no localStorage como cache de fallback
  try { localStorage.setItem(storageKey(), JSON.stringify(store)); }
  catch (e) { console.error('Erro ao salvar store planejamento (local):', e); }
  // Também envia ao Firestore se usuário logado e já terminou o load inicial
  saveStoreToFirestore();
}

async function saveStoreToFirestore(){
  if (!currentUserUid || !_firestoreLoadedOnce || _writingToFirestore) return;
  const ref = planningDocRef();
  if (!ref) return;
  _writingToFirestore = true;
  try {
    await setDoc(ref, {
      currentId: store.currentId || null,
      plans: Array.isArray(store.plans) ? store.plans : [],
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.error('Erro ao salvar planejamento no Firestore:', e);
    if (e && String(e.message || e).toLowerCase().includes('permission')){
      alert('Não foi possível salvar o planejamento no banco de dados.\nVerifique as regras de permissão do Firestore no console Firebase.');
    }
  } finally {
    _writingToFirestore = false;
  }
}

function applyFirestoreToStore(dataFromFirestore, { preferLocalIfConflict = true } = {}){
  if (!dataFromFirestore || (dataFromFirestore.plans === undefined && dataFromFirestore.currentId === undefined)){
    // Nada no Firestore ainda → mantém localStorage (e vamos subir depois)
    return false;
  }
  const hasFirestoreData = Array.isArray(dataFromFirestore.plans) && dataFromFirestore.plans.length > 0;
  const hasLocalData = Array.isArray(store.plans) && store.plans.length > 0;

  let incoming;
  if (preferLocalIfConflict && hasLocalData && !hasFirestoreData){
    // Local tem dados, Firestore está vazio → não aplica, e saveStore() subirá depois
    return false;
  }
  if (preferLocalIfConflict && hasLocalData && hasFirestoreData){
    // Ambos têm dados → dá preferência ao Firestore como fonte sincronizada
    // (mas se local tiver mais simulações, você poderia fazer merge; aqui usamos Firestore como fonte)
  }
  try {
    incoming = normalizePlanFirestoreDoc(dataFromFirestore);
  } catch (e) {
    console.error('Dados do Firestore inválidos para planejamento:', e);
    return false;
  }
  store = incoming;
  // Replica no cache local para o caso de o Firestore falhar depois
  try { localStorage.setItem(storageKey(), JSON.stringify(store)); } catch (_) {}
  return true;
}

function normalizePlanFirestoreDoc(obj){
  const currentId = typeof obj.currentId === 'string' ? obj.currentId : null;
  const plans = Array.isArray(obj.plans) ? obj.plans.map(p => normalizePlan(p)).filter(Boolean) : [];
  return {
    currentId: currentId && plans.find(p => p.id === currentId) ? currentId : (plans.length > 0 ? plans[0].id : null),
    plans
  };
}

async function migrateLocalStorageToFirestoreIfNeeded(){
  if (!currentUserUid) return;
  try {
    const ref = planningDocRef();
    if (!ref) return;
    const snap = await getDoc(ref);
    if (!snap.exists() || !snap.data() || !Array.isArray(snap.data().plans) || snap.data().plans.length === 0){
      // Firestore vazio → sobe o localStorage se tiver dados
      if (Array.isArray(store.plans) && store.plans.length > 0){
        await saveStoreToFirestore();
      }
    }
  } catch (e) {
    console.error('Erro ao migrar localStorage → Firestore (planning):', e);
  }
}

function startPlanningFirestoreListener(){
  if (!currentUserUid) return;
  if (typeof _firestoreUnsubPlanning === 'function') _firestoreUnsubPlanning();
  const ref = planningDocRef();
  if (!ref) return;

  _firestoreUnsubPlanning = onSnapshot(ref, (snap) => {
    if (!snap.exists){
      // Ainda não há doc no Firestore → tenta migrar do localStorage uma única vez
      if (!_firestoreLoadedOnce){
        _firestoreLoadedOnce = true;
        migrateLocalStorageToFirestoreIfNeeded();
        renderAll();
      }
      return;
    }
    const data = snap.data();
    const changed = applyFirestoreToStore(data, { preferLocalIfConflict: !_firestoreLoadedOnce });
    if (!_firestoreLoadedOnce){
      _firestoreLoadedOnce = true;
      // Se o Firestore estava vazio e nós temos dados locais, subir agora
      if (!changed && Array.isArray(store.plans) && store.plans.length > 0){
        migrateLocalStorageToFirestoreIfNeeded();
      }
    }
    // Ajusta referência global do plano ativo
    if (store.plans.length === 0){
      const first = emptyPlan();
      first.id = genId();
      first.name = 'Plano inicial';
      store.plans.push(first);
      store.currentId = first.id;
      saveStore();
    } else if (!store.currentId || !store.plans.find(p=>p.id===store.currentId)){
      store.currentId = store.plans[0].id;
      saveStore();
    }
    plan = store.plans.find(p=>p.id===store.currentId) || emptyPlan();
    renderPlanSelector();
    syncUIWithPlan();
    renderAll();
  }, (err) => {
    console.error('Erro ao ler planejamento do Firestore:', err);
    if (err && String(err.message || err).toLowerCase().includes('permission')){
      // Permissão negada → continua usando localStorage como fonte
      if (!_firestoreLoadedOnce){
        _firestoreLoadedOnce = true;
        renderAll();
      }
    }
  });
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
    rows: rows.map(r => normalizeRowLegacy(r)),
    createdAt: Date.now()
  });
}

// Migra 1 row do formato antigo (mês único) para o formato novo (simulação com qtdMeses)
function normalizeRowLegacy(r){
  if (!r) return null;
  if (typeof r.qtdMeses !== 'undefined' && r.qtdMeses !== null){
    // Já é formato novo
    return normalizeRow(r);
  }
  // Formato antigo → vira simulação de 1 mês
  return normalizeRow({
    id: r?.id || genId(),
    startMonthLabel: r?.monthLabel || nextMonthLabelFromDate(new Date(), 0),
    qtdMeses: 1,
    receita: Number(r?.receita) || 0,
    gastos: Number(r?.gastos) || 0,
    investimentos: Number(r?.investimentos) || 0,
    createdAt: Number(r?.createdAt) || Date.now()
  });
}

function normalizeRow(r){
  if (!r) return null;
  return {
    id: r.id || genId(),
    startMonthLabel: typeof r.startMonthLabel === 'string' && r.startMonthLabel
      ? r.startMonthLabel
      : nextMonthLabelFromDate(new Date(), 0),
    qtdMeses: Math.max(1, parseInt(r.qtdMeses) || 1),
    receita: Number(r.receita) || 0,
    gastos: Number(r.gastos) || 0,
    investimentos: Number(r.investimentos) || 0,
    createdAt: Number(r.createdAt) || Date.now()
  };
}

function normalizePlan(p){
  if (!p) return emptyPlan();
  const rawRows = Array.isArray(p.rows) ? p.rows : [];
  const normalizedRows = [];
  rawRows.forEach(r => {
    const nr = normalizeRowLegacy(r);
    if (nr) normalizedRows.push(nr);
  });
  return {
    id: p.id || genId(),
    name: typeof p.name === 'string' ? p.name : '',
    useCustomBalance: !!p.useCustomBalance,
    customBalance: Number(p.customBalance) || 0,
    rows: normalizedRows,
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
    opt.textContent = `${display}${p.rows.length ? ` · ${p.rows.length} sim` : ''}`;
    if (p.id === store.currentId) opt.selected = true;
    sel.appendChild(opt);
  });
  if (count) count.textContent = `${store.plans.length} plano(s) salvo(s)`;
}

function startFirestoreListener(){
  const txCol = collection(db, 'transactions');
  const q = query(txCol, where('uid', '==', currentUserUid));
  onSnapshot(q, (snapshot) => {
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
  const btnUseSaldo = document.getElementById('btn-use-saldo');
  if (btnUseSaldo) btnUseSaldo.addEventListener('click', () => {
    plan.useCustomBalance = false;
    plan.customBalance = 0;
    saveStore();
    syncUIWithPlan();
    renderAll();
  });

  // --- Botão Limpar simulações (só linhas do plano atual)
  const btnClear = document.getElementById('btn-clear-rows');
  if (btnClear) btnClear.addEventListener('click', () => {
    if (plan.rows.length === 0) return;
    if (!confirm(`Limpar TODAS as ${plan.rows.length} simulações do plano atual?\nNome e saldo inicial permanecem.`)) return;
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

  // Popula as linhas com a quantidade informada na calculadora
  populateReverseIntoCurrent(m, choice==='new');
  if (choice === 'new'){
    renderPlanSelector();
    syncUIWithPlan();
  }
  saveStore();
  renderAll();
}

function chooseSaveAction(){
  const mesesEl = document.getElementById('rev-meses');
  const qtd = parseInt(mesesEl?.value) || 0;
  const qtdStr = qtd > 0 ? `${qtd} mês(es)` : 'os meses';
  const display = (plan.name || EMPTY_PLAN_COUNTER);
  const nSim = plan.rows.length;
  const msg =
`Escolha uma ação para o resultado da calculadora (${qtdStr}):

[1] Salvar no plano ATUAL  →  "${display}"
     - Cria UMA SIMULAÇÃO (1 linha) com ${qtdStr} calculados dinamicamente.
     - ${nSim > 0 ? `Hoje já existem ${nSim} simulação(ões) salva(s) neste plano — mais uma será adicionada.` : 'Ainda não há simulações, a primeira será criada.'}

[2] CRIAR como NOVO plano
     - Gera um novo planejamento independente e o abre.
     - Cria 1 simulação com ${qtdStr}.

Cancelar = não fazer nada.`;

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

  // Cria SEMPRE 1 simulação resumida, com N meses embutidos no parâmetro qtdMeses
  const startLabel = nextMonthLabelFromDate(now, 0);
  const novaSimulacao = {
    id: genId(),
    startMonthLabel: startLabel,
    qtdMeses: Math.max(1, parseInt(qtd) || 1),
    receita: rec,
    gastos: gastoPorMes,
    investimentos: 0,
    createdAt: Date.now()
  };

  if (isNewPlan || plan.rows.length === 0){
    plan.rows = [novaSimulacao];
  } else {
    // Adiciona como NOVA simulação ao lado das existentes
    plan.rows.push(novaSimulacao);
  }
  viewingId = null;
  editingId = null;
}

// ===============================
//   NAVEGAÇÃO DE MÊS NO PAINEL DE VISÃO
// ===============================
function navigateViewMonth(dir){
  const sim = getActiveSimRow();
  if (!sim) return;
  const n = Math.max(1, parseInt(sim.qtdMeses) || 1);
  if (dir === 'first') viewingMonthIdx = 0;
  else if (dir === 'last') viewingMonthIdx = n - 1;
  else viewingMonthIdx = ((viewingMonthIdx + dir) % n + n) % n;
  renderAll();
  requestAnimationFrame(() => {
    const panel = document.getElementById('view-panel');
    if (panel) panel.scrollIntoView({ behavior:'smooth', block:'start' });
    setTimeout(() => {
      const target = document.querySelector(`[data-timeline-id="${sim.id}_m${viewingMonthIdx}"]`);
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
// Retorna a simulação (row) atualmente usada como referência para cálculos/stats
// Prioridade: 1) viewingId se definido  2) última row salva  3) null
function getActiveSimRow(){
  if (!plan.rows || plan.rows.length === 0) return null;
  if (viewingId){
    const r = plan.rows.find(x => x.id === viewingId);
    if (r) return r;
  }
  if (editingId){
    const r = plan.rows.find(x => x.id === editingId);
    if (r) return r;
  }
  return plan.rows[plan.rows.length - 1];
}

function calculate(){
  const active = getActiveSimRow();
  if (!active) return [];
  // Expande a simulação em N meses para manter compatibilidade com renderViewPanel/timeline
  return simulatePlano(active, getStartingBalance());
}

function calculateRunwayMonths(calcRows){
  const startBal = getStartingBalance();
  if (startBal <= 0) return 0;
  const n = Math.max(1, calcRows.length);
  const avgGastos = calcRows.reduce((s,r)=> s + (Number(r.gastos)||0), 0) / n;
  const avgReceita = calcRows.reduce((s,r)=> s + (Number(r.receita)||0), 0) / n;
  const avgInvest = calcRows.reduce((s,r)=> s + (Number(r.investimentos)||0), 0) / n;
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
      extra = `<br>Média de gasto mensal das <strong>${plan.rows.length}</strong> simulações salvas: <strong style="color:var(--gold);">${money(mediaReal)}</strong>/mês`;
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
  const rows = plan.rows || [];

  if (rows.length === 0){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  rows.forEach((sim, simIndex) => {
    const tr = document.createElement('tr');
    tr.dataset.id = sim.id;
    const isEditing = editingId === sim.id;
    const isViewing = viewingId === sim.id;

    // Simulação expandida para mostrar saldo inicial/final e valores agregados
    const expanded = simulatePlano(sim, getStartingBalance());
    const firstMonth = expanded[0];
    const lastMonth  = expanded[expanded.length - 1];
    const labelInicial = sim.startMonthLabel;
    const labelFinal = expanded.length > 1
      ? nextMonthLabelFromLastWithOffset(sim.startMonthLabel, expanded.length - 1)
      : sim.startMonthLabel;

    if (isEditing){
      const state = editingCache;
      tr.style.background = 'rgba(212,168,87,.05)';
      tr.innerHTML = `
        <td style="text-align:left;">
          ${plan.name ? `<span style="font-size:11px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px;letter-spacing:.3px;">${escapeHtml(plan.name)}</span>` : ''}
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input type="text" class="editable-input" name="startMonthLabel" value="${escapeHtml(state.startMonthLabel)}" placeholder="Ex: Julho 2026" autocomplete="off" spellcheck="false" style="flex:1;min-width:140px;">
            <span style="font-size:12px;color:var(--text-dim);">→</span>
            <input type="number" step="1" min="1" class="editable-input mono" name="qtdMeses" value="${state.qtdMeses}" placeholder="12" autocomplete="off" inputmode="numeric" spellcheck="false" style="max-width:90px;">
            <span style="font-size:12px;color:var(--text-dim);">mês(es)</span>
          </div>
        </td>
        <td><div class="mono" style="padding:7px 10px;color:var(--gold);font-weight:600;">${money(firstMonth.saldoInicial)}</div></td>
        <td><input type="number" step="0.01" min="0" class="editable-input mono" name="receita" value="${formatInputNum(state.receita)}" placeholder="0,00" autocomplete="off" inputmode="decimal" spellcheck="false"></td>
        <td><input type="number" step="0.01" min="0" class="editable-input mono" name="gastos" value="${formatInputNum(state.gastos)}" placeholder="0,00" autocomplete="off" inputmode="decimal" spellcheck="false"></td>
        <td><input type="number" step="0.01" min="0" class="editable-input mono" name="investimentos" value="${formatInputNum(state.investimentos)}" placeholder="0,00" autocomplete="off" inputmode="decimal" spellcheck="false"></td>
        <td><div class="mono" style="padding:7px 10px;font-weight:700;color:${lastMonth.saldoFinal<0?'var(--red)':lastMonth.saldoFinal>0?'var(--green)':'var(--text-dim)'};">${(lastMonth.saldoFinal>=0?'+':'')+money(lastMonth.saldoFinal)}</div></td>
        <td style="text-align:left;">
          <div class="row-actions" style="justify-content:flex-start;">
            <button class="icon-btn save" title="Salvar alterações">✓</button>
            <button class="icon-btn cancel" title="Cancelar edição">↶</button>
          </div>
        </td>
      `;
      tr.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', () => {
          if (inp.name === 'startMonthLabel'){
            editingCache.startMonthLabel = inp.value;
          } else if (inp.name === 'qtdMeses'){
            const n = parseInt(inp.value);
            editingCache.qtdMeses = isNaN(n) || n < 1 ? 1 : n;
          } else {
            const n = parseFloat(inp.value);
            editingCache[inp.name] = isNaN(n) ? 0 : n;
          }
        });
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') tr.querySelector('.icon-btn.save').click();
          if (e.key === 'Escape') tr.querySelector('.icon-btn.cancel').click();
        });
      });
      tr.querySelector('.icon-btn.save').addEventListener('click', () => saveRowEdit(sim.id));
      tr.querySelector('.icon-btn.cancel').addEventListener('click', () => { editingId = null; editingCache = {}; renderAll(); });
    } else {
      if (isViewing) tr.style.boxShadow = 'inset 3px 0 0 var(--gold)';
      const totalReceita = sim.receita * sim.qtdMeses;
      const totalGastos  = sim.gastos  * sim.qtdMeses;
      const totalInvest  = sim.investimentos * sim.qtdMeses;
      tr.innerHTML = `
        <td style="text-align:left;font-weight:600;">
          ${plan.name ? `<span style="font-size:11px;color:var(--gold);font-weight:700;display:block;margin-bottom:4px;letter-spacing:.3px;">${escapeHtml(plan.name)}</span>` : ''}
          <span>${escapeHtml(labelInicial)} → ${escapeHtml(labelFinal)}</span>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px;font-weight:500;">
            ${sim.qtdMeses} ${sim.qtdMeses === 1 ? 'mês' : 'meses'} · ${money(totalReceita)} receita · ${money(totalGastos)} gastos${totalInvest>0?` · ${money(totalInvest)} invest.`:''}
          </div>
        </td>
        <td class="mono" style="color:var(--gold);font-weight:600;">${money(firstMonth.saldoInicial)}</td>
        <td class="mono tx-value entrada" style="font-weight:700;">+${money(sim.receita)}<div style="font-size:10px;color:var(--text-dim);font-weight:500;margin-top:2px;">/mês · ${money(totalReceita)} total</div></td>
        <td class="mono tx-value saida" style="font-weight:700;">-${money(sim.gastos)}<div style="font-size:10px;color:var(--text-dim);font-weight:500;margin-top:2px;">/mês · ${money(totalGastos)} total</div></td>
        <td class="mono" style="font-weight:700;color:#b087ff;">${money(sim.investimentos)}<div style="font-size:10px;color:var(--text-dim);font-weight:500;margin-top:2px;">/mês · ${money(totalInvest)} total</div></td>
        <td class="mono" style="font-weight:700;color:${lastMonth.saldoFinal<0?'var(--red)':lastMonth.saldoFinal>0?'var(--green)':'var(--text-dim)'};">${(lastMonth.saldoFinal>=0?'+':'')+money(lastMonth.saldoFinal)}<div style="font-size:10px;color:var(--text-dim);font-weight:500;margin-top:2px;">final do período</div></td>
        <td style="text-align:left;">
          <div class="row-actions" style="justify-content:flex-start;">
            <button class="icon-btn view" title="Visão detalhada (${sim.qtdMeses} mêses)">👁</button>
            <button class="icon-btn edit" title="Editar simulação">✎</button>
            <button class="icon-btn delete" title="Remover simulação">🗑</button>
          </div>
        </td>
      `;
      tr.querySelector('.icon-btn.view').addEventListener('click', () => {
        if (viewingId === sim.id){
          viewingId = null;
          viewingMonthIdx = 0;
        } else {
          viewingId = sim.id;
          viewingMonthIdx = 0;
        }
        renderAll();
      });
      tr.querySelector('.icon-btn.edit').addEventListener('click', () => {
        editingId = sim.id;
        editingCache = {
          id: sim.id,
          startMonthLabel: sim.startMonthLabel,
          qtdMeses: sim.qtdMeses,
          receita: sim.receita,
          gastos: sim.gastos,
          investimentos: sim.investimentos
        };
        renderAll();
        setTimeout(() => document.querySelector(`tr[data-id="${sim.id}"] input[name="receita"]`)?.focus(), 40);
      });
      tr.querySelector('.icon-btn.delete').addEventListener('click', () => {
        if (!confirm(`Remover a simulação "${labelInicial} → ${labelFinal}" (${sim.qtdMeses} mêses) do plano atual?`)) return;
        plan.rows = plan.rows.filter(x => x.id !== sim.id);
        if (viewingId === sim.id){ viewingId = null; viewingMonthIdx = 0; }
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
  const qtd   = parseInt(state.qtdMeses);
  const startLabel = (state.startMonthLabel || '').trim();
  if (!startLabel){ alert('Informe o mês de início (ex: Julho 2026).'); return; }
  if (isNaN(qtd) || qtd < 1){ alert('Informe uma quantidade de meses válida (mínimo 1).'); return; }

  const idx = plan.rows.findIndex(r => r.id === id);
  if (idx === -1) return;
  plan.rows[idx].startMonthLabel = startLabel;
  plan.rows[idx].qtdMeses = qtd;
  plan.rows[idx].receita = isNaN(value) ? 0 : value;
  plan.rows[idx].gastos  = isNaN(gasto) ? 0 : gasto;
  plan.rows[idx].investimentos = isNaN(inv) ? 0 : inv;

  saveStore();
  editingId = null;
  editingCache = {};
  // Se estiver visualizando esta simulação, reseta índice do mês para 0 (evita out of range)
  if (viewingId === id && viewingMonthIdx >= qtd) viewingMonthIdx = 0;
  renderAll();
}

// ===============================
//   VIEW PANEL (DETALHES)
// ===============================
function renderViewPanel(){
  const panel = document.getElementById('view-panel');
  if (!panel) return;
  if (!viewingId){ panel.style.display = 'none'; return; }

  const sim = plan.rows.find(r => r.id === viewingId);
  if (!sim){ viewingId = null; viewingMonthIdx = 0; panel.style.display = 'none'; return; }

  const calc = simulatePlano(sim, getStartingBalance());
  if (calc.length === 0){ viewingId = null; viewingMonthIdx = 0; panel.style.display = 'none'; return; }

  // Garante que o índice do mês esteja dentro do range
  if (viewingMonthIdx < 0) viewingMonthIdx = 0;
  if (viewingMonthIdx >= calc.length) viewingMonthIdx = calc.length - 1;

  const row = calc[viewingMonthIdx];
  panel.style.display = 'block';
  const simLabelFinal = calc.length > 1
    ? nextMonthLabelFromLastWithOffset(sim.startMonthLabel, calc.length - 1)
    : sim.startMonthLabel;
  document.getElementById('view-title-inner').textContent =
    (plan.name ? `${plan.name} · ` : '') +
    `${sim.startMonthLabel} → ${simLabelFinal} (${calc.length} ${calc.length === 1 ? 'mês' : 'meses'}) · ${row.monthLabel}`;

  // ---------- Nav estado (botões e contador) ----------
  const countEl = document.getElementById('view-nav-count');
  const vPrev = document.getElementById('view-prev');
  const vNext = document.getElementById('view-next');
  const vFirst = document.getElementById('view-first');
  const vLast  = document.getElementById('view-last');
  const subEl  = document.getElementById('view-nav-subtitle');
  if (countEl) countEl.textContent = `${viewingMonthIdx + 1} / ${calc.length}`;
  const many = calc.length > 1;
  if (vPrev) { vPrev.disabled = !many; vPrev.style.opacity = many ? '1' : '.35'; vPrev.style.cursor = many ? 'pointer' : 'not-allowed'; }
  if (vNext) { vNext.disabled = !many; vNext.style.opacity = many ? '1' : '.35'; vNext.style.cursor = many ? 'pointer' : 'not-allowed'; }
  if (vFirst){ vFirst.disabled = !many; vFirst.style.opacity = many ? '1' : '.35'; vFirst.style.cursor = many ? 'pointer' : 'not-allowed'; }
  if (vLast) { vLast.disabled  = !many; vLast.style.opacity = many ? '1' : '.35'; vLast.style.cursor  = many ? 'pointer' : 'not-allowed'; }
  if (subEl)  subEl.textContent = many
    ? `◀ / ▶ navega entre os ${calc.length} meses · teclas ← → Home End também funcionam`
    : `Apenas 1 mês nesta simulação. Edite a linha (✎) para aumentar o prazo.`;

  document.getElementById('view-inicial').textContent = money(row.saldoInicial);
  document.getElementById('view-receita').textContent = money(row.receita);
  document.getElementById('view-gastos').textContent  = money(row.gastos);
  document.getElementById('view-invest').textContent  = money(row.investimentos);
  document.getElementById('view-final').textContent   = money(row.saldoFinal);

  const totalSaidas = (row.gastos||0) + (row.investimentos||0);
  const gastoSobreReceita = row.receita > 0 ? (row.gastos / row.receita) : 0;
  const investSobreReceita = row.receita > 0 ? (row.investimentos / row.receita) : 0;
  const saldoDelta = row.saldoFinal - row.saldoInicial;
  const planIdx = viewingMonthIdx;
  const projecaoFinal = calc[calc.length-1].saldoFinal;

  const indicadores = document.getElementById('view-indicators');
  indicadores.innerHTML = `
    <div>• <strong>Total de saídas do mês:</strong> <span class="mono" style="color:var(--red);">${money(totalSaidas)}</span> (gastos + investimentos)</div>
    <div>• <strong>Gasto / Receita:</strong> <span class="mono">${pct(gastoSobreReceita)}</span> ${gastoSobreReceita > 0.7 ? '<span style="color:var(--red);">(alto)</span>' : gastoSobreReceita > 0.5 ? '<span style="color:var(--gold);">(moderado)</span>' : '<span style="color:var(--green);">(saudável)</span>'}</div>
    <div>• <strong>Investimento / Receita:</strong> <span class="mono">${pct(investSobreReceita)}</span> ${investSobreReceita > 0.2 ? '<span style="color:var(--green);">(acima de 20% — excelente!)</span>' : investSobreReceita > 0 ? '<span style="color:var(--gold);">(invista mais)</span>' : ''}</div>
    <div>• <strong>Variação do mês:</strong> <span class="mono" style="color:${saldoDelta<0?'var(--red)':saldoDelta>0?'var(--green)':'var(--text-dim)'};font-weight:700;">${saldoDelta>=0?'+':''}${money(saldoDelta)}</span></div>
    <div>• <strong>Impacto no saldo final:</strong> mês #${planIdx+1} de ${calc.length} — projeção final: <span class="mono" style="color:${projecaoFinal<0?'var(--red)':'var(--gold)'};">${money(projecaoFinal)}</span></div>
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
      titleEl.textContent = `Resumo dos ${calc.length} meses da simulação · clique para ver detalhes abaixo`;
      list.innerHTML = '';
      calc.forEach((r, i) => {
        const isSel = i === viewingMonthIdx;
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
          viewingMonthIdx = i;
          renderAll();
          requestAnimationFrame(() => {
            const panelLocal = document.getElementById('view-panel');
            if (panelLocal){
              panelLocal.scrollIntoView({ behavior:'smooth', block:'start' });
            }
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
            ${isSel ? '<span style="font-size:11px;background:var(--gold);color:#1a1815;padding:2px 8px;border-radius:999px;">atual</span>' : `<span style="font-size:10px;color:var(--text-dim);">mês ${i+1}</span>`}
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
      header.push(`<div style="font-family:'Fraunces',serif;font-size:14.5px;color:var(--gold);margin-bottom:6px;">📘 ${plan.name ? escapeHtml(plan.name) : 'Planejamento sem nome'} · Simulação ${sim.startMonthLabel} → ${simLabelFinal} (${calc.length} ${calc.length === 1 ? 'mês' : 'meses'})</div>`);
      header.push(`<div style="color:var(--text-dim);">`);
      header.push(`• Saldo inicial base: <strong class="mono">${money(saldo0)}</strong>${plan.useCustomBalance ? ' <span style="color:#7a9eff;">(personalizado)</span>' : ' <span style="color:var(--gold);">(do app)</span>'}</div>`);
      header.push(`• Total de receitas: <strong class="mono" style="color:var(--green);">${money(totalReceita)}</strong> · Total de gastos: <strong class="mono" style="color:var(--red);">${money(totalGastos)}</strong> · Total investido: <strong class="mono" style="color:#b087ff;">${money(totalInvest)}</strong></div>`);
      header.push(`• Resultado final após ${calc.length} mês(es): <strong class="mono" style="color:${saldoF<0?'var(--red)':saldoF>0?'var(--green)':'var(--text-dim)'};">${money(saldoF)}</strong> (${deltaTotal>=0?'+':''}${money(deltaTotal)})</div>`);
      header.push(`</div></div>`);

      const lines = [];
      calc.forEach((r, i) => {
        const delta = r.saldoFinal - r.saldoInicial;
        const totalSaidasMes = (+r.gastos||0) + (+r.investimentos||0);
        const isSel = i === viewingMonthIdx;
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
