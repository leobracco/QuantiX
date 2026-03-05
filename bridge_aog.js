const dgram = require("dgram");
const mqtt = require("mqtt");
const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");
const axios = require("axios");

const udpSocket = dgram.createSocket("udp4");
const mqttClient = mqtt.connect("mqtt://127.0.0.1");

// --- CONFIGURACIÓN DE RUTAS Y PUERTOS ---
const UDP_PORT = 17777;
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const MAPA_PATH = path.join(DATA_DIR, "ultimo_mapa.json");
const FLOW_CONFIG_PATH = path.join(DATA_DIR, "flowx_config.json");
const CONFIG_URL = "http://localhost:8080/api/gis/config-implemento";

// --- ESTADO GLOBAL ---
let mapaPrescripcion = null;
let configImplemento = {
  anchos_secciones_cm: [], // Inicializado vacío para evitar crash
  cantidad_secciones_aog: 0,
  motores: [],
};
let velocidadActual = 0;
let latitud = 0;
let longitud = 0;

// --- PERSISTENCIA FLOWX ---
let flowConfig = {
  dosisManual: 0,
  modoManual: true,
  meterCal: 1,
  pwmMinimo: 0,
  pid: { kp: 0.1, ki: 0.0, kd: 0.0 },
};

if (fs.existsSync(FLOW_CONFIG_PATH)) {
  try {
    flowConfig = {
      ...flowConfig,
      ...JSON.parse(fs.readFileSync(FLOW_CONFIG_PATH)),
    };
  } catch (e) {
    console.error("❌ Bridge: Error cargando flowx_config.json");
  }
}

// --- LÓGICA DE SECCIONES Y RETARDO ---
let estadosSecciones = new Array(64).fill(0);
let estadosSeccionesTren2 = new Array(64).fill(0);
let historialSecciones = [];
let distanciaAcumulada = 0;
let lastTimestamp = Date.now();

// --- TRACKING DE HEADING ---
let posicionesHistorial = [];
const MAX_HISTORIAL = 5;
let ultimaPosicion = null;
let headingSuavizado = 0;
let ultimoTiempo = Date.now();

// --- 1. SINCRONIZACIÓN Y ARCHIVOS ---
async function sincronizarConfig() {
  try {
    const res = await axios.get(CONFIG_URL);
    // Mezclamos la config de la API con lo que ya tenemos para no perder datos
    configImplemento = { ...configImplemento, ...res.data };
    console.log("⚙️ Bridge: Configuración sincronizada con QuantiX API");
  } catch (e) {
    console.error("❌ Bridge: Esperando API de QuantiX...");
  }
}

function cargarMapa() {
  if (fs.existsSync(MAPA_PATH)) {
    try {
      mapaPrescripcion = JSON.parse(fs.readFileSync(MAPA_PATH));
      console.log("🗺️ Bridge: Mapa VRA cargado");
    } catch (e) {
      console.error("❌ Error leyendo mapa");
    }
  }
}

fs.watchFile(MAPA_PATH, () => cargarMapa());
setInterval(sincronizarConfig, 30000);
sincronizarConfig();
cargarMapa();

// --- 2. COMUNICACIONES MQTT (UI & HARDWARE) ---
mqttClient.on("connect", () => {
  console.log("🚀 BridgeX: MQTT Conectado.");
  mqttClient.subscribe("agp/flow/ui_cmd");
  mqttClient.subscribe("agp/flow/config_save");
});

mqttClient.on("message", (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    if (topic === "agp/flow/ui_cmd" && data.type === "SET_DOSIS") {
      flowConfig.dosisManual = data.valor;
      flowConfig.modoManual = true;
      saveFlowConfig();
    }
    if (topic === "agp/flow/config_save") {
      flowConfig = { ...flowConfig, ...data };
      saveFlowConfig();
    }
  } catch (e) {
    console.error("❌ Bridge: Error MQTT", topic);
  }
});

function saveFlowConfig() {
  fs.writeFile(FLOW_CONFIG_PATH, JSON.stringify(flowConfig, null, 2), () => {
    ejecutarCalculosModulares();
  });
}

// --- 3. MÓDULOS DE CÁLCULO ---

