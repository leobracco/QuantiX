/**
 * Quantix Pro - App Logic (CORREGIDA)
 */
import { state, CONSTANTS } from "./config.js";
import * as MapEngine from "./map-engine.js";

// --- 1. INICIO ---
const client = mqtt.connect(CONSTANTS.BROKER_URL);

document.addEventListener("DOMContentLoaded", async () => {
  MapEngine.inicializarMapa();

  // CARGA INICIAL: Pedir al backend el mapa y configuración que ya existen
  try {
    const resultado = await fetch("/api/piloto/estado-cambios");
    const alerta = await resultado.json();

    if (alerta.hayCambio) {
      document.getElementById("lbl-nuevas-secciones").innerText =
        alerta.nuevasSecciones;
      const modal = new bootstrap.Modal(
        document.getElementById("modalAlertaPiloto"),
      );
      modal.show();
    }
    const res = await fetch("http://localhost:8080/api/estado-sistema");
    const data = await res.json();
    if (data.mapa) MapEngine.mostrarMapaEnPantalla(data.mapa);
  } catch (e) {
    console.error("Error cargando estado inicial:", e);
  }
});

// Función para el botón "Aceptar y Sincronizar"
window.aceptarCambiosPiloto = async () => {
  try {
    await fetch("/api/piloto/aceptar-cambios", { method: "POST" });
    // Recargar la página para que el Dashboard dibuje la nueva cantidad de secciones
    window.location.reload();
  } catch (e) {
    alert("Error al sincronizar los cambios.");
  }
};
// --- 2. MQTT (Suscripciones Precisas) ---
client.on("connect", () => {
  document.getElementById("mqtt-status-badge").className = "badge bg-success";
  document.getElementById("mqtt-status-badge").innerText = "ONLINE";

  // Suscribirse exactamente a lo que envía el Bridge
  client.subscribe("aog/machine/position");
  client.subscribe("aog/machine/speed");
  client.subscribe("agp/quantix/#");
  client.subscribe("sections/state");
});

client.on("message", (topic, message) => {
  try {
    const msgStr = message.toString();
    const data = JSON.parse(msgStr);

    // A. VELOCIDAD
    if (topic === "aog/machine/speed") {
      const speedVal = parseFloat(data);
      document.getElementById("speed-val").innerText = speedVal.toFixed(1);
    }
    // --- ACTUALIZAR SECCIONES EN LA UI ---
    // --- ACTUALIZAR SECCIONES EN LA UI (app.js) ---
    if (topic === "sections/state") {
      try {
        const estados = JSON.parse(msgStr);

        // Guardamos el estado en memoria para que el mapa lo sepa
        state.seccionesActivasT1 = data.t1; // Delantero
        state.seccionesActivasT2 = data.t2; // Trasero

        // Le ordenamos al mapa que cambie los colores de los rectángulos ¡YA!
        if (typeof MapEngine.actualizarColoresSecciones === "function") {
          MapEngine.actualizarColoresSecciones();
        }

        // Si la configuración aún no cargó, no intentamos actualizar las cajitas del menú
        if (!state.config || !state.config.implemento_activo) return;

        // Actualizamos las cajitas simuladas de la barra lateral
        const cantSecciones =
          state.config.implemento_activo.geometria.cantidad_secciones_aog || 4;
        const container = document.getElementById("container-secciones-vivas");

        if (container) {
          if (container.children.length !== cantSecciones) {
            container.innerHTML = "";
            for (let i = 0; i < cantSecciones; i++) {
              const div = document.createElement("div");
              div.id = `sec-viva-${i}`;
              div.className = "rounded-1 border border-secondary";
              div.style.width = "30px";
              div.style.height = "15px";
              div.style.backgroundColor = "#333";
              container.appendChild(div);
            }
          }

          for (let i = 0; i < cantSecciones; i++) {
            const box = document.getElementById(`sec-viva-${i}`);
            if (box) {
              box.style.backgroundColor = estados[i] === 1 ? "#28a745" : "#444";
              box.style.boxShadow =
                estados[i] === 1 ? "0 0 8px #28a745" : "none";
            }
          }
        }
      } catch (e) {
        console.error("Error visualizando secciones:", e);
      }
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
          state.motores[0]?.lastActual || 0,
        );
      }
      if (data.target > 0) {
        // Enviamos al server para que lo guarde en una base de datos de cobertura
        fetch("/api/guardar-cobertura", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lat: data.lat,
            lon: data.lon,
            dosis: data.actual,
            timestamp: Date.now(),
          }),
        });
      }
    }

    // C. STATUS MOTORES
    if (topic.includes("/status_live")) {
      try {
        const data = JSON.parse(message.toString());
        //console.log("TOPICO:" + message.toString());
        // data debe tener: { uid, id, rpm, pwm, pulsos, ... }
        // 1. Obtener la velocidad actual de la pantalla (ya que el Bridge la publica en speed-val)
        const velocidadKMH =
          parseFloat(document.getElementById("speed-val")?.innerText) || 0;
        const m_s = velocidadKMH / 3.6; // Convertimos a metros por segundo

        // 2. Calcular Dosis Real: (PPS * MeterCal) / Velocidad(m/s)
        // Esto nos da Semillas por Metro (o la unidad que uses en MeterCal)
        let dosisReal = 0;
        let dosisObjetivo = 0;
        if (m_s > 0.1) {
          // Solo calculamos si hay movimiento para evitar división por cero
          dosisReal = (data.pps_real * data.meter_cal) / m_s;
          dosisObjetivo = (data.pps_target * data.meter_cal) / m_s;
        }

        // 3. Actualizar la interfaz del motor específico
        //actualizarFichaMotorUI(data, dosisReal);
        actualizarFichaMotorUI(data, dosisReal || 0, dosisObjetivo || 0);
        actualizarDatosMotor(data);
      } catch (e) {
        console.error("Error parseando status MQTT", e);
      }
    }
  } catch (e) {
    /* Silenciamos errores de parseo de texto plano */
  }
});

