// =========================================================================
// VARIABLES GLOBALES (Manejo de Estado / State Management)
// =========================================================================
const HORAS = ['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00'];
const weekdays = ['DOM','LUN','MAR','MIÉ','JUE','VIE','SÁB'];

// ---> CAMBIAR AQUÍ EL CORREO DEL ADMINISTRADOR (BARBERO) <---
const ADMIN_EMAIL = 'gamarramartin1995@gmail.com';

// Variables que guardan la info en memoria para evitar pedirla al server a cada segundo
let usuario = null;
let servicios = [];
let turnos = [];
let clientes = [];
let diasCerrados = [];
let fechaCliente = '';
let horaCliente = '';
let fechaAdmin = '';
let turnoEditando = null;
let timer = null;

// =========================================================================
// FUNCIONES UTILITARIAS DEL FRONTEND
// =========================================================================

// Calcula la fecha y hora de Argentina para evitar desfases horarios
function getFechaHoraAr() {
  const d = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function hoy() { return getFechaHoraAr().substring(0, 10); } // Devuelve YYYY-MM-DD
function horaPaso(f, h) { return `${f} ${h}` <= getFechaHoraAr(); } // ¿La hora de ese día ya pasó?
function normalizarFH(v) { return v ? String(v).slice(0, 16) : ''; }

// Previene ataques de inyección XSS (Seguridad web básica)
function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'}[m])); }
function capitalizarPrimera(v) { v = String(v || '').trim(); return v ? v.charAt(0).toUpperCase() + v.slice(1) : 'Cliente'; }

// Comprueba si el usuario logueado tiene permisos de admin
function esAdmin() { return usuario && usuario.email && usuario.email.toLowerCase() === ADMIN_EMAIL && usuario.rol === 'barbero'; }

// Función genérica para conectarse al servidor (Manejo asíncrono limpio)
async function api(url, options = {}) {
  const r = await fetch(url, { ...options, cache: 'no-store' });
  let d = {};
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || 'Error de conexión con el servidor.');
  return d;
}

// =========================================================================
// SISTEMA DE AUTENTICACIÓN
// =========================================================================

// Cuando la API de Google devuelve un éxito, mandamos ese token a nuestro servidor
async function manejarRespuestaGoogle(response) {
  try {
    usuario = await api('/api/google-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential })
    });
    localStorage.setItem('usuarioActivo', JSON.stringify(usuario)); // Guarda la sesión en el navegador
    await entrarDashboard();
  } catch (e) {
    alert(e.message || 'Error al autenticar con Google.');
  }
}

// Inicializa el botón de Google apenas carga la página web
window.onload = async () => {
  if (window.google && google.accounts) {
    google.accounts.id.initialize({
      client_id: "345493640489-23tqknehmgiransp3tmt4sbosrrqjnu7.apps.googleusercontent.com", // Tu ID real
      callback: manejarRespuestaGoogle
    });
    google.accounts.id.renderButton(
      document.getElementById("googleButtonContainer"),
      { theme: "outline", size: "large", width: "100%", text: "continue_with" }
    );
  }
  
  // Intenta recuperar sesión previa del LocalStorage (Para no tener que loguear a cada rato)
  try {
    await api('/api/health'); // Despierta el servidor
    const raw = localStorage.getItem('usuarioActivo');
    if (raw) { usuario = JSON.parse(raw); await entrarDashboard(); }
  } catch (e) { console.error("Error de conexión:", e); }
};

async function loginTradicional() {
  const email = document.getElementById('emailInput').value.trim().toLowerCase();
  const nombre = capitalizarPrimera(document.getElementById('nombreInput').value);
  if (!email || !nombre) return alert('Completá nombre y correo.');
  try {
    usuario = await api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, nombre })
    });
    localStorage.setItem('usuarioActivo', JSON.stringify(usuario));
    await entrarDashboard();
  } catch (e) { alert(e.message); }
}