function calcularYEnviarTargetFlow() {
  // BLOQUEO DE SEGURIDAD: Si no hay anchos definidos, no calculamos nada
  if (
    !configImplemento ||
    !configImplemento.anchos_secciones_cm ||
    configImplemento.anchos_secciones_cm.length === 0
  ) {
    return;
  }

  let anchoActivoM = 0;
  let seccionesByte = 0;

  // Usamos la cantidad de secciones que realmente nos dio AgOpenGPS
  const cantidadSeccionesDisponibles =
    configImplemento.anchos_secciones_cm.length;
  const maxAProcesar = Math.min(cantidadSeccionesDisponibles, 10);

  for (let i = 0; i < maxAProcesar; i++) {
    if (estadosSecciones[i] === 1) {
      anchoActivoM += (configImplemento.anchos_secciones_cm[i] || 0) / 100;
      seccionesByte |= 1 << i;
    }
  }

  const dosisTarget =
    flowConfig.modoManual || !mapaPrescripcion
      ? flowConfig.dosisManual
      : obtenerDosisMapa(latitud, longitud);

  let lminTarget =
    velocidadActual > 0.5 && anchoActivoM > 0
      ? (dosisTarget * velocidadActual * anchoActivoM) / 600
      : 0;

  mqttClient.publish(
    "agp/flow/target",
    JSON.stringify({
      target: parseFloat(lminTarget.toFixed(2)),
      sec: seccionesByte,
      vel: velocidadActual,
      pwmMin: flowConfig.pwmMinimo,
      pid: flowConfig.pid,
    }),
  );

  mqttClient.publish(
    "agp/flow/state",
    JSON.stringify({
      dosisTarget: dosisTarget,
      velocidad: velocidadActual,
      caudalActual: 0,
    }),
  );
}

async function procesarDosisQuantiX(lat, lon) {
  if (
    !configImplemento ||
    !configImplemento.motores ||
    configImplemento.motores.length === 0
  )
    return;

  let dosisBase = obtenerDosisMapa(lat, lon);

  const m_s = velocidadActual > 0.5 ? velocidadActual / 3.6 : 0;
  const separacion_m =
    (configImplemento.implemento_activo?.geometria?.separacion_cm || 19) / 100;

  configImplemento.motores.forEach((motor) => {
    if (!motor.configuracion_secciones) return;
    let motorDebeGirar = motor.configuracion_secciones.some((sec) => {
      const idx = sec.seccion_aog - 1;
      return sec.tipo === "trasero"
        ? estadosSeccionesTren2[idx] === 1
        : estadosSecciones[idx] === 1;
    });

    let ppsTarget = 0;
    if (motorDebeGirar && dosisBase > 0 && m_s > 0) {
      const cpReal = parseFloat(motor.meter_cal) || 1.0;
      const factorDosis =
        dosisBase > 500 ? (dosisBase * separacion_m) / 10000 : dosisBase;
      ppsTarget = (factorDosis * m_s) / cpReal;
    }

    mqttClient.publish(
      `agp/quantix/${motor.uid_esp}/target`,
      JSON.stringify({
        id: motor.indice_interno,
        pps: parseFloat(ppsTarget.toFixed(2)),
        seccion_on: motorDebeGirar,
      }),
    );
  });
}

function obtenerDosisMapa(lat, lon) {
  if (!mapaPrescripcion || lat === 0) return 0;
  try {
    const punto = turf.point([lon, lat]);
    for (const f of mapaPrescripcion.features) {
      if (turf.booleanPointInPolygon(punto, f)) {
        return (
          parseFloat(f.properties.Rate || f.properties.SemillasxMetro) || 0
        );
      }
    }
  } catch (e) {}
  return 0;
}

function ejecutarCalculosModulares() {
  calcularYEnviarTargetFlow();
  procesarDosisQuantiX(latitud, longitud);
}

// --- 4. EVENTOS UDP Y SECCIONES ---

