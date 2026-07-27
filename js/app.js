import {
  auth, signOut, onAuthStateChanged,
  db, collection, addDoc, deleteDoc, doc, onSnapshot, serverTimestamp, query, where
} from "./firebase-config.js";

document.getElementById('logout-btn').addEventListener('click', () => {
  signOut(auth).catch(err => console.error('Erro ao sair:', err));
});

let currentUserUid = null;

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  currentUserUid = user.uid;
  startListening();
});

let allTx = [];
let currentType = 'entrada';
let viewDate = new Date();
let selectedDay = null;

const money = (v) => v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
const pad = (n) => String(n).padStart(2,'0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

const submitBtn = document.querySelector('#tx-form .btn-primary');
const segmentedBtns = document.querySelectorAll('.segmented button');

segmentedBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    segmentedBtns.forEach(b => {
      b.classList.remove('active');
      b.classList.remove('entrada', 'saida');
    });
    btn.classList.add('active');
    currentType = btn.dataset.type;
    updateSubmitBtn();
  });
});

function updateSubmitBtn(){
  submitBtn.classList.remove('btn-entrada', 'btn-saida');
  if (currentType === 'entrada'){
    submitBtn.classList.add('btn-entrada');
    submitBtn.textContent = 'Adicionar entrada';
  } else {
    submitBtn.classList.add('btn-saida');
    submitBtn.textContent = 'Adicionar saída';
  }
}
updateSubmitBtn();

document.getElementById('tx-date').value = toISO(new Date());

function startListening(){
  const txCol = collection(db, 'transactions');
  const q = query(txCol, where('uid', '==', currentUserUid));
  onSnapshot(q, (snapshot) => {
    allTx = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAll();
  }, (err) => {
    console.error('Erro ao ler transações:', err);
  });
}

document.getElementById('tx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = parseFloat(document.getElementById('tx-value').value);
  const date = document.getElementById('tx-date').value;
  const desc = document.getElementById('tx-desc').value.trim();
  if (!value || !date || !desc) return;

  try {
    await addDoc(collection(db, 'transactions'), {
      uid: currentUserUid,
      type: currentType,
      value,
      description: desc,
      date,
      createdAt: serverTimestamp()
    });
    document.getElementById('tx-value').value = '';
    document.getElementById('tx-desc').value = '';
  } catch (err) {
    console.error('Erro ao salvar lançamento:', err);
    alert('Não foi possível salvar. Confira sua configuração do Firebase.');
  }
});

async function removeTx(id){
  try { await deleteDoc(doc(db, 'transactions', id)); }
  catch (err) { console.error('Erro ao excluir:', err); }
}

function renderAll(){
  renderDashboardAndList();
  renderCalendar();
  renderYearChart();
}

function txInViewMonth(t){
  const [y,m] = t.date.split('-').map(Number);
  return y === viewDate.getFullYear() && (m-1) === viewDate.getMonth();
}

