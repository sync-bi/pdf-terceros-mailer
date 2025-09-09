let terceros = [];
let uploadId = null;
let rows = [];

async function fetchTerceros(){
  const r = await fetch('/api/terceros');
  terceros = await r.json();
}

function renderGrid(){
  const tbody = document.querySelector('#grid tbody');
  tbody.innerHTML = '';
  for (const row of rows){
    const tr = document.createElement('tr');

    const tdSel = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!row.matched?.email;
    tdSel.appendChild(cb);

    const tdPage = document.createElement('td');
    tdPage.textContent = row.page;

    const tdNombre = document.createElement('td');
    const inNombre = document.createElement('input');
    inNombre.value = row.matched?.nombre || '';
    inNombre.placeholder = 'Nombre';
    inNombre.addEventListener('input', ()=>{
      row.matched = row.matched || { id:null, nombre:'', email:'' };
      row.matched.nombre = inNombre.value;
      const t = terceros.find(t=> t.nombre.toLowerCase() === inNombre.value.toLowerCase());
      if (t){ row.matched.id = t.id; row.matched.email = t.email; inEmail.value = t.email; }
    });
    tdNombre.appendChild(inNombre);

    const tdEmail = document.createElement('td');
    const inEmail = document.createElement('input');
    inEmail.type = 'email';
    inEmail.value = row.matched?.email || '';
    inEmail.placeholder = 'email@dominio.com';
    inEmail.addEventListener('input', ()=>{
      row.matched = row.matched || { id:null, nombre: inNombre.value, email:'' };
      row.matched.email = inEmail.value;
    });
    tdEmail.appendChild(inEmail);

    const tdPrev = document.createElement('td');
    tdPrev.textContent = row.textPreview;

    const tdAcc = document.createElement('td');
    const btnUse = document.createElement('button');
    btnUse.textContent = 'Usar';
    btnUse.addEventListener('click', ()=>{ cb.checked = true; });
    tdAcc.appendChild(btnUse);

    tr.append(tdSel, tdPage, tdNombre, tdEmail, tdPrev, tdAcc);
    tbody.appendChild(tr);
  }
  document.getElementById('sendBtn').disabled = rows.length === 0;
}

async function init(){
  await fetchTerceros();

  document.getElementById('uploadForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const r = await fetch('/api/upload-pdf', { method: 'POST', body: fd });
    const data = await r.json();
    if (data.error){
      document.getElementById('uploadInfo').textContent = 'Error: ' + data.error;
      return;
    }
    uploadId = data.uploadId;
    rows = data.rows;
    document.getElementById('uploadInfo').textContent = `Páginas: ${data.totalPages}`;
    renderGrid();
  });

  document.getElementById('saveTercero').addEventListener('click', async ()=>{
    const nit = document.getElementById('newNit').value.replace(/\D/g,'');
    const nombre = document.getElementById('newNombre').value.trim();
    const email = document.getElementById('newEmail').value.trim();
    if (!nombre || !email) { document.getElementById('saveInfo').textContent = 'Complete NIT (opcional), nombre y email'; return; }
    const r = await fetch('/api/terceros', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ nit, nombre, email }) });
    const data = await r.json();
    if (data.error){ document.getElementById('saveInfo').textContent = 'Error: ' + data.error; return; }
    document.getElementById('saveInfo').textContent = data.created ? 'Creado' : 'Actualizado';
    await fetchTerceros();
  });
document.getElementById('sendBtn').addEventListener('click', async ()=>{
  const subject = document.getElementById('subject').value;
  const body = document.getElementById('body').value;
  const senderEmail = document.getElementById('senderEmail').value.trim();
  const status = document.getElementById('sendStatus');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) { status.textContent = 'Correo inválido'; return; }

  const tbody = document.querySelector('#grid tbody');
  const cbs = tbody.querySelectorAll('input[type="checkbox"]');

  const selections = [];
  cbs.forEach((cb, idx)=>{
    if (cb.checked){
      const r = rows[idx];
      selections.push({ page: r.page, nombre: r.matched?.nombre || '', email: r.matched?.email || '' });
    }
  });
  if (!uploadId || selections.length === 0){ status.textContent = 'Nada para enviar'; return; }

  status.textContent = 'Enviando...';
  try {
    const resp = await fetch('/api/send', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ uploadId, selections, subject, body, senderEmail })
    });

    const data = await resp.json().catch(()=>({}));
    if (!resp.ok) { status.textContent = 'Error: ' + (data.error || resp.statusText); return; }

    const sent = (data.results || []).filter(r=>r.status==='sent').length;
    const errs = (data.results || []).filter(r=>r.status!=='sent').length;
    status.textContent = `OK: ${sent} | Errores: ${errs}`;
  } catch (e) {
    status.textContent = 'Fallo de red: ' + e.message;
  }
});

  
}

init();
