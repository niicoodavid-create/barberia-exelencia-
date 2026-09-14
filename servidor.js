const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ======================================================
// CONFIGURACIÓN GOOGLE
// ======================================================

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID
    ? process.env.GOOGLE_CLIENT_ID.trim()
    : '';

const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
    ? process.env.GOOGLE_CLIENT_SECRET.trim()
    : '';

const GOOGLE_REDIRECT_URI =
    'https://barberia-exelencia.onrender.com/auth/google/callback';


// ======================================================
// BASE DE DATOS
// ======================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});


// ======================================================
// DATOS DEL NEGOCIO
// ======================================================

const CORREO_BARBERO = 'gamarramartin1995@gmail.com';

const DIRECCION_BARBERIA = 'Paraguay 176';

const HORAS_LABORALES = [
    '09:00',
    '10:00',
    '11:00',
    '12:00',
    '13:00',
    '14:00',
    '15:00',
    '16:00',
    '17:00',
    '18:00',
    '19:00',
    '20:00'
];


// ======================================================
// INICIALIZACIÓN DE BASE DE DATOS
// ======================================================

async function inicializarBaseDeDatos() {

    try {

        await pool.query(`

            CREATE TABLE IF NOT EXISTS clientes (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(255),
                email VARCHAR(255) UNIQUE,
                rol VARCHAR(50)
            );

            CREATE TABLE IF NOT EXISTS servicios (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(255),
                precio NUMERIC
            );

            CREATE TABLE IF NOT EXISTS turnos (
                id SERIAL PRIMARY KEY,
                clientes_id INT REFERENCES clientes(id),
                servicios_id INT REFERENCES servicios(id),
                fecha_hora VARCHAR(100),
                estado VARCHAR(50)
            );

            CREATE TABLE IF NOT EXISTS dias_bloqueados (
                id SERIAL PRIMARY KEY,
                fecha VARCHAR(50) UNIQUE
            );

        `);


        // ==================================================
        // SERVICIOS INICIALES
        // ==================================================

        const resServicios = await pool.query(
            'SELECT COUNT(*) FROM servicios'
        );

        if (parseInt(resServicios.rows[0].count) === 0) {

            await pool.query(`
                INSERT INTO servicios (nombre, precio)
                VALUES
                    ('Global', 50000),
                    ('Mechas', 45000),
                    ('Corte', 14000),
                    ('Corte y Barba', 15000);
            `);

        }


        // ==================================================
        // PROTECCIÓN CONTRA DOBLE RESERVA
        // ==================================================
        //
        // IMPORTANTE:
        // NO elimina ningún turno existente.
        //
        // Simplemente impide que PostgreSQL permita
        // dos turnos exactamente en la misma fecha/hora.
        //

        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            idx_turnos_fecha_hora_unica
            ON turnos (fecha_hora);
        `);


        console.log(
            '¡Tablas y base de datos de Excelencia listas y operativas!'
        );

        console.log(
            `Dirección configurada: ${DIRECCION_BARBERIA}`
        );

    } catch (err) {

        console.error(
            'Error al auto-inicializar la base de datos:',
            err
        );

    }
}

inicializarBaseDeDatos();


// ======================================================
// MIDDLEWARE
// ======================================================

app.use(express.json());

app.use(
    express.urlencoded({
        extended: true
    })
);


app.use((req, res, next) => {

    res.header(
        'Access-Control-Allow-Origin',
        '*'
    );

    res.header(
        'Access-Control-Allow-Headers',
        'Origin, Content-Type, Accept'
    );

    res.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE'
    );

    next();

});


app.use(
    express.static(
        path.join(__dirname)
    )
);


// ======================================================
// PÁGINA PRINCIPAL
// ======================================================

app.get('/', (req, res) => {

    res.sendFile(
        path.join(__dirname, 'index.html')
    );

});


// ======================================================
// INFORMACIÓN DE LA BARBERÍA
// ======================================================

app.get('/api/configuracion', (req, res) => {

    res.json({

        nombre: 'Barbería Excelencia',

        direccion: DIRECCION_BARBERIA,

        horasLaborales: HORAS_LABORALES

    });

});


// ======================================================
// 1. LOGIN TRADICIONAL
// ======================================================

app.post('/api/login', async (req, res) => {

    const { email, nombre } = req.body;

    if (!email || !nombre) {

        return res.status(400).json({
            error: 'Faltan datos para iniciar sesión.'
        });

    }

    try {

        let usuarioExistente = await pool.query(
            'SELECT * FROM clientes WHERE email = $1',
            [email]
        );


        if (usuarioExistente.rows.length > 0) {

            res.json(
                usuarioExistente.rows[0]
            );

        } else {

            const nuevoUsuario = await pool.query(

                `
                INSERT INTO clientes
                (nombre, email, rol)
                VALUES ($1, $2, $3)
                RETURNING *
                `,

                [
                    nombre,
                    email,
                    'cliente'
                ]

            );

            res.json(
                nuevoUsuario.rows[0]
            );

        }

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: 'Error en inicio de sesión'
        });

    }

});


// ======================================================
// 2. GOOGLE OAUTH
// ======================================================

app.get('/auth/google', (req, res) => {

    const googleAuthUrl =
        `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=email%20profile`;

    res.redirect(googleAuthUrl);

});


app.get('/auth/google/callback', async (req, res) => {

    const code = req.query.code;

    if (!code) {

        return res
            .status(400)
            .send('Falta el código de Google.');

    }

    try {

        const tokenResponse = await fetch(
            'https://oauth2.googleapis.com/token',
            {

                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/x-www-form-urlencoded'
                },

                body: new URLSearchParams({

                    code: code,

                    client_id: CLIENT_ID,

                    client_secret: CLIENT_SECRET,

                    redirect_uri: GOOGLE_REDIRECT_URI,

                    grant_type: 'authorization_code'

                })

            }
        );


        const tokenJson =
            await tokenResponse.json();


        if (!tokenJson.access_token) {

            return res.send(`
                <div style="
                    padding:40px;
                    background:#0b0b0b;
                    color:#fff;
                    font-family:Arial;
                ">

                    <h2>Error de Google</h2>

                    <pre>
${JSON.stringify(tokenJson, null, 2)}
                    </pre>

                </div>
            `);

        }


        const userResponse = await fetch(

            `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${tokenJson.access_token}`

        );


        const googleUser =
            await userResponse.json();


        const email =
            googleUser.email;

        const nombre =
            googleUser.name;


        let usuarioExistente =
            await pool.query(

                'SELECT * FROM clientes WHERE email = $1',

                [email]

            );


        let usuarioFinal;


        if (usuarioExistente.rows.length > 0) {

            usuarioFinal =
                usuarioExistente.rows[0];

        } else {

            const nuevoUsuario =
                await pool.query(

                    `
                    INSERT INTO clientes
                    (nombre, email, rol)
                    VALUES ($1, $2, $3)
                    RETURNING *
                    `,

                    [
                        nombre,
                        email,
                        'cliente'
                    ]

                );

            usuarioFinal =
                nuevoUsuario.rows[0];

        }


        res.send(`

            <script>

                localStorage.setItem(
                    'usuarioActivo',
                    JSON.stringify(
                        ${JSON.stringify(usuarioFinal)}
                    )
                );

                window.location.href =
                    '/?login=success';

            </script>

        `);


    } catch (err) {

        console.error(err);

        res.status(500).send(
            `Error interno procesando la autenticación: ${err.message}`
        );

    }

});


// ======================================================
// 3. OBTENER SERVICIOS
// ======================================================

app.get('/api/servicios', async (req, res) => {

    try {

        const resultado =
            await pool.query(
                'SELECT * FROM servicios ORDER BY id ASC'
            );

        res.json(
            resultado.rows
        );

    } catch (error) {

        console.error(error);

        res.status(500).json({
            error: 'Error al obtener servicios'
        });

    }

});


// ======================================================
// 4. ACTUALIZAR PRECIOS
// ======================================================

app.put('/api/servicios/:id', async (req, res) => {

    const { id } =
        req.params;

    const { precio } =
        req.body;


    if (precio === undefined || precio === '') {

        return res.status(400).json({
            error: 'Debe indicar un precio.'
        });

    }


    try {

        const actualizado =
            await pool.query(

                `
                UPDATE servicios
                SET precio = $1
                WHERE id = $2
                RETURNING *
                `,

                [
                    precio,
                    id
                ]

            );


        if (actualizado.rows.length === 0) {

            return res.status(404).json({
                error: 'Servicio no encontrado.'
            });

        }


        res.json({

            mensaje:
                'Precio actualizado con éxito',

            servicio:
                actualizado.rows[0]

        });


    } catch (error) {

        console.error(error);

        res.status(500).json({
            error:
                'Error al actualizar el precio'
        });

    }

});


// ======================================================
// 5. OBTENER TURNOS
// ======================================================

app.get('/api/turnos', async (req, res) => {

    try {

        const resultado =
            await pool.query(`

                SELECT

                    turnos.id,

                    turnos.fecha_hora,

                    turnos.estado,

                    turnos.clientes_id,

                    turnos.servicios_id,

                    clientes.nombre AS cliente,

                    servicios.nombre AS servicio

                FROM turnos

                JOIN clientes
                    ON turnos.clientes_id = clientes.id

                JOIN servicios
                    ON turnos.servicios_id = servicios.id

                ORDER BY turnos.fecha_hora ASC;

            `);


        res.json(
            resultado.rows
        );


    } catch (error) {

        console.error(error);

        res.status(500).json({
            error:
                'Error al obtener turnos'
        });

    }

});


// ======================================================
// 6. CREAR TURNO
// ======================================================

app.post('/api/turnos', async (req, res) => {

    const {
        cliente_id,
        servicios_id,
        fecha_hora
    } = req.body;


    // ==================================================
    // VALIDACIÓN BÁSICA
    // ==================================================

    if (
        !cliente_id ||
        !servicios_id ||
        !fecha_hora
    ) {

        return res.status(400).json({
            error:
                'Faltan datos para crear el turno.'
        });

    }


    try {

        // ==================================================
        // VALIDAR FORMATO
        // ==================================================

        const formato =
            /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

        const partes =
            fecha_hora.match(formato);


        if (!partes) {

            return res.status(400).json({
                error:
                    'Formato de fecha inválido.'
            });

        }


        const anio =
            Number(partes[1]);

        const mes =
            Number(partes[2]);

        const dia =
            Number(partes[3]);

        const hora =
            Number(partes[4]);

        const minuto =
            Number(partes[5]);


        // ==================================================
        // VALIDAR HORA LABORAL
        // ==================================================

        const horaNormalizada =
            `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`;


        if (
            !HORAS_LABORALES.includes(
                horaNormalizada
            )
        ) {

            return res.status(400).json({
                error:
                    'Ese horario no pertenece al horario laboral.'
            });

        }


        // ==================================================
        // FECHA/HORA REAL
        // ==================================================

        const fechaTurno =
            new Date(
                anio,
                mes - 1,
                dia,
                hora,
                minuto,
                0,
                0
            );


        if (
            Number.isNaN(
                fechaTurno.getTime()
            )
        ) {

            return res.status(400).json({
                error:
                    'Fecha inválida.'
            });

        }


        // ==================================================
        // IMPEDIR TURNOS PASADOS
        // ==================================================

        const ahora =
            new Date();


        if (
            fechaTurno <= ahora
        ) {

            return res.status(400).json({
                error:
                    'No se puede reservar un horario que ya pasó.'
            });

        }


        // ==================================================
        // VERIFICAR DÍA BLOQUEADO
        // ==================================================

        const fechaTexto =
            `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;


        const diaBloqueado =
            await pool.query(

                `
                SELECT id
                FROM dias_bloqueados
                WHERE fecha = $1
                `,

                [fechaTexto]

            );


        if (
            diaBloqueado.rows.length > 0
        ) {

            return res.status(400).json({
                error:
                    'La barbería no atiende ese día.'
            });

        }


        // ==================================================
        // VERIFICAR QUE EXISTA EL CLIENTE
        // ==================================================

        const cliente =
            await pool.query(

                `
                SELECT id
                FROM clientes
                WHERE id = $1
                `,

                [cliente_id]

            );


        if (
            cliente.rows.length === 0
        ) {

            return res.status(404).json({
                error:
                    'Cliente no encontrado.'
            });

        }


        // ==================================================
        // VERIFICAR QUE EXISTA EL SERVICIO
        // ==================================================

        const servicio =
            await pool.query(

                `
                SELECT id
                FROM servicios
                WHERE id = $1
                `,

                [servicios_id]

            );


        if (
            servicio.rows.length === 0
        ) {

            return res.status(404).json({
                error:
                    'Servicio no encontrado.'
            });

        }


        // ==================================================
        // VERIFICAR SI YA ESTÁ OCUPADO
        // ==================================================

        const ocupado =
            await pool.query(

                `
                SELECT id
                FROM turnos
                WHERE fecha_hora = $1
                `,

                [fecha_hora]

            );


        if (
            ocupado.rows.length > 0
        ) {

            return res.status(409).json({
                error:
                    'Este horario ya se encuentra reservado.'
            });

        }


        // ==================================================
        // CREAR TURNO
        // ==================================================

        const nuevoTurno =
            await pool.query(

                `
                INSERT INTO turnos
                (
                    clientes_id,
                    servicios_id,
                    fecha_hora,
                    estado
                )

                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4
                )

                RETURNING *
                `,

                [
                    cliente_id,
                    servicios_id,
                    fecha_hora,
                    'confirmado'
                ]

            );


        res.status(201).json({

            mensaje:
                '¡Turno reservado con éxito!',

            turno:
                nuevoTurno.rows[0]

        });


    } catch (error) {

        console.error(
            'Error al reservar turno:',
            error
        );


        // ==================================================
        // ERROR DE DOBLE RESERVA
        // ==================================================

        if (
            error.code === '23505'
        ) {

            return res.status(409).json({
                error:
                    'Este horario acaba de ser reservado por otra persona.'
            });

        }


        res.status(500).json({
            error:
                'Error al reservar el turno'
        });

    }

});


