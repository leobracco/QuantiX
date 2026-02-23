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
        const resultado = await fetch('/api/piloto/estado-cambios');
        const alerta = await resultado.json();
        
        if (alerta.hayCambio) {
            document.getElementById('lbl-nuevas-secciones').innerText = alerta.nuevasSecciones;
            const modal = new bootstrap.Modal(document.getElementById('modalAlertaPiloto'));
            modal.show();
        }
        const res = await fetch('http://localhost:8080/api/estado-sistema');
        const data = await res.json();
        if (data.mapa) MapEngine.mostrarMapaEnPantalla(data.mapa);
    } catch (e) { console.error("Error cargando estado inicial:", e); }
});

// Función para el botón "Aceptar y Sincronizar"
window.aceptarCambiosPiloto = async () => {
    try {
        await fetch('/api/piloto/aceptar-cambios', { method: 'POST' });
        // Recargar la página para que el Dashboard dibuje la nueva cantidad de secciones
        window.location.reload(); 
    } catch (e) {
        alert("Error al sincronizar los cambios.");
    }
};
// --- 2. MQTT (Suscripciones Precisas) ---
client.on('connect', () => {
    document.getElementById('mqtt-status-badge').className = "badge bg-success";
    document.getElementById('mqtt-status-badge').innerText = "ONLINE";
    
    // Suscribirse exactamente a lo que envía el Bridge
    client.subscribe("aog/machine/position"); 
    client.subscribe("aog/machine/speed");
    client.subscribe("agp/quantix/#"); 
    client.subscribe("sections/state");
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
        // --- ACTUALIZAR SECCIONES EN LA UI ---
if (topic === "sections/state") {
    try {
        const estados = JSON.parse(msgStr);
        // Sacamos la cantidad de secciones desde nuestra config oficial
        // state.config es donde deberías tener cargado el JSON que me mostraste
        const cantSecciones = state.config.implemento.cantidad_secciones_aog || 4;
        const container = document.getElementById('container-secciones-vivas');

        if (container) {
            // Si el número de cajitas no coincide con la config, las volvemos a crear
            if (container.children.length !== cantSecciones) {
                container.innerHTML = '';
                for (let i = 0; i < cantSecciones; i++) {
                    const div = document.createElement('div');
                    div.id = `sec-viva-${i}`;
                    div.className = 'rounded-1 border border-secondary';
                    // Calculamos el ancho dinámico para que entren todas
                    div.style.width = '30px';
                    div.style.height = '15px';
                    div.style.backgroundColor = '#333';
                    container.appendChild(div);
                }
            }

            // Actualizamos el color según el estado (ON/OFF)
            for (let i = 0; i < cantSecciones; i++) {
                const box = document.getElementById(`sec-viva-${i}`);
                if (box) {
                    box.style.backgroundColor = (estados[i] === 1) ? '#28a745' : '#444'; // Verde si ON, Gris si OFF
                    box.style.boxShadow = (estados[i] === 1) ? '0 0 8px #28a745' : 'none';
                }
            }
        }
    } catch (e) { console.error("Error visualizando secciones:", e); }
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
// ========================================================
// 🚜 VIGILANTE DE CAMBIOS EN EL PILOTO AUTOMÁTICO
// ========================================================
let modalAOG = null;
let alertaIgnorada = false;

// Consultar cada 3 segundos si el servidor tiene una alerta pendiente
setInterval(async () => {
    // Si el usuario le dio a "Ignorar", no lo molestamos más hasta que recargue la página
    if (alertaIgnorada) return; 
    
    try {
        const res = await fetch('/api/piloto/estado-cambios');
        const alerta = await res.json();
        
        if (alerta.hayCambio) {
            // Actualizamos el número en el cartel
            document.getElementById('lbl-nuevas-secciones').innerText = alerta.nuevasSecciones;
            
            // Inicializamos el modal si no existe
            if (!modalAOG) {
                modalAOG = new bootstrap.Modal(document.getElementById('modalAlertaPiloto'));
            }
            
            // Si el modal no está visible en pantalla, lo mostramos
            if (!document.getElementById('modalAlertaPiloto').classList.contains('show')) {
                modalAOG.show();
            }
        }
    } catch (e) {
        // Ignoramos errores de red silenciosamente
    }
}, 3000);

// Función para el botón amarillo "Aceptar y Sincronizar"
window.aceptarCambiosPiloto = async () => {
    // Bloqueamos nuevas consultas mientras aceptamos
    alertaIgnorada = true; 

    try {
        const response = await fetch('/api/piloto/aceptar-cambios', { method: 'POST' });
        const result = await response.json();
        
        if (result.success) {
            if (modalAOG) modalAOG.hide();
            console.log("Sincronización exitosa");
            // Recargamos para ver los cambios
            setTimeout(() => window.location.reload(), 500);
        } else {
            alert("Error al sincronizar: " + result.error);
            alertaIgnorada = false; // Reintentar si falló
        }
    } catch (e) {
        console.error("Error al sincronizar", e);
        alertaIgnorada = false;
    }
};