async function cerrarSesion() {
  clearInterval(timer);
  try { await fetch('/api/logout-admin', { method: 'POST' }); } catch {}
  usuario = null;
  localStorage.removeItem('usuarioActivo');
  location.reload(); // Refresca la página limpia
}

// =========================================================================
// CONTROLADOR PRINCIPAL DEL PANEL (DASHBOARD)
// =========================================================================

async function entrarDashboard() {
  // Cambia la vista de login a la app
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('dashboardView').classList.remove('hidden');
  
  const admin = esAdmin();
  document.getElementById('welcomeUser').textContent = admin ? `Panel Barbero: ${capitalizarPrimera(usuario.nombre)}` : `Hola, ${capitalizarPrimera(usuario.nombre)}`;
  document.getElementById('roleText').textContent = admin ? 'Administrador con acceso total a la agenda' : 'Solicitá un solo turno activo por cuenta';
  
  // Muestra u oculta paneles según el rol (UX Dinámico)
  document.getElementById('clientView').classList.toggle('hidden', admin);
  document.getElementById('adminView').classList.toggle('hidden', !admin);
  
  // Carga inicial masiva de datos
  await cargarDatos();
  
  if (admin) await cargarAdmin();
  else await cargarCliente();
  
  // Polling: Pide datos al servidor cada 5 segundos para actualizar estado de la agenda en tiempo real
  clearInterval(timer);
  timer = setInterval(actualizacionTiempoReal, 5000);
}

// Pide todos los datos maestros al backend en paralelo para ser más rápido
async function cargarDatos() {
  const [s, t, d] = await Promise.all([
    api('/api/servicios?t=' + Date.now()),
    api('/api/turnos?t=' + Date.now()),
    api('/api/dias-bloqueados?t=' + Date.now())
  ]);
  servicios = s;
  turnos = t;
  diasCerrados = d;
}

async function actualizacionTiempoReal() {
  try {
    await cargarDatos();
    if (esAdmin()) await cargarAdmin();
    else await cargarCliente();
  } catch (e) {} // Ignora errores silenciosos de red temporal
}

function pintarWeekdays(id) {
  document.getElementById(id).innerHTML = weekdays.map(x => `<div class="weekday">${x}</div>`).join('');
}

// =========================================================================
// LÓGICA DEL CLIENTE (Reservas)
// =========================================================================

async function cargarCliente() {
  pintarWeekdays('clientWeekdays');
  renderServicesClient();
  renderClientCalendar();
  renderHours();
  
  // Revisa si el cliente ya tiene un turno tomado
  const active = turnos.find(t => Number(t.clientes_id) === Number(usuario.id) && t.estado === 'confirmado');
  const box = document.getElementById('myTurnBox');
  if (active) {
    const s = servicios.find(x => x.id === active.servicios_id);
    box.classList.remove('hidden');
    box.innerHTML = `<div class="title">TU TURNO ACTIVO</div><div class="main">${normalizarFH(active.fecha_hora).replace(' ',' · ')}</div><div class="meta">${escapeHtml(s?.nombre || active.servicio)} · $${Number(s?.precio ?? 0).toLocaleString('es-AR')}</div>`;
    document.getElementById('reserveButton').disabled = true;
  } else {
    box.classList.add('hidden');
    document.getElementById('reserveButton').disabled = false;
  }
}

function renderServicesClient() {
  const c = document.getElementById('contenedorServicios');
  c.innerHTML = '';
  servicios.forEach((s, i) => {
    const isSelected = Number(servicioSeleccionado()) === s.id || (i === 0 && !servicioSeleccionado());
    const b = document.createElement('button');
    b.className = 'service-card' + (isSelected ? ' selected' : '');
    b.dataset.id = s.id;
    b.type = 'button';
    b.innerHTML = `<div class="service-name">${escapeHtml(s.nombre)}</div><div class="service-price">$${Number(s.precio).toLocaleString('es-AR')}</div>`;
    b.onclick = () => {
      document.querySelectorAll('.service-card').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      actualizarSteps();
    };
    c.appendChild(b);
  });
  actualizarSteps();
}