udpSocket.on("message", (msg) => {
  if (msg.length < 8) return;
  const pgn = msg[3];

  // PGN 254: Velocidad
  if (pgn === 254) {
    velocidadActual = msg.readInt16LE(5) / 10;
    mqttClient.publish("aog/machine/speed", velocidadActual.toFixed(1));
    ejecutarCalculosModulares();
  }
  // PGN 100: Posición
  else if (pgn === 100) {
    longitud = msg.readDoubleLE(5);
    latitud = msg.readDoubleLE(13);
    const headingFinal = calcularHeadingDesdePosiciones(latitud, longitud);
    mqttClient.publish(
      "aog/machine/position",
      JSON.stringify({ lat: latitud, lon: longitud, heading: headingFinal }),
    );
    ejecutarCalculosModulares();
  }
  // PGN 235: Configuración de Anchos (IMPORTANTE PARA EVITAR EL CRASH)
  else if (pgn === 235) {
    if (msg.length >= 38) {
      const cantidadSeccionesAOG = msg[37];
      let anchos_cm = [];
      for (let i = 0; i < cantidadSeccionesAOG; i++) {
        anchos_cm.push(msg.readUInt16LE(5 + i * 2));
      }

      if (cantidadSeccionesAOG > 0) {
        // Sincronizamos los anchos con nuestra memoria
        configImplemento.cantidad_secciones_aog = cantidadSeccionesAOG;
        configImplemento.anchos_secciones_cm = anchos_cm;

        mqttClient.publish(
          "aog/machine/sections_config",
          JSON.stringify({
            secciones_detectadas: cantidadSeccionesAOG,
            anchos_detectados: anchos_cm,
          }),
          { retain: true },
        );
      }
    }
  }
  // PGN 229: Estados de Secciones
  else if (pgn === 229) {
    let seccionesActuales = new Array(64).fill(0);
    for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
      const byteValue = msg[5 + byteIdx];
      for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
        const idx = byteIdx * 8 + bitIdx;
        if (idx < 64) seccionesActuales[idx] = (byteValue >> bitIdx) & 1;
      }
    }
    actualizarLogicaSecciones(seccionesActuales);
  }
});

function actualizarLogicaSecciones(seccionesActuales) {
  const now = Date.now();
  const dt = (now - lastTimestamp) / 1000;
  lastTimestamp = now;
  distanciaAcumulada += (velocidadActual / 3.6) * dt;

  estadosSecciones = [...seccionesActuales];
  const distTren2 =
    parseFloat(
      configImplemento?.implemento_activo?.geometria?.distancia_trenes_m,
    ) || 1.5;

  historialSecciones.push({
    estados: [...seccionesActuales],
    distanciaMeta: distanciaAcumulada + distTren2,
  });
  if (historialSecciones.length > 2000) historialSecciones.shift();

  while (
    historialSecciones.length > 0 &&
    distanciaAcumulada >= historialSecciones[0].distanciaMeta
  ) {
    const puntoPasado = historialSecciones.shift();
    estadosSeccionesTren2 = puntoPasado.estados;
  }

  mqttClient.publish(
    "sections/state",
    JSON.stringify({ t1: estadosSecciones, t2: estadosSeccionesTren2 }),
  );
  ejecutarCalculosModulares();
}

// --- 5. FUNCIONES HELPER (GPS/HEADING) ---

function calcularHeadingDesdePosiciones(latActual, lonActual) {
  const ahora = Date.now();
  if (!ultimaPosicion) {
    ultimaPosicion = { lat: latActual, lon: lonActual, timestamp: ahora };
    return 0;
  }
  const distancia = calcularDistanciaMetros(
    ultimaPosicion.lat,
    ultimaPosicion.lon,
    latActual,
    lonActual,
  );
  if (distancia < 0.5 || ahora - ultimoTiempo < 100) return headingSuavizado;

  const headingBruto = calcularHeadingGPS(
    ultimaPosicion.lat,
    ultimaPosicion.lon,
    latActual,
    lonActual,
  );
  posicionesHistorial.push({ heading: headingBruto });
  if (posicionesHistorial.length > MAX_HISTORIAL) posicionesHistorial.shift();

  headingSuavizado = suavizarHeading(posicionesHistorial);
  ultimaPosicion = { lat: latActual, lon: lonActual, timestamp: ahora };
  ultimoTiempo = ahora;
  return headingSuavizado;
}

function calcularHeadingGPS(lat1, lon1, lat2, lon2) {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1R = (lat1 * Math.PI) / 180;
  const lat2R = (lat2 * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2R);
  const x =
    Math.cos(lat1R) * Math.sin(lat2R) -
    Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function suavizarHeading(historial) {
  let sSin = 0,
    sCos = 0;
  historial.forEach((h, i) => {
    const p = (i + 1) / historial.length;
    sSin += Math.sin((h.heading * Math.PI) / 180) * p;
    sCos += Math.cos((h.heading * Math.PI) / 180) * p;
  });
  return ((Math.atan2(sSin, sCos) * 180) / Math.PI + 360) % 360;
}

function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

udpSocket.bind(UDP_PORT, () =>
  console.log(`📡 BridgeX Activo en Puerto ${UDP_PORT}`),
);
