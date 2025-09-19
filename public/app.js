let terceros = [];
let uploadId = null;
let rows = [];
let totalPages = 0;

// --- Theme toggle ---
function applyTheme(theme){
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme','dark');
  else root.removeAttribute('data-theme');
}
function initTheme(){
  const saved = localStorage.getItem('theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'));
  const btn = document.getElementById('themeToggle');
  if (btn){
    const refreshIcon = ()=>{
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      btn.textContent = isDark ? '☀️' : '🌙';
    };
    refreshIcon();
    btn.addEventListener('click', ()=>{
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const next = isDark ? 'light' : 'dark';
      applyTheme(next);
      localStorage.setItem('theme', next);
      refreshIcon();
    });
  }
}

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
    cb.addEventListener('change', updateSelectedCounter);
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
    btnUse.className = 'btn-secondary';
    btnUse.addEventListener('click', async ()=>{
      cb.checked = true;
      // Rellenar con el match si existe; si no, intentar por NIT en la lista de terceros
      if (row.matched && (row.matched.nombre || row.matched.email)) {
        inNombre.value = row.matched.nombre || '';
        inEmail.value = row.matched.email || '';
      } else if (row.nit) {
        const t = terceros.find(t=> String(t.nit||'') === String(row.nit||''));
        if (t) {
          row.matched = { id: t.id, nit: t.nit, nombre: t.nombre, email: t.email };
          inNombre.value = t.nombre;
          inEmail.value = t.email;
        }
      }
      // Sincroniza el objeto row.matched con los inputs actuales
      row.matched = row.matched || { id:null, nombre:'', email:'' };
      row.matched.nombre = inNombre.value;
      row.matched.email = inEmail.value;

      // Guardado automático si hay datos válidos
      const nombre = inNombre.value.trim();
      const email = inEmail.value.trim();
      const nit = (row.nit || '').toString();
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (nombre && validEmail) {
        try {
          const resp = await fetch('/api/terceros', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nit, nombre, email })
          });
          const data = await resp.json().catch(()=>({}));
          if (resp.ok) {
            // Actualiza matched con la respuesta del servidor si viene id/nit
            row.matched.id = data.id ?? row.matched.id ?? null;
            row.matched.nit = data.nit ?? row.matched.nit ?? (nit || null);
            await fetchTerceros();
          }
        } catch (e) {
          // Silencioso: evitar interrumpir flujo del usuario
          console.warn('Auto-guardado tercero falló:', e);
        }
      }

      updateSelectedCounter();
    });
    tdAcc.appendChild(btnUse);

    const btnClear = document.createElement('button');
    btnClear.textContent = 'Quitar';
    btnClear.className = 'btn-secondary';
    btnClear.style.marginLeft = '6px';
    btnClear.addEventListener('click', ()=>{
      inNombre.value = '';
      inEmail.value = '';
      row.matched = null;
      cb.checked = false;
      updateSelectedCounter();
    });
    tdAcc.appendChild(btnClear);

    const btnDelete = document.createElement('button');
    btnDelete.textContent = 'Eliminar';
    btnDelete.className = 'btn-secondary';
    btnDelete.style.marginLeft = '6px';
    btnDelete.addEventListener('click', async ()=>{
      // Determinar id del tercero a eliminar
      let delId = row.matched?.id || null;
      if (!delId && row.nit){
        const tNit = terceros.find(t=> String(t.nit||'') === String(row.nit||''));
        delId = tNit?.id || null;
      }
      if (!delId){
        const name = (inNombre.value||'').trim().toLowerCase();
        if (name){
          const tName = terceros.find(t=> (t.nombre||'').toLowerCase() === name);
          delId = tName?.id || null;
        }
      }
      if (!delId){ alert('No se encontró tercero para eliminar'); return; }
      if (!confirm('¿Eliminar este tercero de la base?')) return;
      try {
        const resp = await fetch(`/api/terceros/${delId}`, { method: 'DELETE' });
        const data = await resp.json().catch(()=>({}));
        if (!resp.ok) { alert('Error al eliminar: ' + (data.error || resp.statusText)); return; }
        // Limpiar fila y refrescar terceros
        inNombre.value = '';
        inEmail.value = '';
        row.matched = null;
        cb.checked = false;
        await fetchTerceros();
        updateSelectedCounter();
      } catch (e) {
        alert('Fallo al eliminar: ' + e.message);
      }
    });
    tdAcc.appendChild(btnDelete);

    tr.append(tdSel, tdPage, tdNombre, tdEmail, tdPrev, tdAcc);
    tbody.appendChild(tr);
  }
  document.getElementById('sendBtn').disabled = rows.length === 0;
  updateSelectedCounter();
}

