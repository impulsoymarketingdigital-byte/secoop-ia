require('dotenv').config();
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'jirehai.db');

let saveTimeout = null;
function saveDB(sqlDb) {
  if (saveTimeout) return;
  
  saveTimeout = setTimeout(async () => {
    try {
      const data = sqlDb.export();
      await fs.promises.writeFile(DB_PATH, Buffer.from(data));
      // console.log('💾 DB persistida (async)');
    } catch (err) {
      console.error('❌ Error persistiendo DB (async):', err.message);
    } finally {
      saveTimeout = null;
    }
  }, 500);
}

async function saveDBImmediate(sqlDb) {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  const data = sqlDb.export();
  await fs.promises.writeFile(DB_PATH, Buffer.from(data));
}

class Statement {
  constructor(sqlDb, sql, dbWrapper) {
    this._sqlDb = sqlDb;
    this._sql = sql;
    this._db = dbWrapper;
  }

  _params(args) {
    if (args.length === 0) return [];
    if (args.length === 1 && Array.isArray(args[0])) return args[0];
    return args;
  }

  get(...args) {
    const params = this._params(args);
    const stmt = this._sqlDb.prepare(this._sql);
    try {
      if (params.length) stmt.bind(params);
      return stmt.step() ? stmt.getAsObject() : undefined;
    } finally {
      stmt.free();
    }
  }

  all(...args) {
    const params = this._params(args);
    const stmt = this._sqlDb.prepare(this._sql);
    try {
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  run(...args) {
    const params = this._params(args);
    this._sqlDb.run(this._sql, params.length ? params : []);
    const lastIdRes = this._sqlDb.exec('SELECT last_insert_rowid()');
    const lastInsertRowid = lastIdRes[0]?.values[0]?.[0] ?? 0;
    const changes = this._sqlDb.getRowsModified();
    if (!this._db._inTransaction) saveDB(this._sqlDb);
    return { lastInsertRowid, changes };
  }
}

class DatabaseWrapper {
  constructor(sqlDb) {
    this._sqlDb = sqlDb;
    this._inTransaction = false;
  }

  pragma(str) {
    try { this._sqlDb.run(`PRAGMA ${str}`); } catch {}
  }

  exec(sql) {
    this._sqlDb.exec(sql);
    saveDB(this._sqlDb);
    return this;
  }

  prepare(sql) {
    return new Statement(this._sqlDb, sql, this);
  }

  transaction(fn) {
    return (...args) => {
      this._inTransaction = true;
      this._sqlDb.run('BEGIN');
      try {
        const result = fn(...args);
        this._sqlDb.run('COMMIT');
        this._inTransaction = false;
        saveDB(this._sqlDb);
        return result;
      } catch (e) {
        this._inTransaction = false;
        try { this._sqlDb.run('ROLLBACK'); } catch {}
        throw e;
      }
    };
  }
}

let db = null;

async function initDB() {
  const SQL = await initSqlJs();

  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    try {
      sqlDb = new SQL.Database(fs.readFileSync(DB_PATH));
      // Verificar integridad básica antes de continuar
      sqlDb.exec('SELECT 1');
      console.log('📂 Base de datos cargada desde disco');
    } catch (err) {
      console.warn('⚠️  Base de datos corrupta detectada — creando nueva base limpia...');
      // Renombrar la corrupta como backup en vez de eliminarla
      const backupPath = DB_PATH + '.corrupted_' + Date.now();
      try { fs.renameSync(DB_PATH, backupPath); } catch {}
      sqlDb = new SQL.Database();
      console.log('🆕 Nueva base de datos creada (la anterior fue renombrada como backup)');
    }
  } else {
    sqlDb = new SQL.Database();
    console.log('🆕 Nueva base de datos creada');
  }

  db = new DatabaseWrapper(sqlDb);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      plan TEXT DEFAULT 'basico',
      role TEXT DEFAULT 'user',
      active INTEGER DEFAULT 1,
      email_verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    );