function renderClientCalendar() {
  const c = document.getElementById('clientCalendar'), title = document.getElementById('clientCalendarTitle');
  const base = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
  const months = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
  title.textContent = months[base.getMonth()] + ' ' + base.getFullYear();
  c.innerHTML = '';
  
  for(let i=0; i<base.getDay(); i++) c.innerHTML += '<div class="blank"></div>'; // Espacios vacíos iniciales
  
  // Dibuja los próximos 15 días
  for(let i=0; i<15; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const f = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const closed = diasCerrados.includes(f);
    
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `day ${closed?'blocked':'available'} ${fechaCliente===f?'selected':''}`;
    b.innerHTML = `<span class="day-name">${weekdays[d.getDay()]}</span><span class="day-num">${d.getDate()}</span><span class="day-state">${closed?'CERRADO':'LIBRE'}</span>`;
    b.onclick = () => { if(!closed) seleccionarFechaCliente(f); };
    c.appendChild(b);
  }
}

function seleccionarFechaCliente(f) {
  fechaCliente = f;
  horaCliente = '';
  document.getElementById('clientDateStatus').innerHTML = `Día seleccionado: <strong>${f.split('-').reverse().join('/')}</strong>`;
  renderClientCalendar();
  renderHours();
  actualizarSteps();
}

function renderHours() {
  const box = document.getElementById('hoursBox');
  box.innerHTML = '';
  
  if(!fechaCliente) { box.innerHTML = '<div class="status-box grid-full-width">Primero seleccioná un día.</div>'; return; }
  if(diasCerrados.includes(fechaCliente)) { box.innerHTML = '<div class="status-box grid-full-width">El barbero mantiene este día cerrado.</div>'; return; }
  
  const active = turnos.find(t => Number(t.clientes_id) === Number(usuario.id) && t.estado === 'confirmado');
  if(active) { box.innerHTML = '<div class="status-box grid-full-width">Ya tenés un turno activo.</div>'; return; }
  
  HORAS.forEach(h => {
    const occupied = turnos.some(t => normalizarFH(t.fecha_hora) === `${fechaCliente} ${h}` && t.estado === 'confirmado');
    const past = horaPaso(fechaCliente, h);
    
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hour ' + (occupied ? 'busy' : past ? 'past' : 'free') + (horaCliente === h ? ' selected' : '');
    b.innerHTML = `${h}<small>${occupied ? 'OCUPADO' : past ? 'VENCIDO' : 'LIBRE'}</small>`;
    if(!occupied && !past) b.onclick = () => { horaCliente = h; renderHours(); actualizarSteps(); };
    box.appendChild(b);
  });
}

function servicioSeleccionado() { return document.querySelector('.service-card.selected')?.dataset.id || ''; }

function actualizarSteps() {
  document.getElementById('step1').classList.toggle('active', !!servicioSeleccionado());
  document.getElementById('step2').classList.toggle('active', !!fechaCliente);
  document.getElementById('step3').classList.toggle('active', !!horaCliente);
}

async function reservarTurno() {
  const sid = Number(servicioSeleccionado()), fecha = fechaCliente, hora = horaCliente;
  if(!sid || !fecha || !hora) return alert('Seleccioná servicio, fecha y hora.');
  
  const b = document.getElementById('reserveButton');
  b.disabled = true;
  b.textContent = 'Verificando...';
  
  try {
    await api('/api/turnos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliente_id: usuario.id, servicios_id: sid, fecha_hora: `${fecha} ${hora}` })
    });
    alert('Turno confirmado con éxito.');
    horaCliente = '';
    await cargarDatos();
    await cargarCliente();
  } catch(e) {
    alert(e.message);
    await cargarDatos();
    await cargarCliente();
  } finally { b.textContent = 'Solicitar turno'; }
}

