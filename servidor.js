const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.trim() : '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ? process.env.GOOGLE_CLIENT_SECRET.trim() : '';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST');
    next();
});

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
        res.status(500).json({ error: 'Error en inicio de sesión' });
    }
});

app.get('/auth/google', (req, res) => {
    const redirectUri = 'https://barberia-exelencia.onrender.com/auth/google/callback';
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=email%20profile`;
    res.redirect(googleAuthUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send('Falta el código de Google.');
    }

    try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code: code,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: 'https://barberia-exelencia.onrender.com/auth/google/callback',
                grant_type: 'authorization_code'
            })
        });

        const tokenJson = await tokenResponse.json();

        if (!tokenJson.access_token) {
            return res.send(`<div style="padding: 40px; background:#0b0b0b; color:#fff;"><h2>Error de Google</h2><pre>${JSON.stringify(tokenJson, null, 2)}</pre></div>`);
        }

        const userResponse = await fetch(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${tokenJson.access_token}`);
        const googleUser = await userResponse.json();
        const email = googleUser.email;
        const nombre = googleUser.name;

        let usuarioExistente = await pool.query('SELECT * FROM clientes WHERE email = $1', [email]);
        let usuarioFinal;
        
        if (usuarioExistente.rows.length > 0) {
            usuarioFinal = usuarioExistente.rows[0];
        } else {
            const nuevoUsuario = await pool.query(
                'INSERT INTO clientes (nombre, email, rol) VALUES ($1, $2, $3) RETURNING *',
                [nombre, email, 'cliente']
            );
            usuarioFinal = nuevoUsuario.rows[0];
        }

        res.send(`
            <script>
                localStorage.setItem('usuarioActivo', JSON.stringify(${JSON.stringify(usuarioFinal)}));
                window.location.href = '/?login=success';
            </script>
        `);
    } catch (err) {
        // FORZAMOS LA CONVERSIÓN A TEXTO PLANO
        const errorMensaje = err && err.stack ? err.stack : (err.message ? err.message : String(err));
        
        res.status(500).send(`
            <div style="background:#0b0b0b; color:#f4f4f4; padding: 40px; font-family: sans-serif; text-align: center;">
                <h2 style="color:#c5a059;">¡Atrapado! Este es el error real:</h2>
                <pre style="background:#1f1f1f; padding: 20px; color:#d52b1e; border-radius: 8px; display: inline-block; text-align: left; font-size: 15px; white-space: pre-wrap;">${errorMensaje}</pre>
                <br><br><a href="/" style="color:#000; text-decoration: none; padding: 10px 20px; background:#c5a059; border-radius: 5px;">Volver al inicio</a>
            </div>
        `);
    }
});

app.get('/api/servicios', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM servicios;');
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener servicios' });
    }
});

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
    console.log(`Servidor de Excelencia corriendo en el puerto ${port}`);
});