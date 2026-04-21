const express = require("express");
const path = require("path");
const fs = require("fs");
const mqtt = require("mqtt");
const gisRoutes = require("./routes/gis.routes");
const configRoutes = require("./routes/config.routes");

const app = express();
const PORT = 8080;

// ========================================================
// 📁 CONFIGURACIÓN DE RUTAS Y ARCHIVOS
// ========================================================
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const IMP_DIR = path.join(DATA_DIR, "implementos");

const MAPA_PERSISTENTE = path.join(DATA_DIR, "ultimo_mapa.json");
const CONFIG_FILE = path.join(DATA_DIR, "config_sistema.json");
const IMPLEMENTOS_FILE = path.join(DATA_DIR, "implementos.json"); // Nueva base de datos de modelos

// Inicialización de carpetas de forma segura
[DATA_DIR, UPLOADS_DIR, IMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ========================================================
// 🧠 ESTADO EN MEMORIA (Arquitectura Modular)
// ========================================================
let memoriaEstado = {
  implemento_activo: {
    id_modelo: "tanzi_96_doble",
    nombre: "Tanzi 96 Surcos (19cm) - Modelo Genérico",
    geometria: {
      surcos_totales: 96,
      separacion_cm: 19,
      tipo_tren: "doble",
      distancia_trenes_m: 1.5,
      cantidad_secciones_aog: 4,
      anchos_secciones_aog: [456, 456, 456, 456],
    },
    distribucion_mecanica: [
      {
        id_nodo: "T1_SEM",
        nombre: "Torre 1",
        tren: "trasero",
        surcos: [1, 12],
      },
      {
        id_nodo: "T2_SEM",
        nombre: "Torre 2",
        tren: "trasero",
        surcos: [13, 24],
      },
      {
        id_nodo: "T3_SEM",
        nombre: "Torre 3",
        tren: "trasero",
        surcos: [25, 36],
      },
      {
        id_nodo: "T4_SEM",
        nombre: "Torre 4",
        tren: "trasero",
        surcos: [37, 48],
      },
      {
        id_nodo: "T5_SEM",
        nombre: "Torre 5",
        tren: "delantero",
        surcos: [49, 60],
      },
      {
        id_nodo: "T6_SEM",
        nombre: "Torre 6",
        tren: "delantero",
        surcos: [61, 72],
      },
      {
        id_nodo: "T7_SEM",
        nombre: "Torre 7",
        tren: "delantero",
        surcos: [73, 84],
      },
      {
        id_nodo: "T8_SEM",
        nombre: "Torre 8",
        tren: "delantero",
        surcos: [85, 96],
      },
    ],
  },
  motores: [],
};

// --- CARGA INICIAL DESDE DISCO ---
function cargarConfiguracion() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      // Mezclamos lo guardado con la estructura por defecto para evitar undefineds
      memoriaEstado = { ...memoriaEstado, ...data };
      if (!memoriaEstado.motores) memoriaEstado.motores = [];
      console.log("✅ Configuración cargada desde disco.");
    } catch (e) {
      console.error(
        "❌ Archivo config_sistema.json corrupto. Usando valores por defecto.",
        e.message,
      );
    }
  }
}
cargarConfiguracion();

// ========================================================
// 🔧 FUNCIONES AUXILIARES GLOBALES
// ========================================================
function guardarConfig() {
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify(memoriaEstado, null, 2),
      "utf8",
    );
    // Notificación reactiva al Bridge para que no dependa solo del polling
    if (client && client.connected) {
      client.publish("agp/quantix/bridge/config_changed", JSON.stringify({ ts: Date.now() }));
    }
  } catch (e) {
    console.error("❌ Error CRÍTICO guardando config:", e);
  }
}

function enviarConfigMQTT(uid) {
  const motores = memoriaEstado.motores.filter((m) => m.uid_esp === uid);
  if (motores.length === 0) return;

  const payload = {
    configs: motores.map((m) => ({
      idx: m.indice_interno,
      config_pid: {
        kp: m.control_pid?.kp || 1.0,
        ki: m.control_pid?.ki || 0.1,
        kd: m.control_pid?.kd || 0.0,
        pid_time: m.control_pid?.pid_time || 50,
        max_integral: m.control_pid?.max_integral || 255,
      },
      calibracion: m.calibracion || { pwm_min: 40, pwm_max: 255 },
      meter_cal: m.meter_cal || 50,
    })),
  };

  const topic = `agp/quantix/${uid}/config`;
  const message = JSON.stringify(payload);

  // --- LOG POR CONSOLA ---
  console.log("------------------------------------------");
  console.log(`📤 ENVIANDO CONFIGURACIÓN MQTT`);
  console.log(`📍 Tópico: ${topic}`);
  console.log(`📦 Mensaje: ${message}`);
  console.log("------------------------------------------");

  client.publish(topic, message, { retain: true });
}

