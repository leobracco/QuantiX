/**
 * Quantix Pro - Motor Administration (V2)
 */
import { state } from './config.js';

let currentUidToAssign = null;
let currentEditingUid = null;     // UID del motor que se está editando
let currentEditingIdLogico = null; // ID lógico (indice interno) para pruebas PWM
let pollInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    // Iniciar búsqueda periódica de dispositivos nuevos
    startDiscoveryPolling();
    // Cargar la tabla inicial
    cargarConfiguracionTabla();
});

// --- 1. LÓGICA DE DESCUBRIMIENTO ---

function startDiscoveryPolling() {
    // Poll cada 4 segundos
    if(pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(buscarDispositivosNuevos, 4000);
    buscarDispositivosNuevos(); // Primera ejecución inmediata
}

async function buscarDispositivosNuevos() {
    try {
        const res = await fetch('/api/config/descubiertos');
        if (!res.ok) return;
        
        const lista = await res.json();
        const contenedor = document.getElementById('lista-descubiertos');
        const badge = document.getElementById('badge-nuevos');
        
        if (!contenedor) return;

        badge.innerText = lista.length;

        if (lista.length === 0) {
            contenedor.innerHTML = '<div class="p-3 text-center text-muted small">Sin dispositivos nuevos...</div>';
            return;
        }

        contenedor.innerHTML = '';
        lista.forEach(device => {
            const item = document.createElement('div');
            item.className = 'list-group-item bg-dark text-white border-secondary d-flex justify-content-between align-items-center px-2 py-2';
            item.innerHTML = `
                <div class="overflow-hidden me-2">
                    <div class="fw-bold text-truncate text-warning" title="${device.uid}" style="font-family:monospace;">${device.uid}</div>
                    <small class="text-muted" style="font-size:0.75rem;">IP: ${device.ip}</small>
                </div>
                <button class="btn btn-sm btn-outline-success" onclick="window.abrirModalAsignar('${device.uid}')">
                    <i class="fas fa-plus"></i>
                </button>
            `;
            contenedor.appendChild(item);
        });
    } catch (e) { 
        console.error("Error polling dispositivos", e); 
    }
}

// --- 2. LÓGICA DE TABLA CONFIGURADA ---

export async function cargarConfiguracionTabla() {
    try {
        const res = await fetch('/api/estado-sistema'); // Endpoint unificado
        if (!res.ok) return;

        const data = await res.json();
        const config = data.config; // Accedemos a la parte de config
        
        // Actualizamos el estado global
        if (config.motores) state.motores = config.motores;
        
        // Guardamos info de AOG para el modal
        if (config.anchosSecciones) state.seccionesAOG = config.anchosSecciones;

        const tbody = document.getElementById('tabla-motores');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (!config.motores || config.motores.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">No hay motores configurados</td></tr>';
            return;
        }

        // Ordenar por ID lógico para que aparezcan en orden: 1, 2, 3...
        const motoresOrdenados = [...config.motores].sort((a, b) => a.id_logico - b.id_logico);

        motoresOrdenados.forEach(m => {
            // Estimación visual: Motor impar es Semilla, par es Ferti (o Motor 1/2)
            // id_logico suele ser: 1, 2, 3, 4...
            const tipo = (m.id_logico % 2 !== 0) ? "Semilla" : "Ferti";
            const badgeColor = (tipo === "Semilla") ? "bg-success" : "bg-primary";
            
            // Si el nombre no está definido, usamos uno genérico
            const nombreDisplay = m.nombre || `Motor ${m.id_logico}`;

            const row = `
                <tr>
                    <td class="text-center fw-bold text-white">${m.id_logico}</td>
                    <td>
                        <div class="fw-bold">${nombreDisplay}</div>
                        <span class="badge ${badgeColor} text-dark" style="font-size:0.65rem">${tipo}</span>
                    </td>
                    <td>
                        <div class="text-monospace small text-muted">${m.uid_esp}</div>
                        <div class="small text-secondary" style="font-size:0.7rem">Secciones: [${m.secciones_aog || 'Todas'}]</div>
                    </td>
                    <td class="text-end">
                        <button class="btn btn-outline-info btn-sm border-0" onclick="window.abrirConfiguracionMotor('${m.uid_esp}', ${m.id_logico})">
                            <i class="fas fa-cog fa-lg"></i>
                        </button>
                    </td>
                </tr>
            `;
            tbody.innerHTML += row;
        });

    } catch (e) { console.error("Error cargando tabla motores", e); }
}

// --- 3. FUNCIONES GLOBALES (ASIGNACIÓN) ---

window.abrirModalAsignar = (uid) => {
    currentUidToAssign = uid;
    document.getElementById('modal-uid').innerText = uid;
    document.getElementById('input-nro-cuerpo').value = ""; // Limpiar input
    
    const el = document.getElementById('modalAsignar');
    const modal = new bootstrap.Modal(el);
    modal.show();
};

window.confirmarAsignacion = async () => {
    const nroCuerpo = document.getElementById('input-nro-cuerpo').value;
    if (!nroCuerpo || nroCuerpo < 1) return alert("Ingrese un número de cuerpo válido");

    try {
        const res = await fetch('/api/config/asignar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid: currentUidToAssign,
                numeroCuerpo: nroCuerpo
            })
        });

        const result = await res.json();
        
        if (result.status === "ok") {
            // Cerrar modal
            const el = document.getElementById('modalAsignar');
            const modal = bootstrap.Modal.getInstance(el);
            modal.hide();
            
            // Recargar datos inmediatamente
            buscarDispositivosNuevos();
            cargarConfiguracionTabla();
            
        } else {
            alert("Error al asignar: " + (result.error || "Desconocido"));
        }
    } catch (e) {
        console.error("Error en asignación", e);
        alert("Error de conexión al asignar");
    }
};

