const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// ---> CAMBIAR AQUÍ EL CORREO DEL ADMINISTRADOR (BARBERO) <---
const ADMIN_EMAIL = 'gamarramartin1995@gmail.com';
const DATA_FILE = path.join(__dirname, 'data.json');
let db = {
  servicios: [
    { id: 1, nombre: 'Corte clásico/fade', precio: $14,000 },
    { id: 2, nombre: 'corte premium(barba/ceja/limpieza facial)', precio: $18,000 },
    { id: 3, nombre: 'corte/barba', precio: $18,000 },
    { id: 4, nombre: 'color global+corte(4 a 5hs aprox)', precio: $60,000 },
    { id: 5, nombre: 'mechas+corte', precio: $50,000 }
  ],
  clientes: [
    { id: 1, nombre: 'Martin Admin', email: ADMIN_EMAIL, rol: 'barbero' }
  ],
  turnos: [],
  diasBloqueados: []
};
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.servicios) db.servicios = parsed.servicios;
    if (parsed.clientes) db.clientes = parsed.clientes;
    if (parsed.turnos) db.turnos = parsed.turnos;
    if (parsed.diasBloqueados) db.diasBloqueados = parsed.diasBloqueados;
  } catch (e) {}
}
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {}
}
function getFechaHoraAr() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}
function capitalize(value = '') {
  const text = String(value).trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Cliente';
}
function nextId(list) {
  return list.length ? Math.max(...list.map(item => Number(item.id) || 0)) + 1 : 1;
}
function getClienteById(id) { return db.clientes.find(c => Number(c.id) === Number(id)); }
function getServicioById(id) { return db.servicios.find(s => Number(s.id) === Number(id)); }
function normalizeFechaHora(v) { return v ? String(v).slice(0, 16) : ''; }
function isPastDateTime(fh) { return fh ? fh < getFechaHoraAr() : false; }
function serializeTurno(turno) {
  const cliente = getClienteById(turno.clientes_id);
  const servicio = getServicioById(turno.servicios_id);
  return {
    id: turno.id,
    clientes_id: turno.clientes_id,
    servicios_id: turno.servicios_id,
    fecha_hora: normalizeFechaHora(turno.fecha_hora),
    estado: turno.estado || 'confirmado',
    cliente: cliente ? cliente.nombre : 'Cliente',
    servicio: servicio ? servicio.nombre : 'Servicio',
    precio: servicio ? servicio.precio : 0
  };
}
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/servicios', (_req, res) => res.json(db.servicios));
app.get('/api/clientes', (_req, res) => res.json(db.clientes));
app.get('/api/turnos', (_req, res) => res.json(db.turnos.map(serializeTurno)));
app.get('/api/dias-bloqueados', (_req, res) => res.json([...db.diasBloqueados].sort()));
app.post('/api/google-login', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Falta la credencial de Google.' });
  try {
    const googleRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const googleData = await googleRes.json();
    if (!googleRes.ok || !googleData.email) {
      return res.status(401).json({ error: 'Token de Google inválido.' });
    }
    const email = googleData.email.trim().toLowerCase();
    const nombre = capitalize(googleData.given_name || googleData.name || 'Cliente');
    let cliente = db.clientes.find(item => item.email === email);
    if (!cliente) {
      cliente = { id: nextId(db.clientes), nombre, email, rol: 'cliente' };
      db.clientes.push(cliente);
      saveData();
    } else {
      cliente.nombre = nombre;
      saveData();
    }
    if (email === ADMIN_EMAIL) {
      cliente.rol = 'barbero';
      saveData();
    }
    return res.json(cliente);
  } catch (e) {
    return res.status(500).json({ error: 'Error al verificar autenticación con Google.' });
  }
});
app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const nombre = capitalize(req.body?.nombre || '');
  if (!email || !nombre) return res.status(400).json({ error: 'Faltan datos.' });
  let cliente = db.clientes.find(item => item.email === email);
  if (!cliente) {
    cliente = { id: nextId(db.clientes), nombre, email, rol: 'cliente' };
    db.clientes.push(cliente);
    saveData();
  } else {
    cliente.nombre = nombre;
    saveData();
  }
  if (email === ADMIN_EMAIL) {
    cliente.rol = 'barbero';
    saveData();
  }
  return res.json(cliente);
});
app.post('/api/logout-admin', (_req, res) => res.json({ ok: true }));
app.post('/api/turnos', (req, res) => {
  const { cliente_id, servicios_id, fecha_hora } = req.body || {};
  const cliente = getClienteById(cliente_id);
  const servicio = getServicioById(servicios_id);
  const fhNormalizada = normalizeFechaHora(fecha_hora);
  if (!cliente || !servicio) return res.status(400).json({ error: 'Datos no válidos.' });
  const yaTieneTurno = db.turnos.some(t => Number(t.clientes_id) === Number(cliente_id) && t.estado !== 'cancelado');
  if (yaTieneTurno) return res.status(409).json({ error: 'Ya tenés un turno activo.' });
  if (isPastDateTime(fhNormalizada)) return res.status(400).json({ error: 'No se puede reservar en el pasado.' });
  const conflicto = db.turnos.some(t => t.estado === 'confirmado' && t.fecha_hora === fhNormalizada);
  if (conflicto) return res.status(409).json({ error: 'Horario ocupado.' });
  const nuevoTurno = { id: nextId(db.turnos), clientes_id: Number(cliente_id), servicios_id: Number(servicios_id), fecha_hora: fhNormalizada, estado: 'confirmado' };
  db.turnos.push(nuevoTurno);
  saveData();
  return res.status(201).json(serializeTurno(nuevoTurno));
});
app.post('/api/admin/servicios', (req, res) => {
  const nombre = String(req.body?.nombre || '').trim();
  const precio = Number(req.body?.precio);
  if (!nombre || !Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: 'Datos inválidos.' });
  const s = { id: nextId(db.servicios), nombre, precio };
  db.servicios.push(s);
  saveData();
  return res.status(201).json(s);
});
app.put('/api/admin/servicios/:id', (req, res) => {
  const s = db.servicios.find(i => Number(i.id) === Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'No encontrado.' });
  s.nombre = String(req.body?.nombre || '').trim();
  s.precio = Number(req.body?.precio);
  saveData();
  return res.json(s);
});
app.delete('/api/admin/servicios/:id', (req, res) => {
  const index = db.servicios.findIndex(i => Number(i.id) === Number(req.params.id));
  if (index !== -1) {
    db.servicios.splice(index, 1);
    db.turnos.forEach(t => { if (Number(t.servicios_id) === Number(req.params.id)) t.estado = 'cancelado'; });
    saveData();
  }
  return res.json({ ok: true });
});
app.post('/api/admin/dias-bloqueados', (req, res) => {
  const fecha = String(req.body?.fecha || '').trim();
  if (fecha && !db.diasBloqueados.includes(fecha)) {
    db.diasBloqueados.push(fecha);
    saveData();
  }
  return res.status(201).json({ fecha });
});
app.delete('/api/admin/dias-bloqueados/:fecha', (req, res) => {
  const index = db.diasBloqueados.indexOf(req.params.fecha);
  if (index !== -1) {
    db.diasBloqueados.splice(index, 1);
    saveData();
  }
  return res.json({ ok: true });
});
app.post('/api/admin/turnos', (req, res) => {
  const { cliente_id, servicios_id, fecha_hora } = req.body || {};
  const fhNormalizada = normalizeFechaHora(fecha_hora);
  const conflicto = db.turnos.some(t => t.estado === 'confirmado' && t.fecha_hora === fhNormalizada);
  if (conflicto) return res.status(409).json({ error: 'Horario ocupado.' });
  const nuevoTurno = { id: nextId(db.turnos), clientes_id: Number(cliente_id), servicios_id: Number(servicios_id), fecha_hora: fhNormalizada, estado: 'confirmado' };
  db.turnos.push(nuevoTurno);
  saveData();
  return res.status(201).json(serializeTurno(nuevoTurno));
});
app.put('/api/admin/turnos/:id', (req, res) => {
  const t = db.turnos.find(i => Number(i.id) === Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'No encontrado.' });
  t.clientes_id = Number(req.body.cliente_id);
  t.servicios_id = Number(req.body.servicios_id);
  t.fecha_hora = normalizeFechaHora(req.body.fecha_hora);
  saveData();
  return res.json(serializeTurno(t));
});
app.delete('/api/admin/turnos/:id', (req, res) => {
  const t = db.turnos.find(i => Number(i.id) === Number(req.params.id));
  if (t) {
    t.estado = 'cancelado';
    saveData();
  }
  return res.json({ ok: true });
});
app.put('/api/admin/clientes/:id', (req, res) => {
  const c = db.clientes.find(i => Number(i.id) === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  c.nombre = capitalize(req.body.nombre);
  c.email = String(req.body.email || '').trim().toLowerCase();
  saveData();
  return res.json(c);
});
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'No encontrado.' });
  return res.sendFile(path.join(__dirname, 'index.html'));
});
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));