const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================================
// CORREO DEL ADMINISTRADOR (BARBERO)
// =====================================================================
const ADMIN_EMAIL = 'niicoodavid@gmail.com';
// =====================================================================

const servicios = [
  { id: 1, nombre: 'Corte clásico', precio: 2500 },
  { id: 2, nombre: 'Corte + barba', precio: 3500 },
  { id: 3, nombre: 'Barba completa', precio: 2200 },
  { id: 4, nombre: 'Perfilado', precio: 1800 },
  { id: 5, nombre: 'Corte premium', precio: 4200 }
];

const clientes = [
  { id: 1, nombre: 'Nico', email: ADMIN_EMAIL, rol: 'barbero' }
];

const turnos = [];
const diasBloqueados = [];

// Función para obtener la hora exacta de Argentina
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
  if (!text) return 'Cliente';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildClientePublico(cliente) {
  if (!cliente) return null;
  return {
    id: cliente.id,
    nombre: cliente.nombre,
    email: cliente.email,
    rol: cliente.rol || 'cliente'
  };
}

function nextId(list) {
  return list.length ? Math.max(...list.map(item => Number(item.id) || 0)) + 1 : 1;
}

function getClienteById(id) {
  return clientes.find((cliente) => Number(cliente.id) === Number(id));
}

function getServicioById(id) {
  return servicios.find((servicio) => Number(servicio.id) === Number(id));
}

function normalizeFechaHora(value) {
  if (!value) return '';
  return String(value).slice(0, 16);
}

function getHoraFromFechaHora(value) {
  const fechaHora = normalizeFechaHora(value);
  return fechaHora.includes(' ') ? fechaHora.split(' ')[1] : '';
}

function getFechaFromFechaHora(value) {
  const fechaHora = normalizeFechaHora(value);
  return fechaHora.includes(' ') ? fechaHora.split(' ')[0] : fechaHora;
}

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

app.get('/api/health', (_req, res) => res.json({ ok: true, message: 'Barberia API funcionando' }));
app.get('/api/servicios', (_req, res) => res.json(servicios));
app.get('/api/clientes', (_req, res) => res.json(clientes.map(buildClientePublico)));
app.get('/api/turnos', (_req, res) => res.json(turnos.map(serializeTurno)));
app.get('/api/dias-bloqueados', (_req, res) => res.json([...diasBloqueados].sort()));

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const nombre = capitalize(req.body?.nombre || '');

  if (!email || !nombre) {
    return res.status(400).json({ error: 'Completar nombre y correo.' });
  }

  let cliente = clientes.find((item) => item.email === email);

  if (!cliente) {
    cliente = { id: nextId(clientes), nombre, email, rol: 'cliente' };
    clientes.push(cliente);
  } else {
    cliente.nombre = nombre;
  }

  // AQUÍ ES DONDE EL SERVIDOR DETECTA INTELIGENTEMENTE SI ERES EL ADMIN
  if (email === ADMIN_EMAIL) {
    cliente.rol = 'barbero';
  }

  return res.json(buildClientePublico(cliente));
});

app.post('/api/logout-admin', (_req, res) => res.json({ ok: true }));

// Rutas de cliente
app.post('/api/turnos', (req, res) => {
  const { cliente_id, servicios_id, fecha_hora } = req.body || {};
  const cliente = getClienteById(cliente_id);
  const servicio = getServicioById(servicios_id);
  const fechaHoraNormalizada = normalizeFechaHora(fecha_hora);

  if (!cliente) return res.status(400).json({ error: 'Cliente no encontrado.' });
  if (!servicio) return res.status(400).json({ error: 'Servicio no encontrado.' });
  if (!fechaHoraNormalizada || !fechaHoraNormalizada.includes(' ')) return res.status(400).json({ error: 'Fecha y hora requeridas.' });

  const yaTieneTurno = turnos.some((turno) => Number(turno.clientes_id) === Number(cliente_id) && turno.estado !== 'cancelado');
  if (yaTieneTurno) return res.status(409).json({ error: 'Ya tenés un turno activo.' });
  if (isPastDateTime(fechaHoraNormalizada)) return res.status(400).json({ error: 'No se puede reservar un horario pasado.' });

  const conflicto = turnos.some((turno) => turno.estado === 'confirmado' && turno.fecha_hora === fechaHoraNormalizada);
  if (conflicto) return res.status(409).json({ error: 'Ese horario ya fue ocupado por otro usuario.' });

  const nuevoTurno = {
    id: nextId(turnos),
    clientes_id: Number(cliente_id),
    servicios_id: Number(servicios_id),
    fecha_hora: fechaHoraNormalizada,
    estado: 'confirmado'
  };

  turnos.push(nuevoTurno);
  return res.status(201).json(serializeTurno(nuevoTurno));
});

