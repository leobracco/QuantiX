const express = require('express');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');
const gisRoutes = require('./routes/gis.routes');
const configRoutes = require('./routes/config.routes');

const app = express();
const PORT = 8080;

// --- CONFIGURACIÓN DE RUTAS Y ARCHIVOS ---
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const IMP_DIR = path.join(DATA_DIR, 'implementos');
const MAPA_PERSISTENTE = path.join(DATA_DIR, 'ultimo_mapa.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config_sistema.json');

// Inicialización de carpetas
[DATA_DIR, UPLOADS_DIR, IMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- ESTADO EN MEMORIA ---
let memoriaEstado = {
    perfilActivo: 'tanzi_48',
    anchosSecciones: [],
    motores: [] // Aquí se guardarán los motores vinculados
};

// Cargar configuración inicial
if (fs.existsSync(CONFIG_FILE)) {
    try {
        memoriaEstado = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (!memoriaEstado.motores) memoriaEstado.motores = [];
    } catch (e) {
        console.error("❌ Error al cargar memoriaEstado, usando default.");
    }
}

// Almacén temporal para dispositivos nuevos
let dispositivosDetectados = {}; 

// --- CLIENTE MQTT (BACKEND) ---
const MQTT_BROKER = "mqtt://127.0.0.1";
const client = mqtt.connect(MQTT_BROKER);

client.on('connect', () => {
    console.log("✅ Servidor conectado a MQTT Broker");
    client.subscribe("agp/quantix/announcement");
});

client.on('message', (topic, message) => {
    if (topic === "agp/quantix/announcement") {
        try {
            const data = JSON.parse(message.toString());
            const uid = data.uid;
            
            const yaRegistrado = memoriaEstado.motores.some(m => m.uid_esp === uid);

            if (!yaRegistrado) {
                dispositivosDetectados[uid] = {
                    uid: uid,
                    ip: data.ip || 'Unknown',
                    tipo: data.type || 'MOTOR',
                    visto: Date.now()
                };
            }
        } catch (e) { }
    }
});

// --- MIDDLEWARE ---
app.use(express.json());
app.use(express.static('public'));

// --- RUTAS DE API ---

app.use('/api/gis', gisRoutes);
app.use('/api/config', configRoutes);

// 1. Obtener estado completo
app.get('/api/estado-sistema', (req, res) => {
    const mapa = fs.existsSync(MAPA_PERSISTENTE) 
                ? JSON.parse(fs.readFileSync(MAPA_PERSISTENTE)) 
                : null;
    res.json({ config: memoriaEstado, mapa: mapa });
});

// 2. Obtener descubiertos
app.get('/api/config/descubiertos', (req, res) => {
    res.json(Object.values(dispositivosDetectados));
});

// 3. ASIGNAR (Crear motores)
app.post('/api/config/asignar', (req, res) => {
    const { uid, numeroCuerpo } = req.body;
    if (!uid || !numeroCuerpo) return res.status(400).json({ error: "Faltan datos" });

    delete dispositivosDetectados[uid];

    const nro = parseInt(numeroCuerpo);
    const idSemilla = (nro * 2) - 1;
    const idFerti = nro * 2;

    const motorSemilla = {
        uid_esp: uid,
        indice_interno: 0,
        id_logico: idSemilla,
        nombre: `Semilla C${nro}`,
        tren: 1,
        seccionAOG: nro - 1,
        meter_cal: 50.0,
        control_pid: { kp: 1.0, ki: 0.1, kd: 0.0, pid_time: 50, max_integral: 255 },
        calibracion: { pwm_min: 40, pwm_max: 255 },
        secciones_aog: [nro - 1], 
        active: true
    };

    const motorFerti = {
        uid_esp: uid,
        indice_interno: 1,
        id_logico: idFerti,
        nombre: `Ferti C${nro}`,
        tren: 2,
        seccionAOG: nro - 1,
        meter_cal: 50.0,
        control_pid: { kp: 1.0, ki: 0.1, kd: 0.0, pid_time: 50, max_integral: 255 },
        calibracion: { pwm_min: 40, pwm_max: 255 },
        secciones_aog: [nro - 1],
        active: true
    };

    memoriaEstado.motores = memoriaEstado.motores.filter(m => m.uid_esp !== uid);
    memoriaEstado.motores.push(motorSemilla, motorFerti);

    guardarConfig();
    enviarConfigMQTT(uid);

    console.log(`✅ Asignado UID ${uid} al Cuerpo ${nro}`);
    res.json({ status: "ok" });
});

// 4. ACTUALIZAR MOTOR (Dosis, PID, Secciones)
app.post('/api/config/update-motor', (req, res) => {
    const data = req.body; 
    
    // A. ACTUALIZAMOS LOS DATOS GLOBALES (Surcos, Trenes, etc.)
    if (data.implemento) {
    memoriaEstado.implemento = {
        ...memoriaEstado.implemento,
        surcos_totales: data.implemento.surcos_totales,
        distancia_trenes: data.implemento.distancia_trenes,
        tipo_tren: data.implemento.tipo_tren,
        sentido_surcos: data.implemento.sentido_surcos // <-- AGREGAR ESTO
    };
}
  

    // B. BUSQUEDA ROBUSTA DEL MOTOR
    // Intentamos buscar por UID y Nombre, o mejor aún por id_logico si el frontend lo mandó
    let target = memoriaEstado.motores.find(m => 
        (m.uid_esp === data.uid && m.id_logico === data.id_logico) ||
        (m.uid_esp === data.uid && m.nombre === data.nombre)
    );

    if (target) {
        // Actualizamos los valores básicos
        target.nombre = data.nombre;
        target.meter_cal = data.meter_cal;
        target.control_pid = data.control_pid;
        target.calibracion = data.calibracion;
        
        // ¡ESTO ES LO MÁS IMPORTANTE!: 
        // El frontend manda 'configuracion_secciones', lo guardamos tal cual en el JSON
        target.configuracion_secciones = data.configuracion_secciones; 
        
        // Guardar físicamente en el archivo JSON
        // Nota: Asegúrate que tu función se llame guardarConfig o usa guardarEstadoEnArchivo
        if (typeof guardarConfig === 'function') {
            guardarConfig();
        } else {
            const rutaConfig = path.join(__dirname, 'data', 'config_sistema.json');
            fs.writeFileSync(rutaConfig, JSON.stringify(memoriaEstado, null, 2));
        }
        
        // Avisamos a la placa por MQTT
        enviarConfigMQTT(data.uid);
        
        console.log(`✅ Motor ${data.nombre} y configuración de surcos guardados con éxito.`);
        res.json({ status: "ok" });
    } else {
        console.error("❌ Error: No se pudo identificar el motor para guardar.");
        res.status(404).json({ error: "Motor no encontrado. Intenta recargar el dashboard." });
    }
});
// 5. ELIMINAR MOTOR (Desvincular Placa)
app.post('/api/config/delete-motor', (req, res) => {
    const { uid } = req.body;
    memoriaEstado.motores = memoriaEstado.motores.filter(m => m.uid_esp !== uid);
    guardarConfig();
    console.log(`🗑️ Eliminado dispositivo UID ${uid}`);
    res.json({ status: "ok" });
});
// 6. PRUEBA DE MOTOR (TEST PWM EN VIVO)
app.post('/api/config/test-motor', (req, res) => {
    const { uid, idx, pwm, cmd } = req.body;
    
    // Tópico que escucha tu firmware: agp/quantix/{UID}/test
    // Payload esperado: { "cmd": "start", "pwm": 1500, "idx": 0 } 
    // (Asegúrate que tu firmware soporte 'idx' en el test, si no, moverá ambos o el por defecto)
    
    const topic = `agp/quantix/${uid}/test`;
    
    // Si tu firmware actual de test NO soporta idx, habrá conflicto si hay 2 motores.
    // Asumiremos que actualizaste el firmware para leer "idx" o "id" en el JSON de test.
    
    const payload = {
        cmd: cmd || 'start',
        pwm: pwm,
        id: idx // Enviamos el índice interno (0 o 1)
    };

    client.publish(topic, JSON.stringify(payload));
    
    // No logueamos cada movimiento del slider para no saturar consola
     console.log(`🔧 Test topico ${topic} ${uid} M${idx} -> PWM ${pwm} json ${JSON.stringify(payload)}`);
    
    res.json({ status: "ok" });
});
// 7. CALIBRACIÓN (NUEVA RUTA)
app.post('/api/config/calibrar', (req, res) => {
    const { uid, idx, pwm, pulsos, cmd } = req.body;
    
    // Tópico: agp/quantix/{UID}/cal
    // Este es el que escucha tu firmware en MQTT_Custom.cpp
    const topic = `agp/quantix/${uid}/cal`;
    
    const payload = {
        id: idx,         // 0 o 1
        cmd: cmd || 'stop',
        pwm: pwm || 0,
        pulsos: pulsos || 0 // Meta de pulsos (ej: 3600)
    };

    client.publish(topic, JSON.stringify(payload));
    
    console.log(`⚖️ Calibración ${uid} M${idx}: ${cmd} (Meta: ${pulsos})`);
    res.json({ status: "ok" });
});
// --- FUNCIONES AUXILIARES ---

function guardarConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(memoriaEstado, null, 2));
    } catch (e) { console.error("Error guardando config:", e); }
}