// --- 4. GESTIÓN DEL MODAL DE CONFIGURACIÓN AVANZADA ---

window.abrirConfiguracionMotor = (uid, id_logico) => {
    // 1. Buscar datos del motor en memoria
    const motor = state.motores.find(m => m.uid_esp === uid && m.id_logico === id_logico);
    if (!motor) return alert("Motor no encontrado en memoria local.");
    // --- CORRECCIÓN AQUÍ ---
    // Guardamos en variables globales del navegador (window)
    window.currentEditingUid = uid;
    window.currentEditingIdLogico = (motor.indice_interno !== undefined) 
                                    ? motor.indice_interno 
                                    : ((id_logico % 2 === 0) ? 1 : 0);
    // -----------------------

    currentEditingUid = uid; // Mantén estas para uso interno del módulo si quieres
    currentEditingIdLogico = window.currentEditingIdLogico;
    // Si 'indice_interno' no existe, lo deducimos: id_logico par = 1, impar = 0 (aprox)
    // O mejor, confiamos en que el backend lo guardó.
    currentEditingIdLogico = (typeof motor.indice_interno !== 'undefined') ? motor.indice_interno : ((id_logico % 2 === 0) ? 1 : 0);
    
    // 2. Llenar Header
    document.getElementById('conf-motor-title').innerHTML = `<i class="fas fa-cogs me-2"></i>Configurar: ${motor.nombre || 'Motor ' + id_logico}`;
    document.getElementById('conf-motor-uid').innerText = `UID: ${uid} | ID Lógico: ${id_logico}`;

    // 3. Llenar Tab DOSIS
    document.getElementById('input-metercal').value = motor.meter_cal || 50;
    document.getElementById('input-nombre').value = motor.nombre || '';

    // 4. Llenar Tab PID (Valores del JSON o defaults seguros)
    const pid = motor.control_pid || {};
    document.getElementById('input-kp').value = pid.kp ?? 2.5;
    document.getElementById('input-ki').value = pid.ki ?? 1.5;
    document.getElementById('input-kd').value = pid.kd ?? 0.0;
    
    const cal = motor.calibracion || {};
    document.getElementById('input-minpwm').value = cal.pwm_min ?? 40;
    document.getElementById('input-maxpwm').value = cal.pwm_max ?? 255; 
    
    // Estos son nuevos, si no existen en BD usar defaults
    document.getElementById('input-pidtime').value = pid.pid_time ?? 50;
    document.getElementById('input-maxint').value = pid.max_integral ?? 255;

    // 5. Resetear Zona de Pruebas
    const chkTest = document.getElementById('chk-test-live');
    if(chkTest) chkTest.checked = false;
    
    const slider = document.getElementById('slider-pwm-test');
    if(slider) {
        slider.value = 0;
        slider.disabled = true;
        // Ajustar el max del slider si se usa 12 bits
        const maxPwmConfig = cal.pwm_max > 255 ? 4095 : 255;
        slider.max = maxPwmConfig; 
    }
    if(document.getElementById('lbl-pwm-test')) document.getElementById('lbl-pwm-test').innerText = "0";
    if (state.config && state.config.implemento) {
        const impl = state.config.implemento;
        if(document.getElementById('input-surcos-totales')) 
            document.getElementById('input-surcos-totales').value = impl.surcos_totales || 80;
        
        if(document.getElementById('input-distancia-trenes'))
            document.getElementById('input-distancia-trenes').value = impl.distancia_entre_trenes || 1.5;
            
        if(document.getElementById('chk-doble-tren'))
            document.getElementById('chk-doble-tren').checked = (impl.tipo_tren === 'doble');
    }
    // 6. Llenar Tab SECCIONES AOG
    generarMatrizSecciones(motor);
    setTimeout(() => window.actualizarGemelo(), 300); // Darle tiempo a la UI para dibujar

    // 7. Mostrar Modal
    const el = document.getElementById('modalConfigMotor');
    const modal = new bootstrap.Modal(el);
    modal.show();
};