// ========================================================
// 📡 CLIENTE MQTT (BACKEND)
// ========================================================
let dispositivosDetectados = {};
const MQTT_BROKER = "mqtt://127.0.0.1";
const client = mqtt.connect(MQTT_BROKER);

client.on("connect", () => {
  console.log("✅ Servidor conectado a MQTT Broker local");
  client.subscribe("agp/quantix/announcement");
});

client.on("message", (topic, message) => {
  if (topic === "agp/quantix/announcement") {
    try {
      const data = JSON.parse(message.toString());
      const uid = data.uid;
      const yaRegistrado = memoriaEstado.motores.some((m) => m.uid_esp === uid);

      if (!yaRegistrado) {
        dispositivosDetectados[uid] = {
          uid: uid,
          ip: data.ip || "Unknown",
          tipo: data.type || "MOTOR",
          visto: Date.now(),
        };
      }
    } catch (e) {}
  }
});

// ========================================================
// 🌐 MIDDLEWARE Y RUTAS EXPRESS
// ========================================================
app.use(express.json());
app.use(express.static("public"));

app.use("/api/gis", gisRoutes);
app.use("/api/config", configRoutes);

// --- FLOW CONFIG (incluye fuera_zona_modo y dosis_default) ---
const FLOW_CONFIG_PATH = path.join(DATA_DIR, "flowx_config.json");

app.get("/api/flow/config", (req, res) => {
  let cfg = {};
  if (fs.existsSync(FLOW_CONFIG_PATH)) {
    try {
      cfg = JSON.parse(fs.readFileSync(FLOW_CONFIG_PATH, "utf8"));
    } catch (e) {}
  }
  res.json(cfg);
});

app.post("/api/flow/fallback", (req, res) => {
  const { fuera_zona_modo, dosis_default } = req.body;
  const permitidos = ["ultima", "cero", "default"];
  if (!permitidos.includes(fuera_zona_modo)) {
    return res.status(400).json({ error: "fuera_zona_modo inválido" });
  }
  // Publicamos por MQTT al Bridge, que es el único dueño de flowx_config.json
  const payload = { fuera_zona_modo };
  if (dosis_default) payload.dosis_default = dosis_default;
  client.publish("agp/flow/config_save", JSON.stringify(payload));
  res.json({ status: "ok" });
});

// --- 1. ESTADO DEL SISTEMA ---
app.get("/api/estado-sistema", (req, res) => {
  let mapa = null;
  if (fs.existsSync(MAPA_PERSISTENTE)) {
    try {
      mapa = JSON.parse(fs.readFileSync(MAPA_PERSISTENTE));
    } catch (e) {}
  }
  res.json({ config: memoriaEstado, mapa: mapa });
});

app.get("/api/config/descubiertos", (req, res) => {
  res.json(Object.values(dispositivosDetectados));
});

// --- 2. ASIGNAR NUEVO MÓDULO (2 Motores por ESP32) ---
app.post("/api/config/asignar", (req, res) => {
  const { uid, numeroCuerpo } = req.body;
  if (!uid || !numeroCuerpo)
    return res.status(400).json({ error: "Faltan datos" });

  delete dispositivosDetectados[uid];
  const nro = parseInt(numeroCuerpo);

  const baseMotor = {
    uid_esp: uid,
    meter_cal: 50.0,
    control_pid: { kp: 1.0, ki: 0.1, kd: 0.0, pid_time: 50, max_integral: 255 },
    calibracion: { pwm_min: 40, pwm_max: 255 },
    nodo_asignado: "", // Empieza sin estar conectado mecánicamente a ninguna torre
  };

  memoriaEstado.motores = memoriaEstado.motores.filter(
    (m) => m.uid_esp !== uid,
  );

  memoriaEstado.motores.push(
    {
      ...baseMotor,
      indice_interno: 0,
      id_logico: nro * 2 - 1,
      nombre: `Semilla M${nro}`,
      producto: "semilla",
    },
    {
      ...baseMotor,
      indice_interno: 1,
      id_logico: nro * 2,
      nombre: `Ferti M${nro}`,
      producto: "ferti",
    },
  );

  guardarConfig();
  enviarConfigMQTT(uid);
  res.json({ status: "ok" });
});

