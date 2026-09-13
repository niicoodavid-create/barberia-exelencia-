const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de la base de datos PostgreSQL en la nube
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    next();
});

// Configurar carpeta estática para servir el index.html y recursos visuales
app.use(express.static(path.join(__dirname)));

// Ruta principal obligatoria para evitar el error "Cannot GET /"
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Ruta de Autenticación Institucional por Correo
app.post('/api/login', async (req, res) => {
    const { email, nombre } = req.body;
    try {
        let usuarioExistente = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);
        if (usuarioExistente.rows.length > 0) {
            res.json(usuarioExistente.rows[0]);
        } else {
            const nuevoUsuario = await pool.query(
                'INSERT INTO clientes (nombre, email, rol) VALUES ($1, $2, $3) RETURNING *',
                [nombre, email, 'cliente']
            );
            res.json(nuevoUsuario.rows[0]);
        }
    } catch (error) {
        res.status(500).json({ error: 'Error en el inicio de sesión' });
    }
});

// 2. Catálogo de servicios desde PostgreSQL
app.get('/api/servicios', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM servicios;');
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener servicios' });
    }
});

// 3. Guardar un nuevo turno/cita
app.post('/api/turnos', async (req, res) => {
    const { cliente_id, servicios_id, fecha_hora } = req.body;
    try {
        const nuevoTurno = await pool.query(
            'INSERT INTO turnos (clientes_id, servicios_id, fecha_hora, estado) VALUES ($1, $2, $3, $4) RETURNING *',
            [cliente_id, servicios_id, fecha_hora, 'pendiente']
        );
        res.json({ mensaje: '¡Turno reservado con éxito!', turno: nuevoTurno.rows });
    } catch (error) {
        res.status(500).json({ error: 'Error al reservar el turno' });
    }
});

app.listen(port, () => {
    console.log(`Servidor de "Excelencia" corriendo en el puerto ${port}`);
});