import {
  auth, signOut, onAuthStateChanged,
  db, collection, addDoc, deleteDoc, doc, onSnapshot, serverTimestamp, updateDoc
} from "./firebase-config.js";

document.getElementById('logout-btn').addEventListener('click', () => {
  signOut(auth).catch(err => console.error('Erro ao sair:', err));
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  startListening();
});

let allTx = [];
let editingId = null;
let editingCache = {};

const filters = {
  search: '',
  type: 'all',
  month: 'all',
  sort: 'date-desc'
};

const money = (v) => v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const pad = (n) => String(n).padStart(2,'0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function startListening(){
  const txCol = collection(db, 'transactions');
  onSnapshot(txCol, (snapshot) => {
    allTx = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    rebuildMonthFilter();
    renderAll();
  }, (err) => {
    console.error('Erro ao ler transações:', err);
  });
}

function rebuildMonthFilter(){
  const sel = document.getElementById('f-month');
  const cur = sel.value;
  const set = new Set();
  allTx.forEach(t => {
    const [y,m] = t.date.split('-').map(Number);
    set.add(`${y}-${String(m).padStart(2,'0')}`);
  });
  const arr = Array.from(set).sort().reverse();
  const now = new Date();
  const def = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  let html = '<option value="all">Todos os meses</option>';
  if (!arr.includes(def)) arr.unshift(def);
  arr.forEach(k => {
    const [y,m] = k.split('-');
    html += `<option value="${k}">${MONTHS[parseInt(m)-1]} ${y}</option>`;
  });
  sel.innerHTML = html;
  sel.value = cur && (cur === 'all' || arr.includes(cur)) ? cur : 'all';
  filters.month = sel.value;
}

document.getElementById('f-search').addEventListener('input', e => {
  filters.search = e.target.value.trim().toLowerCase();
  renderAll();
});
document.getElementById('f-type').addEventListener('change', e => {
  filters.type = e.target.value;
  renderAll();
});
document.getElementById('f-month').addEventListener('change', e => {
  filters.month = e.target.value;
  renderAll();
});
document.getElementById('f-sort').addEventListener('change', e => {
  filters.sort = e.target.value;
  renderAll();
});

document.getElementById('btn-new').addEventListener('click', () => {
  const today = toISO(new Date());
  const tmpId = '__new__' + Date.now();
  editingId = tmpId;
  editingCache = {
    id: tmpId,
    type: 'entrada',
    value: '',
    description: '',
    date: today,
    isNew: true
  };
  renderAll();
  setTimeout(() => document.querySelector(`tr[data-id="${tmpId}"] input[name="description"]`)?.focus(), 50);
});

function getFiltered(){
  let list = [...allTx];
  if (filters.type !== 'all') list = list.filter(t => t.type === filters.type);
  if (filters.month !== 'all') list = list.filter(t => t.date.startsWith(filters.month));
  if (filters.search) list = list.filter(t => (t.description || '').toLowerCase().includes(filters.search));

  switch(filters.sort){
    case 'date-asc':  list.sort((a,b)=> a.date < b.date ? -1 : a.date > b.date ? 1 : 0); break;
    case 'date-desc': list.sort((a,b)=> a.date < b.date ?  1 : a.date > b.date ? -1 : 0); break;
    case 'value-asc': list.sort((a,b)=> a.value - b.value); break;
    case 'value-desc':list.sort((a,b)=> b.value - a.value); break;
  }
  return list;
}

function renderAll(){
  renderSummary();
  renderTable();
}

function renderSummary(){
  const list = getFiltered();
  const entradas = list.filter(t=>t.type==='entrada').reduce((s,t)=>s+(+t.value||0),0);
  const saidas   = list.filter(t=>t.type==='saida').reduce((s,t)=>s+(+t.value||0),0);
  document.getElementById('ws-in').textContent    = money(entradas);
  document.getElementById('ws-out').textContent   = money(saidas);
  document.getElementById('ws-net').textContent   = money(entradas - saidas);
  document.getElementById('ws-count').textContent = list.length;
}

