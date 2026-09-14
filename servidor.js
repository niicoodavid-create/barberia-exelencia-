const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const https = require('https');
const querystring = require('querystring'); // Añadido para el formato exacto de Google

const app = express();
const port = process.env.PORT || 3000;

// Configuración de la base de datos PostgreSQL en la nube
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

// Carpeta estática
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 1. Ruta Institucional
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

// 2. Ruta a Google OAuth
app.get('/auth/google', (req, res) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = 'https://barberia-exelencia.onrender.com/auth/google/callback';
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=email%20profile`;
    res.redirect(googleAuthUrl);
});

// 3. Callback Oficial de Google (Actualizado a Form-UrlEncoded)
app.get('/auth/google/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send('Falta el código de Google.');
    }

    // Convertir los datos al formato exacto que pide Google
    const tokenData = querystring.stringify({
        code: code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'https://barberia-exelencia.onrender.com/auth/google/callback',
        grant_type: 'authorization_code'
    });

    const tokenReq = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': tokenData.length
        }
    }, (tokenRes) => {
        let responseBody = '';
        tokenRes.on('data', (chunk) => { responseBody += chunk; });
        tokenRes.on('end', async () => {
            try {
                const tokenJson = JSON.parse(responseBody);
                const accessToken = tokenJson.access_token;

                if (!accessToken) {
                    console.log("Error de token:", tokenJson); // Para rastreo en Render
                    return res.send('<script>alert("Error de Google. Por favor intenta iniciar sesión de nuevo."); window.location.href="/";</script>');
                }

                // Obtener datos del usuario
                https.get(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${accessToken}`, (userInfoRes) => {
                    let userBody = '';
                    userInfoRes.on('data', (chunk) => { userBody += chunk; });
                    userInfoRes.on('end', async () => {
                        try {
                            const googleUser = JSON.parse(userBody);
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

                            // Redirigir al inicio con sesión activa
                            res.send(`
                                <script>
                                    localStorage.setItem('usuarioActivo', JSON.stringify(${JSON.stringify(usuarioFinal)}));
                                    window.location.href = '/?login=success';
                                </script>
                            `);
                        } catch (err) {
                            res.status(500).send('Error procesando el perfil.');
                        }
                    });
                }).on('error', () => { res.status(500).send('Error conectando con Google.'); });
            } catch (err) {
                res.status(500).send('Error procesando respuesta de autenticación.');
            }
        });
    });

    tokenReq.on('error', () => { res.status(500).send('Error solicitando token.'); });
    tokenReq.write(tokenData);
    tokenReq.end();
});

// 4. Servicios
app.get('/api/servicios', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM servicios;');
        res.json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener servicios' });
    }
});

// 5. Turnos
app.post('/api/turnos', async (req, res) => {
    const { cliente_id, servicios_id, fecha_hora } = req.body;
    try {
        const nuevoTurno = await pool.query(
            'INSERT INTO turnos (clientes_id, servicios_id, fecha_hora, estado) VALUES ($1, $2, $3, $4) RETURNING *',
            [cliente_id, servicios_id, fecha_hora, 'pendiente']
        );
        res.json({ mensaje: '¡Turno reservado!', turno: nuevoTurno.rows });
    } catch (error) {
        res.status(500).json({ error: 'Error al reservar el turno' });
    }
});

app.listen(port, () => {
    console.log(`Servidor de Excelencia corriendo en el puerto ${port}`);
});