function renderDashboardAndList(){
  const monthTx = allTx.filter(txInViewMonth);
  const sorted = [...monthTx].sort((a,b)=> a.date < b.date ? 1 : -1);

  const entradas = monthTx.filter(t=>t.type==='entrada').reduce((s,t)=>s+t.value,0);
  const saidas   = monthTx.filter(t=>t.type==='saida').reduce((s,t)=>s+t.value,0);
  const totalIn  = allTx.filter(t=>t.type==='entrada').reduce((s,t)=>s+t.value,0);
  const totalOut = allTx.filter(t=>t.type==='saida').reduce((s,t)=>s+t.value,0);

  document.getElementById('stat-entradas').textContent = money(entradas);
  document.getElementById('stat-saidas').textContent   = money(saidas);
  document.getElementById('stat-saldo').textContent    = money(entradas - saidas);
  document.getElementById('stat-total').textContent    = money(totalIn - totalOut);

  const list = sorted.filter(t => !selectedDay || t.date === selectedDay).slice(0, 15);
  const titleEl = document.getElementById('tx-list-title');
  titleEl.textContent = selectedDay
    ? `Lançamentos de ${selectedDay.split('-').reverse().join('/')}`
    : 'Lançamentos recentes';

  const ul = document.getElementById('tx-list');
  ul.innerHTML = '';
  if (list.length === 0){
    ul.innerHTML = '<div class="empty-note">Nenhum lançamento encontrado.</div>';
    return;
  }
  list.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div class="tx-desc">${escapeHtml(t.description)}</div>
        <div class="tx-date">${t.date.split('-').reverse().join('/')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="tx-value ${t.type} mono">${t.type==='entrada'?'+':'-'} ${money(t.value)}</div>
        <button class="tx-del" data-id="${t.id}" title="Excluir">✕</button>
      </div>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll('.tx-del').forEach(btn=>{
    btn.addEventListener('click', () => removeTx(btn.dataset.id));
  });
}

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

const DOWS = ['DOM','SEG','TER','QUA','QUI','SEX','SÁB'];
const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function renderCalendar(){
  document.getElementById('cal-month-label').textContent =
    `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`;

  const dowRow = document.getElementById('cal-dow-row');
  dowRow.innerHTML = DOWS.map(d=>`<div class="cal-dow">${d}</div>`).join('');

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  const todayISO = toISO(new Date());

  const byDay = {};
  allTx.filter(txInViewMonth).forEach(t => {
    byDay[t.date] = byDay[t.date] || 0;
    byDay[t.date] += (t.type === 'entrada' ? t.value : -t.value);
  });

  for (let i=0;i<firstDow;i++){
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    grid.appendChild(empty);
  }

  for (let day=1; day<=daysInMonth; day++){
    const iso = `${year}-${pad(month+1)}-${pad(day)}`;
    const net = byDay[iso];
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    if (iso === todayISO) cell.classList.add('today');
    if (iso === selectedDay) cell.classList.add('selected');
    if (net > 0) cell.classList.add('pos');
    if (net < 0) cell.classList.add('neg');

    cell.innerHTML = `
      <div class="num">${day}</div>
      <div class="net mono">${net ? (net>0?'+':'') + net.toLocaleString('pt-BR',{maximumFractionDigits:0}) : ''}</div>
    `;
    cell.addEventListener('click', () => {
      const wasSelected = (selectedDay === iso);
      selectedDay = wasSelected ? null : iso;
      if (!wasSelected) {
        document.getElementById('tx-date').value = iso;
      }
      renderAll();
    });
    grid.appendChild(cell);
  }
}

function renderYearChart(){
  const year = new Date().getFullYear();
  const chart = document.getElementById('year-chart');
  chart.innerHTML = '';

  const monthly = {};
  for (let m=0;m<12;m++){
    monthly[m] = { in:0, out:0 };
  }

  allTx.forEach(t => {
    const [ty,tm] = t.date.split('-').map(Number);
    if (ty === year){
      const idx = tm-1;
      if (t.type === 'entrada') monthly[idx].in += t.value;
      else monthly[idx].out += t.value;
    }
  });

  let maxIn = 1, maxOut = 1;
  for (let m=0;m<12;m++){
    if (monthly[m].in  > maxIn)  maxIn  = monthly[m].in;
    if (monthly[m].out > maxOut) maxOut = monthly[m].out;
  }
  const maxVal = Math.max(maxIn, maxOut);

  const lbls = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
  for (let m=0;m<12;m++){
    const inH  = Math.max(2, Math.round( (monthly[m].in  / maxVal) * 60 ));
    const outH = Math.max(2, Math.round( (monthly[m].out / maxVal) * 60 ));
    const col = document.createElement('div');
    col.className = 'ym';
    col.title = `${MONTHS[m]}: +${money(monthly[m].in)} / -${money(monthly[m].out)}`;
    col.innerHTML = `
      <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;">
        <div class="bar-in"  style="height:${inH}px;${monthly[m].in===0?'opacity:.2':''}"></div>
        <div class="bar-out" style="height:${outH}px;${monthly[m].out===0?'opacity:.2':''}"></div>
      </div>
      <div class="mlbl">${lbls[m]}</div>
    `;
    chart.appendChild(col);
  }

  const yearIn  = allTx.filter(t => t.date.startsWith(year+'-') && t.type==='entrada').reduce((s,t)=>s+t.value,0);
  const yearOut = allTx.filter(t => t.date.startsWith(year+'-') && t.type==='saida').reduce((s,t)=>s+t.value,0);
  document.getElementById('year-in').textContent  = money(yearIn);
  document.getElementById('year-out').textContent = money(yearOut);
  document.getElementById('year-net').textContent = money(yearIn - yearOut);
}

document.getElementById('cal-prev').addEventListener('click', () => {
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth()-1, 1);
  selectedDay = null;
  renderAll();
});
document.getElementById('cal-next').addEventListener('click', () => {
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth()+1, 1);
  selectedDay = null;
  renderAll();
});

renderAll();
