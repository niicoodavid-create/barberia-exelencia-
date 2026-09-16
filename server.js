const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================================
// CONFIGURACIÓN DEL ADMINISTRADOR INTELIGENTE
// =====================================================================
const ADMIN_EMAIL = 'niicoodavid@gmail.com';

// Base de datos en memoria (Estructuras de datos conectadas)
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
// UTILIDADES Y HORARIOS DE ARGENTINA
// =====================================================================
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

function getClienteById(id) { return clientes.find(c => Number(c.id) === Number(id)); }
function getServicioById(id) { return servicios.find(s => Number(s.id) === Number(id)); }
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

// =====================================================================
// ENDPOINTS DE CONTROL Y CONEXIÓN (API REST)
// =====================================================================

// Ruta de diagnóstico para verificar que el servidor responde correctamente
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, message: 'Conexión establecida correctamente con el servidor de Excelencia' });
});

app.get('/api/servicios', (_req, res) => res.json(servicios));
app.get('/api/clientes', (_req, res) => res.json(clientes));
app.get('/api/turnos', (_req, res) => res.json(turnos.map(serializeTurno)));
app.get('/api/dias-bloqueados', (_req, res) => res.json([...diasBloqueados].sort()));

// Endpoint inteligente de autenticación (Reconoce rol de barbero o cliente)
app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const nombre = capitalize(req.body?.nombre || '');

  if (!email || !nombre) {
    return res.status(400).json({ error: 'Faltan datos obligatorios para iniciar sesión.' });
  }

  let cliente = clientes.find(item => item.email === email);

  if (!cliente) {
    cliente = { id: nextId(clientes), nombre, email, rol: 'cliente' };
    clientes.push(cliente);
  } else {
    cliente.nombre = nombre;
  }

  // Inteligencia de roles: Asigna rol barbero si coincide con el correo autorizado
  if (email === ADMIN_EMAIL) {
    cliente.rol = 'barbero';
  }

  return res.json(cliente);
});

app.post('/api/logout-admin', (_req, res) => res.json({ ok: true }));

// Gestión de turnos (Cliente)
app.post('/api/turnos', (req, res) => {
  const { cliente_id, servicios_id, fecha_hora } = req.body || {};
  const cliente = getClienteById(cliente_id);
  const servicio = getServicioById(servicios_id);
  const fhNormalizada = normalizeFechaHora(fecha_hora);

  if (!cliente || !servicio) return res.status(400).json({ error: 'Cliente o servicio no válido.' });
  if (!fhNormalizada.includes(' ')) return res.status(400).json({ error: 'Formato de fecha y hora incorrecto.' });

  const yaTieneTurno = turnos.some(t => Number(t.clientes_id) === Number(cliente_id) && t.estado !== 'cancelado');
  if (yaTieneTurno) return res.status(409).json({ error: 'Ya posees un turno activo registrado.' });
  if (isPastDateTime(fhNormalizada)) return res.status(400).json({ error: 'No se puede reservar en un horario pasado.' });

  const conflicto = turnos.some(t => t.estado === 'confirmado' && t.fecha_hora === fhNormalizada);
  if (conflicto) return res.status(409).json({ error: 'Este horario ya ha sido reservado por otro usuario.' });

  const nuevoTurno = {
    id: nextId(turnos),
    clientes_id: Number(cliente_id),
    servicios_id: Number(servicios_id),
    fecha_hora: fhNormalizada,
    estado: 'confirmado'
  };

  turnos.push(nuevoTurno);
  return res.status(201).json(serializeTurno(nuevoTurno));
});

// =====================================================================
// ENDPOINTS EXCLUSIVOS DE ADMINISTRACIÓN
// =====================================================================
app.post('/api/admin/servicios', (req, res) => {
  const nombre = String(req.body?.nombre || '').trim();
  const precio = Number(req.body?.precio);
  if (!nombre || !Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: 'Nombre y precio válidos requeridos.' });
  const s = { id: nextId(servicios), nombre, precio };
  servicios.push(s);
  return res.status(201).json(s);
});

app.put('/api/admin/servicios/:id', (req, res) => {
  const s = servicios.find(i => Number(i.id) === Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Servicio no encontrado.' });
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
  const fecha = String(req.body?.fecha || '').trim();
  if (fecha && !diasBloqueados.includes(fecha)) diasBloqueados.push(fecha);
  return res.status(201).json({ fecha });
});

app.delete('/api/admin/dias-bloqueados/:fecha', (req, res) => {
  const index = diasBloqueados.indexOf(req.params.fecha);
  if (index !== -1) diasBloqueados.splice(index, 1);
  return res.json({ ok: true });
});

app.post('/api/admin/turnos', (req, res) => {
  const { cliente_id, servicios_id, fecha_hora } = req.body || {};
  const fhNormalizada = normalizeFechaHora(fecha_hora);
  const conflicto = turnos.some(t => t.estado === 'confirmado' && t.fecha_hora === fhNormalizada);
  if (conflicto) return res.status(409).json({ error: 'Horario ocupado.' });

  const nuevoTurno = { id: nextId(turnos), clientes_id: Number(cliente_id), servicios_id: Number(servicios_id), fecha_hora: fhNormalizada, estado: 'confirmado' };
  turnos.push(nuevoTurno);
  return res.status(201).json(serializeTurno(nuevoTurno));
});

app.put('/api/admin/turnos/:id', (req, res) => {
  const t = turnos.find(i => Number(i.id) === Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Turno no encontrado.' });
  t.clientes_id = Number(req.body.cliente_id);
  t.servicios_id = Number(req.body.servicios_id);
  t.fecha_hora = normalizeFechaHora(req.body.fecha_hora);
  return res.json(serializeTurno(t));
});

app.delete('/api/admin/turnos/:id', (req, res) => {
  const t = turnos.find(i => Number(i.id) === Number(req.params.id));
  if (t) t.estado = 'cancelado';
  return res.json({ ok: true });
});

app.put('/api/admin/clientes/:id', (req, res) => {
  const c = clientes.find(i => Number(i.id) === Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  c.nombre = capitalize(req.body.nombre);
  c.email = String(req.body.email || '').trim().toLowerCase();
  return res.json(c);
});

// Servir archivos estáticos y redirección de rutas
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Ruta de API no encontrada.' });
  return res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor de Excelencia operando correctamente en el puerto ${PORT}`);
});