// --- 3. ACTUALIZAR CONFIGURACIÓN DE UN MOTOR (LA MAGIA DE LOS NODOS) ---
// 4. ACTUALIZAR MOTOR (Dosis, PID, Secciones)
app.post("/api/config/update-motor", (req, res) => {
  try {
    const data = req.body;

    // A. ACTUALIZAMOS LA GEOMETRÍA DE LA MÁQUINA
    if (data.implemento) {
      if (!memoriaEstado.implemento_activo)
        memoriaEstado.implemento_activo = { geometria: {} };
      if (!memoriaEstado.implemento_activo.geometria)
        memoriaEstado.implemento_activo.geometria = {};

      memoriaEstado.implemento_activo.geometria.surcos_totales =
        data.implemento.surcos_totales;
      memoriaEstado.implemento_activo.geometria.distancia_trenes_m =
        data.implemento.distancia_trenes;
      memoriaEstado.implemento_activo.geometria.tipo_tren =
        data.implemento.tipo_tren;
    }

    // B. BÚSQUEDA ESTRICTA (¡Sin buscar por nombre!)
    let target = memoriaEstado.motores.find(
      (m) => m.uid_esp === data.uid && m.id_logico === data.id_logico,
    );

    if (target) {
      // Actualizamos los valores del motor correcto
      target.nombre = data.nombre;
      target.meter_cal = data.meter_cal;
      target.control_pid = data.control_pid;
      target.calibracion = data.calibracion;

      // Guardamos la matriz manual
      target.configuracion_secciones = data.configuracion_secciones;

      // C. GUARDADO FÍSICO SEGURO
      if (typeof guardarEstadoEnArchivo === "function") {
        guardarEstadoEnArchivo();
      } else if (typeof guardarConfig === "function") {
        guardarConfig();
      } else {
        const fs = require("fs");
        const path = require("path");
        const rutaConfig = path.join(__dirname, "data", "config_sistema.json");
        fs.writeFileSync(rutaConfig, JSON.stringify(memoriaEstado, null, 2));
      }

      // Avisar a la placa por MQTT
      if (typeof enviarConfigMQTT === "function") {
        enviarConfigMQTT(data.uid);
      }

      console.log(
        `✅ Motor ${data.nombre} (ID: ${data.id_logico}) guardado OK.`,
      );
      res.json({ status: "ok" });
    } else {
      console.log(
        `❌ Motor no encontrado UID: ${data.uid} ID Lógico: ${data.id_logico}`,
      );
      res.status(404).json({ error: "Motor no encontrado en el servidor." });
    }
  } catch (error) {
    console.error("❌ Error grave en update-motor:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- 4. ELIMINAR MOTOR ---
app.post("/api/config/delete-motor", (req, res) => {
  const { uid } = req.body;
  memoriaEstado.motores = memoriaEstado.motores.filter(
    (m) => m.uid_esp !== uid,
  );
  guardarConfig();
  res.json({ status: "ok" });
});

// --- 5. TEST Y CALIBRACIÓN EN VIVO ---
// --- 5. TEST Y CALIBRACIÓN EN VIVO ---
app.post("/api/config/test-motor", (req, res) => {
  const { uid, idx, pwm, cmd } = req.body;

  // TRADUCTOR: El frontend manda el 'id_logico' (1, 2, 3, 4...), pero la placa solo entiende 0 y 1.
  const motor = memoriaEstado.motores.find(
    (m) => m.uid_esp === uid && m.id_logico === idx,
  );
  const internalId = motor ? motor.indice_interno : idx % 2 === 0 ? 1 : 0;

  const topic = `agp/quantix/${uid}/test`;
  const payload = { cmd: cmd || "start", pwm: pwm, id: internalId };

  client.publish(topic, JSON.stringify(payload));
  console.log(
    `🔧 Test MQTT -> Topic: ${topic} | Motor Interno: ${internalId} | PWM: ${pwm}`,
  );

  res.json({ status: "ok" });
});

app.post("/api/config/calibrar", (req, res) => {
  const { uid, idx, pwm, pulsos, cmd } = req.body;

  // TRADUCTOR: Traducimos el ID Lógico al Índice Interno (0 o 1)
  const motor = memoriaEstado.motores.find(
    (m) => m.uid_esp === uid && m.id_logico === idx,
  );
  const internalId = motor ? motor.indice_interno : idx % 2 === 0 ? 1 : 0;

  const topic = `agp/quantix/${uid}/cal`;
  const payload = {
    id: internalId,
    cmd: cmd || "stop",
    pwm: pwm || 0,
    pulsos: pulsos || 0,
  };

  client.publish(topic, JSON.stringify(payload));
  console.log(
    `⚖️ Calibración MQTT -> Topic: ${topic} | Motor Interno: ${internalId} | Cmd: ${cmd}`,
  );

  res.json({ status: "ok" });
});
// ========================================================
// 🚜 SINCRONIZACIÓN CON PILOTO AUTOMÁTICO (AOG)
// ========================================================
let alertaPiloto = { hayCambio: false, nuevasSecciones: 0, nuevosAnchos: [] };

app.post("/api/piloto/notificar-cambio", (req, res) => {
  alertaPiloto = {
    hayCambio: true,
    nuevasSecciones: req.body.secciones_detectadas,
    nuevosAnchos: req.body.anchos_detectados,
  };
  console.log(
    `[AOG] ⚠️ Cambio detectado: ${alertaPiloto.nuevasSecciones} secciones.`,
  );
  res.json({ success: true });
});

app.get("/api/piloto/estado-cambios", (req, res) => res.json(alertaPiloto));

app.post("/api/piloto/aceptar-cambios", (req, res) => {
  if (alertaPiloto.hayCambio) {
    try {
      memoriaEstado.implemento_activo.geometria.cantidad_secciones_aog =
        alertaPiloto.nuevasSecciones;
      memoriaEstado.implemento_activo.geometria.anchos_secciones_aog =
        alertaPiloto.nuevosAnchos;

      guardarConfig();
      alertaPiloto.hayCambio = false;

      console.log(`[AOG] ✅ Configuración de piloto sincronizada.`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  } else {
    res.json({ success: true, message: "Sin cambios pendientes." });
  }
});
// ========================================================
// 💾 GESTIÓN DE PERFILES (MÁQUINAS / IMPLEMENTOS)
// ========================================================

// Listar todos los perfiles guardados
app.get("/api/perfiles", (req, res) => {
  try {
    const archivos = fs.readdirSync(IMP_DIR).filter((f) => f.endsWith(".json"));
    const perfiles = archivos.map((arch) => {
      const data = JSON.parse(fs.readFileSync(path.join(IMP_DIR, arch)));
      return {
        archivo: arch,
        nombre: data.nombre_perfil || arch.replace(".json", ""),
        fecha: fs.statSync(path.join(IMP_DIR, arch)).mtime,
      };
    });
    res.json(perfiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardar la configuración actual como un perfil nuevo
app.post("/api/perfiles/guardar", (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ error: "Nombre requerido" });

    // Limpiamos el nombre para que sea un archivo válido
    const nombreArchivo =
      nombre.replace(/[^a-z0-9]/gi, "_").toLowerCase() + ".json";

    memoriaEstado.nombre_perfil = nombre; // Guardamos el nombre adentro del JSON

    // Guardamos el archivo en la carpeta de implementos
    fs.writeFileSync(
      path.join(IMP_DIR, nombreArchivo),
      JSON.stringify(memoriaEstado, null, 2),
    );

    // Actualizamos también el config actual
    guardarConfig();

    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cargar un perfil y convertirlo en el activo
app.post("/api/perfiles/cargar", (req, res) => {
  try {
    const { archivo } = req.body;
    const ruta = path.join(IMP_DIR, archivo);
    if (fs.existsSync(ruta)) {
      // Reemplazamos toda la memoria con el perfil cargado
      memoriaEstado = JSON.parse(fs.readFileSync(ruta, "utf8"));
      guardarConfig(); // Sobreescribe config_sistema.json

      // Re-enviamos la configuración a todas las placas conectadas
      if (memoriaEstado.motores) {
        // Usamos Set para no mandar duplicados al mismo ESP32
        const uidsUnicos = [
          ...new Set(memoriaEstado.motores.map((m) => m.uid_esp)),
        ];
        uidsUnicos.forEach((uid) => {
          if (typeof enviarConfigMQTT === "function") enviarConfigMQTT(uid);
        });
      }

      console.log(`🚜 Perfil cargado y activado: ${archivo}`);
      res.json({ status: "ok" });
    } else {
      res.status(404).json({ error: "Archivo no encontrado" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Borrar un perfil
app.post("/api/perfiles/borrar", (req, res) => {
  try {
    const { archivo } = req.body;
    const ruta = path.join(IMP_DIR, archivo);
    if (fs.existsSync(ruta)) {
      fs.unlinkSync(ruta);
      res.json({ status: "ok" });
    } else {
      res.status(404).json({ error: "Archivo no encontrado" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// --- INICIO DEL SERVIDOR ---
app.listen(PORT, () => {
  console.log(`🚀 Quantix Server activo en http://localhost:${PORT}`);
});