// --- NUEVA LÓGICA DE MATRIZ Y GEMELO DIGITAL ---

function generarMatrizSecciones(motor) {
    const head = document.getElementById('head-matriz');
    const body = document.getElementById('body-matriz');
    if (!head || !body) return;

    // --- LEER DEL JSON ACTUALIZADO ---
    // Buscamos la cantidad de secciones en la nueva ruta del JSON
    const totalSeccionesAOG = (state.config && state.config.implemento) 
        ? state.config.implemento.cantidad_secciones_aog 
        : 4; // 4 por defecto si no hay nada

    const cfgSecciones = motor.configuracion_secciones || [];

    console.log(`🛠️ Generando matriz para ${totalSeccionesAOG} secciones.`);

    // Generar Cabecera dinámicamente
    let trHead = `<tr><th style="width: 15%">Tren</th>`;
    for (let i = 1; i <= totalSeccionesAOG; i++) {
        trHead += `<th>Sec ${i}</th>`;
    }
    trHead += `</tr>`;
    head.innerHTML = trHead;

    // Función para generar las celdas de la tabla
    const generarCeldas = (tipoTren) => {
        let html = '';
        for (let i = 1; i <= totalSeccionesAOG; i++) {
            const cfg = cfgSecciones.find(c => c.seccion_aog === i && c.tipo === tipoTren);
            const checked = cfg ? 'checked' : '';
            const sIni = cfg ? cfg.surcos_inicio : '';
            const sFin = cfg ? cfg.surcos_fin : '';

            html += `
                <td>
                    <div class="form-check d-flex flex-column align-items-center">
                        <input class="form-check-input chk-matriz mb-1" type="checkbox" 
                               data-sec="${i}" data-tren="${tipoTren}" ${checked} 
                               onchange="window.actualizarGemelo()">
                        <div class="input-group input-group-sm" style="width: 70px;">
                            <input type="number" class="form-control px-1 text-center in-ini" 
                                   placeholder="1" value="${sIni}" onchange="window.actualizarGemelo()">
                            <input type="number" class="form-control px-1 text-center in-fin" 
                                   placeholder="20" value="${sFin}" onchange="window.actualizarGemelo()">
                        </div>
                    </div>
                </td>`;
        }
        return html;
    };

    // Llenar el cuerpo de la tabla
    body.innerHTML = `
        <tr><td class="fw-bold text-success small">FRONT</td>${generarCeldas('delantero')}</tr>
        <tr><td class="fw-bold text-primary small">REAR</td>${generarCeldas('trasero')}</tr>
    `;
}