// --- 3. CARGA DE MAPA REAL (CONECTADA AL BACKEND) ---
async function subirArchivosAlServer() {
  const fileInput = document.getElementById("map-upload");
  if (fileInput.files.length < 2) return alert("Seleccione .SHP y .DBF");

  const formData = new FormData();
  for (let f of fileInput.files) {
    const ext = f.name.toLowerCase().split(".").pop();
    formData.append(ext, f);
  }

  try {
    // 1. Subir para obtener columnas
    const res = await fetch("http://localhost:8080/api/get-columns", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();

    // 2. Mostrar selectores (Función que ya tienes o debes crear para el mapeo)
    renderMappingSelectors(data.columnas, data.tempFiles);
  } catch (e) {
    alert("Error conectando con el servidor de mapas");
  }
}

// Esta función es necesaria para que el usuario elija qué columna es la dosis
function renderMappingSelectors(columnas, tempFiles) {
  const area = document.getElementById("mapping-area"); // Asegúrate que este ID exista en tu HTML
  area.innerHTML = `
        <select id="select-dosis" class="form-select bg-dark text-white mb-2">
            ${columnas.map((c) => `<option value="${c}">${c}</option>`).join("")}
        </select>
        <button class="btn btn-success w-100" onclick="confirmarMapeo('${tempFiles.shp}', '${tempFiles.dbf}')">
            Confirmar Mapeo
        </button>
    `;
  area.style.display = "block";
}

window.confirmarMapeo = async (shp, dbf) => {
  const col = document.getElementById("select-dosis").value;
  const res = await fetch("http://localhost:8080/api/confirmar-mapa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tempFiles: { shp, dbf },
      mapping: { SemillasxMetro: col },
    }),
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

/**
 * Actualiza la UI con datos REALES recibidos del ESP32 por MQTT
 * Payload esperado: { uid, id (interno 0 o 1), rpm, pwm, pulsos, calibrando, ... }
 */
export function actualizarDatosMotor(data) {
  if (!data || !data.uid) return;

  // 1. TRADUCCIÓN DE IDs
  // El firmware de la placa envía el índice interno (0 o 1).
  const idxInterno =
    data.id !== undefined
      ? parseInt(data.id)
      : data.id_logico !== undefined
        ? parseInt(data.id_logico)
        : 0;

  // Buscamos a qué "ID Lógico" global corresponde este motor físico.
  const motorInfo = state.motores.find(
    (m) => m.uid_esp === data.uid && m.indice_interno === idxInterno,
  );

  // Si no lo encontramos en memoria, ignoramos el paquete (quizás es una placa no asignada)
  if (!motorInfo) return;

  const idLogicoGlobal = motorInfo.id_logico;
  const uniqueId = `${data.uid}-${idLogicoGlobal}`;

  // --- 2. ACTUALIZACIÓN DEL MODAL DE CONFIGURACIÓN ---
  const modalAbierto = document.getElementById("modalConfigMotor");
  const isModalOpen = modalAbierto && modalAbierto.classList.contains("show");

  if (isModalOpen) {
    // ¿El motor que estamos editando AHORA es el que mandó este paquete MQTT?
    const mismoUID = window.currentEditingUid === data.uid;
    const mismoID = window.currentEditingIdLogico === idLogicoGlobal;

    if (mismoUID && mismoID) {
      // A. Test PWM (Restaurado)
      const valPwmReales = data.pwm || data.pwm_out || 0;
      const lblPwm = document.getElementById("lbl-pwm-test");
      if (lblPwm) lblPwm.innerText = valPwmReales;

      // B. Calibración (Pulsos)
      const pulsosReales = data.pulsos || data.total_pulses || 0;

      const badgePulsos = document.getElementById("lbl-pulsos-acumulados");
      if (badgePulsos) {
        badgePulsos.innerText = `${pulsosReales} pulsos`;

        // Efecto visual: si gira o dice 'calibrando', el badge titila en verde.
        const estaMoviendo =
          data.rpm > 0 || data.pps_real > 0 || data.calibrando === true;
        badgePulsos.className = estaMoviendo
          ? "badge bg-success border border-light" // Activo
          : "badge bg-dark text-warning border border-secondary"; // Quieto
      }

      const inputPulsos = document.getElementById("input-calib-pulsos");
      if (inputPulsos) {
        inputPulsos.value = pulsosReales;
      }
    }
  }

  // --- 3. ACTUALIZACIÓN DEL DASHBOARD PRINCIPAL ---
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
    const res = await fetch("/api/piloto/estado-cambios");
    const alerta = await res.json();

    if (alerta.hayCambio) {
      // Actualizamos el número en el cartel
      document.getElementById("lbl-nuevas-secciones").innerText =
        alerta.nuevasSecciones;

      // Inicializamos el modal si no existe
      if (!modalAOG) {
        modalAOG = new bootstrap.Modal(
          document.getElementById("modalAlertaPiloto"),
        );
      }

      // Si el modal no está visible en pantalla, lo mostramos
      if (
        !document.getElementById("modalAlertaPiloto").classList.contains("show")
      ) {
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
    const response = await fetch("/api/piloto/aceptar-cambios", {
      method: "POST",
    });
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
// Activar/Desactivar Dosis Manual desde la UI
window.toggleDosisManual = async () => {
  const valorInput = document.getElementById("val-manual").value;
  const btn = document.querySelector("button[onclick='toggleDosisManual()']");

  // Si dice "Activar", lo prendemos. Si no, lo apagamos.
  const activando = btn.innerText.includes("Activar");

  try {
    await fetch("/api/gis/config-trabajo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dosisManual: {
          activo: activando,
          valor: activando ? parseFloat(valorInput) : 0,
        },
      }),
    });

    if (activando) {
      btn.innerText = "Desactivar Manual";
      btn.classList.replace("btn-outline-info", "btn-danger");
      alert(`Dosis manual activada a ${valorInput}`);
    } else {
      btn.innerText = "Activar Dosis Manual";
      btn.classList.replace("btn-danger", "btn-outline-info");
      document.getElementById("val-manual").value = "0";
      alert("Dosis manual desactivada. Volviendo a mapa (si hay).");
    }
  } catch (e) {
    console.error("Error cambiando dosis manual", e);
  }
};
// Función para actualizar o crear la tarjeta del motor en el panel derecho
function actualizarFichaMotorUI(data, dosisReal, dosisObjetivo) {
  const motorList = document.getElementById("motor-list");
  if (!motorList || !data) return;

  const motorUIId = `motor-card-${data.uid}-${data.id}`;
  let motorCard = document.getElementById(motorUIId);

  if (!motorCard) {
    motorCard = document.createElement("div");
    motorCard.id = motorUIId;
    motorCard.className =
      "motor-item p-2 mb-2 bg-dark rounded border border-secondary shadow-sm";
    motorList.appendChild(motorCard);
  }

  // BLINDAJE: Si por algún motivo llegan undefined, los convertimos a 0
  const dReal = typeof dosisReal === "number" ? dosisReal : 0;
  const dObj = typeof dosisObjetivo === "number" ? dosisObjetivo : 0;
  const ppsReal = data.pps_real || 0;

  // Lógica de colores (igual que antes)
  let colorDosis = "#28a745";
  if (dObj > 0) {
    const diff = Math.abs(dReal - dObj) / dObj;
    if (diff > 0.15) colorDosis = "#ffc107";
    if (dReal < 0.1 && dObj > 0.5) colorDosis = "#dc3545";
  } else {
    colorDosis = "#6c757d";
  }

  motorCard.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-1">
          <span class="badge ${data.id === 0 ? "bg-primary" : "bg-info"}" style="font-size:0.6rem;">M${data.id + 1}</span>
          <div class="text-end">
              <span class="fw-bold" style="color: ${colorDosis}; font-size: 1.1rem; font-family: 'Courier New', monospace;">
                  ${dReal.toFixed(1)}
              </span>
              <div style="font-size: 0.6rem; color: #888; margin-top: -5px;">
                  Objetivo: ${dObj.toFixed(1)} 
              </div>
          </div>
      </div>
      <div class="d-flex justify-content-between small text-secondary" style="font-size: 0.7rem;">
          <span>RPM: <b class="text-light">${data.rpm || 0}</b></span>
          <span>PPS: <b class="text-light">${ppsReal.toFixed(1)}</b></span>
      </div>
      <div class="progress mt-1" style="height: 4px; background-color: #222;">
          <div class="progress-bar ${data.load_pct > 90 ? "bg-danger" : "bg-success"}" 
               style="width: ${data.load_pct || 0}%; transition: width 0.3s;"></div>
      </div>
  `;
}
