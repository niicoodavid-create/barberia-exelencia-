const express=require('express');
const {Pool}=require('pg');
const path=require('path');
const crypto=require('crypto');
const app=express();
const port=process.env.PORT||3000;
const ARGENTINA_TIME_ZONE='America/Argentina/Buenos_Aires';
const CLIENT_ID=process.env.GOOGLE_CLIENT_ID?process.env.GOOGLE_CLIENT_ID.trim():'';
const CLIENT_SECRET=process.env.GOOGLE_CLIENT_SECRET?process.env.GOOGLE_CLIENT_SECRET.trim():'';
const GOOGLE_REDIRECT_URI='https://barberia-exelencia.onrender.com/auth/google/callback';
const ADMIN_SESSION_SECRET=process.env.ADMIN_SESSION_SECRET||CLIENT_SECRET;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});
const CORREO_BARBERO='gamarramartin1995@gmail.com';
const DIRECCION_BARBERIA='Paraguay 176';
const MAX_DIAS=14;
const HORAS_LABORALES=['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00'];

function fechaHoraArgentina(){
    const p=new Intl.DateTimeFormat('sv-SE',{timeZone:ARGENTINA_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
    const v=Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
    return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}`;
}
function fechaArgentina(){return fechaHoraArgentina().slice(0,10)}
function fechaMasDias(n){
    const d=new Date(`${fechaArgentina()}T00:00:00`);
    d.setDate(d.getDate()+n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function diasEntre(a,b){return Math.round((new Date(`${b}T00:00:00`)-new Date(`${a}T00:00:00`))/86400000)}
function esDentroVentana(fecha){
    const d=diasEntre(fechaArgentina(),fecha);
    return d>=0&&d<=MAX_DIAS;
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
function firmar(valor){
    return crypto.createHmac('sha256',ADMIN_SESSION_SECRET).update(valor).digest('hex');
}
function crearTokenAdmin(email){
    const valor=`${email.toLowerCase()}.${Date.now()}`;
    return Buffer.from(`${valor}.${firmar(valor)}`).toString('base64url');
}
function validarTokenAdmin(token){
    try{
        const valor=Buffer.from(token,'base64url').toString();
        const partes=valor.split('.');
        if(partes.length<3)return false;
        const firma=partes.pop();
        const email=partes.shift();
        const timestamp=Number(partes.shift());
        if(!email||!Number.isFinite(timestamp)||Date.now()-timestamp>43200000)return false;
        const esperado=firmar(`${email}.${timestamp}`);
        return email.toLowerCase()===CORREO_BARBERO&&crypto.timingSafeEqual(Buffer.from(firma),Buffer.from(esperado));
    }catch{return false}
}
function requiereAdmin(req,res,next){
    const cookies=String(req.headers.cookie||'').split(';').map(x=>x.trim());
    const token=cookies.find(x=>x.startsWith('admin_session='))?.split('=')[1];
    if(!token||!validarTokenAdmin(token))return res.status(403).json({error:'Acceso de administrador requerido.'});
    next();
}
async function inicializarBaseDeDatos(){
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
    const s=await pool.query('SELECT COUNT(*) FROM servicios');
    if(Number(s.rows[0].count)===0)await pool.query(`INSERT INTO servicios(nombre,precio) VALUES('Global',50000),('Mechas',45000),('Corte',14000),('Corte y Barba',15000)`);
    await pool.query('DROP INDEX IF EXISTS idx_turnos_fecha_hora_unica');
    try{
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_fecha_hora_confirmado ON turnos(fecha_hora) WHERE estado='confirmado'`);
    }catch(e){
        if(e.code!=='23505')console.error('Índice de turnos:',e.message);
    }
}
app.disable('etag');
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    res.header('Access-Control-Allow-Origin',req.headers.origin||'*');
    res.header('Access-Control-Allow-Headers','Origin, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods','GET, POST, PUT, DELETE');
    res.header('Access-Control-Allow-Credentials','true');
    next();
});
app.use(express.static(path.join(__dirname)));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));

app.post('/api/login',async(req,res)=>{
    const {email,nombre}=req.body;
    if(!email||!nombre)return res.status(400).json({error:'Faltan datos para iniciar sesión.'});
    const emailNormalizado=String(email).trim().toLowerCase();
    if(emailNormalizado===CORREO_BARBERO)return res.status(403).json({error:'El administrador debe ingresar con Google.'});
    try{
        const existente=await pool.query('SELECT * FROM clientes WHERE email=$1',[emailNormalizado]);
        if(existente.rows.length)return res.json(existente.rows[0]);
        const nuevo=await pool.query('INSERT INTO clientes(nombre,email,rol) VALUES($1,$2,$3) RETURNING *',[nombre,emailNormalizado,'cliente']);
        res.json(nuevo.rows[0]);
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error en inicio de sesión'});
    }
});

