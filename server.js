const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================================
// [1] CONFIGURACIÓN INTELIGENTE: CORREO DEL ADMINISTRADOR
// =====================================================================
// Todo aquel que inicie sesión con este correo, tendrá permisos de Barbero.
const ADMIN_EMAIL = 'niicoodavid@gmail.com';
// =====================================================================

// Base de datos en memoria (Simulada para este entorno)
const servicios = [
  { id: 1, nombre: 'Corte clásico', precio: 2500 },
  { id: 2, nombre: 'Corte + barba', precio: 3500 },
  { id: 3, nombre: 'Barba completa', precio: 2200 },
  { id: 4, nombre: 'Perfilado', precio: 1800 },
  { id: 5, nombre: 'Corte premium', precio: 4200 }
];

const clientes = [
  { id: 1, nombre: 'Nico Admin', email: ADMIN_EMAIL, rol: 'barbero' }
];

const turnos = [];
const diasBloqueados = [];

// =====================================================================
// [2] FUNCIONES DIDÁCTICAS Y DE UTILIDAD
// =====================================================================

// Asegura que todas las fechas y horas sean estrictamente de Argentina
function getFechaHoraAr() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`; // Formato: YYYY-MM-DD HH:mm
}

function capitalize(value = '') {
  const text = String(value).trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Cliente';
}

function nextId(list) {
  return list.length ? Math.max(...list.map(item => Number(item.id) || 0)) + 1 : 1;
}

function getClienteById(id) { return clientes.find((c) => Number(c.id) === Number(id)); }
function getServicioById(id) { return servicios.find((s) => Number(s.id) === Number(id)); }

function normalizeFechaHora(value) { return value ? String(value).slice(0, 16) : ''; }

function isPastDateTime(fechaHora) {
  if (!fechaHora) return false;
  return String(fechaHora).slice(0, 16) < getFechaHoraAr();
}

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

// =====================================================================
// [3] RUTAS PÚBLICAS Y DE AUTENTICACIÓN
// =====================================================================

app.get('/api/servicios', (_req, res) => res.json(servicios));
app.get('/api/clientes', (_req, res) => res.json(clientes));
app.get('/api/turnos', (_req, res) => res.json(turnos.map(serializeTurno)));
app.get('/api/dias-bloqueados', (_req, res) => res.json([...diasBloqueados].sort()));

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const nombre = capitalize(req.body?.nombre || '');

  if (!email || !nombre) return res.status(400).json({ error: 'Faltan datos de usuario.' });

  let cliente = clientes.find((item) => item.email === email);

  if (!cliente) {
    cliente = { id: nextId(clientes), nombre, email, rol: 'cliente' };
    clientes.push(cliente);
  } else {
    cliente.nombre = nombre; // Actualiza el nombre si cambió
  }

  // LÓGICA INTELIGENTE: Si el mail es el del admin, le damos acceso total
  if (email === ADMIN_EMAIL) {
    cliente.rol = 'barbero';
  }

  return res.json(cliente);
});

app.post('/api/logout-admin', (_req, res) => res.json({ ok: true }));

// =====================================================================
// [4] RUTAS PARA CLIENTES (Solicitar turnos)
// =====================================================================

app.post('/api/turnos', (req, res) => {
  const { cliente_id, servicios_id, fecha_hora } = req.body || {};
  const cliente = getClienteById(cliente_id);
  const servicio = getServicioById(servicios_id);
  const fhNormalizada = normalizeFechaHora(fecha_hora);

  if (!cliente || !servicio) return res.status(400).json({ error: 'Datos inválidos.' });
  if (!fhNormalizada.includes(' ')) return res.status(400).json({ error: 'Fecha inválida.' });

  const yaTieneTurno = turnos.some((t) => Number(t.clientes_id) === Number(cliente_id) && t.estado !== 'cancelado');
  if (yaTieneTurno) return res.status(409).json({ error: 'Ya tenés un turno activo.' });
  if (isPastDateTime(fhNormalizada)) return res.status(400).json({ error: 'Horario pasado.' });

  const conflicto = turnos.some((t) => t.estado === 'confirmado' && t.fecha_hora === fhNormalizada);
  if (conflicto) return res.status(409).json({ error: 'Horario ocupado.' });

  const nuevoTurno = { id: nextId(turnos), clientes_id: Number(cliente_id), servicios_id: Number(servicios_id), fecha_hora: fhNormalizada, estado: 'confirmado' };
  turnos.push(nuevoTurno);
  return res.status(201).json(serializeTurno(nuevoTurno));
});

// =====================================================================
// [5] RUTAS EXCLUSIVAS DEL ADMINISTRADOR (Barbero)
// =====================================================================

app.post('/api/admin/servicios', (req, res) => {
  const nombre = String(req.body?.nombre || '').trim();
  const precio = Number(req.body?.precio);
  if (!nombre || !Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: 'Datos inválidos.' });
  const s = { id: nextId(servicios), nombre, precio };
  servicios.push(s);
  return res.status(201).json(s);
});

app.put('/api/admin/servicios/:id', (req, res) => {
  const s = servicios.find(i => Number(i.id) === Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'No encontrado.' });
  s.nombre = String(req.body?.nombre || '').trim();
  s.precio = Number(req.body?.precio);
  return res.json(s);
});

app.delete('/api/admin/servicios/:id', (req, res) => {
  const index = servicios.findIndex(i => Number(i.id) === Number(req.params.id));
  if (index !== -1) {
    servicios.splice(index, 1);
    turnos.forEach(t => { if (Number(t.servicios_id) === Number(req.params.id)) t.estado = 'cancelado'; });
  }
  return res.json({ ok: true });
});

app.post('/api/admin/dias-bloqueados', (req, res) => {
  const f = String(req.body?.fecha || '').trim();
  if (f && !diasBloqueados.includes(f)) diasBloqueados.push(f);
  return res.status(201).json({ fecha: f });
});

app.delete('/api/admin/dias-bloqueados/:fecha', (req, res) => {
  const i = diasBloqueados.indexOf(req.params.fecha);
  if (i !== -1) diasBloqueados.splice(i, 1);
  return res.json({ ok: true });
});

app.post('/api/admin/turnos', (req, res) => { // Dar turno manual
  const { cliente_id, servicios_id, fecha_hora } = req.body || {};
  const fhNormalizada = normalizeFechaHora(fecha_hora);
  const conflicto = turnos.some(t => t.estado === 'confirmado' && t.fecha_hora === fhNormalizada);
  if (conflicto) return res.status(409).json({ error: 'Ocupado.' });

  const nuevoTurno = { id: nextId(turnos), clientes_id: Number(cliente_id), servicios_id: Number(servicios_id), fecha_hora: fhNormalizada, estado: 'confirmado' };
  turnos.push(nuevoTurno);
  return res.status(201).json(serializeTurno(nuevoTurno));
});

app.put('/api/admin/turnos/:id', (req, res) => { // Editar turno
  const t = turnos.find(i => Number(i.id) === Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'No encontrado.' });
  t.clientes_id = Number(req.body.cliente_id);
  t.servicios_id = Number(req.body.servicios_id);
  t.fecha_hora = normalizeFechaHora(req.body.fecha_hora);
  return res.json(serializeTurno(t));
});

app.delete('/api/admin/turnos/:id', (req, res) => { // Cancelar turno
  const t = turnos.find(i => Number(i.id) === Number(req.params.id));
  if (t) t.estado = 'cancelado';
  return res.json({ ok: true });
});

// Entrega el HTML
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Servidor de Excelencia activo en el puerto ${PORT}`));