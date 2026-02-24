const dgram = require("dgram");
const mqtt = require("mqtt");
const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");
const axios = require("axios");

const udpSocket = dgram.createSocket("udp4");
const mqttClient = mqtt.connect("mqtt://127.0.0.1");

const UDP_PORT = 17777;
const MAPA_PATH = path.join(__dirname, 'data', 'ultimo_mapa.json');
const CONFIG_URL = "http://localhost:8080/api/gis/config-implemento";

let mapaPrescripcion = null;
let configImplemento = null;
let velocidadActual = 0;
let latitud = 0;
let longitud = 0;
// --- LÓGICA DE SECCIONES Y RETARDO ---
let estadosSecciones = new Array(64).fill(0);      // Tren 1 (Inmediato)
let estadosSeccionesTren2 = new Array(64).fill(0); // Tren 2 (Retardado)
let historialSecciones = [];                       // Buffer de estados
let distanciaAcumulada = 0;                        // Odómetro virtual
let lastTimestamp = Date.now();

// --- 1. SINCRONIZACIÓN ---
async function sincronizarConfig() {
    try {
        const res = await axios.get(CONFIG_URL);
        configImplemento = res.data;
        console.log("⚙️ Bridge: Configuración sincronizada (64 secciones + Doble Tren)");
    } catch (e) { console.error("❌ Bridge: Error conectando con API"); }
}

function cargarMapa() {
    if (fs.existsSync(MAPA_PATH)) {
        try {
            mapaPrescripcion = JSON.parse(fs.readFileSync(MAPA_PATH));
            console.log("🗺️ Bridge: Mapa cargado");
        } catch (e) { console.error("❌ Error leyendo mapa"); }
    }
}

fs.watchFile(MAPA_PATH, () => cargarMapa());
setInterval(sincronizarConfig, 30000);
sincronizarConfig();
cargarMapa();

// --- 2. CÁLCULO DE DOSIS ---
async function procesarDosis(lat, lon) {
    if (!configImplemento || !configImplemento.motores || !configImplemento.implemento.maqueta) return;

    // 1. Obtener Dosis (Manual o Prescripción)
    let dosisBase = 0;
    try {
        const res = await axios.get("http://localhost:8080/api/gis/config-trabajo");
        if (res.data.dosisManual?.activo) {
            dosisBase = parseFloat(res.data.dosisManual.valor) || 0;
        } else if (mapaPrescripcion) {
            const punto = turf.point([lon, lat]);
            for (const f of mapaPrescripcion.features) {
                if (turf.booleanPointInPolygon(punto, f)) {
                    dosisBase = parseFloat(f.properties.SemillasxMetro || f.properties.Rate) || 0;
                    break;
                }
            }
        }
    } catch (e) { }

    const m_s = (velocidadActual > 0.5) ? (velocidadActual / 3.6) : 0;
    const distSurcos = 0.19; 

    // 2. Procesar cada motor basándose en la MAQUETA
    configImplemento.motores.forEach(motor => {
        // Buscamos a qué torre está asignado este motor en el modelo global
        const torre = configImplemento.implemento.maqueta.find(t => t.id === motor.id_maqueta);
        if (!torre) return; // Motor sin torre asignada, no gira.

        // En este modelo, supongamos que cada Torre corresponde a 1 Sección de AOG
        // O puedes mapearlo: Torre 1 -> Sección 1, Torre 2 -> Sección 2...
        const seccionIndex = torre.id - 1; 
        
        // SELECCIÓN DE TREN DESDE EL MODELO
        const seccionActiva = (torre.tren === 'trasero') 
            ? (estadosSeccionesTren2[seccionIndex] === 1)
            : (estadosSecciones[seccionIndex] === 1);

        let ppsTarget = 0;
        if (seccionActiva && dosisBase > 0 && m_s > 0) {
            const cpReal = parseFloat(motor.meter_cal) || 1.0;
            const factorDosis = (dosisBase > 500) ? (dosisBase * distSurcos / 10000) : dosisBase;
            ppsTarget = (factorDosis * m_s) / cpReal;
        }

        // Enviar orden al ESP32
        mqttClient.publish(`agp/quantix/${motor.uid_esp}/target`, JSON.stringify({
            id: motor.indice_interno, // 0 o 1 de la placa
            pps: parseFloat(ppsTarget.toFixed(2)),
            seccion_on: seccionActiva
        }));
    });
}

// --- 3. EVENTOS UDP ---
// Variables globales para tracking de heading
let posicionesHistorial = [];
const MAX_HISTORIAL = 5;
let ultimaPosicion = null;
let headingSuavizado = 0;
let ultimoTiempo = Date.now();

