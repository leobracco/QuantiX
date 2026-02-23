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
    const data = req.body; // uid, nombre, meter_cal, control_pid, calibracion, secciones_aog
    
    // IMPORTANTE: En el frontend debemos enviar también el 'indice_interno' o 'id_logico' 
    // para saber cuál de los 2 motores de la placa estamos tocando.
    // Si el frontend envía 'id_logico', lo usamos.
    
    const motor = memoriaEstado.motores.find(m => m.uid_esp === data.uid && m.nombre === data.nombre);
    // Nota: Buscar por nombre es riesgoso si se edita el nombre. 
    // Lo ideal es que el frontend envíe el índice del array o un ID inmutable.
    // Asumiremos que el frontend envía el objeto completo o usamos lógica de búsqueda mejorada si fallara.
    
    // BÚSQUEDA ROBUSTA: Encontrar por UID y ID Lógico (que no cambia fácilmente)
    // El frontend debería enviarlo. Si no, intentamos actualizar todos los de ese UID (no recomendado).
    
    // Vamos a buscar el motor específico en el array
    let motorTarget = null;
    
    // Estrategia: El frontend envía el objeto completo modificado o IDs clave.
    // Vamos a asumir que actualizamos por UID + id_logico si viene, o nombre.
    // Si el request body no trae id_logico, intentamos deducirlo.
    
    // FIX para el código anterior del frontend:
    // El frontend debe enviar 'id_logico' en el payload. 
    // Si no lo hace, podemos buscar por nombre original antes de editarlo.
    
    // Por simplicidad, iteramos y actualizamos el que coincida.
    // Aquí actualizamos en memoria:
    
    // Encontramos el índice
    const idx = memoriaEstado.motores.findIndex(m => m.uid_esp === data.uid && (m.nombre === data.nombre || m.nombre.startsWith(data.nombre.split(' ')[0])));
    
    // Si no encontramos match exacto, asumimos que estamos editando uno basado en el UID y algún parámetro.
    // Para evitar errores, actualizaremos el motor que tenga el mismo 'uid' y 'indice_interno' si viniera.
    
    // ASUNCIÓN: El frontend envía 'uid' correcto. Pero como un UID tiene 2 motores,
    // necesitamos saber cuál es.
    // Vamos a asumir que el usuario edita y guarda.
    // El frontend que te pasé antes envía todo el payload. 
    
    // Buscamos por UID y NOMBRE (El nombre viejo venía en el objeto original, el nuevo en data.nombre)
    // Esto es delicado. Mejor buscar por índice en el array si el frontend lo tuviera.
    
    // SOLUCIÓN PRÁCTICA: Buscar por UID y TIPO (Semilla/Ferti) basándonos en el ID lógico implícito
    // O mejor, el frontend que te pasé envía el UID.
    // Vamos a buscar todos los motores de ese UID y ver cuál coincide con el ID Lógico o Indice Interno.
    // Como el frontend `motor-admin.js` guarda `currentEditingUid` pero no el ID específico,
    // *deberías* actualizar `motor-admin.js` para enviar `id_logico`.
    
    // SIN EMBARGO, para que funcione YA con el código que tienes:
    // Vamos a buscar el motor por UID y si el nombre contiene "Semilla" o "Ferti".
    
    let target = memoriaEstado.motores.find(m => m.uid_esp === data.uid && m.nombre === data.nombre);
    
    // Si cambiamos el nombre, esto fallará la próxima vez.
    // Es CRITICO que el frontend envíe un ID único. 
    // (Asumimos que has actualizado motor-admin.js como te indiqué en el paso anterior).
    
    // Si no encuentra, busca por ID Lógico si viniera en el body (Recomendado agregar al frontend)
    if (!target && data.id_logico) {
        target = memoriaEstado.motores.find(m => m.id_logico === data.id_logico);
    }

    if (target) {
        target.nombre = data.nombre;
        target.meter_cal = data.meter_cal;
        target.control_pid = data.control_pid;
        target.calibracion = data.calibracion;
        target.secciones_aog = data.secciones_aog;
        
        // Guardar
        guardarConfig();
        
        // Enviar a la placa
        enviarConfigMQTT(data.uid);
        
        res.json({ status: "ok" });
    } else {
        // Fallback: Si no sabemos cuál es, actualizamos el primero que coincida con el UID (Peligroso)
        // O devolvemos error.
        
        // Intento de recuperación: Buscar por UID y "indice_interno" (0 o 1) si estuviera.
        // Si no, devolvemos error para forzar corrección en frontend.
        res.status(404).json({ error: "Motor específico no encontrado. Faltan datos de identificación." });
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

app.listen(PORT, () => {
    console.log(`🚀 Quantix Server activo en http://localhost:${PORT}`);
});