// RUTAS DE ADMINISTRADOR
app.post('/api/admin/servicios', (req, res) => {
  const nombre = String(req.body?.nombre || '').trim();
  const precio = Number(req.body?.precio);
  if (!nombre || !Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: 'Datos inválidos.' });
  
  const servicio = { id: nextId(servicios), nombre, precio };
  servicios.push(servicio);
  return res.status(201).json(servicio);
});

app.put('/api/admin/servicios/:id', (req, res) => {
  const id = Number(req.params.id);
  const servicio = servicios.find((item) => Number(item.id) === id);
  if (!servicio) return res.status(404).json({ error: 'Servicio no encontrado.' });

  const nombre = String(req.body?.nombre || '').trim();
  const precio = Number(req.body?.precio);
  if (!nombre || !Number.isFinite(precio) || precio < 0) return res.status(400).json({ error: 'Datos inválidos.' });

  servicio.nombre = nombre;
  servicio.precio = precio;
  return res.json(servicio);
});

app.delete('/api/admin/servicios/:id', (req, res) => {
  const id = Number(req.params.id);
  const index = servicios.findIndex((item) => Number(item.id) === id);
  if (index === -1) return res.status(404).json({ error: 'Servicio no encontrado.' });

  servicios.splice(index, 1);
  turnos.forEach((turno) => { if (Number(turno.servicios_id) === id) turno.estado = 'cancelado'; });
  return res.json({ ok: true });
});

app.post('/api/admin/dias-bloqueados', (req, res) => {
  const fecha = String(req.body?.fecha || '').trim();
  if (!fecha) return res.status(400).json({ error: 'Fecha inválida.' });
  if (!diasBloqueados.includes(fecha)) diasBloqueados.push(fecha);
  return res.status(201).json({ fecha });
});

app.delete('/api/admin/dias-bloqueados/:fecha', (req, res) => {
  const index = diasBloqueados.indexOf(req.params.fecha);
  if (index !== -1) diasBloqueados.splice(index, 1);
  return res.json({ ok: true });
});

app.post('/api/admin/turnos', (req, res) => {
  const { cliente_id, servicios_id, fecha_hora } = req.body || {};
  const cliente = getClienteById(cliente_id);
  const servicio = getServicioById(servicios_id);
  const fechaHoraNormalizada = normalizeFechaHora(fecha_hora);

  if (!cliente || !servicio) return res.status(400).json({ error: 'Faltan datos.' });
  const conflicto = turnos.some((turno) => turno.estado === 'confirmado' && turno.fecha_hora === fechaHoraNormalizada);
  if (conflicto) return res.status(409).json({ error: 'Horario ocupado.' });

  const nuevoTurno = {
    id: nextId(turnos),
    clientes_id: Number(cliente_id),
    servicios_id: Number(servicios_id),
    fecha_hora: fechaHoraNormalizada,
    estado: 'confirmado'
  };
  turnos.push(nuevoTurno);
  return res.status(201).json(serializeTurno(nuevoTurno));
});

app.put('/api/admin/turnos/:id', (req, res) => {
  const id = Number(req.params.id);
  const turno = turnos.find((item) => Number(item.id) === id);
  if (!turno) return res.status(404).json({ error: 'Turno no encontrado.' });

  turno.clientes_id = Number(req.body.cliente_id);
  turno.servicios_id = Number(req.body.servicios_id);
  turno.fecha_hora = normalizeFechaHora(req.body.fecha_hora);
  return res.json(serializeTurno(turno));
});

app.delete('/api/admin/turnos/:id', (req, res) => {
  const turno = turnos.find((item) => Number(item.id) === Number(req.params.id));
  if (turno) turno.estado = 'cancelado';
  return res.json({ ok: true });
});

app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'No encontrado.' });
  return res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en el puerto ${PORT}`);
});