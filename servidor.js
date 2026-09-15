const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicialización de la Base de Datos
async function inicializarBD() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS clientes (
                id SERIAL PRIMARY KEY, nombre VARCHAR(255), email VARCHAR(255) UNIQUE, rol VARCHAR(50)
            );
            CREATE TABLE IF NOT EXISTS servicios (
                id SERIAL PRIMARY KEY, nombre VARCHAR(255), precio NUMERIC
            );
            CREATE TABLE IF NOT EXISTS turnos (
                id SERIAL PRIMARY KEY, clientes_id INT REFERENCES clientes(id), servicios_id INT REFERENCES servicios(id), fecha_hora VARCHAR(100), estado VARCHAR(50)
            );
            CREATE TABLE IF NOT EXISTS dias_bloqueados (
                id SERIAL PRIMARY KEY, fecha VARCHAR(50) UNIQUE
            );
        `);

        const resServicios = await pool.query('SELECT COUNT(*) FROM servicios');
        if (parseInt(resServicios.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO servicios (nombre, precio) VALUES 
                ('Global', 50000), ('Mechas', 45000), ('Corte', 14000), ('Corte y Barba', 15000);
            `);
        }
        console.log("Base de datos de Excelencia lista.");
    } catch (err) { console.error("Error BD:", err); }
}
inicializarBD();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Obtener hora actual en Argentina (Formato YYYY-MM-DD HH:mm)
function getHoraArgentina() {
    return new Date().toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" }).replace('T', ' ').substring(0, 16);
}

// 1. LOGIN
app.post('/api/login', async (req, res) => {
    const { email, nombre } = req.body;
    try {
        let user = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);
        if (user.rows.length === 0) {
            user = await pool.query('INSERT INTO clientes (nombre, email, rol) VALUES ($1, $2, $3) RETURNING *', [nombre, email, 'cliente']);
        }
        res.json(user.rows[0]);
    } catch (error) { res.status(500).json({ error: 'Error en login' }); }
});

// 2. TURNOS (Cliente)
app.post('/api/turnos', async (req, res) => {
    const { servicios_id, fecha_hora, cliente_id } = req.body;
    try {
        const ahora = getHoraArgentina();

        // REGLA 1: Solo un turno activo por persona
        const activo = await pool.query(`SELECT * FROM turnos WHERE clientes_id = $1 AND fecha_hora > $2 AND estado = 'confirmado'`, [cliente_id, ahora]);
        if (activo.rows.length > 0) {
            return res.status(400).json({ error: 'Ya tenés un turno activo. Debés esperar a que finalice para solicitar otro.' });
        }

        // REGLA 2: Evitar superposición de turnos
        const ocupado = await pool.query(`SELECT * FROM turnos WHERE fecha_hora = $1 AND estado = 'confirmado'`, [fecha_hora]);
        if (ocupado.rows.length > 0) {
            return res.status(400).json({ error: 'El horario ya fue reservado por otra persona.' });
        }

        const nuevoTurno = await pool.query('INSERT INTO turnos (clientes_id, servicios_id, fecha_hora, estado) VALUES ($1, $2, $3, $4) RETURNING *', [cliente_id, servicios_id, fecha_hora, 'confirmado']);
        res.json(nuevoTurno.rows[0]);
    } catch (error) { res.status(500).json({ error: 'Error al reservar' }); }
});

// 3. DATOS GENERALES
app.get('/api/servicios', async (req, res) => {
    const r = await pool.query('SELECT * FROM servicios ORDER BY id ASC');
    res.json(r.rows);
});
app.get('/api/turnos', async (req, res) => {
    const r = await pool.query(`
        SELECT t.id, t.fecha_hora, t.estado, t.clientes_id, t.servicios_id, c.nombre as cliente, c.email as cliente_email, s.nombre as servicio, s.precio 
        FROM turnos t JOIN clientes c ON t.clientes_id = c.id JOIN servicios s ON t.servicios_id = s.id ORDER BY t.fecha_hora ASC
    `);
    res.json(r.rows);
});
app.get('/api/dias-bloqueados', async (req, res) => {
    const r = await pool.query('SELECT fecha FROM dias_bloqueados');
    res.json(r.rows.map(x => x.fecha));
});
app.get('/api/clientes', async (req, res) => {
    const r = await pool.query('SELECT * FROM clientes ORDER BY nombre ASC');
    res.json(r.rows);
});

// 4. RUTAS DE ADMINISTRADOR (Barbero)
app.post('/api/admin/servicios', async (req, res) => {
    await pool.query('INSERT INTO servicios (nombre, precio) VALUES ($1, $2)', [req.body.nombre, req.body.precio]);
    res.json({ ok: true });
});
app.put('/api/admin/servicios/:id', async (req, res) => {
    await pool.query('UPDATE servicios SET nombre=$1, precio=$2 WHERE id=$3', [req.body.nombre, req.body.precio, req.params.id]);
    res.json({ ok: true });
});
app.delete('/api/admin/servicios/:id', async (req, res) => {
    await pool.query('DELETE FROM servicios WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
});
app.post('/api/admin/dias-bloqueados', async (req, res) => {
    await pool.query('INSERT INTO dias_bloqueados (fecha) VALUES ($1) ON CONFLICT DO NOTHING', [req.body.fecha]);
    res.json({ ok: true });
});
app.delete('/api/admin/dias-bloqueados/:fecha', async (req, res) => {
    await pool.query('DELETE FROM dias_bloqueados WHERE fecha=$1', [req.params.fecha]);
    res.json({ ok: true });
});
app.post('/api/admin/turnos', async (req, res) => {
    await pool.query('INSERT INTO turnos (clientes_id, servicios_id, fecha_hora, estado) VALUES ($1, $2, $3, $4)', [req.body.cliente_id, req.body.servicios_id, req.body.fecha_hora, 'confirmado']);
    res.json({ ok: true });
});
app.put('/api/admin/turnos/:id', async (req, res) => {
    await pool.query('UPDATE turnos SET clientes_id=$1, servicios_id=$2, fecha_hora=$3 WHERE id=$4', [req.body.cliente_id, req.body.servicios_id, req.body.fecha_hora, req.params.id]);
    res.json({ ok: true });
});
app.delete('/api/admin/turnos/:id', async (req, res) => {
    await pool.query('DELETE FROM turnos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
});

app.listen(port, () => console.log(`Servidor Excelencia en puerto ${port}`));