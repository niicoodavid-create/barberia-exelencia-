const express = require('express');
const { Pool } = require('pg');
const https = require('https');

const app = express();
const port = 3000;

// Configuración de la base de datos PostgreSQL
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'barberia',
    password: 'Nicosql', // Reemplaza con tu contraseña real
    port: 5432,
});

app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    next();
});

// 1. Autenticación Real con Google Token
app.post('/api/login-google', async (req, res) => {
    const { token } = req.body;

    https.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`, (resp) => {
        let data = '';
        resp.on('data', (chunk) => { data += chunk; });
        resp.on('end', async () => {
            try {
                const googleUser = JSON.parse(data);
                if (!googleUser.email) {
                    return res.status(401).json({ error: 'Token de Google inválido' });
                }

                const email = googleUser.email;
                const nombre = googleUser.name || 'Usuario Google';

                let usuarioRes = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);
                let usuario;

                if (usuarioRes.rows.length > 0) {
                    usuario = usuarioRes.rows[0];
                } else {
                    const nuevoUsuario = await pool.query(
                        'INSERT INTO clientes (nombre, email, rol) VALUES ($1, $2, $3) RETURNING *',
                        [nombre, email, 'cliente']
                    );
                    usuario = nuevoUsuario.rows[0];
                }

                res.json(usuario);
            } catch (err) {
                res.status(500).json({ error: 'Error procesando el usuario de Google' });
            }
        });
    }).on("error", () => {
        res.status(500).json({ error: 'No se pudo conectar con el servidor de Google' });
    });
});

// 2. Autenticación Real con Apple ID
app.post('/api/login-apple', async (req, res) => {
    const { email, nombre } = req.body;

    try {
        if (!email) {
            return res.status(401).json({ error: 'No se pudo obtener el correo de Apple ID' });
        }

        let usuarioRes = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);
        let usuario;

        if (usuarioRes.rows.length > 0) {
            usuario = usuarioRes.rows[0];
        } else {
            const nuevoUsuario = await pool.query(
                'INSERT INTO clientes (nombre, email, rol) VALUES ($1, $2, $3) RETURNING *',
                [nombre || 'Usuario Apple ID', email, 'cliente']
            );
            usuario = nuevoUsuario.rows[0];
        }

        res.json(usuario);
    } catch (err) {
        res.status(500).json({ error: 'Error procesando el usuario de Apple ID' });
    }
});

// 3. Obtener el catálogo de servicios desde PostgreSQL
app.get('/api/servicios', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM servicios;');
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener servicios' });
    }
});

// 4. Guardar un nuevo turno/cita
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
    console.log(`Servidor real de "Excelencia" corriendo en http://localhost:${port}`);
});