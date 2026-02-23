/**
 * Quantix Pro - App Logic (CORREGIDA)
 */
import { state, CONSTANTS } from './config.js';
import * as MapEngine from './map-engine.js';

// --- 1. INICIO ---
const client = mqtt.connect(CONSTANTS.BROKER_URL);

document.addEventListener('DOMContentLoaded', async () => {
    MapEngine.inicializarMapa();
    
    // CARGA INICIAL: Pedir al backend el mapa y configuración que ya existen
    try {
        const res = await fetch('http://localhost:8080/api/estado-sistema');
        const data = await res.json();
        if (data.mapa) MapEngine.mostrarMapaEnPantalla(data.mapa);
    } catch (e) { console.error("Error cargando estado inicial:", e); }
});

// --- 2. MQTT (Suscripciones Precisas) ---
client.on('connect', () => {
    document.getElementById('mqtt-status-badge').className = "badge bg-success";
    document.getElementById('mqtt-status-badge').innerText = "ONLINE";
    
    // Suscribirse exactamente a lo que envía el Bridge
    client.subscribe("aog/machine/position"); 
    client.subscribe("aog/machine/speed");
    client.subscribe("agp/quantix/#"); 
});

client.on('message', (topic, message) => {
    try {
        const msgStr = message.toString();
        const data = JSON.parse(msgStr);
        
        // A. VELOCIDAD
        if (topic === "aog/machine/speed") {
            const speedVal = parseFloat(data);
            document.getElementById('speed-val').innerText = speedVal.toFixed(1);
        }

        // B. POSICIÓN TRACTOR (AQUÍ SE MUESTRA EL TRACTOR)
        if (topic === "aog/machine/position") {
            if (data.lat && data.lon) {
                // Actualizamos el marcador en el MapEngine
                MapEngine.actualizarTractor(
                    data.lat, 
                    data.lon, 
                    data.heading || 0, 
                    state.motores[0]?.lastTarget || 0, 
                    state.motores[0]?.lastActual || 0
                );
            }
            if (data.target > 0) {
    // Enviamos al server para que lo guarde en una base de datos de cobertura
    fetch('/api/guardar-cobertura', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            lat: data.lat,
            lon: data.lon,
            dosis: data.actual,
            timestamp: Date.now()
        })
    });
}
        }

        // C. STATUS MOTORES
        if (topic.includes('/status_live')) {
        try {
            const data = JSON.parse(message.toString());
            console.log("TOPICO:"+message.toString())
            // data debe tener: { uid, id, rpm, pwm, pulsos, ... }
            
            actualizarDatosMotor(data);

        } catch (e) { console.error("Error parseando status MQTT", e); }
    }

    } catch (e) { /* Silenciamos errores de parseo de texto plano */ }
});

// --- 3. CARGA DE MAPA REAL (CONECTADA AL BACKEND) ---
async function subirArchivosAlServer() {
    const fileInput = document.getElementById('map-upload');
    if (fileInput.files.length < 2) return alert("Seleccione .SHP y .DBF");

    const formData = new FormData();
    for (let f of fileInput.files) {
        const ext = f.name.toLowerCase().split('.').pop();
        formData.append(ext, f);
    }

    try {
        // 1. Subir para obtener columnas
        const res = await fetch('http://localhost:8080/api/get-columns', { method: 'POST', body: formData });
        const data = await res.json();
        
        // 2. Mostrar selectores (Función que ya tienes o debes crear para el mapeo)
        renderMappingSelectors(data.columnas, data.tempFiles);
    } catch (e) { alert("Error conectando con el servidor de mapas"); }
}

// Esta función es necesaria para que el usuario elija qué columna es la dosis
function renderMappingSelectors(columnas, tempFiles) {
    const area = document.getElementById('mapping-area'); // Asegúrate que este ID exista en tu HTML
    area.innerHTML = `
        <select id="select-dosis" class="form-select bg-dark text-white mb-2">
            ${columnas.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <button class="btn btn-success w-100" onclick="confirmarMapeo('${tempFiles.shp}', '${tempFiles.dbf}')">
            Confirmar Mapeo
        </button>
    `;
    area.style.display = 'block';
}

window.confirmarMapeo = async (shp, dbf) => {
    const col = document.getElementById('select-dosis').value;
    const res = await fetch('http://localhost:8080/api/confirmar-mapa', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            tempFiles: { shp, dbf },
            mapping: { SemillasxMetro: col }
        })
    });
    const geojson = await res.json();
    MapEngine.mostrarMapaEnPantalla(geojson);
};

/**
 * Actualiza la UI con datos en tiempo real recibidos por MQTT/Websocket
 * @param {Object} data - Payload JSON: { uid, id, rpm, pwm, pulsos, pps_real, ... }
 */
/**
 * Actualiza la UI con datos en tiempo real recibidos por MQTT/Websocket
 */
/**
 * Actualiza la UI con datos REALES recibidos del ESP32
 * data = { uid, id, rpm, pwm, pulsos, ... }
 */
// js/app.js

export function actualizarDatosMotor(data) {
    if (!data || !data.uid) return;

    // Normalizamos: Si el dato viene como 'id_logico' o 'id', usamos lo que haya.
    // El firmware corregido envía 'id' (0 o 1).
    const incomingId = (data.id !== undefined) ? data.id : data.id_logico;

    const uniqueId = `${data.uid}-${incomingId}`;

    // --- 1. ACTUALIZACIÓN DEL MODAL ---
    const modalAbierto = document.getElementById('modalConfigMotor');
    const isModalOpen = modalAbierto && modalAbierto.classList.contains('show');
    
    if (isModalOpen) {
        // Comparamos usando '==' para tolerar diferencias de tipo (string vs number)
        const mismoUID = (window.currentEditingUid === data.uid);
        const mismoID = (window.currentEditingIdLogico == incomingId);

        if (mismoUID && mismoID) {
            
            // A. PWM Test
            const lblPwm = document.getElementById('lbl-pwm-test');
            if (lblPwm) lblPwm.innerText = data.pwm || data.pwm_out || 0;

            // B. Calibración (Pulsos)
            const badgePulsos = document.getElementById('lbl-pulsos-acumulados');
            const inputPulsos = document.getElementById('input-calib-pulsos');
            
            const pulsosReales = data.pulsos || data.total_pulses || 0;

            if (badgePulsos) {
                badgePulsos.innerText = `${pulsosReales} pulsos`;
                
                // CONDICIÓN MEJORADA: Se enciende si hay RPM, PPS o si está la bandera 'calibrando'
                const estaMoviendo = (data.rpm > 0) || (data.pps_real > 0) || (data.calibrando === true);
                
                badgePulsos.className = estaMoviendo 
                    ? "badge bg-success blink"  // Verde parpadeando
                    : "badge bg-dark text-warning"; // Quieto
            }

            if (inputPulsos) {
                inputPulsos.value = pulsosReales;
            }
        }
    }

    // --- 2. DASHBOARD ---
    const elRpm = document.getElementById(`rpm-${uniqueId}`);
    if (elRpm) elRpm.innerText = Math.round(data.rpm || 0);

    const elPwmBar = document.getElementById(`pwm-bar-${uniqueId}`);
    if (elPwmBar) {
        const valPwm = data.pwm || data.pwm_out || 0;
        const pct = Math.min((valPwm / 4095) * 100, 100);
        elPwmBar.style.width = `${pct}%`;
    }
}