// ======================================================
// 7. DÍAS BLOQUEADOS
// ======================================================

app.get('/api/dias-bloqueados', async (req, res) => {

    try {

        const resultado =
            await pool.query(

                `
                SELECT fecha
                FROM dias_bloqueados
                ORDER BY fecha ASC
                `

            );


        res.json(

            resultado.rows.map(
                row => row.fecha
            )

        );


    } catch (error) {

        console.error(error);

        res.status(500).json({
            error:
                'Error al obtener días bloqueados'
        });

    }

});


app.post('/api/dias-bloqueados', async (req, res) => {

    const { fecha } =
        req.body;


    if (!fecha) {

        return res.status(400).json({
            error:
                'Debe indicar una fecha.'
        });

    }


    try {

        await pool.query(

            `
            INSERT INTO dias_bloqueados
            (fecha)

            VALUES ($1)

            ON CONFLICT (fecha)
            DO NOTHING
            `,

            [fecha]

        );


        res.json({

            mensaje:
                'Día bloqueado exitosamente',

            fecha:
                fecha

        });


    } catch (error) {

        console.error(error);

        res.status(500).json({
            error:
                'Error al bloquear día'
        });

    }

});


// ======================================================
// SERVIDOR
// ======================================================

app.listen(port, () => {

    console.log(
        `Servidor de Excelencia corriendo en el puerto ${port}`
    );

});