// =========================================================================
// LÓGICA DEL ADMINISTRADOR (Gestión del negocio)
// =========================================================================

async function cargarAdmin() {
  pintarWeekdays('adminCalendarWeekdays');
  renderAdminCalendar();
  renderStats();
  renderNotifications();
  renderServicesAdmin();
  try { clientes = await api('/api/clientes'); } catch(e){}
  renderClientesAdmin();
  renderAgendaAdmin();
}

function renderStats() {
  const active = turnos.filter(t => t.estado === 'confirmado').length;
  const todayCount = turnos.filter(t => t.estado === 'confirmado' && normalizarFH(t.fecha_hora).slice(0, 10) === hoy()).length;
  document.getElementById('adminStats').innerHTML = `
    <div class="stat"><strong>${clientes.length}</strong><span>Clientes</span></div>
    <div class="stat"><strong>${active}</strong><span>Activos</span></div>
    <div class="stat"><strong>${todayCount}</strong><span>Hoy</span></div>
    <div class="stat"><strong>${diasCerrados.length}</strong><span>Cerrados</span></div>`;
}

function renderNotifications() {
  const c = document.getElementById('notificationsBox'), now = hoy();
  const today = turnos.filter(t => t.estado === 'confirmado' && normalizarFH(t.fecha_hora).slice(0, 10) === now);
  const recent = turnos.filter(t => t.estado === 'confirmado').sort((a,b) => b.fecha_hora.localeCompare(a.fecha_hora)).slice(0, 5);
  c.innerHTML = `<div class="notice"><b>${today.length}</b> reservas para hoy.</div>` + 
                (recent.length ? recent.map(t => `<div class="notice">${escapeHtml(t.cliente)} · ${normalizarFH(t.fecha_hora)}</div>`).join('') : '<div class="notice">Sin reservas.</div>');
}

function renderServicesAdmin() {
  const c = document.getElementById('servicesAdminList');
  c.innerHTML = servicios.map(s => `
    <div class="admin-card">
      <div class="admin-row">
        <div>
          <div class="admin-main">${escapeHtml(s.nombre)}</div>
          <div class="admin-sub">$${Number(s.precio).toLocaleString('es-AR')}</div>
        </div>
        <div class="flex-actions">
          <button class="icon-btn" onclick="editarServicio(${s.id})">✎</button>
          <button class="icon-btn" style="color: var(--danger-color);" onclick="eliminarServicio(${s.id})">✕</button>
        </div>
      </div>
    </div>`).join('');
}

function renderAdminCalendar() {
  const c = document.getElementById('adminCalendar'), title = document.getElementById('adminCalendarTitle');
  const base = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
  const months = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
  title.textContent = months[base.getMonth()] + ' ' + base.getFullYear();
  c.innerHTML = '';
  
  for(let i=0; i<base.getDay(); i++) c.innerHTML += '<div class="blank"></div>';
  
  for(let i=0; i<15; i++){
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    const f = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const closed = diasCerrados.includes(f);
    
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `day ${closed?'blocked':'available'} ${fechaAdmin===f?'selected':''}`;
    b.innerHTML = `<span class="day-name">${weekdays[d.getDay()]}</span><span class="day-num">${d.getDate()}</span><span class="day-state">${closed?'CERRADO':'ABIERTO'}</span>`;
    b.onclick = () => { fechaAdmin = f; renderAdminCalendar(); renderAgendaAdmin(); };
    c.appendChild(b);
  }
}

async function toggleDia(f, closed) {
  try {
    if(closed) await api(`/api/admin/dias-bloqueados/${encodeURIComponent(f)}`, {method:'DELETE'});
    else await api('/api/admin/dias-bloqueados', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fecha:f})});
    fechaAdmin = f;
    await cargarDatos();
    await cargarAdmin();
  } catch(e) { alert(e.message); }
}

function toggleDiaActual() {
  const f = fechaAdmin || hoy();
  const closed = diasCerrados.includes(f);
  toggleDia(f, closed);
}