function updateSelectedCounter(){
  const total = rows.length || 0;
  const selected = Array.from(document.querySelectorAll('#grid tbody input[type="checkbox"]')).filter(cb=>cb.checked).length;
  const el = document.getElementById('selectedCounter');
  if (el) el.textContent = `Seleccionados: ${selected}/${total}`;
}

async function init(){
  initTheme();
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
    totalPages = data.totalPages || (rows ? rows.length : 0);
    document.getElementById('uploadInfo').textContent = `Páginas: ${totalPages}`;
    const badge = document.getElementById('pagesBadge');
    if (badge) badge.textContent = `${totalPages}`;
    renderGrid();
  });

  document.getElementById('saveTercero').addEventListener('click', async ()=>{
    const nit = document.getElementById('newNit').value.replace(/\D/g,'');
    const nombre = document.getElementById('newNombre').value.trim();
    const email = document.getElementById('newEmail').value.trim();
    const saveInfo = document.getElementById('saveInfo');
    if (!nombre || !email) { saveInfo.className = 'note note--warn'; saveInfo.textContent = 'Complete NIT (opcional), nombre y email'; return; }
    const r = await fetch('/api/terceros', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ nit, nombre, email }) });
    const data = await r.json();
    if (data.error){ saveInfo.className = 'note note--err'; saveInfo.textContent = 'Error: ' + data.error; return; }
    saveInfo.className = 'note note--ok';
    saveInfo.textContent = data.created ? 'Creado' : 'Actualizado';
    await fetchTerceros();
  });

  document.getElementById('sendBtn').addEventListener('click', async ()=>{
    const subject = document.getElementById('subject').value;
    const body = document.getElementById('body').value;
    const senderEmail = document.getElementById('senderEmail').value.trim();
    const status = document.getElementById('sendStatus');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
      status.className = 'status status--err';
      status.textContent = 'Correo inválido';
      return;
    }

    const tbody = document.querySelector('#grid tbody');
    const cbs = tbody.querySelectorAll('input[type="checkbox"]');

    const selections = [];
    cbs.forEach((cb, idx)=>{
      if (cb.checked){
        const r = rows[idx];
        selections.push({ page: r.page, nombre: r.matched?.nombre || '', email: r.matched?.email || '' });
      }
    });
    if (!uploadId || selections.length === 0){
      status.className = 'status status--warn';
      status.textContent = 'Nada para enviar';
      return;
    }

    // Confirmación previa con resumen
    const emailsPreview = selections.map(s=> s.email).filter(Boolean);
    const previewList = emailsPreview.slice(0, 5).join('\n - ');
    const more = emailsPreview.length > 5 ? `\n ... y ${emailsPreview.length - 5} más` : '';
    const subj = subject && subject.trim() ? subject.trim() : 'Documento';
    const ok = confirm(`Confirmar envío\n\nAsunto: ${subj}\nDestinatarios: ${emailsPreview.length}\nAdjuntos: ${selections.length}\n\nPrimeros destinatarios:\n - ${previewList}${more}`);
    if (!ok) return;

    status.className = 'status';
    status.textContent = 'Enviando...';
    try {
      const resp = await fetch('/api/send', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ uploadId, selections, subject, body, senderEmail })
      });

      const data = await resp.json().catch(()=>({}));
      if (!resp.ok) {
        status.className = 'status status--err';
        status.textContent = 'Error: ' + (data.error || resp.statusText);
        return;
      }

      const sent = (data.results || []).filter(r=>r.status==='sent').length;
      const errs = (data.results || []).filter(r=>r.status!=='sent').length;
      if (sent > 0 && errs === 0) status.className = 'status status--ok';
      else if (sent > 0 && errs > 0) status.className = 'status status--warn';
      else status.className = 'status status--err';
      status.textContent = `OK: ${sent} | Errores: ${errs}`;
    } catch (e) {
      status.className = 'status status--err';
      status.textContent = 'Fallo de red: ' + e.message;
    }
  });

  // Reimportar Excel
  const reimportBtn = document.getElementById('reimportBtn');
  if (reimportBtn){
    reimportBtn.addEventListener('click', async ()=>{
      const el = document.getElementById('saveInfo');
      try {
        reimportBtn.disabled = true;
        el.className = 'note';
        el.textContent = 'Reimportando Excel...';
        const resp = await fetch('/api/reimport-excel', { method: 'POST' });
        const data = await resp.json().catch(()=>({}));
        if (!resp.ok || data.ok === false) { el.className = 'note note--err'; el.textContent = 'Error al reimportar: ' + (data.error || resp.statusText); return; }
        await fetchTerceros();
        // Re-matchear filas existentes por NIT si aplica
        let updated = 0;
        rows.forEach(r=>{
          if (r && r.nit) {
            const t = terceros.find(t=> String(t.nit||'') === String(r.nit||''));
            if (t) { r.matched = { id:t.id, nit:t.nit, nombre:t.nombre, email:t.email }; updated++; }
          }
        });
        renderGrid();
        el.className = 'note note--ok';
        el.textContent = `Reimportado: ${data.processed}/${data.total}. Actualizadas ${updated} filas.`;
      } catch (e) {
        el.className = 'note note--err';
        el.textContent = 'Fallo al reimportar: ' + e.message;
      } finally {
        reimportBtn.disabled = false;
      }
    });
  }

  // Selección masiva
  document.getElementById('selectAllBtn').addEventListener('click', ()=>{
    document.querySelectorAll('#grid tbody input[type="checkbox"]').forEach(cb=> cb.checked = true);
    updateSelectedCounter();
  });
  document.getElementById('clearSelectionBtn').addEventListener('click', ()=>{
    document.querySelectorAll('#grid tbody input[type="checkbox"]').forEach(cb=> cb.checked = false);
    updateSelectedCounter();
  });

  // Solo coincidentes (con email)
  document.getElementById('selectMatchesBtn').addEventListener('click', ()=>{
    const cbs = document.querySelectorAll('#grid tbody input[type="checkbox"]');
    cbs.forEach((cb, idx)=>{
      const r = rows[idx];
      cb.checked = !!(r && r.matched && r.matched.email);
    });
    updateSelectedCounter();
  });

  // Limpiar grilla (resetea estado y formulario)
  document.getElementById('resetGridBtn').addEventListener('click', ()=>{
    rows = [];
    uploadId = null;
    totalPages = 0;
    const tbody = document.querySelector('#grid tbody');
    if (tbody) tbody.innerHTML = '';
    document.getElementById('sendBtn').disabled = true;
    const status = document.getElementById('sendStatus');
    status.className = 'status';
    status.textContent = '';
    const counter = document.getElementById('selectedCounter');
    if (counter) counter.textContent = 'Seleccionados: 0/0';
    document.getElementById('uploadInfo').textContent = '';
    document.getElementById('subject').value = '';
    document.getElementById('body').value = '';
    const pdfInput = document.getElementById('pdf');
    if (pdfInput) pdfInput.value = '';
    const badge = document.getElementById('pagesBadge');
    if (badge) badge.textContent = '';
  });

  // Salir
  document.getElementById('exitBtn').addEventListener('click', ()=>{
    const go = confirm('¿Desea salir?');
    if (!go) return;
    // Intentar cerrar la pestaña; si el navegador lo bloquea, fallback a about:blank
    window.open('', '_self');
    window.close();
    setTimeout(()=>{ window.location.href = 'about:blank'; }, 200);
  });

}

init();