// Dibuja el Gemelo Digital basado en los inputs actuales
window.actualizarGemelo = () => {
    const canvas = document.getElementById('canvas-maquina');
    if(!canvas) return;
    canvas.innerHTML = '';

    const surcosTotales = parseInt(document.getElementById('input-surcos-totales').value) || 96;
    const distTrenes = document.getElementById('input-distancia-trenes').value || 1.5;

    // 1. Icono del Tractor (Referencia de frente)
    canvas.innerHTML += `
        <div style="width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-bottom: 25px solid #ffcc00; margin-bottom: 20px; position:relative;">
            <span style="position:absolute; top:-18px; left:-25px; color:#ffcc00; font-size:9px; font-weight:bold; letter-spacing:1px;">TRACTOR</span>
        </div>`;

    // 2. Extraer asignaciones de la tabla
    const cfgVisual = [];
    document.querySelectorAll('.chk-matriz:checked').forEach(chk => {
        const td = chk.closest('td');
        const sIni = parseInt(td.querySelector('.in-ini').value) || 0;
        const sFin = parseInt(td.querySelector('.in-fin').value) || 0;
        if(sIni > 0 && sFin > 0) {
            cfgVisual.push({ tipo: chk.dataset.tren, inicio: sIni, fin: sFin });
        }
    });

    // 3. Función para dibujar cada tren con rangos específicos
    const dibujarFila = (nombre, tipo, surcoInicio, surcoFin) => {
        let html = `<div style="display:flex; align-items:center; margin-bottom:8px;">`;
        html += `<span style="color:#bbb; font-size:0.65rem; width:80px; text-align:right; margin-right:12px; font-weight:bold; text-transform:uppercase;">${nombre}</span>`;
        html += `<div style="display:flex; gap:2px; background:#1a1a1a; padding:6px; border-radius:3px; border:1px solid #333; flex-wrap: wrap; max-width: 700px;">`;
        
        for(let i = surcoInicio; i <= surcoFin; i++) {
            const asignado = cfgVisual.some(c => c.tipo === tipo && i >= c.inicio && i <= c.fin);
            
            let color = '#333'; // Gris oscuro (apagado)
            let glow = '';
            let border = '1px solid #444';

            if (asignado) {
                if (tipo === 'trasero') {
                    color = '#00d4ff'; // Azul Cyan para el trasero
                    glow = 'box-shadow: 0 0 8px rgba(0, 212, 255, 0.8);';
                    border = '1px solid #fff';
                } else {
                    color = '#28a745'; // VERDE para el delantero (así resaltan ambos)
                    glow = 'box-shadow: 0 0 8px rgba(40, 167, 69, 0.8);';
                    border = '1px solid #fff';
                }
            }
            
            html += `<div style="width:6px; height:18px; background-color:${color}; border-radius:1px; ${glow} border: ${border};" title="Surco ${i}"></div>`;
        }
        html += `</div></div>`;
        return html;
    };

    // --- DIBUJO DE LAS FILAS ---
    // Según tu indicación: Delantero es de 49 a 96
    canvas.innerHTML += dibujarFila("Delantero", "delantero", 49, 96);

    // Espaciado / Offset
    canvas.innerHTML += `
        <div style="height:25px; border-left:2px dashed #444; margin-left:92px; display:flex; align-items:center;">
            <span style="margin-left:10px; color:#aaa; font-size:0.6rem;">↕ DISTANCIA: ${distTrenes}m</span>
        </div>`;

    // Según tu indicación: Trasero es de 1 a 48
    canvas.innerHTML += dibujarFila("Trasero", "trasero", 1, 48);
};

// --- 5. FUNCIONES DE CALIBRACIÓN / TEST (PWM) ---

window.toggleMotorTest = () => {
    const active = document.getElementById('chk-test-live').checked;
    const slider = document.getElementById('slider-pwm-test');
    
    if(slider) slider.disabled = !active;
    
    if (!active) {
        // Al apagar, enviamos 0 PWM inmediatamente para seguridad
        if(slider) slider.value = 0;
        if(document.getElementById('lbl-pwm-test')) document.getElementById('lbl-pwm-test').innerText = "0";
        enviarComandoTest(0);
    }
};

window.updateTestPWM = (val) => {
    if(document.getElementById('lbl-pwm-test')) document.getElementById('lbl-pwm-test').innerText = val;
    enviarComandoTest(val);
};

