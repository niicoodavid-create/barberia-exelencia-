const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
    console.warn('ADVERTENCIA: no hay DATABASE_URL configurada. Configurala en las variables de entorno de Render.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const ADMIN_EMAIL = 'gamarramartin1995@gmail.com';

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS clientes (id SERIAL PRIMARY KEY, nombre VARCHAR(255), email VARCHAR(255) UNIQUE, rol VARCHAR(50));
            CREATE TABLE IF NOT EXISTS servicios (id SERIAL PRIMARY KEY, nombre VARCHAR(255), precio NUMERIC);
            CREATE TABLE IF NOT EXISTS turnos (id SERIAL PRIMARY KEY, clientes_id INT REFERENCES clientes(id), servicios_id INT REFERENCES servicios(id), fecha_hora VARCHAR(100), estado VARCHAR(50));
            CREATE TABLE IF NOT EXISTS dias_bloqueados (id SERIAL PRIMARY KEY, fecha VARCHAR(50) UNIQUE);
        `);
        const resS = await pool.query('SELECT COUNT(*) FROM servicios');
        if (parseInt(resS.rows[0].count) === 0) {
            await pool.query(`INSERT INTO servicios (nombre, precio) VALUES ('Global', 50000), ('Mechas', 45000), ('Corte', 14000), ('Corte y Barba', 15000);`);
        }
        console.log('Base de datos inicializada correctamente.');
    } catch (e) {
        console.error('Error inicializando la base de datos:', e.message);
    }
}
initDB();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function getHoraAr() {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

app.post('/api/login', async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const nombre = String(req.body.nombre || '').trim();
        if (!email || !nombre) return res.status(400).json({ error: 'Faltan datos.' });

        const esAdminEmail = email === ADMIN_EMAIL;
        let u = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);

        if (u.rows.length === 0) {
            u = await pool.query(
                'INSERT INTO clientes (nombre, email, rol) VALUES ($1, $2, $3) RETURNING *',
                [nombre, email, esAdminEmail ? 'barbero' : 'cliente']
            );
        } else if (esAdminEmail && u.rows[0].rol !== 'barbero') {
            u = await pool.query(
                'UPDATE clientes SET rol = $1 WHERE email = $2 RETURNING *',
                ['barbero', email]
            );
        }
        res.json(u.rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error DB' });
    }
});

app.post('/api/turnos', async (req, res) => {
    try {
        const ahora = getHoraAr();
        if (req.body.fecha_hora <= ahora) return res.status(400).json({ error: 'No se puede reservar en el pasado.' });
        const ocupado = await pool.query("SELECT * FROM turnos WHERE fecha_hora = $1 AND estado = 'confirmado'", [req.body.fecha_hora]);
        if (ocupado.rows.length > 0) return res.status(400).json({ error: 'Este horario ya está ocupado.' });
        const activo = await pool.query("SELECT * FROM turnos WHERE clientes_id = $1 AND fecha_hora >= $2 AND estado = 'confirmado'", [req.body.cliente_id, ahora]);
        if (activo.rows.length > 0) return res.status(400).json({ error: 'Ya tienes un turno activo.' });
        const nuevo = await pool.query('INSERT INTO turnos (clientes_id, servicios_id, fecha_hora, estado) VALUES ($1, $2, $3, $4) RETURNING *', [req.body.cliente_id, req.body.servicios_id, req.body.fecha_hora, 'confirmado']);
        res.json(nuevo.rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al reservar' });
    }
});

app.get('/api/servicios', async (req, res) => {
    try { const r = await pool.query('SELECT * FROM servicios ORDER BY id ASC'); res.json(r.rows); }
    catch (e) { console.error(e); res.json([]); }
});

app.get('/api/turnos', async (req, res) => {
    try {
        const r = await pool.query(`SELECT t.id, t.fecha_hora, t.estado, t.clientes_id, t.servicios_id, c.nombre as cliente, c.email as cliente_email, s.nombre as servicio, s.precio FROM turnos t JOIN clientes c ON t.clientes_id = c.id JOIN servicios s ON t.servicios_id = s.id ORDER BY t.fecha_hora ASC`);
        res.json(r.rows);
    } catch (e) { console.error(e); res.json([]); }
});

app.get('/api/dias-bloqueados', async (req, res) => {
    try { const r = await pool.query('SELECT fecha FROM dias_bloqueados'); res.json(r.rows.map(x => x.fecha)); }
    catch (e) { console.error(e); res.json([]); }
});

app.get('/api/clientes', async (req, res) => {
    try {
        const ahora = getHoraAr();
        const r = await pool.query(`SELECT c.*, (SELECT COUNT(*) FROM turnos t WHERE t.clientes_id = c.id) as turnos_total, (SELECT COUNT(*) FROM turnos t WHERE t.clientes_id = c.id AND t.fecha_hora >= $1 AND t.estado = 'confirmado') as turnos_activos FROM clientes c ORDER BY c.nombre ASC`, [ahora]);
        res.json(r.rows);
    } catch (e) { console.error(e); res.json([]); }
});

app.post('/api/admin/servicios', async (req, res) => {
    try { await pool.query('INSERT INTO servicios (nombre, precio) VALUES ($1, $2)', [req.body.nombre, req.body.precio]); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error al guardar servicio' }); }
});
app.put('/api/admin/servicios/:id', async (req, res) => {
    try { await pool.query('UPDATE servicios SET nombre=$1, precio=$2 WHERE id=$3', [req.body.nombre, req.body.precio, req.params.id]); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error al actualizar servicio' }); }
});
app.delete('/api/admin/servicios/:id', async (req, res) => {
    try { await pool.query('DELETE FROM servicios WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error al eliminar servicio' }); }
});

app.post('/api/admin/dias-bloqueados', async (req, res) => {
    try { await pool.query('INSERT INTO dias_bloqueados (fecha) VALUES ($1) ON CONFLICT DO NOTHING', [req.body.fecha]); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error al bloquear día' }); }
});
app.delete('/api/admin/dias-bloqueados/:fecha', async (req, res) => {
    try { await pool.query('DELETE FROM dias_bloqueados WHERE fecha=$1', [req.params.fecha]); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error al desbloquear día' }); }
});

app.post('/api/admin/turnos', async (req, res) => {
    try {
        const ocupado = await pool.query("SELECT * FROM turnos WHERE fecha_hora = $1 AND estado = 'confirmado'", [req.body.fecha_hora]);
        if (ocupado.rows.length > 0) return res.status(400).json({ error: 'Este horario ya está ocupado.' });
        await pool.query('INSERT INTO turnos (clientes_id, servicios_id, fecha_hora, estado) VALUES ($1, $2, $3, $4)', [req.body.cliente_id, req.body.servicios_id, req.body.fecha_hora, 'confirmado']);
        res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error al crear turno' }); }
});
app.put('/api/admin/turnos/:id', async (req, res) => {
    try {
        const ocupado = await pool.query("SELECT * FROM turnos WHERE fecha_hora = $1 AND estado = 'confirmado' AND id != $2", [req.body.fecha_hora, req.params.id]);
        if (ocupado.rows.length > 0) return res.status(400).json({ error: 'Este horario ya está ocupado.' });
        await pool.query('UPDATE turnos SET clientes_id=$1, servicios_id=$2, fecha_hora=$3 WHERE id=$4', [req.body.cliente_id, req.body.servicios_id, req.body.fecha_hora, req.params.id]);
        res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error al editar turno' }); }
});
app.delete('/api/admin/turnos/:id', async (req, res) => {
    try { await pool.query('DELETE FROM turnos WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error al cancelar turno' }); }
});

app.put('/api/admin/clientes/:id', async (req, res) => {
    try { await pool.query('UPDATE clientes SET nombre=$1, email=$2 WHERE id=$3', [req.body.nombre, req.body.email, req.params.id]); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error al actualizar cliente' }); }
});
app.delete('/api/admin/clientes/:id', async (req, res) => {
    try { await pool.query('DELETE FROM clientes WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
    catch (e) { console.error(e); res.status(500).json({ error: 'Error al eliminar cliente' }); }
});

app.post('/api/logout-admin', (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).json({ error: 'No encontrado' }));

app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));