// Función principal para calcular heading
function calcularHeadingDesdePosiciones(latActual, lonActual) {
    const ahora = Date.now();
    const tiempoTranscurrido = ahora - ultimoTiempo;
    
    // Si es la primera posición, no podemos calcular heading
    if (!ultimaPosicion) {
        ultimaPosicion = { lat: latActual, lon: lonActual, timestamp: ahora };
        ultimoTiempo = ahora;
        return 0;
    }
    
    // Solo calcular si han pasado al menos 100ms y hay movimiento significativo
    if (tiempoTranscurrido < 100) {
        return headingSuavizado;
    }
    
    // Calcular distancia entre posiciones (en metros)
    const distancia = calcularDistanciaMetros(
        ultimaPosicion.lat, ultimaPosicion.lon,
        latActual, lonActual
    );
    
    // Si la distancia es muy pequeña (< 0.5m), mantener heading anterior
    if (distancia < 0.5) {
        ultimoTiempo = ahora;
        return headingSuavizado;
    }
    
    // Calcular heading bruto
    let headingBruto = calcularHeadingGPS(
        ultimaPosicion.lat, ultimaPosicion.lon,
        latActual, lonActual
    );
    
    // Agregar al historial
    posicionesHistorial.push({
        lat: latActual,
        lon: lonActual,
        heading: headingBruto,
        timestamp: ahora
    });
    
    // Mantener solo las últimas posiciones
    if (posicionesHistorial.length > MAX_HISTORIAL) {
        posicionesHistorial.shift();
    }
    
    // Suavizar heading con promedio circular
    headingSuavizado = suavizarHeading(posicionesHistorial);
    
    // Actualizar última posición
    ultimaPosicion = { lat: latActual, lon: lonActual, timestamp: ahora };
    ultimoTiempo = ahora;
    
    return headingSuavizado;
}

// Función para calcular heading entre dos puntos GPS
function calcularHeadingGPS(lat1, lon1, lat2, lon2) {
    // Convertir grados a radianes
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const lon1Rad = lon1 * Math.PI / 180;
    const lon2Rad = lon2 * Math.PI / 180;
    
    // Diferencia de longitudes
    const dLon = lon2Rad - lon1Rad;
    
    // Fórmula para calcular rumbo (heading)
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - 
              Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    
    let heading = Math.atan2(y, x);
    
    // Convertir de radianes a grados
    heading = heading * 180 / Math.PI;
    
    // Normalizar a 0-360 grados
    heading = (heading + 360) % 360;
    
    return heading;
}

// Función para suavizar heading (promedio circular)
function suavizarHeading(historial) {
    if (historial.length === 0) return 0;
    
    let sumSin = 0;
    let sumCos = 0;
    
    // Pesos: más peso a las mediciones recientes
    for (let i = 0; i < historial.length; i++) {
        const peso = (i + 1) / historial.length; // Pesos crecientes
        const headingRad = historial[i].heading * Math.PI / 180;
        
        sumSin += Math.sin(headingRad) * peso;
        sumCos += Math.cos(headingRad) * peso;
    }
    
    // Calcular promedio circular ponderado
    const avgHeadingRad = Math.atan2(
        sumSin / historial.length,
        sumCos / historial.length
    );
    
    let avgHeading = avgHeadingRad * 180 / Math.PI;
    avgHeading = (avgHeading + 360) % 360;
    
    return avgHeading;
}

// Función para calcular distancia en metros usando fórmula de Haversine
function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Radio de la Tierra en metros
    
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1Rad) * Math.cos(lat2Rad) * 
              Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distancia = R * c;
    
    return distancia;
}

// Función para detectar cambios bruscos de heading (giros)
function detectarCambioBrusco(headingNuevo, headingAnterior, umbral = 30) {
    if (!headingAnterior) return false;
    
    // Calcular diferencia angular (manejando el cruce 0/360)
    let diff = Math.abs(headingNuevo - headingAnterior);
    diff = Math.min(diff, 360 - diff);
    
    return diff > umbral;
}

