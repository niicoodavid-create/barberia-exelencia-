const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Configuración Base de Datos PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicialización de Tablas
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

        // Insertar servicios por defecto si está vacío
        const resServicios = await pool.query('SELECT COUNT(*) FROM servicios');
        if (parseInt(resServicios.rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO servicios (nombre, precio) VALUES 
                ('Global', 50000), ('Mechas', 45000), ('Corte', 14000), ('Corte y Barba', 15000);
            `);
        }
        console.log("✅ Base de datos de Excelencia en línea.");
    } catch (err) { console.error("❌ Error iniciando BD:", err); }
}
inicializarBD();

// Middlewares (AUTORIZACIONES COMPLEMENTARIAS - CORS)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); // Permite peticiones de cualquier origen
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Servir la interfaz gráfica
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Función: Hora Actual Exacta en Argentina
function getHoraArgentina() {
    return new Date().toLocaleString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" }).replace('T', ' ').substring(0, 16);
}

// ---------------- ENDPOINTS CLIENTES ---------------- //

app.post('/api/login', async (req, res) => {
    const { email, nombre } = req.body;
    try {
        let user = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);
        if (user.rows.length === 0) {
            user = await pool.query('INSERT INTO clientes (nombre, email, rol) VALUES ($1, $2, $3) RETURNING *', [nombre, email, 'cliente']);
        }
        res.json(user.rows[0]);
    } catch (error) { res.status(500).json({ error: 'Error en acceso' }); }
});

app.post('/api/turnos', async (req, res) => {
    const { cliente_id, servicios_id, fecha_hora } = req.body;
    try {
        const ahora = getHoraArgentina();

        if (fecha_hora <= ahora) {
            return res.status(400).json({ error: 'No puedes reservar en el pasado.' });
        }

        // REGLA 1: Evitar doble reserva en el mismo horario (Rojo)
        const ocupado = await pool.query(`SELECT * FROM turnos WHERE fecha_hora = $1 AND estado = 'confirmado'`, [fecha_hora]);
        if (ocupado.rows.length > 0) {
            return res.status(400).json({ error: 'Este horario acaba de ser tomado por alguien más.' });
        }

        // REGLA 2: Solo un turno activo por persona (Se libera cuando pase la hora)
        const activo = await pool.query(`SELECT * FROM turnos WHERE clientes_id = $1 AND fecha_hora >= $2 AND estado = 'confirmado'`, [cliente_id, ahora]);
        if (activo.rows.length > 0) {
            return res.status(400).json({ error: 'Ya tienes un turno activo. Podrás pedir otro cuando el actual termine.' });
        }

        const nuevoTurno = await pool.query('INSERT INTO turnos (clientes_id, servicios_id, fecha_hora, estado) VALUES ($1, $2, $3, $4) RETURNING *', [cliente_id, servicios_id, fecha_hora, 'confirmado']);
        res.json(nuevoTurno.rows[0]);
    } catch (error) { res.status(500).json({ error: 'Error interno de servidor al reservar' }); }
});

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

// ---------------- ENDPOINTS ADMIN (BARBERO) ---------------- //

app.get('/api/clientes', async (req, res) => {
    // Calcula cuántos turnos activos tiene cada cliente para mostrarlo en el panel
    const ahora = getHoraArgentina();
    const r = await pool.query(`
        SELECT c.*, 
        (SELECT COUNT(*) FROM turnos t WHERE t.clientes_id = c.id) as turnos_total,
        (SELECT COUNT(*) FROM turnos t WHERE t.clientes_id = c.id AND t.fecha_hora >= $1 AND t.estado = 'confirmado') as turnos_activos
        FROM clientes c ORDER BY c.nombre ASC
    `, [ahora]);
    res.json(r.rows);
});

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
app.put('/api/admin/clientes/:id', async (req, res) => {
    await pool.query('UPDATE clientes SET nombre=$1, email=$2 WHERE id=$3', [req.body.nombre, req.body.email, req.params.id]);
    res.json({ ok: true });
});
app.delete('/api/admin/clientes/:id', async (req, res) => {
    await pool.query('DELETE FROM clientes WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
});
app.post('/api/logout-admin', (req, res) => res.json({ ok: true }));

app.listen(port, () => console.log(`🚀 Servidor Excelencia operando en puerto ${port}`));