function renderClientesAdmin() {
  const term = document.getElementById('clientSearch').value.trim().toLowerCase();
  const c = document.getElementById('clientsList');
  const rows = clientes.filter(x => `${x.nombre} ${x.email}`.toLowerCase().includes(term));
  c.innerHTML = rows.map(x => `
    <div class="admin-card">
      <div class="admin-row">
        <div>
          <div class="admin-main">${escapeHtml(x.nombre)}</div>
          <div class="admin-sub">${escapeHtml(x.email)}</div>
        </div>
        <button class="icon-btn" onclick="editarCliente(${x.id})">✎</button>
      </div>
    </div>`).join('');
}

function renderAgendaAdmin() {
  const f = fechaAdmin || hoy();
  fechaAdmin = f;
  document.getElementById('agendaDayLabel').textContent = `Fecha: ${f.split('-').reverse().join('/')}`;
  
  const isClosed = diasCerrados.includes(f);
  const btnToggle = document.getElementById('btnToggleDia');
  if(btnToggle) {
    btnToggle.textContent = isClosed ? 'Abrir día' : 'Cerrar día';
    btnToggle.className = isClosed ? 'btn btn-primary btn-small' : 'btn btn-secondary btn-small';
  }
  
  const c = document.getElementById('agendaList');
  c.innerHTML = '';
  
  HORAS.forEach(h => {
    const t = turnos.find(x => x.estado === 'confirmado' && normalizarFH(x.fecha_hora) === `${f} ${h}`);
    const past = horaPaso(f, h);
    const card = document.createElement('div');
    card.className = 'admin-card';
    
    if(t) {
      card.innerHTML = `
        <div class="admin-row">
          <div>
            <div class="admin-main" style="color:#888;">${h} · OCUPADO: ${escapeHtml(t.cliente)}</div>
            <div class="admin-sub">${escapeHtml(t.servicio)}</div>
          </div>
          <button class="icon-btn" onclick="editarTurno(${t.id})">✎</button>
        </div>`;
    } else {
      card.innerHTML = `
        <div class="admin-row">
          <div><div class="admin-main" style="color:${past?'#888':'var(--success-light)'}">${h} · ${isClosed ? 'DÍA CERRADO' : past ? 'PASADO' : 'LIBRE'}</div></div>
          ${isClosed || past ? '' : `<button class="icon-btn" onclick="abrirTurnoModal('${f}','${h}')">＋</button>`}
        </div>`;
    }
    c.appendChild(card);
  });
}

// =========================================================================
// GESTIÓN DE MODALES (Pop-ups)
// =========================================================================

function cerrarModal(id) { document.getElementById(id).classList.add('hidden'); }

// CRUD de Servicios
function abrirServicioModal(id=null) {
  window.editandoServicio = id;
  document.getElementById('serviceModalTitle').textContent = id ? 'Editar servicio' : 'Nuevo servicio';
  const s = id ? servicios.find(x => x.id === id) : null;
  document.getElementById('serviceName').value = s?.nombre || '';
  document.getElementById('servicePrice').value = s?.precio ?? '';
  document.getElementById('serviceModal').classList.remove('hidden');
}
function editarServicio(id) { abrirServicioModal(id); }

async function guardarServicio() {
  const id = window.editandoServicio;
  const nombre = document.getElementById('serviceName').value.trim();
  const precio = Number(document.getElementById('servicePrice').value);
  try {
    await api(id ? `/api/admin/servicios/${id}` : '/api/admin/servicios', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, precio })
    });
    cerrarModal('serviceModal');
    await cargarDatos();
    await cargarAdmin();
  } catch(e) { alert(e.message); }
}

async function eliminarServicio(id) {
  if(!confirm('¿Estás seguro de eliminar este servicio? Los turnos asociados se cancelarán.')) return;
  try {
    await api(`/api/admin/servicios/${id}`, { method: 'DELETE' });
    await cargarDatos();
    await cargarAdmin();
  } catch(e) { alert(e.message); }
}

