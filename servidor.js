const express=require('express');
const {Pool}=require('pg');
const path=require('path');
const crypto=require('crypto');
const app=express();
const port=process.env.PORT||3000;
const ARGENTINA_TIME_ZONE='America/Argentina/Buenos_Aires';
const HORAS_LABORALES=['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00'];
const CLIENT_ID=(process.env.GOOGLE_CLIENT_ID||'').trim();
const CLIENT_SECRET=(process.env.GOOGLE_CLIENT_SECRET||'').trim();
const ADMIN_EMAIL='gamarramartin1995@gmail.com';
const GOOGLE_REDIRECT_URI='https://barberia-exelencia.onrender.com/auth/google/callback';
const ADMIN_SESSION_SECRET=(process.env.ADMIN_SESSION_SECRET||CLIENT_SECRET||'excelencia-admin-secret').trim();
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});

function fechaHoraArgentina(){
 const p=new Intl.DateTimeFormat('sv-SE',{timeZone:ARGENTINA_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
 const o=Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 return `${o.year}-${o.month}-${o.day} ${o.hour}:${o.minute}`;
}

function fechaArgentina(){
 return fechaHoraArgentina().slice(0,10);
}

function fechaMasDias(n){
 const d=new Date(`${fechaArgentina()}T00:00:00`);
 d.setDate(d.getDate()+n);
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function esFechaValida(f){
 if(typeof f!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(f))return false;
 const[a,m,d]=f.split('-').map(Number);
 const x=new Date(Date.UTC(a,m-1,d));
 return x.getUTCFullYear()===a&&x.getUTCMonth()===m-1&&x.getUTCDate()===d;
}

function esFechaHoraValida(v){
 if(typeof v!=='string')return false;
 const m=v.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
 return !!m&&esFechaValida(m[1])&&HORAS_LABORALES.includes(m[2]);
}

function turnoVencido(v){
 return v<=fechaHoraArgentina();
}

function firmarAdmin(){
 const exp=Math.floor(Date.now()/1000)+43200;
 const raw=`${ADMIN_EMAIL}.${exp}`;
 const sig=crypto.createHmac('sha256',ADMIN_SESSION_SECRET).update(raw).digest('hex');
 return `${ADMIN_EMAIL}.${exp}.${sig}`;
}

function firmarUsuario(id){
 const exp=Math.floor(Date.now()/1000)+2592000;
 const raw=`${id}.${exp}`;
 const sig=crypto.createHmac('sha256',ADMIN_SESSION_SECRET).update(raw).digest('hex');
 return `${id}.${exp}.${sig}`;
}

function usuarioIdDeCookie(req){
 const c=req.headers.cookie||'';
 const m=c.match(/(?:^|;\s*)cliente_session=([^;]+)/);
 if(!m)return null;
 const p=decodeURIComponent(m[1]).split('.');
 if(p.length!==3)return null;
 const[id,exp,sig]=p;
 if(!/^\d+$/.test(id)||Number(exp)<Math.floor(Date.now()/1000))return null;
 const e=crypto.createHmac('sha256',ADMIN_SESSION_SECRET).update(`${id}.${exp}`).digest('hex');
 if(sig.length!==e.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(e)))return null;
 return Number(id);
}

function requiereCliente(req,res,next){
 const id=usuarioIdDeCookie(req);
 if(!id)return res.status(401).json({error:'La sesión no es válida. Ingresá nuevamente.'});
 req.clienteId=id;
 next();
}

function cookieCliente(id){
 return `cliente_session=${encodeURIComponent(firmarUsuario(id))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}

function verificarAdmin(req){
 const c=req.headers.cookie||'';
 const match=c.match(/(?:^|;\s*)admin_session=([^;]+)/);
 if(!match)return false;
 const parts=decodeURIComponent(match[1]).split('.');
 if(parts.length!==3)return false;
 const[email,exp,sig]=parts;
 if(email!==ADMIN_EMAIL||Number(exp)<Math.floor(Date.now()/1000))return false;
 const expected=crypto.createHmac('sha256',ADMIN_SESSION_SECRET).update(`${email}.${exp}`).digest('hex');
 return sig.length===expected.length&&crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected));
}

function requiereAdmin(req,res,next){
 if(!verificarAdmin(req))return res.status(403).json({error:'Acceso exclusivo del barbero administrador.'});
 next();
}

function nombreCapitalizado(nombre){
 const v=String(nombre||'').trim().replace(/\s+/g,' ');
 return v?v.charAt(0).toUpperCase()+v.slice(1).toLowerCase():'Cliente';
}

async function iniciarBD(){
 await pool.query(`CREATE TABLE IF NOT EXISTS clientes (id SERIAL PRIMARY KEY,nombre VARCHAR(255),email VARCHAR(255) UNIQUE,rol VARCHAR(50))`);
 await pool.query(`CREATE TABLE IF NOT EXISTS servicios (id SERIAL PRIMARY KEY,nombre VARCHAR(255),precio NUMERIC)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS turnos (id SERIAL PRIMARY KEY,clientes_id INT REFERENCES clientes(id),servicios_id INT REFERENCES servicios(id),fecha_hora VARCHAR(100),estado VARCHAR(50))`);
 await pool.query(`CREATE TABLE IF NOT EXISTS dias_bloqueados (id SERIAL PRIMARY KEY,fecha VARCHAR(50) UNIQUE)`);

 const s=await pool.query('SELECT COUNT(*)::int total FROM servicios');
 if(s.rows[0].total===0){
  await pool.query(`INSERT INTO servicios(nombre,precio) VALUES ('Global',50000),('Mechas',45000),('Corte',14000),('Corte y Barba',15000)`);
 }

 try{
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_fecha_hora_confirmado ON turnos(fecha_hora) WHERE estado='confirmado'`);
 }catch(e){
  console.warn('Indice de horario no creado:',e.message);
 }

 try{
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turnos_uno_por_cliente_confirmado ON turnos(clientes_id) WHERE estado='confirmado'`);
 }catch(e){
  console.warn('Indice de un turno por cliente no creado:',e.message);
 }

 const barber=await pool.query('SELECT id FROM clientes WHERE lower(email)=lower($1) LIMIT 1',[ADMIN_EMAIL]);
 if(barber.rows.length){
  await pool.query(`UPDATE clientes SET rol='barbero' WHERE id=$1`,[barber.rows[0].id]);
 }

 console.log('Base de datos de Excelencia lista.');
}

app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({extended:true}));

app.use((req,res,next)=>{
 res.setHeader('Cache-Control','no-store,no-cache,must-revalidate,proxy-revalidate');
 res.setHeader('Pragma','no-cache');
 res.setHeader('Expires','0');
 next();
});

app.use(express.static(__dirname));

app.get('/',(req,res)=>{
 res.sendFile(path.join(__dirname,'index.html'));
});

app.get('/api/configuracion',(req,res)=>{
 res.json({
  direccion:'Paraguay 176',
  horarios:HORAS_LABORALES,
  ventana_dias:14,
  correo_barbero:ADMIN_EMAIL
 });
});

app.post('/api/login',async(req,res)=>{
 const email=typeof req.body.email==='string'?req.body.email.trim().toLowerCase():'';
 const nombre=typeof req.body.nombre==='string'?nombreCapitalizado(req.body.nombre):'';

 if(!email||!nombre)return res.status(400).json({error:'Email y nombre son obligatorios.'});
 if(email===ADMIN_EMAIL)return res.status(403).json({error:'El barbero administrador debe ingresar con Google.'});

 try{
  const ex=await pool.query('SELECT * FROM clientes WHERE lower(email)=lower($1) LIMIT 1',[email]);

  if(ex.rows.length){
   const u=ex.rows[0];

   if(u.rol==='barbero')return res.status(403).json({error:'Cuenta reservada para el administrador.'});

   if(nombre&&u.nombre!==nombre){
    await pool.query('UPDATE clientes SET nombre=$1 WHERE id=$2',[nombre,u.id]);
   }

   res.setHeader('Set-Cookie',cookieCliente(u.id));
   return res.json({...u,nombre});
  }

  const n=await pool.query(`INSERT INTO clientes(nombre,email,rol) VALUES($1,$2,'cliente') RETURNING *`,[nombre,email]);
  res.setHeader('Set-Cookie',cookieCliente(n.rows[0].id));
  res.status(201).json(n.rows[0]);

 }catch(e){
  console.error(e);
  res.status(500).json({error:'No se pudo iniciar sesión.'});
 }
});

app.post('/api/logout-admin',(req,res)=>{
 res.setHeader('Set-Cookie',[
  'admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
  'cliente_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
 ]);
 res.json({ok:true});
});

app.get('/auth/google',(req,res)=>{
 if(!CLIENT_ID||!CLIENT_SECRET)return res.status(500).send('Google OAuth no está configurado.');

 const p=new URLSearchParams({
  client_id:CLIENT_ID,
  redirect_uri:GOOGLE_REDIRECT_URI,
  response_type:'code',
  scope:'openid email profile',
  access_type:'online',
  prompt:'select_account'
 });

 res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
});

app.get('/auth/google/callback',async(req,res)=>{
 const code=typeof req.query.code==='string'?req.query.code:'';

 if(!code)return res.status(400).send('Código de Google no recibido.');
 if(!CLIENT_ID||!CLIENT_SECRET)return res.status(500).send('Google OAuth no está configurado.');

 try{
  const tr=await fetch('https://oauth2.googleapis.com/token',{
   method:'POST',
   headers:{'Content-Type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({
    code,
    client_id:CLIENT_ID,
    client_secret:CLIENT_SECRET,
    redirect_uri:GOOGLE_REDIRECT_URI,
    grant_type:'authorization_code'
   })
  });

  if(!tr.ok)throw new Error(`Google token ${tr.status}`);

  const td=await tr.json();

  const ur=await fetch('https://www.googleapis.com/oauth2/v2/userinfo',{
   headers:{Authorization:`Bearer ${td.access_token}`}
  });

  if(!ur.ok)throw new Error(`Google userinfo ${ur.status}`);

  const gu=await ur.json();
  const email=(gu.email||'').trim().toLowerCase();
  const nombre=nombreCapitalizado(gu.name||'Cliente');

  if(!email)return res.status(400).send('Google no devolvió un email válido.');

  let q=await pool.query('SELECT * FROM clientes WHERE lower(email)=lower($1) LIMIT 1',[email]);
  let usuario;

  if(q.rows.length){
   usuario=q.rows[0];

   if(email===ADMIN_EMAIL){
    q=await pool.query(`UPDATE clientes SET nombre=$1,rol='barbero' WHERE id=$2 RETURNING *`,[nombre,usuario.id]);
    usuario=q.rows[0];
   }else if(usuario.rol==='barbero'){
    return res.status(403).send('Cuenta de administrador no válida.');
   }
  }else{
   q=await pool.query(
    `INSERT INTO clientes(nombre,email,rol) VALUES($1,$2,$3) RETURNING *`,
    [nombre,email,email===ADMIN_EMAIL?'barbero':'cliente']
   );
   usuario=q.rows[0];
  }

  const cookies=[cookieCliente(usuario.id)];

  if(email===ADMIN_EMAIL){
   cookies.push(`admin_session=${encodeURIComponent(firmarAdmin())}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
  }else{
   cookies.push('admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  }

  res.setHeader('Set-Cookie',cookies);

  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Excelencia</title></head><body><script>localStorage.setItem('usuarioActivo',${JSON.stringify(JSON.stringify(usuario))});location.replace('/?login=success')</script></body></html>`);

 }catch(e){
  console.error(e);
  res.status(500).send('No se pudo completar el acceso con Google.');
 }
});

app.get('/api/servicios',async(req,res)=>{
 try{
  const r=await pool.query('SELECT * FROM servicios ORDER BY id');
  res.json(r.rows);
 }catch(e){
  console.error(e);
  res.status(500).json({error:'No se pudieron obtener los servicios.'});
 }
});

app.post('/api/admin/servicios',requiereAdmin,async(req,res)=>{
 const nombre=String(req.body.nombre||'').trim();
 const precio=Number(req.body.precio);

 if(!nombre||!Number.isFinite(precio)||precio<0)return res.status(400).json({error:'Nombre o precio inválido.'});

 try{
  const r=await pool.query(`INSERT INTO servicios(nombre,precio) VALUES($1,$2) RETURNING *`,[nombre,precio]);
  res.status(201).json(r.rows[0]);
 }catch(e){
  console.error(e);
  res.status(500).json({error:'No se pudo crear el servicio.'});
 }
});

app.put('/api/admin/servicios/:id',requiereAdmin,async(req,res)=>{
 const id=Number(req.params.id);
 const nombre=String(req.body.nombre||'').trim();
 const precio=Number(req.body.precio);

 if(!Number.isInteger(id)||!nombre||!Number.isFinite(precio)||precio<0)return res.status(400).json({error:'Datos inválidos.'});

 try{
  const r=await pool.query('UPDATE servicios SET nombre=$1,precio=$2 WHERE id=$3 RETURNING *',[nombre,precio,id]);

  if(!r.rows.length)return res.status(404).json({error:'Servicio no encontrado.'});

  res.json(r.rows[0]);
 }catch(e){
  console.error(e);
  res.status(500).json({error:'No se pudo editar el servicio.'});
 }
});

app.delete('/api/admin/servicios/:id',requiereAdmin,async(req,res)=>{
 const id=Number(req.params.id);

 if(!Number.isInteger(id))return res.status(400).json({error:'Id inválido.'});

 try{
  const usados=await pool.query(`SELECT 1 FROM turnos WHERE servicios_id=$1 LIMIT 1`,[id]);

  if(usados.rows.length){
   return res.status(409).json({
    error:'No se puede borrar un servicio que tiene historial de turnos. Puedes renombrarlo o cambiar su precio.'
   });
  }

  const r=await pool.query('DELETE FROM servicios WHERE id=$1 RETURNING id',[id]);

  if(!r.rows.length)return res.status(404).json({error:'Servicio no encontrado.'});

  res.json({ok:true});
 }catch(e){
  console.error(e);
  res.status(500).json({error:'No se pudo eliminar el servicio.'});
 }
});

app.get('/api/turnos',async(req,res)=>{
 try{
  const r=await pool.query(`
   SELECT
   t.id,
   t.clientes_id,
   t.servicios_id,
   t.fecha_hora,
   t.estado,
   c.nombre cliente,
   c.email cliente_email,
   s.nombre servicio,
   s.precio precio
   FROM turnos t
   LEFT JOIN clientes c ON t.clientes_id=c.id
   LEFT JOIN servicios s ON t.servicios_id=s.id
   ORDER BY t.fecha_hora
  `);

  res.json(r.rows);
 }catch(e){
  console.error(e);
  res.status(500).json({error:'No se pudieron obtener los turnos.'});
 }
});

async function crearTurno(clienteId,servicioId,fechaHora){
 if(!Number.isInteger(clienteId)||!Number.isInteger(servicioId)||!esFechaHoraValida(fechaHora)){
  return {status:400,error:'Los datos del turno no son válidos.'};
 }

 const fecha=fechaHora.slice(0,10);

 if(
  fecha<fechaArgentina()||
  fecha>fechaMasDias(14)||
  turnoVencido(fechaHora)
 ){
  return {status:409,error:'Ese horario ya no está disponible.'};
 }

 const client=await pool.connect();

 try{
  await client.query('BEGIN');

  await client.query(
   'SELECT pg_advisory_xact_lock(hashtext($1))',
   [fechaHora]
  );

  await client.query(
   'SELECT pg_advisory_xact_lock(hashtext($1))',
   [`cliente:${clienteId}`]
  );

  const b=await client.query(
   'SELECT 1 FROM dias_bloqueados WHERE fecha=$1 LIMIT 1',
   [fecha]
  );

  if(b.rows.length){
   await client.query('ROLLBACK');
   return {status:409,error:'Ese día está cerrado.'};
  }

  const c=await client.query(
   'SELECT id,rol FROM clientes WHERE id=$1 LIMIT 1',
   [clienteId]
  );

  if(!c.rows.length){
   await client.query('ROLLBACK');
   return {status:400,error:'El cliente no existe.'};
  }

  const s=await client.query(
   'SELECT id FROM servicios WHERE id=$1 LIMIT 1',
   [servicioId]
  );

  if(!s.rows.length){
   await client.query('ROLLBACK');
   return {status:400,error:'El servicio no existe.'};
  }

  const own=await client.query(
   `SELECT id,fecha_hora FROM turnos WHERE clientes_id=$1 AND estado='confirmado' LIMIT 1`,
   [clienteId]
  );

  if(own.rows.length){
   await client.query('ROLLBACK');
   return {
    status:409,
    error:'Ya tienes un turno activo. No puedes reservar otro.'
   };
  }

  const busy=await client.query(
   `SELECT id FROM turnos WHERE fecha_hora=$1 AND estado='confirmado' LIMIT 1`,
   [fechaHora]
  );

  if(busy.rows.length){
   await client.query('ROLLBACK');
   return {
    status:409,
    error:'Ese horario ya está ocupado.'
   };
  }

  const n=await client.query(
   `INSERT INTO turnos(clientes_id,servicios_id,fecha_hora,estado)
    VALUES($1,$2,$3,'confirmado')
    RETURNING *`,
   [clienteId,servicioId,fechaHora]
  );

  await client.query('COMMIT');

  return {
   status:201,
   row:n.rows[0]
  };

 }catch(e){
  try{await client.query('ROLLBACK')}catch{}

  if(e.code==='23505'){
   if(e.constraint==='idx_turnos_uno_por_cliente_confirmado'){
    return {
     status:409,
     error:'Ya tienes un turno activo. No puedes reservar otro.'
    };
   }

   return {
    status:409,
    error:'Ese horario ya está ocupado.'
   };
  }

  console.error(e);

  return {
   status:500,
   error:'No se pudo reservar el turno.'
  };

 }finally{
  client.release();
 }
}

app.post('/api/turnos',requiereCliente,async(req,res)=>{
 const r=await crearTurno(
  req.clienteId,
  Number(req.body.servicios_id),
  typeof req.body.fecha_hora==='string'?req.body.fecha_hora.trim():''
 );

 res.status(r.status).json(r.status===201?r.row:{error:r.error});
});

app.post('/api/admin/turnos',requiereAdmin,async(req,res)=>{
 const r=await crearTurno(
  Number(req.body.cliente_id),
  Number(req.body.servicios_id),
  typeof req.body.fecha_hora==='string'?req.body.fecha_hora.trim():''
 );

 res.status(r.status).json(r.status===201?r.row:{error:r.error});
});

app.put('/api/admin/turnos/:id',requiereAdmin,async(req,res)=>{
 const id=Number(req.params.id);
 const clienteId=Number(req.body.cliente_id);
 const servicioId=Number(req.body.servicios_id);
 const fechaHora=typeof req.body.fecha_hora==='string'?req.body.fecha_hora.trim():'';

 if(!Number.isInteger(id)||!Number.isInteger(clienteId)||!Number.isInteger(servicioId)||!esFechaHoraValida(fechaHora)){
  return res.status(400).json({error:'Datos inválidos.'});
 }

 const client=await pool.connect();

 try{
  await client.query('BEGIN');

  await client.query(
   'SELECT pg_advisory_xact_lock(hashtext($1))',
   [fechaHora]
  );

  await client.query(
   'SELECT pg_advisory_xact_lock(hashtext($1))',
   [`cliente:${clienteId}`]
  );

  const fecha=fechaHora.slice(0,10);

  if(
   fecha<fechaArgentina()||
   fecha>fechaMasDias(14)||
   turnoVencido(fechaHora)
  ){
   await client.query('ROLLBACK');
   return res.status(409).json({error:'Ese horario ya no está disponible.'});
  }

  const b=await client.query(
   'SELECT 1 FROM dias_bloqueados WHERE fecha=$1 LIMIT 1',
   [fecha]
  );

  if(b.rows.length){
   await client.query('ROLLBACK');
   return res.status(409).json({error:'Ese día está cerrado.'});
  }

  const existe=await client.query(
   `SELECT id FROM turnos WHERE id=$1 LIMIT 1`,
   [id]
  );

  if(!existe.rows.length){
   await client.query('ROLLBACK');
   return res.status(404).json({error:'Turno no encontrado.'});
  }

  const busy=await client.query(
   `SELECT id FROM turnos
    WHERE fecha_hora=$1
    AND estado='confirmado'
    AND id<>$2
    LIMIT 1`,
   [fechaHora,id]
  );

  if(busy.rows.length){
   await client.query('ROLLBACK');
   return res.status(409).json({error:'Ese horario ya está ocupado.'});
  }

  const own=await client.query(
   `SELECT id FROM turnos
    WHERE clientes_id=$1
    AND estado='confirmado'
    AND id<>$2
    LIMIT 1`,
   [clienteId,id]
  );

  if(own.rows.length){
   await client.query('ROLLBACK');
   return res.status(409).json({error:'Ese cliente ya tiene un turno activo.'});
  }

  const c=await client.query(
   'SELECT id FROM clientes WHERE id=$1 LIMIT 1',
   [clienteId]
  );

  const s=await client.query(
   'SELECT id FROM servicios WHERE id=$1 LIMIT 1',
   [servicioId]
  );

  if(!c.rows.length||!s.rows.length){
   await client.query('ROLLBACK');
   return res.status(400).json({error:'Cliente o servicio inexistente.'});
  }

  const u=await client.query(
   `UPDATE turnos
    SET clientes_id=$1,servicios_id=$2,fecha_hora=$3,estado='confirmado'
    WHERE id=$4
    RETURNING *`,
   [clienteId,servicioId,fechaHora,id]
  );

  await client.query('COMMIT');

  res.json(u.rows[0]);

 }catch(e){
  try{await client.query('ROLLBACK')}catch{}

  if(e.code==='23505'){
   return res.status(409).json({
    error:'No fue posible guardar: horario o cliente ocupado.'
   });
  }

  console.error(e);
  res.status(500).json({error:'No se pudo editar el turno.'});

 }finally{
  client.release();
 }
});

app.delete('/api/admin/turnos/:id',requiereAdmin,async(req,res)=>{
 const id=Number(req.params.id);

 if(!Number.isInteger(id))return res.status(400).json({error:'Id inválido.'});

 try{
  const r=await pool.query(
   `UPDATE turnos
    SET estado='cancelado'
    WHERE id=$1 AND estado='confirmado'
    RETURNING *`,
   [id]
  );

  if(!r.rows.length){
   return res.status(404).json({
    error:'Turno no encontrado o ya cancelado.'
   });
  }

  res.json(r.rows[0]);

 }catch(e){
  console.error(e);
  res.status(500).json({error:'No se pudo cancelar el turno.'});
 }
});

app.get('/api/clientes',requiereAdmin,async(req,res)=>{
 try{
  const r=await pool.query(`
   SELECT
   c.id,
   c.nombre,
   c.email,
   c.rol,
   COUNT(t.id)::int turnos_total,
   COUNT(t.id) FILTER(WHERE t.estado='confirmado')::int turnos_activos,
   MAX(t.fecha_hora) ultimo_turno
   FROM clientes c
   LEFT JOIN turnos t ON t.clientes_id=c.id
   GROUP BY c.id
   ORDER BY c.id DESC
  `);

  res.json(r.rows);
 }catch(e){
  console.error(e);
  res.status(500).json({error:'No se pudieron obtener los clientes.'});
 }
});

app.put('/api/admin/clientes/:id',requiereAdmin,async(req,res)=>{
 const id=Number(req.params.id);
 const nombre=nombreCapitalizado(req.body.nombre);
 const email=String(req.body.email||'').trim().toLowerCase();

 if(!Number.isInteger(id)||!nombre||!email){
  return res.status(400).json({
   error:'Nombre y email son obligatorios.'
  });
 }

 try{
  const actual=await pool.query(
   'SELECT id,email,rol FROM clientes WHERE id=$1 LIMIT 1',
   [id]
  );

  if(!actual.rows.length){
   return res.status(404).json({error:'Cliente no encontrado.'});
  }

  if(actual.rows[0].email.toLowerCase()===ADMIN_EMAIL){
   return res.status(403).json({
    error:'No se puede modificar la cuenta del administrador desde Clientes.'
   });
  }

  if(email===ADMIN_EMAIL){
   return res.status(400).json({
    error:'Ese correo pertenece al administrador.'
   });
  }

  const dup=await pool.query(
   'SELECT id FROM clientes WHERE lower(email)=lower($1) AND id<>$2 LIMIT 1',
   [email,id]
  );

  if(dup.rows.length){
   return res.status(409).json({
    error:'Ese email ya está registrado.'
   });
  }

  const r=await pool.query(
   `UPDATE clientes
    SET nombre=$1,email=$2
    WHERE id=$3
    RETURNING id,nombre,email,rol`,
   [nombre,email,id]
  );

  res.json(r.rows[0]);

 }catch(e){
  console.error(e);
  res.status(500).json({
   error:'No se pudo editar el cliente.'
  });
 }
});

app.delete('/api/admin/clientes/:id',requiereAdmin,async(req,res)=>{
 const id=Number(req.params.id);

 if(!Number.isInteger(id)){
  return res.status(400).json({error:'Id inválido.'});
 }

 try{
  const u=await pool.query(
   'SELECT id,email FROM clientes WHERE id=$1 LIMIT 1',
   [id]
  );

  if(!u.rows.length){
   return res.status(404).json({
    error:'Cliente no encontrado.'
   });
  }

  if(u.rows[0].email.toLowerCase()===ADMIN_EMAIL){
   return res.status(403).json({
    error:'No se puede eliminar al administrador.'
   });
  }

  const t=await pool.query(
   'SELECT 1 FROM turnos WHERE clientes_id=$1 LIMIT 1',
   [id]
  );

  if(t.rows.length){
   return res.status(409).json({
    error:'No se puede eliminar un cliente con historial de turnos.'
   });
  }

  await pool.query(
   'DELETE FROM clientes WHERE id=$1',
   [id]
  );

  res.json({ok:true});

 }catch(e){
  console.error(e);
  res.status(500).json({
   error:'No se pudo eliminar el cliente.'
  });
 }
});

app.get('/api/dias-bloqueados',async(req,res)=>{
 try{
  const r=await pool.query(
   'SELECT fecha FROM dias_bloqueados ORDER BY fecha'
  );

  res.json(r.rows.map(x=>x.fecha));
 }catch(e){
  console.error(e);
  res.status(500).json({
   error:'No se pudieron obtener los días cerrados.'
  });
 }
});

app.post('/api/admin/dias-bloqueados',requiereAdmin,async(req,res)=>{
 const fecha=String(req.body.fecha||'').trim();

 if(
  !esFechaValida(fecha)||
  fecha<fechaArgentina()||
  fecha>fechaMasDias(14)
 ){
  return res.status(400).json({
   error:'Solo puedes abrir o cerrar días dentro de los próximos 14 días.'
  });
 }

 try{
  const r=await pool.query(
   `INSERT INTO dias_bloqueados(fecha)
    VALUES($1)
    ON CONFLICT(fecha) DO NOTHING
    RETURNING fecha`,
   [fecha]
  );

  res.status(201).json({
   fecha,
   creada:r.rows.length>0
  });

 }catch(e){
  console.error(e);
  res.status(500).json({
   error:'No se pudo cerrar el día.'
  });
 }
});

app.delete('/api/admin/dias-bloqueados/:fecha',requiereAdmin,async(req,res)=>{
 const fecha=decodeURIComponent(req.params.fecha);

 if(!esFechaValida(fecha)){
  return res.status(400).json({
   error:'Fecha inválida.'
  });
 }

 try{
  const r=await pool.query(
   'DELETE FROM dias_bloqueados WHERE fecha=$1 RETURNING fecha',
   [fecha]
  );

  if(!r.rows.length){
   return res.status(404).json({
    error:'Ese día ya estaba disponible.'
   });
  }

  res.json({
   ok:true,
   fecha
  });

 }catch(e){
  console.error(e);
  res.status(500).json({
   error:'No se pudo abrir el día.'
  });
 }
});

app.get('/api/admin/estado',requiereAdmin,async(req,res)=>{
 try{
  const[c,t,s,d]=await Promise.all([
   pool.query(`SELECT COUNT(*)::int total FROM clientes WHERE rol='cliente'`),
   pool.query(`SELECT COUNT(*)::int total FROM turnos WHERE estado='confirmado'`),
   pool.query(`SELECT COUNT(*)::int total FROM servicios`),
   pool.query(`SELECT COUNT(*)::int total FROM dias_bloqueados WHERE fecha>=$1 AND fecha<=$2`,[fechaArgentina(),fechaMasDias(14)])
  ]);

  res.json({
   clientes:c.rows[0].total,
   turnos_activos:t.rows[0].total,
   servicios:s.rows[0].total,
   dias_cerrados:d.rows[0].total
  });

 }catch(e){
  console.error(e);
  res.status(500).json({
   error:'No se pudo obtener el estado.'
  });
 }
});

iniciarBD()
.then(()=>{
 app.listen(port,()=>{
  console.log(`Servidor de Excelencia escuchando en ${port}`);
 });
})
.catch(e=>{
 console.error('Error inicializando la base:',e);
 process.exit(1);
});