window.setAsMinPWM = () => {
    const val = document.getElementById('slider-pwm-test').value;
    const input = document.getElementById('input-minpwm');
    if(input) {
        input.value = val;
        // Efecto visual flash
        input.style.backgroundColor = "#d4edda"; // Verde claro
        setTimeout(() => input.style.backgroundColor = "", 500);
    }
};

window.setAsMaxPWM = () => {
    const val = document.getElementById('slider-pwm-test').value;
    const input = document.getElementById('input-maxpwm');
    if(input) {
        input.value = val;
        // Efecto visual flash
        input.style.backgroundColor = "#d4edda";
        setTimeout(() => input.style.backgroundColor = "", 500);
    }
};

async function enviarComandoTest(pwmVal) {
    console.log(currentEditingUid)
    if (!currentEditingUid) 
        
        return;
    
    try {
        await fetch('/api/config/test-motor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid: currentEditingUid,
                idx: currentEditingIdLogico, // 0 o 1
                pwm: parseInt(pwmVal),
                cmd: 'start' // El firmware espera este comando
            })
        });
    } catch (e) { console.error("Error enviando test PWM", e); }
}

// --- 6. GUARDAR Y ELIMINAR ---

window.guardarConfiguracionMotor = async () => {
    if (!currentEditingUid) return;

    // Recolectar Secciones seleccionadas
 // Recolectar Secciones desde la Matriz
    const configuracionSecciones = [];
    document.querySelectorAll('.chk-matriz:checked').forEach(chk => {
        const td = chk.closest('td');
        const sIni = parseInt(td.querySelector('.in-ini').value) || 0;
        const sFin = parseInt(td.querySelector('.in-fin').value) || 0;
        
        configuracionSecciones.push({
            seccion_aog: parseInt(chk.dataset.sec),
            tipo: chk.dataset.tren,
            surcos_inicio: sIni,
            surcos_fin: sFin
        });
    });

    // Construir Objeto Payload
    const payload = {
        uid: currentEditingUid,
        nombre: document.getElementById('input-nombre').value,
        meter_cal: parseFloat(document.getElementById('input-metercal').value),
        control_pid: {
            kp: parseFloat(document.getElementById('input-kp').value),
            ki: parseFloat(document.getElementById('input-ki').value),
            kd: parseFloat(document.getElementById('input-kd').value),
            pid_time: parseInt(document.getElementById('input-pidtime').value),
            max_integral: parseFloat(document.getElementById('input-maxint').value)
        },
        calibracion: {
            pwm_min: parseInt(document.getElementById('input-minpwm').value),
            pwm_max: parseInt(document.getElementById('input-maxpwm').value)
        },
        // NUEVA ESTRUCTURA:
        configuracion_secciones: configuracionSecciones, 
        implemento: {
            surcos_totales: parseInt(document.getElementById('input-surcos-totales').value),
            distancia_trenes: parseFloat(document.getElementById('input-distancia-trenes').value),
            tipo_tren: document.getElementById('chk-doble-tren').checked ? 'doble' : 'simple'
        }
    };
    
    // Agregamos el id_logico para que el backend sepa exactamente a quién actualizar si hay nombres repetidos
    // (Asegurate que el backend maneje esto o busque por nombre)
    // Para compatibilidad con tu server.js actual que busca por nombre/uid:
    // payload.id_logico = ... (no es estrictamente necesario si el nombre es único)

    try {
        const res = await fetch('/api/config/update-motor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await res.json();
        if (result.status === "ok") {
            const el = document.getElementById('modalConfigMotor');
            const modal = bootstrap.Modal.getInstance(el);
            modal.hide();
            cargarConfiguracionTabla();
            
            // Opcional: Detener test si estaba activo
            enviarComandoTest(0); 
        } else {
            alert("Error al guardar: " + result.error);
        }
    } catch (e) { console.error(e); alert("Error de conexión"); }
};

window.eliminarMotorActual = async () => {
    if (!currentEditingUid) return;
    if (!confirm("¿ESTÁ SEGURO?\nEsta acción desvinculará este dispositivo.\n\nPara reactivarlo deberá asignarlo nuevamente.")) return;

    try {
        const res = await fetch('/api/config/delete-motor', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: currentEditingUid })
        });

        if (res.ok) {
            const el = document.getElementById('modalConfigMotor');
            const modal = bootstrap.Modal.getInstance(el);
            modal.hide();
            cargarConfiguracionTabla();
            buscarDispositivosNuevos(); // Volverá a aparecer en descubiertos
        } else {
            alert("Error al eliminar");
        }
    } catch (e) { console.error(e); }
};

