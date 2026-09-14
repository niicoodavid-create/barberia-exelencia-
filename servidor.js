const express=require('express');
const {Pool}=require('pg');
const path=require('path');
const app=express();
const port=process.env.PORT||3000;
const ARGENTINA_TIME_ZONE='America/Argentina/Buenos_Aires';
const CLIENT_ID=process.env.GOOGLE_CLIENT_ID?process.env.GOOGLE_CLIENT_ID.trim():'';
const CLIENT_SECRET=process.env.GOOGLE_CLIENT_SECRET?process.env.GOOGLE_CLIENT_SECRET.trim():'';
const GOOGLE_REDIRECT_URI='https://barberia-exelencia.onrender.com/auth/google/callback';
const pool=new Pool({
    connectionString:process.env.DATABASE_URL,
    ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false
});
const CORREO_BARBERO='gamarramartin1995@gmail.com';
const DIRECCION_BARBERIA='Paraguay 176';
const HORAS_LABORALES=[
    '09:00','10:00','11:00','12:00','13:00','14:00',
    '15:00','16:00','17:00','18:00','19:00','20:00'
];

function fechaHoraArgentina(){
    const partes=new Intl.DateTimeFormat('sv-SE',{
        timeZone:ARGENTINA_TIME_ZONE,
        year:'numeric',
        month:'2-digit',
        day:'2-digit',
        hour:'2-digit',
        minute:'2-digit',
        hourCycle:'h23'
    }).formatToParts(new Date());
    const datos=Object.fromEntries(
        partes
            .filter(p=>p.type!=='literal')
            .map(p=>[p.type,p.value])
    );
    return `${datos.year}-${datos.month}-${datos.day} ${datos.hour}:${datos.minute}`;
}

function fechaArgentina(){
    return fechaHoraArgentina().slice(0,10);
}

function esFechaValida(fecha){
    if(typeof fecha!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(fecha))return false;
    const [y,m,d]=fecha.split('-').map(Number);
    const x=new Date(Date.UTC(y,m-1,d));
    return x.getUTCFullYear()===y&&x.getUTCMonth()===m-1&&x.getUTCDate()===d;
}

function esFechaHoraValida(fechaHora){
    if(typeof fechaHora!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(fechaHora))return false;
    const [fecha,hora]=fechaHora.split(' ');
    return esFechaValida(fecha)&&HORAS_LABORALES.includes(hora);
}