// Función para resetear el cálculo de heading
function resetearHeading() {
    posicionesHistorial = [];
    ultimaPosicion = null;
    headingSuavizado = 0;
    ultimoTiempo = Date.now();
    console.log('Cálculo de heading reseteado');
}
// --- 3. EVENTOS UDP ---
udpSocket.on("message", (msg) => {
    // AgOpenGPS Header: 0x80 (0), 0x81 (1), Source (2), PGN (3)
    if (msg.length < 8) return; // Validación mínima
    const pgn = msg[3];

    // ---------------------------------------------------------
    // PGN 254 (0xFE): AutoSteer Data -> FUENTE FIABLE DE VELOCIDAD
    // ---------------------------------------------------------
    if (pgn === 254) { 
        // Unimos los dos bytes (Little Endian)
        //const speedRaw = msg.readInt16LE(4); // Byte 4 y 5
        
        // Convertimos a km/h (divisor 10 para corregir el desborde y escala)
        velocidadActual = msg.readInt16LE(5) / 10;
        
        // Publicamos la velocidad como un valor simple (String o JSON)
        // El Dashboard espera recibir aog/machine/speed
        mqttClient.publish("aog/machine/speed", velocidadActual.toFixed(1));
    }
    // ---------------------------------------------------------
    // PGN 235 (0xEB): CONFIGURACIÓN DE SECCIONES DESDE AOG
    // ---------------------------------------------------------
    // ---------------------------------------------------------
    // PGN 235 (0xEB): CONFIGURACIÓN DE SECCIONES DESDE AOG
    // ---------------------------------------------------------
    else if (pgn === 235) {
        if (msg.length >= 38) {
            const cantidadSeccionesAOG = msg[37]; 
            
            let anchos_cm = [];
            for (let i = 0; i < cantidadSeccionesAOG; i++) {
                anchos_cm.push(msg.readUInt16LE(5 + (i * 2)));
            }

            // Evitamos que crashee si configImplemento todavía no cargó
            const configActual = configImplemento?.cantidad_secciones_aog || 0;

            // Solo disparamos la alerta si el monitor tiene configuradas secciones
            // Y si ese número es diferente al que QuantiX conoce actualmente.
            if (cantidadSeccionesAOG > 0 && cantidadSeccionesAOG !== configActual) {
                console.log(`\n⚠️ ALERTA: AOG cambió a ${cantidadSeccionesAOG} secciones. QuantiX esperaba ${configActual}. Avisando al servidor...`);
                
                // 1. Enviar el paquete al Backend
                axios.post("http://localhost:8080/api/piloto/notificar-cambio", {
                    secciones_detectadas: cantidadSeccionesAOG,
                    anchos_detectados: anchos_cm
                }).catch(err => console.error("❌ Error enviando alerta al servidor:", err.message));
                
                // 2. Actualizamos la memoria temporal del Bridge para no "spamear" el POST
                if (configImplemento) {
                    configImplemento.cantidad_secciones_aog = cantidadSeccionesAOG;
                }
            }
        }
    }
    else if (pgn === 100) { 
    const longitud = msg.readDoubleLE(5);
    const latitud = msg.readDoubleLE(13);
    
    // Calcular heading basado en movimiento
    const headingCalculado = calcularHeadingDesdePosiciones(latitud, longitud);
    
    // También intentar leer heading del mensaje AOG si está disponible
    let headingFinal = headingCalculado;
    
    try {
        // Opción 1: Intentar leer heading como float en radianes (bytes 21-24)
        const headingRad = msg.readFloatLE(21);
        if (!isNaN(headingRad) && Math.abs(headingRad) < 10) {
            const headingFromMsg = headingRad * (180 / Math.PI);
            const headingNormalizado = (headingFromMsg + 360) % 360;
            
            // Combinar heading calculado con heading del mensaje
            // Dar más peso al heading del mensaje si es confiable
            const velocidad = calcularVelocidad(latitud, longitud);
            
            if (velocidad < 1.0) {
                // Baja velocidad: usar heading del mensaje (probablemente de IMU)
                headingFinal = headingNormalizado;
            } else {
                // Alta velocidad: mezclar ambos (70% calculado, 30% del mensaje)
                headingFinal = 0.7 * headingCalculado + 0.3 * headingNormalizado;
                headingFinal = (headingFinal + 360) % 360;
            }
            
            //console.log(`[BRIDGE] Heading combinado: Calculado=${headingCalculado.toFixed(1)}°, Mensaje=${headingNormalizado.toFixed(1)}°, Final=${headingFinal.toFixed(1)}°`);
        }
    } catch (e) {
        // Si no hay heading en el mensaje, usar el calculado
       // console.log(`[BRIDGE] Heading solo GPS: ${headingCalculado.toFixed(1)}°`);
    }
    
    // Armamos el JSON completo de posición
    const posPayload = JSON.stringify({
        lat: latitud,
        lon: longitud,
        heading: headingFinal
    });
    
    // Publicamos en el tópico que el Dashboard está escuchando
    mqttClient.publish("aog/machine/position", posPayload);
    
    // Opcional: Disparar el cálculo de dosis inmediatamente
    procesarDosis(latitud, longitud);
}
else if (pgn === 236) {
        // El PGN 236 trae la configuración del implemento armada en el monitor.
        // El Byte 5 contiene la cantidad de secciones configuradas.
        const cantidadSeccionesAOG = msg[5];
        
        // Si tenemos nuestra configuración cargada, verificamos si coinciden
        if (configImplemento && cantidadSeccionesAOG > 0) {
            // Asumimos que tienes una variable en QuantiX que guarda esto
            const cantidadSeccionesQuantiX = configImplemento.cantidad_secciones_aog || 0;

            // Si el monitor dice que hay 8 secciones, y QuantiX tiene 4, hay un cambio.
            if (cantidadSeccionesQuantiX !== 0 && cantidadSeccionesAOG !== cantidadSeccionesQuantiX) {
                console.log(`⚠️ ALERTA: Monitor configurado con ${cantidadSeccionesAOG} secciones. QuantiX esperaba ${cantidadSeccionesQuantiX}.`);
                
                // Aquí podrías enviar un mensaje al Dashboard (App.js) para que
                // muestre el cartel: "Cambió la config del piloto, ¿desea actualizar?"
                /*
                axios.post("http://localhost:8080/api/piloto/notificar-cambio", {
                    secciones_detectadas: cantidadSeccionesAOG
                }).catch(() => {});
                */
            }
        }
    }
    // ---------------------------------------------------------
    // PGN 229 (0xE5): 64 SECCIONES (Versión Extendida)
    // ---------------------------------------------------------
    else if (pgn === 229) {
        // En el PGN 229, los 8 bytes de secciones empiezan en el Byte 5
        let seccionesActuales = new Array(64).fill(0);
        
        for (let byteIdx = 0; byteIdx < 8; byteIdx++) {
            const byteValue = msg[5 + byteIdx]; 
            for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
                const idx = (byteIdx * 8) + bitIdx;
                if (idx < 64) {
                    seccionesActuales[idx] = (byteValue >> bitIdx) & 1;
                }
            }
        }
        
        // Actualizamos estados y disparamos lógica de retardo
        actualizarLogicaSecciones(seccionesActuales);
    }
    

});
/**
 * Procesa el estado de secciones, gestiona el odómetro y el retardo del Tren 2
 * @param {Array} seccionesActuales - Array de 64 enteros (0 o 1)
 */