app.get('/auth/google',(req,res)=>{
    const url='https://accounts.google.com/o/oauth2/v2/auth'+`?client_id=${CLIENT_ID}`+`&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}`+'&response_type=code&scope=email%20profile';
    res.redirect(url);
});

app.get('/auth/google/callback',async(req,res)=>{
    const code=req.query.code;
    if(!code)return res.status(400).send('Falta el código de Google.');
    try{
        const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{
            method:'POST',
            headers:{'Content-Type':'application/x-www-form-urlencoded'},
            body:new URLSearchParams({code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:GOOGLE_REDIRECT_URI,grant_type:'authorization_code'})
        });
        const tokenJson=await tokenResponse.json();
        if(!tokenResponse.ok||!tokenJson.access_token)return res.status(502).send('No se pudo completar la autenticación con Google.');
        const userResponse=await fetch(`https://www.googleapis.com/oauth2/v3/userinfo?access_token=${encodeURIComponent(tokenJson.access_token)}`);
        const googleUser=await userResponse.json();
        if(!userResponse.ok||!googleUser.email)return res.status(502).send('No se pudo obtener el usuario de Google.');
        const email=googleUser.email.trim().toLowerCase();
        const esBarbero=email===CORREO_BARBERO;
        const existente=await pool.query('SELECT * FROM clientes WHERE email=$1',[email]);
        let usuarioFinal;
        if(existente.rows.length){
            const actualizado=await pool.query('UPDATE clientes SET rol=$1 WHERE id=$2 RETURNING *',[esBarbero?'barbero':existente.rows[0].rol,existente.rows[0].id]);
            usuarioFinal=actualizado.rows[0];
        }else{
            const nuevo=await pool.query('INSERT INTO clientes(nombre,email,rol) VALUES($1,$2,$3) RETURNING *',[googleUser.name,email,esBarbero?'barbero':'cliente']);
            usuarioFinal=nuevo.rows[0];
        }
        if(esBarbero){
            const token=crearTokenAdmin(email);
            res.setHeader('Set-Cookie',`admin_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
        }
        res.send(`<script>localStorage.setItem('usuarioActivo',JSON.stringify(${JSON.stringify(usuarioFinal)}));location.href='/?login=success';</script>`);
    }catch(e){
        console.error(e);
        res.status(500).send('Error interno procesando la autenticación.');
    }
});

app.get('/api/clientes',requiereAdmin,async(req,res)=>{
    try{
        const r=await pool.query('SELECT id,nombre,email,rol FROM clientes ORDER BY nombre ASC');
        res.json(r.rows);
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al obtener clientes'});
    }
});

app.get('/api/configuracion',(req,res)=>{
    res.json({nombre:'Excelencia',direccion:DIRECCION_BARBERIA,horasLaborales:HORAS_LABORALES,maxDias:MAX_DIAS});
});

app.get('/api/servicios',async(req,res)=>{
    try{
        const r=await pool.query('SELECT * FROM servicios ORDER BY id ASC');
        res.json(r.rows);
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al obtener servicios'});
    }
});

app.post('/api/admin/servicios',requiereAdmin,async(req,res)=>{
    const {nombre,precio}=req.body;
    const p=Number(precio);
    if(!nombre||String(nombre).trim()===''||!Number.isFinite(p)||p<0)return res.status(400).json({error:'Nombre o precio inválido.'});
    try{
        const r=await pool.query('INSERT INTO servicios(nombre,precio) VALUES($1,$2) RETURNING *',[String(nombre).trim(),p]);
        res.status(201).json({servicio:r.rows[0]});
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al crear servicio'});
    }
});

app.put('/api/admin/servicios/:id',requiereAdmin,async(req,res)=>{
    const {id}=req.params;
    const {nombre,precio}=req.body;
    try{
        const actual=await pool.query('SELECT * FROM servicios WHERE id=$1',[id]);
        if(!actual.rows.length)return res.status(404).json({error:'Servicio no encontrado.'});
        const n=nombre===undefined?actual.rows[0].nombre:String(nombre).trim();
        const p=precio===undefined?actual.rows[0].precio:Number(precio);
        if(!n||!Number.isFinite(Number(p))||Number(p)<0)return res.status(400).json({error:'Datos inválidos.'});
        const r=await pool.query('UPDATE servicios SET nombre=$1,precio=$2 WHERE id=$3 RETURNING *',[n,p,id]);
        res.json({servicio:r.rows[0]});
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al actualizar servicio'});
    }
});

app.get('/api/turnos',async(req,res)=>{
    try{
        const r=await pool.query(`
            SELECT
                turnos.id,
                turnos.fecha_hora,
                turnos.estado,
                turnos.clientes_id,
                turnos.servicios_id,
                clientes.nombre AS cliente,
                servicios.nombre AS servicio
            FROM turnos
            JOIN clientes ON turnos.clientes_id=clientes.id
            JOIN servicios ON turnos.servicios_id=servicios.id
            ORDER BY turnos.fecha_hora ASC
        `);
        const ahora=fechaHoraArgentina();
        res.json(r.rows.map(t=>({...t,vencido:t.estado==='confirmado'&&t.fecha_hora<=ahora})));
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al obtener turnos'});
    }
});

async function procesarNuevoTurno({cliente_id,servicios_id,fecha_hora}){
    if(!cliente_id||!servicios_id||!fecha_hora)return {status:400,data:{error:'Faltan datos para crear el turno.'}};
    if(!esFechaHoraValida(fecha_hora))return {status:400,data:{error:'Fecha u horario inválido.'}};
    if(!esDentroVentana(fecha_hora.slice(0,10)))return {status:400,data:{error:'Solo se pueden reservar los próximos 14 días.'}};
    if(fecha_hora<=fechaHoraArgentina())return {status:400,data:{error:'No se puede reservar un horario que ya pasó.'}};
    const fecha=fecha_hora.slice(0,10);
    const client=await pool.connect();
    try{
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[fecha_hora]);
        const bloqueado=await client.query('SELECT id FROM dias_bloqueados WHERE fecha=$1',[fecha]);
        if(bloqueado.rows.length){
            await client.query('ROLLBACK');
            return {status:400,data:{error:'La barbería no atiende ese día.'}};
        }
        const cliente=await client.query('SELECT id FROM clientes WHERE id=$1',[cliente_id]);
        if(!cliente.rows.length){
            await client.query('ROLLBACK');
            return {status:404,data:{error:'Cliente no encontrado.'}};
        }
        const servicio=await client.query('SELECT id FROM servicios WHERE id=$1',[servicios_id]);
        if(!servicio.rows.length){
            await client.query('ROLLBACK');
            return {status:404,data:{error:'Servicio no encontrado.'}};
        }
        const ocupado=await client.query(`SELECT id FROM turnos WHERE fecha_hora=$1 AND estado='confirmado' LIMIT 1`,[fecha_hora]);
        if(ocupado.rows.length){
            await client.query('ROLLBACK');
            return {status:409,data:{error:'Este horario ya se encuentra reservado.'}};
        }
        const nuevo=await client.query(`INSERT INTO turnos(clientes_id,servicios_id,fecha_hora,estado) VALUES($1,$2,$3,'confirmado') RETURNING *`,[cliente_id,servicios_id,fecha_hora]);
        await client.query('COMMIT');
        return {status:201,data:{mensaje:'¡Turno reservado con éxito!',turno:nuevo.rows[0]}};
    }catch(e){
        try{await client.query('ROLLBACK')}catch{}
        if(e.code==='23505')return {status:409,data:{error:'Este horario acaba de ser reservado por otra persona.'}};
        throw e;
    }finally{client.release()}
}

app.post('/api/turnos',async(req,res)=>{
    try{
        const r=await procesarNuevoTurno(req.body);
        res.status(r.status).json(r.data);
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al reservar el turno'});
    }
});

app.post('/api/admin/turnos',requiereAdmin,async(req,res)=>{
    try{
        const r=await procesarNuevoTurno(req.body);
        res.status(r.status).json(r.data);
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al agregar el turno'});
    }
});

app.put('/api/admin/turnos/:id',requiereAdmin,async(req,res)=>{
    const {id}=req.params;
    const {cliente_id,servicios_id,fecha_hora}=req.body;
    if(!cliente_id||!servicios_id||!fecha_hora)return res.status(400).json({error:'Faltan datos para editar el turno.'});
    if(!esFechaHoraValida(fecha_hora))return res.status(400).json({error:'Fecha u horario inválido.'});
    if(!esDentroVentana(fecha_hora.slice(0,10)))return res.status(400).json({error:'Solo se pueden organizar los próximos 14 días.'});
    if(fecha_hora<=fechaHoraArgentina())return res.status(400).json({error:'No se puede asignar un horario que ya pasó.'});
    const client=await pool.connect();
    try{
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[fecha_hora]);
        const turno=await client.query('SELECT * FROM turnos WHERE id=$1 FOR UPDATE',[id]);
        if(!turno.rows.length){
            await client.query('ROLLBACK');
            return res.status(404).json({error:'Turno no encontrado.'});
        }
        const fecha=fecha_hora.slice(0,10);
        const bloqueado=await client.query('SELECT id FROM dias_bloqueados WHERE fecha=$1',[fecha]);
        if(bloqueado.rows.length){
            await client.query('ROLLBACK');
            return res.status(400).json({error:'La barbería no atiende ese día.'});
        }
        const ocupado=await client.query(`SELECT id FROM turnos WHERE fecha_hora=$1 AND estado='confirmado' AND id<>$2 LIMIT 1`,[fecha_hora,id]);
        if(ocupado.rows.length){
            await client.query('ROLLBACK');
            return res.status(409).json({error:'El nuevo horario ya está ocupado.'});
        }
        const cliente=await client.query('SELECT id FROM clientes WHERE id=$1',[cliente_id]);
        const servicio=await client.query('SELECT id FROM servicios WHERE id=$1',[servicios_id]);
        if(!cliente.rows.length||!servicio.rows.length){
            await client.query('ROLLBACK');
            return res.status(404).json({error:'Cliente o servicio no encontrado.'});
        }
        const actualizado=await client.query(`UPDATE turnos SET clientes_id=$1,servicios_id=$2,fecha_hora=$3,estado='confirmado' WHERE id=$4 RETURNING *`,[cliente_id,servicios_id,fecha_hora,id]);
        await client.query('COMMIT');
        res.json({turno:actualizado.rows[0]});
    }catch(e){
        try{await client.query('ROLLBACK')}catch{}
        if(e.code==='23505')return res.status(409).json({error:'El nuevo horario ya está ocupado.'});
        console.error(e);
        res.status(500).json({error:'Error al editar el turno'});
    }finally{client.release()}
});

app.delete('/api/admin/turnos/:id',requiereAdmin,async(req,res)=>{
    try{
        const r=await pool.query(`UPDATE turnos SET estado='cancelado' WHERE id=$1 RETURNING *`,[req.params.id]);
        if(!r.rows.length)return res.status(404).json({error:'Turno no encontrado.'});
        res.json({mensaje:'Turno cancelado correctamente',turno:r.rows[0]});
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al cancelar el turno'});
    }
});

app.get('/api/dias-bloqueados',async(req,res)=>{
    try{
        const r=await pool.query('SELECT fecha FROM dias_bloqueados ORDER BY fecha ASC');
        res.json(r.rows.map(x=>x.fecha));
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al obtener días bloqueados'});
    }
});

app.post('/api/admin/dias-bloqueados',requiereAdmin,async(req,res)=>{
    const {fecha}=req.body;
    if(!esFechaValida(fecha))return res.status(400).json({error:'Fecha inválida.'});
    if(!esDentroVentana(fecha))return res.status(400).json({error:'Solo puedes organizar los próximos 14 días.'});
    try{
        await pool.query('INSERT INTO dias_bloqueados(fecha) VALUES($1) ON CONFLICT(fecha) DO NOTHING',[fecha]);
        res.json({mensaje:'Día marcado como no disponible',fecha});
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al marcar el día'});
    }
});

app.delete('/api/admin/dias-bloqueados/:fecha',requiereAdmin,async(req,res)=>{
    const {fecha}=req.params;
    if(!esFechaValida(fecha))return res.status(400).json({error:'Fecha inválida.'});
    try{
        const r=await pool.query('DELETE FROM dias_bloqueados WHERE fecha=$1 RETURNING *',[fecha]);
        if(!r.rows.length)return res.status(404).json({error:'Ese día no estaba bloqueado.'});
        res.json({mensaje:'Día disponible nuevamente',fecha});
    }catch(e){
        console.error(e);
        res.status(500).json({error:'Error al habilitar el día'});
    }
});

app.post('/api/logout-admin',(req,res)=>{
    res.setHeader('Set-Cookie','admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ok:true});
});

inicializarBaseDeDatos().then(()=>{
    app.listen(port,()=>console.log(`Servidor de Excelencia corriendo en el puerto ${port}`));
}).catch(e=>{
    console.error(e);
    process.exit(1);
});