// --- 7. LÓGICA DE CALIBRACIÓN DE DOSIS ---

let pulsosInicioTest = 0;
let monitorPulsosInterval = null;
// --- LÓGICA DE CALIBRACIÓN ---

window.iniciarCalibracion = async () => {
    // 1. Leer parámetros
    const pwm = document.getElementById('slider-calib-pwm').value;
    
    // Aquí puedes definir cuántas "vueltas" o pulsos quieres de meta.
    // Por defecto hardcodeamos una vuelta completa estándar o lo sacamos de un input extra si quisieras.
    // Supongamos 10 vueltas de 360 pulsos = 3600 pulsos.
    const pulsosMeta = 3600; 

    if (pwm < 10) return alert("Seleccione una velocidad (PWM) mayor a 0.");

    // 2. Preparar UI (Solo visual)
    document.getElementById('btn-start-calib').classList.add('d-none');
    document.getElementById('btn-stop-calib').classList.remove('d-none');
    document.getElementById('slider-calib-pwm').disabled = true;

    // 3. LIMPIEZA: Ponemos el input en 0 y el badge en texto
    const inputPulsos = document.getElementById('input-calib-pulsos');
    if(inputPulsos) inputPulsos.value = 0; // Reseteo numérico

    const badge = document.getElementById('lbl-pulsos-acumulados');
    if(badge) badge.innerText = "Iniciando...";

    // 4. ENVIAR COMANDO AL ESP32
    // Usamos la ruta de calibración específica que crearemos en server.js
    try {
        await fetch('/api/config/calibrar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid: currentEditingUid,
                idx: currentEditingIdLogico, // 0 o 1
                pwm: parseInt(pwm),
                pulsos: pulsosMeta, // <--- LE DECIMOS CUANTO GIRAR
                cmd: 'start'
            })
        });
    } catch (e) { console.error(e); }
};

window.detenerCalibracion = async () => {
    // UI Updates
    document.getElementById('btn-start-calib').classList.remove('d-none');
    document.getElementById('btn-stop-calib').classList.add('d-none');
    document.getElementById('slider-calib-pwm').disabled = false;

    // Enviamos STOP
    try {
        await fetch('/api/config/calibrar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid: currentEditingUid,
                idx: currentEditingIdLogico,
                cmd: 'stop'
            })
        });
    } catch (e) { console.error(e); }
    
    // NO HACEMOS NADA MÁS CON EL INPUT.
    // El input ya tiene el último valor que envió el ESP32 antes de frenar.
};

window.calcularYAplicarMeterCal = () => {
    const pulsos = parseFloat(document.getElementById('input-calib-pulsos').value);
    const peso = parseFloat(document.getElementById('input-calib-peso').value);

    if (!pulsos || pulsos <= 0) return alert("El ESP32 no reportó pulsos. ¿Giró el motor?");
    if (!peso || peso <= 0) return alert("Ingrese el peso recolectado.");

    // Fórmula: Pulsos Totales / Kilos Totales
    const nuevoMeterCal = (pulsos / peso).toFixed(2);

    document.getElementById('input-metercal').value = nuevoMeterCal;
    
    // Feedback
    const div = document.getElementById('resultado-calib');
    if(div) {
        div.style.display = 'block';
        div.innerHTML = `<strong>Resultado:</strong> ${pulsos} pulsos / ${peso} kg = <strong>${nuevoMeterCal}</strong> pp/u`;
    }
};
// Exportar funciones globales
window.cargarConfiguracionTabla = cargarConfiguracionTabla;
window.abrirModalAsignar = window.abrirModalAsignar; // Reafirmar exportación
window.confirmarAsignacion = window.confirmarAsignacion;