    CREATE TABLE IF NOT EXISTS user_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      config_json TEXT DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS applied_processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      process_number TEXT NOT NULL,
      process_data_json TEXT DEFAULT '{}',
      analysis_json TEXT,
      observations TEXT,
      cumple TEXT DEFAULT 'pendiente',
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      analyzed_at DATETIME,
      UNIQUE(user_id, process_number)
    );

    CREATE TABLE IF NOT EXISTS user_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL,
      expiry_date DATE,
      notes TEXT,
      file_name TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, doc_type)
    );

    CREATE TABLE IF NOT EXISTS unspsc_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      category TEXT,
      keywords TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email_enabled INTEGER DEFAULT 1,
      notify_new_processes INTEGER DEFAULT 1,
      notify_closing_soon INTEGER DEFAULT 1,
      notify_docs_expiring INTEGER DEFAULT 1,
      notify_unspsc_match INTEGER DEFAULT 1,
      scan_interval INTEGER DEFAULT 4,
      notification_email TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL,
      price INTEGER,
      start_date DATE DEFAULT CURRENT_DATE,
      end_date DATE,
      status TEXT DEFAULT 'active',
      payment_method TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scan_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      scan_type TEXT,
      processes_found INTEGER DEFAULT 0,
      new_matches INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Tablas del motor AI SECOP ──────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS process_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT UNIQUE NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      process_ref TEXT,
      entity_name TEXT,
      status TEXT DEFAULT 'pending',
      progress_pct INTEGER DEFAULT 0,
      progress_step TEXT DEFAULT '',
      progress_msg TEXT DEFAULT '',
      error_msg TEXT,
      output_dir TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS analysis_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT UNIQUE NOT NULL REFERENCES process_analysis(job_id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS analysis_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES process_analysis(job_id) ON DELETE CASCADE,
      step TEXT,
      pct INTEGER,
      msg TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS downloaded_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES process_analysis(job_id) ON DELETE CASCADE,
      filename TEXT,
      doc_type TEXT,
      source_url TEXT,
      file_path TEXT,
      size_kb REAL,
      page_count INTEGER DEFAULT 0,
      is_scanned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS extracted_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES process_analysis(job_id) ON DELETE CASCADE,
      req_type TEXT,
      req_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS risk_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES process_analysis(job_id) ON DELETE CASCADE,
      nivel_riesgo TEXT,
      score_riesgo INTEGER DEFAULT 0,
      risk_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Recuperación de contraseña ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Límite diario de tokens de IA ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS daily_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      usage_date DATE NOT NULL,
      analyses_used INTEGER DEFAULT 0,
      tokens_used INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, usage_date)
    );
  `);

  // ── Migraciones de columnas nuevas (idempotentes vía try/catch) ──────────
  const addColIfMissing = (sql) => {
    try { sqlDb.run(sql); saveDB(sqlDb); } catch (_) { /* columna ya existe */ }
  };
  addColIfMissing("ALTER TABLE users ADD COLUMN trial_expires_at DATETIME");
  addColIfMissing("ALTER TABLE users ADD COLUMN plan_expires_at  DATETIME");
  addColIfMissing("ALTER TABLE subscriptions ADD COLUMN stripe_session_id TEXT");
  addColIfMissing("ALTER TABLE subscriptions ADD COLUMN stripe_payment_intent TEXT");

  // Seed admin user (sistema)
  const adminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@jirehai.com');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin2025', 10);
    db.prepare('INSERT INTO users (name, email, password_hash, plan, role, active, email_verified) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Administrador JIREHAI', 'admin@jirehai.com', hash, 'empresarial', 'admin', 1, 1);
    console.log('✅ Admin creado: admin@jirehai.com / admin2025');
  }

  // Seed admin personalizado — impulsoymarketingdigital@gmail.com
  const customAdminExists = db.prepare('SELECT id FROM users WHERE email = ?').get('impulsoymarketingdigital@gmail.com');
  if (!customAdminExists) {
    const hash = bcrypt.hashSync('M@riate2026*', 10);
    db.prepare(`INSERT INTO users
      (name, email, password_hash, plan, role, active, email_verified, trial_expires_at, plan_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run('Luis Felipe Pinilla', 'impulsoymarketingdigital@gmail.com', hash, 'empresarial', 'admin', 1, 1);
    const newId = db.prepare('SELECT id FROM users WHERE email = ?').get('impulsoymarketingdigital@gmail.com').id;
    db.prepare('INSERT OR IGNORE INTO notification_settings (user_id, notification_email) VALUES (?, ?)').run(newId, 'impulsoymarketingdigital@gmail.com');
    console.log('✅ Admin creado: impulsoymarketingdigital@gmail.com / M@riate2026*');
  } else {
    // Si ya existe, asegurarse de que sea admin sin vencimiento
    db.prepare(`UPDATE users SET role='admin', plan='empresarial', active=1,
                trial_expires_at=NULL, plan_expires_at=NULL
                WHERE email='impulsoymarketingdigital@gmail.com' AND role != 'admin'`).run();
  }

  // Seed UNSPSC codes
  const row = db.prepare('SELECT COUNT(*) as cnt FROM unspsc_codes').get();
  if (!row || row.cnt === 0) {
    const codes = [
      ['43230000','Software y Sistemas de Información','Tecnología','software,sistema,aplicación,plataforma,licencia,erp,crm,saas'],
      ['81110000','Servicios de Consultoría en TI','Tecnología','consultoría,consultor,asesoría,implementación,soporte técnico,it'],
      ['43210000','Hardware y Equipos de Cómputo','Tecnología','computador,servidor,hardware,equipo,impresora,red,laptop,pc'],
      ['83000000','Servicios de Ingeniería','Ingeniería','ingeniería,diseño,construcción,obras,civil,estructural'],
      ['72000000','Servicios de Construcción','Construcción','construcción,edificio,infraestructura,vial,carretera,obra pública'],
      ['73000000','Servicios de Mantenimiento','Mantenimiento','mantenimiento,reparación,soporte,correctivo,preventivo'],
      ['80000000','Servicios de Gestión y Administración','Gestión','gestión,administración,gerencia,dirección,management'],
      ['86000000','Servicios de Salud','Salud','salud,médico,hospital,clínica,medicamento,farmacia,ips'],
      ['85000000','Educación y Formación','Educación','capacitación,formación,educación,entrenamiento,curso,taller'],
      ['92000000','Seguridad y Defensa','Seguridad','seguridad,vigilancia,defensa,custodia,guardas'],
      ['77000000','Servicios Ambientales','Ambiente','ambiental,ambiente,residuos,reciclaje,basuras,saneamiento'],
      ['78000000','Transporte y Logística','Transporte','transporte,logística,flete,mensajería,distribución,carga'],
      ['82000000','Servicios Editoriales y Gráficos','Comunicación','publicidad,impresión,diseño gráfico,editorial,imprenta'],
      ['71000000','Minería y Petróleo','Energía','minería,petróleo,gas,hidrocarburos,energía,minero'],
      ['91000000','Servicios Jurídicos','Legal','jurídico,legal,abogado,asesoría legal,derecho,notaría'],
      ['44000000','Suministros de Oficina','Suministros','papelería,insumos,suministros,oficina,escritorio,tóner'],
      ['47000000','Limpieza y Aseo','Aseo','aseo,limpieza,higiene,sanitario,desinfección,cafetería'],
      ['53000000','Ropa y Textiles','Dotación','dotación,uniformes,ropa,textiles,calzado,EPP'],
      ['41000000','Equipos de Laboratorio','Laboratorio','laboratorio,equipo médico,instrumental,diagnóstico'],
      ['60000000','Arte y Artesanías','Arte','arte,artesanías,cultura,espectáculo,entretenimiento'],
      ['30000000','Estructuras y Edificios','Construcción','estructura,edificio,prefabricado,módulo,placa huella'],
      ['31000000','Materiales de Construcción','Materiales','material,cemento,concreto,acero,ladrillo,hierro'],
      ['15000000','Combustibles','Energía','combustible,gasolina,diesel,aceite,lubricante,gas natural'],
      ['50000000','Alimentos y Bebidas','Alimentos','alimento,comida,mercado,viveres,bebida,ración,refrigerio'],
      ['56000000','Muebles y Accesorios','Mobiliario','mueble,silla,escritorio,archivador,sala de espera'],
      ['40000000','Distribución y Acondicionamiento','Instalaciones','aire acondicionado,ventilación,plomería,eléctrico,hidráulico'],
      ['39000000','Electricidad e Iluminación','Electricidad','electricidad,iluminación,eléctrico,transformador,panel solar'],
      ['43220000','Telecomunicaciones','Telecomunicaciones','telecomunicaciones,internet,fibra,radiocomunicación,telefonía'],
      ['84000000','Servicios Financieros','Finanzas','financiero,contabilidad,auditoría,revisoría,banca,seguros'],
      ['75000000','Servicios Industriales','Industrial','industrial,manufactura,planta,producción,procesamiento'],
      ['76000000','Servicios de Instalación','Instalación','instalación,montaje,adecuación,obra,remodelación'],
      ['81100000','Estrategia y Planificación','Consultoría','estrategia,planificación,planeación,diagnóstico,estudio'],
      ['81120000','Economía','Economía','economía,econometría,estadística,análisis económico'],
      ['81130000','Gestión de Proyectos','Proyectos','proyecto,pmo,interventoría,supervisión,gerencia proyectos'],
      ['81140000','Ingeniería de Software','Software','desarrollo,programación,app,web,frontend,backend,bases de datos'],
      ['81150000','Redes y Comunicaciones','Redes','red,networking,cisco,firewall,ciberseguridad,seguridad informática'],
      ['81160000','Ciencias de la Tierra','Geociencias','topografía,geotecnia,geología,cartografía,sig,gis'],
      ['81170000','Ciencias Sociales','Social','social,sociología,psicología,trabajo social,comunidades'],
      ['81180000','Ciencias Ambientales','Ambiental','medio ambiente,impacto ambiental,biodiversidad,flora,fauna'],
      ['93000000','Servicios Políticos y Civiles','Gobierno','gobierno,estado,administración pública,entidad,municipio'],
      ['95000000','Servicios de Tierras','Tierras','predio,catastro,terreno,lote,avalúo,inmueble'],
      ['96000000','Beneficios no Laborales','Bienestar','bienestar,recreación,deporte,cultura,evento institucional'],
      ['48000000','Protección y Seguridad Industrial','Industrial','EPP,protección,casco,guante,botas,extintor,señalización'],
      ['49000000','Artículos Deportivos','Deporte','deporte,recreación,implementos deportivos,cancha,piscina'],
      ['51000000','Medicamentos','Salud','medicamento,droga,fármaco,insumo médico,dispositivo médico'],
      ['52000000','Artículos del Hogar','Doméstico','electrodoméstico,cocina,hogar,aseo,menaje'],
      ['55000000','Publicaciones','Editorial','libro,publicación,revista,suscripción,base de datos bibliográfica'],
      ['58000000','Equipos de Impresión','Impresión','impresora,copiadora,plóter,escáner,tóner,tinta'],
      ['62000000','Plantas y Jardines','Agrícola','planta,jardín,paisajismo,siembra,vivero,arborización'],
      ['70000000','Agricultura y Alimentación','Agricultura','agricultura,ganadería,pesca,campo,rural,semilla']
    ];
    const insertCode = db.prepare('INSERT OR IGNORE INTO unspsc_codes (code, description, category, keywords) VALUES (?, ?, ?, ?)');
    const insertMany = db.transaction((items) => {
      for (const item of items) insertCode.run(...item);
    });
    insertMany(codes);
    console.log(`✅ Seeded ${codes.length} UNSPSC codes`);
  }

  return db;
}

const exported = { db: null, initDB: async function() {
  const result = await initDB();
  exported.db = result;
  return result;
} };

module.exports = exported;