async function inicializarBaseDeDatos(){
    try{
        await pool.query(`
            CREATE TABLE IF NOT EXISTS clientes(
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(255),
                email VARCHAR(255) UNIQUE,
                rol VARCHAR(50)
            );
            CREATE TABLE IF NOT EXISTS servicios(
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(255),
                precio NUMERIC
            );
            CREATE TABLE IF NOT EXISTS turnos(
                id SERIAL PRIMARY KEY,
                clientes_id INT REFERENCES clientes(id),
                servicios_id INT REFERENCES servicios(id),
                fecha_hora VARCHAR(100),
                estado VARCHAR(50)
            );
            CREATE TABLE IF NOT EXISTS dias_bloqueados(
                id SERIAL PRIMARY KEY,
                fecha VARCHAR(50) UNIQUE
            );
        `);

        const resServicios=await pool.query('SELECT COUNT(*) FROM servicios');

        if(Number(resServicios.rows[0].count)===0){
            await pool.query(`
                INSERT INTO servicios(nombre,precio)
                VALUES
                    ('Global',50000),
                    ('Mechas',45000),
                    ('Corte',14000),
                    ('Corte y Barba',15000);
            `);
        }

        try{
            await pool.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS
                idx_turnos_fecha_hora_confirmado
                ON turnos(fecha_hora)
                WHERE estado='confirmado';
            `);
        }catch(error){
            if(error.code!=='23505'){
                console.error('No se pudo crear la protección única de turnos:',error.message);
            }
        }
    }catch(error){
        console.error('Error al auto-inicializar la base de datos:',error);
    }
}

app.disable('etag');

app.use(express.json());
app.use(express.urlencoded({extended:true}));

app.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    res.header('Access-Control-Allow-Origin','*');
    res.header('Access-Control-Allow-Headers','Origin, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods','GET, POST, PUT, DELETE');
    next();
});

app.use(express.static(path.join(__dirname)));

app.get('/',(req,res)=>{
    res.sendFile(path.join(__dirname,'index.html'));
});

app.get('/api/configuracion',(req,res)=>{
    res.json({
        nombre:'Barbería Excelencia',
        direccion:DIRECCION_BARBERIA,
        horasLaborales:HORAS_LABORALES
    });
});

app.post('/api/login',async(req,res)=>{
    const {email,nombre}=req.body;

    if(!email||!nombre){
        return res.status(400).json({
            error:'Faltan datos para iniciar sesión.'
        });
    }

    try{
        const existente=await pool.query(
            'SELECT * FROM clientes WHERE email=$1',
            [email]
        );

        if(existente.rows.length){
            return res.json(existente.rows[0]);
        }

        const nuevo=await pool.query(
            'INSERT INTO clientes(nombre,email,rol) VALUES($1,$2,$3) RETURNING *',
            [nombre,email,'cliente']
        );

        res.json(nuevo.rows[0]);
    }catch(error){
        console.error(error);
        res.status(500).json({
            error:'Error en inicio de sesión'
        });
    }
});

app.get('/auth/google',(req,res)=>{
    const url=
        `https://accounts.google.com/o/oauth2/v2/auth`+
        `?client_id=${CLIENT_ID}`+
        `&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}`+
        `&response_type=code`+
        `&scope=email%20profile`;

    res.redirect(url);
});

app.get('/auth/google/callback',async(req,res)=>{
    const code=req.query.code;

    if(!code){
        return res.status(400).send('Falta el código de Google.');
    }

    try{
        const tokenResponse=await fetch(
            'https://oauth2.googleapis.com/token',
            {
                method:'POST',
                headers:{
                    'Content-Type':
                        'application/x-www-form-urlencoded'
                },
                body:new URLSearchParams({
                    code,
                    client_id:CLIENT_ID,
                    client_secret:CLIENT_SECRET,
                    redirect_uri:GOOGLE_REDIRECT_URI,
                    grant_type:'authorization_code'
                })
            }
        );

        const tokenJson=await tokenResponse.json();

        if(!tokenResponse.ok||!tokenJson.access_token){
            return res.status(502).send(
                'No se pudo completar la autenticación con Google.'
            );
        }

        const userResponse=await fetch(
            `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${encodeURIComponent(tokenJson.access_token)}`
        );

        const googleUser=await userResponse.json();

        if(!userResponse.ok||!googleUser.email){
            return res.status(502).send(
                'No se pudo obtener el usuario de Google.'
            );
        }

        const existente=await pool.query(
            'SELECT * FROM clientes WHERE email=$1',
            [googleUser.email]
        );

        let usuarioFinal;

        if(existente.rows.length){
            usuarioFinal=existente.rows[0];
        }else{
            const nuevo=await pool.query(
                'INSERT INTO clientes(nombre,email,rol) VALUES($1,$2,$3) RETURNING *',
                [
                    googleUser.name,
                    googleUser.email,
                    'cliente'
                ]
            );

            usuarioFinal=nuevo.rows[0];
        }

        res.send(`
            <script>
                localStorage.setItem(
                    'usuarioActivo',
                    JSON.stringify(${JSON.stringify(usuarioFinal)})
                );
                window.location.href='/?login=success';
            </script>
        `);
    }catch(error){
        console.error(error);
        res.status(500).send(
            'Error interno procesando la autenticación.'
        );
    }
});

app.get('/api/servicios',async(req,res)=>{
    try{
        const resultado=await pool.query(
            'SELECT * FROM servicios ORDER BY id ASC'
        );

        res.json(resultado.rows);
    }catch(error){
        console.error(error);
        res.status(500).json({
            error:'Error al obtener servicios'
        });
    }
});

app.put('/api/servicios/:id',async(req,res)=>{
    const {id}=req.params;
    const {precio}=req.body;

    if(precio===undefined||precio===''){
        return res.status(400).json({
            error:'Debe indicar un precio.'
        });
    }

    if(Number.isNaN(Number(precio))||Number(precio)<0){
        return res.status(400).json({
            error:'Precio inválido.'
        });
    }

    try{
        const actualizado=await pool.query(
            'UPDATE servicios SET precio=$1 WHERE id=$2 RETURNING *',
            [precio,id]
        );

        if(!actualizado.rows.length){
            return res.status(404).json({
                error:'Servicio no encontrado.'
            });
        }

        res.json({
            mensaje:'Precio actualizado con éxito',
            servicio:actualizado.rows[0]
        });
    }catch(error){
        console.error(error);
        res.status(500).json({
            error:'Error al actualizar el precio'
        });
    }
});

app.get('/api/turnos',async(req,res)=>{
    try{
        const resultado=await pool.query(`
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
                ON turnos.clientes_id=clientes.id
            JOIN servicios
                ON turnos.servicios_id=servicios.id
            ORDER BY turnos.fecha_hora ASC
        `);

        const ahora=fechaHoraArgentina();

        res.json(
            resultado.rows.map(t=>({
                ...t,
                vencido:
                    t.estado==='confirmado'&&
                    t.fecha_hora<=ahora
            }))
        );
    }catch(error){
        console.error(error);
        res.status(500).json({
            error:'Error al obtener turnos'
        });
    }
});

app.post('/api/turnos',async(req,res)=>{
    const {
        cliente_id,
        servicios_id,
        fecha_hora
    }=req.body;

    if(!cliente_id||!servicios_id||!fecha_hora){
        return res.status(400).json({
            error:'Faltan datos para crear el turno.'
        });
    }

    if(!esFechaHoraValida(fecha_hora)){
        return res.status(400).json({
            error:'Fecha u horario inválido.'
        });
    }

    if(fecha_hora<=fechaHoraArgentina()){
        return res.status(400).json({
            error:'No se puede reservar un horario que ya pasó.'
        });
    }

    const fecha=fecha_hora.slice(0,10);
    const client=await pool.connect();

    try{
        await client.query('BEGIN');
        await client.query(
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            [fecha_hora]
        );

        const bloqueado=await client.query(
            'SELECT id FROM dias_bloqueados WHERE fecha=$1',
            [fecha]
        );

        if(bloqueado.rows.length){
            await client.query('ROLLBACK');
            return res.status(400).json({
                error:'La barbería no atiende ese día.'
            });
        }

        const cliente=await client.query(
            'SELECT id FROM clientes WHERE id=$1',
            [cliente_id]
        );

        if(!cliente.rows.length){
            await client.query('ROLLBACK');
            return res.status(404).json({
                error:'Cliente no encontrado.'
            });
        }

        const servicio=await client.query(
            'SELECT id FROM servicios WHERE id=$1',
            [servicios_id]
        );

        if(!servicio.rows.length){
            await client.query('ROLLBACK');
            return res.status(404).json({
                error:'Servicio no encontrado.'
            });
        }

        const ocupado=await client.query(
            `SELECT id
             FROM turnos
             WHERE fecha_hora=$1
             AND estado='confirmado'
             FOR UPDATE`,
            [fecha_hora]
        );

        if(ocupado.rows.length){
            await client.query('ROLLBACK');
            return res.status(409).json({
                error:'Este horario ya se encuentra reservado.'
            });
        }

        const nuevo=await client.query(
            `INSERT INTO turnos(
                clientes_id,
                servicios_id,
                fecha_hora,
                estado
            )
            VALUES($1,$2,$3,$4)
            RETURNING *`,
            [
                cliente_id,
                servicios_id,
                fecha_hora,
                'confirmado'
            ]
        );

        await client.query('COMMIT');

        res.status(201).json({
            mensaje:'¡Turno reservado con éxito!',
            turno:nuevo.rows[0]
        });
    }catch(error){
        try{
            await client.query('ROLLBACK');
        }catch{}

        console.error('Error al reservar turno:',error);

        if(error.code==='23505'){
            return res.status(409).json({
                error:'Este horario acaba de ser reservado por otra persona.'
            });
        }

        res.status(500).json({
            error:'Error al reservar el turno'
        });
    }finally{
        client.release();
    }
});

app.get('/api/dias-bloqueados',async(req,res)=>{
    try{
        const resultado=await pool.query(
            'SELECT fecha FROM dias_bloqueados ORDER BY fecha ASC'
        );

        res.json(
            resultado.rows.map(row=>row.fecha)
        );
    }catch(error){
        console.error(error);
        res.status(500).json({
            error:'Error al obtener días bloqueados'
        });
    }
});

app.post('/api/dias-bloqueados',async(req,res)=>{
    const {fecha}=req.body;

    if(!esFechaValida(fecha)){
        return res.status(400).json({
            error:'Fecha inválida.'
        });
    }

    if(fecha<fechaArgentina()){
        return res.status(400).json({
            error:'No se puede bloquear una fecha pasada.'
        });
    }

    try{
        await pool.query(
            `INSERT INTO dias_bloqueados(fecha)
             VALUES($1)
             ON CONFLICT(fecha) DO NOTHING`,
            [fecha]
        );

        res.json({
            mensaje:'Día bloqueado exitosamente',
            fecha
        });
    }catch(error){
        console.error(error);
        res.status(500).json({
            error:'Error al bloquear día'
        });
    }
});

inicializarBaseDeDatos()
    .then(()=>{
        app.listen(
            port,
            ()=>console.log(
                `Servidor de Excelencia corriendo en el puerto ${port}`
            )
        );
    })
    .catch(error=>{
        console.error(error);
        process.exit(1);
    });