function actualizarLogicaSecciones(seccionesActuales) {
    const now = Date.now();
    const dt = (now - lastTimestamp) / 1000;
    lastTimestamp = now;

    // 1. Calculamos el avance en metros basado en la velocidad actual
    const m_s = velocidadActual / 3.6;
    const avance = m_s * dt;
    distanciaAcumulada += avance;

    // 2. Actualizamos el Tren 1 (Inmediato)
    estadosSecciones = [...seccionesActuales];

    // 3. Gestionamos el historial para el Tren 2 (Retardado)
    const distTren2 = parseFloat(configImplemento?.distanciaEntreTrenes) || 1.2;
    
    historialSecciones.push({
        estados: [...seccionesActuales],
        distanciaMeta: distanciaAcumulada + distTren2
    });

    // 4. Limpieza de seguridad: Si el buffer es gigante (tractor quieto mucho tiempo), 
    // mantenemos solo lo necesario para no agotar la RAM
    if (historialSecciones.length > 2000) {
        historialSecciones.shift();
    }

    // 5. Procesamos la cola de retardo: 
    // Si la distancia acumulada ya superó la meta de algún punto del historial, 
    // ese estado "cae" al Tren 2.
    while (historialSecciones.length > 0 && distanciaAcumulada >= historialSecciones[0].distanciaMeta) {
        const puntoPasado = historialSecciones.shift();
        estadosSeccionesTren2 = puntoPasado.estados;
    }

    // 6. Notificamos al Dashboard el estado actual (Tren 1)
    mqttClient.publish("sections/state", JSON.stringify(estadosSecciones));
    
    // 7. IMPORTANTE: Disparamos el cálculo de dosis para actualizar los motores
    // Usamos las últimas coordenadas GPS guardadas globalmente
    if (latitud !== 0 && longitud !== 0) {
        procesarDosis(latitud, longitud);
    }
}
udpSocket.bind(UDP_PORT, () => console.log(`📡 Bridge AGP: 64 Secciones + Doble Tren en Puerto ${UDP_PORT}`));