function renderTable(){
  const tbody = document.getElementById('wallet-body');
  const empty = document.getElementById('empty-wallet');
  tbody.innerHTML = '';

  const list = getFiltered();

  if (editingCache && editingCache.isNew){
    tbody.appendChild(buildRow(editingCache, true));
  }

  if (list.length === 0 && !editingCache.isNew){
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  list.forEach(t => {
    const isEditing = editingId === t.id;
    tbody.appendChild(buildRow(t, isEditing));
  });
}

function buildRow(t, isEditing){
  const tr = document.createElement('tr');
  tr.dataset.id = t.id;

  if (isEditing){
    const state = t.isNew ? editingCache : { ...editingCache, id: t.id };
    tr.innerHTML = `
      <td><input type="date" class="editable-input" name="date" value="${state.date || ''}" autocomplete="off"></td>
      <td>
        <select class="editable-input" name="type" autocomplete="off">
          <option value="entrada" ${state.type==='entrada'?'selected':''}>Entrada</option>
          <option value="saida"   ${state.type==='saida'?'selected':''}>Saída</option>
        </select>
      </td>
      <td><input type="text" class="editable-input" name="description" value="${escapeHtml(state.description || '')}" placeholder="Descrição" autocomplete="off" spellcheck="false"></td>
      <td><input type="number" step="0.01" min="0" class="editable-input mono" name="value" value="${state.value ?? ''}" placeholder="0,00" autocomplete="off" inputmode="decimal" spellcheck="false"></td>
      <td>
        <div class="row-actions">
          <button class="icon-btn save" title="Salvar">✓</button>
          <button class="icon-btn cancel" title="Cancelar">↶</button>
        </div>
      </td>
    `;
    tr.querySelectorAll('input, select').forEach(inp => {
      inp.addEventListener('input', () => {
        const val = inp.name === 'value' ? (inp.value === '' ? '' : parseFloat(inp.value)) : inp.value;
        if (t.isNew) editingCache[inp.name] = val;
        else editingCache = { ...editingCache, id: t.id, [inp.name]: val };
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') tr.querySelector('.icon-btn.save').click();
        if (e.key === 'Escape') tr.querySelector('.icon-btn.cancel').click();
      });
    });
    tr.querySelector('.icon-btn.save').addEventListener('click', () => saveEdit(t));
    tr.querySelector('.icon-btn.cancel').addEventListener('click', () => cancelEdit(t));
  } else {
    tr.innerHTML = `
      <td class="mono">${t.date.split('-').reverse().join('/')}</td>
      <td><span class="pill-type ${t.type}">${t.type==='entrada'? 'Entrada' : 'Saída'}</span></td>
      <td>${escapeHtml(t.description || '')}</td>
      <td class="tx-value ${t.type} mono" style="font-weight:700;">${t.type==='entrada'?'+':'-'} ${money(+t.value||0)}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn edit" title="Editar">✎</button>
          <button class="icon-btn delete" title="Excluir">🗑</button>
        </div>
      </td>
    `;
    tr.querySelector('.icon-btn.edit').addEventListener('click', () => startEdit(t));
    tr.querySelector('.icon-btn.delete').addEventListener('click', () => removeTx(t.id));
  }
  return tr;
}

function startEdit(t){
  editingId = t.id;
  editingCache = {
    id: t.id,
    type: t.type,
    value: t.value,
    description: t.description,
    date: t.date
  };
  renderAll();
  setTimeout(() => document.querySelector(`tr[data-id="${t.id}"] input[name="description"]`)?.focus(), 50);
}

function cancelEdit(t){
  if (t.isNew){
    editingId = null;
    editingCache = {};
  } else {
    editingId = null;
    editingCache = {};
  }
  renderAll();
}

async function saveEdit(t){
  const state = t.isNew ? editingCache : editingCache;
  const value = parseFloat(state.value);
  const date = state.date;
  const desc = (state.description || '').trim();
  const type = state.type;

  if (!value || value <= 0){ alert('Informe um valor válido maior que zero.'); return; }
  if (!date){ alert('Informe a data.'); return; }
  if (!desc){ alert('Informe a descrição.'); return; }
  if (type !== 'entrada' && type !== 'saida'){ alert('Selecione o tipo.'); return; }

  try {
    if (t.isNew){
      await addDoc(collection(db, 'transactions'), {
        type, value, description: desc, date,
        createdAt: serverTimestamp()
      });
    } else {
      await updateDoc(doc(db, 'transactions', t.id), {
        type, value, description: desc, date,
        updatedAt: serverTimestamp()
      });
    }
    editingId = null;
    editingCache = {};
    renderAll();
  } catch (err){
    console.error('Erro ao salvar:', err);
    alert('Não foi possível salvar. Verifique sua conexão e configuração do Firebase.');
  }
}

async function removeTx(id){
  if (!confirm('Excluir este lançamento? Esta ação não pode ser desfeita.')) return;
  try {
    await deleteDoc(doc(db, 'transactions', id));
  } catch (err){
    console.error('Erro ao excluir:', err);
    alert('Não foi possível excluir.');
  }
}