function enviarConfigMQTT(uid) {
    // Buscamos los 2 motores de este UID para armar el paquete completo
    const motores = memoriaEstado.motores.filter(m => m.uid_esp === uid);
    
    if (motores.length === 0) return;

    // Estructura que espera el ESP32 (según tu firmware MQTT_Custom)
    // OJO: Tu firmware actual espera: doc["control_pid"]["kp"], etc.
    // No soporta array de configs nativamente en el código que mostraste.
    // Tuviste que haber actualizado MQTT_Custom.cpp para soportar 'idx'.
    
    // Si tu firmware NO soporta arrays, enviamos 2 mensajes, uno para cada motor si el firmware distingue por tópico.
    // Pero tu firmware usa un solo tópico `.../config`.
    
    // ASUMIRÉ que actualizaste el firmware para leer un JSON con estructura:
    // { "configs": [ { "idx": 0, ... }, { "idx": 1, ... } ] }
    // O que enviarás los parámetros sueltos si solo hay 1 motor.
    
    const payload = {
        configs: motores.map(m => ({
            idx: m.indice_interno,
            config_pid: { // Ajustado al nombre en tu firmware
                kp: m.control_pid.kp,
                ki: m.control_pid.ki,
                kd: m.control_pid.kd,
                pid_time: m.control_pid.pid_time,
                max_integral: m.control_pid.max_integral
            },
            calibracion: m.calibracion,
            meter_cal: m.meter_cal
        }))
    };

    const topic = `agp/quantix/${uid}/config`;
    client.publish(topic, JSON.stringify(payload), { retain: true });
    console.log(`📤 Config enviada a ${topic}`);
}