// Edición de Clientes
function editarCliente(id) {
  const c = clientes.find(x => x.id === id);
  if(!c) return;
  document.getElementById('editClientId').value = id;
  document.getElementById('editClientName').value = c.nombre;
  document.getElementById('editClientEmail').value = c.email;
  document.getElementById('clientModal').classList.remove('hidden');
}

async function guardarCliente() {
  const id = document.getElementById('editClientId').value;
  const nombre = capitalizarPrimera(document.getElementById('editClientName').value);
  const email = document.getElementById('editClientEmail').value.trim().toLowerCase();
  try {
    await api(`/api/admin/clientes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, email })
    });
    cerrarModal('clientModal');
    await cargarAdmin();
  } catch(e) { alert(e.message); }
}

// CRUD de Turnos Administrativos
async function prepararTurnoSelectors() {
  document.getElementById('turnClient').innerHTML = clientes.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('');
  document.getElementById('turnService').innerHTML = servicios.map(s => `<option value="${s.id}">${escapeHtml(s.nombre)}</option>`).join('');
  document.getElementById('turnHour').innerHTML = HORAS.map(h => `<option value="${h}">${h}</option>`).join('');
  document.getElementById('editTurnClient').innerHTML = document.getElementById('turnClient').innerHTML;
  document.getElementById('editTurnService').innerHTML = document.getElementById('turnService').innerHTML;
  document.getElementById('editTurnHour').innerHTML = document.getElementById('turnHour').innerHTML;
}

async function abrirTurnoModal(f = fechaAdmin || hoy(), h = '09:00') {
  await prepararTurnoSelectors();
  document.getElementById('turnDate').value = f;
  document.getElementById('turnHour').value = h;
  document.getElementById('turnModal').classList.remove('hidden');
}

async function guardarTurnoAdmin() {
  try {
    await api('/api/admin/turnos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: Number(document.getElementById('turnClient').value),
        servicios_id: Number(document.getElementById('turnService').value),
        fecha_hora: `${document.getElementById('turnDate').value} ${document.getElementById('turnHour').value}`
      })
    });
    cerrarModal('turnModal');
    await cargarDatos();
    await cargarAdmin();
  } catch(e) { alert(e.message); }
}

async function editarTurno(id) {
  const t = turnos.find(x => x.id === id);
  if(!t) return;
  turnoEditando = id;
  await prepararTurnoSelectors();
  document.getElementById('editTurnId').value = id;
  document.getElementById('editTurnClient').value = t.clientes_id;
  document.getElementById('editTurnService').value = t.servicios_id;
  document.getElementById('editTurnDate').value = normalizarFH(t.fecha_hora).slice(0, 10);
  document.getElementById('editTurnHour').value = normalizarFH(t.fecha_hora).slice(11, 16);
  document.getElementById('editTurnModal').classList.remove('hidden');
}

async function guardarEdicionTurno() {
  try {
    await api(`/api/admin/turnos/${document.getElementById('editTurnId').value}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cliente_id: Number(document.getElementById('editTurnClient').value),
        servicios_id: Number(document.getElementById('editTurnService').value),
        fecha_hora: `${document.getElementById('editTurnDate').value} ${document.getElementById('editTurnHour').value}`
      })
    });
    cerrarModal('editTurnModal');
    await cargarDatos();
    await cargarAdmin();
  } catch(e) { alert(e.message); }
}

function cancelarTurnoDesdeModal() {
  cerrarModal('editTurnModal');
  cancelarTurno(Number(document.getElementById('editTurnId').value));
}

async function cancelarTurno(id) {
  if(!confirm('¿Estás seguro de que deseas cancelar este turno definitivamente?')) return;
  try {
    await api(`/api/admin/turnos/${id}`, { method: 'DELETE' });
    await cargarDatos();
    await cargarAdmin();
  } catch(e) { alert(e.message); }
}