// ========================================================
// 🚜 ALERTA DE CAMBIOS EN EL PILOTO AUTOMÁTICO (AOG)
// ========================================================

// Esta variable guarda la alerta hasta que el usuario la acepte
let alertaPiloto = {
    hayCambio: false,
    nuevasSecciones: 0,
    nuevosAnchos: []
};

// 1. El Bridge golpea esta ruta cuando detecta el PGN 235 diferente
app.post('/api/piloto/notificar-cambio', (req, res) => {
    const { secciones_detectadas, anchos_detectados } = req.body;
    console.log(`[API] ⚠️ Atención: AOG notificó un cambio a ${secciones_detectadas} secciones.`);
    
    alertaPiloto.hayCambio = true;
    alertaPiloto.nuevasSecciones = secciones_detectadas;
    alertaPiloto.nuevosAnchos = anchos_detectados;
    
    res.json({ success: true });
});

// 2. El Dashboard Web (app.js) consulta esta ruta al abrirse
app.get('/api/piloto/estado-cambios', (req, res) => {
    res.json(alertaPiloto);
});

// 3. El usuario le da al botón "Aceptar y Sincronizar" en el modal de la web
app.post('/api/piloto/aceptar-cambios', (req, res) => {
    if (alertaPiloto.hayCambio) {
        try {
            // 1. Actualizamos el objeto en memoria (asegurándonos de que existan los campos)
            if (!memoriaEstado.implemento) memoriaEstado.implemento = {};
            
            memoriaEstado.implemento.cantidad_secciones_aog = alertaPiloto.nuevasSecciones;
            memoriaEstado.implemento.anchos_secciones_aog = alertaPiloto.nuevosAnchos;
            
            const anchoTotalMetros = alertaPiloto.nuevosAnchos.reduce((a, b) => a + b, 0) / 100;
            memoriaEstado.implemento.ancho_total = anchoTotalMetros;

            // 2. GUARDADO REAL (Usando tu lógica de server.js)
            // En tu código, el archivo es path.join(__dirname, 'data', 'config_sistema.json')
            const rutaConfig = path.join(__dirname, 'data', 'config_sistema.json');
            fs.writeFileSync(rutaConfig, JSON.stringify(memoriaEstado, null, 2));
            
            console.log(`[API] ✅ Configuración sincronizada y guardada en: ${rutaConfig}`);

            // 3. Limpiamos la alerta para que deje de aparecer
            alertaPiloto.hayCambio = false;
            
            res.json({ success: true });
        } catch (error) {
            console.error("❌ Error al guardar la configuración:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        res.json({ success: true, message: "No había cambios pendientes" });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Quantix Server activo en http://localhost:${PORT}`);
});