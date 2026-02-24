/**
 * Quantix Pro - Motor Administration (V4 - Control Manual y Gemelo Dinámico)
 */
import { state } from "./config.js";

let currentUidToAssign = null;
let currentEditingUid = null;
let currentEditingIdLogico = null;
let pollInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  startDiscoveryPolling();
  cargarConfiguracionTabla();
});

// ========================================================
// 1. LÓGICA DE DESCUBRIMIENTO (POLLING)
// ========================================================
function startDiscoveryPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(buscarDispositivosNuevos, 4000);
  buscarDispositivosNuevos();
}

async function buscarDispositivosNuevos() {
  try {
    const res = await fetch("/api/config/descubiertos");
    if (!res.ok) return;

    const lista = await res.json();
    const contenedor = document.getElementById("lista-descubiertos");
    const badge = document.getElementById("badge-nuevos");

    if (!contenedor) return;
    badge.innerText = lista.length;

    if (lista.length === 0) {
      contenedor.innerHTML =
        '<div class="p-3 text-center text-muted small">Sin dispositivos nuevos...</div>';
      return;
    }

    contenedor.innerHTML = "";
    lista.forEach((device) => {
      contenedor.innerHTML += `
                <div class="list-group-item bg-dark text-white border-secondary d-flex justify-content-between align-items-center px-2 py-2">
                    <div class="overflow-hidden me-2">
                        <div class="fw-bold text-truncate text-warning" title="${device.uid}" style="font-family:monospace;">${device.uid}</div>
                        <small class="text-muted" style="font-size:0.75rem;">IP: ${device.ip}</small>
                    </div>
                    <button class="btn btn-sm btn-outline-success" onclick="window.abrirModalAsignar('${device.uid}')">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
            `;
    });
  } catch (e) {
    console.error("Error polling dispositivos", e);
  }
}

// ========================================================
// 2. TABLA PRINCIPAL DE MOTORES CONFIGURADOS
// ========================================================
export async function cargarConfiguracionTabla() {
  try {
    const res = await fetch("/api/estado-sistema");
    if (!res.ok) return;

    const data = await res.json();
    if (data.config.motores) state.motores = data.config.motores;
    if (data.config.implemento_activo)
      state.config = { implemento_activo: data.config.implemento_activo };

    const tbody = document.getElementById("tabla-motores");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (!state.motores || state.motores.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="text-center text-muted py-3">No hay motores configurados</td></tr>';
      return;
    }

    const motoresOrdenados = [...state.motores].sort(
      (a, b) => a.id_logico - b.id_logico,
    );

    motoresOrdenados.forEach((m) => {
      const tipo = m.id_logico % 2 !== 0 ? "Semilla" : "Ferti";
      const badgeColor = tipo === "Semilla" ? "bg-success" : "bg-primary";
      const nombreDisplay = m.nombre || `Motor ${m.id_logico}`;

      // Mostrar resumen de secciones asignadas en la tabla
      const cantSecciones = m.configuracion_secciones
        ? m.configuracion_secciones.length
        : 0;

      tbody.innerHTML += `
                <tr>
                    <td class="text-center fw-bold text-white">${m.id_logico}</td>
                    <td>
                        <div class="fw-bold">${nombreDisplay}</div>
                        <span class="badge ${badgeColor} text-dark" style="font-size:0.65rem">${tipo}</span>
                    </td>
                    <td>
                        <div class="text-monospace small text-muted">${m.uid_esp}</div>
                        <div class="small text-info fw-bold" style="font-size:0.7rem"><i class="fas fa-layer-group"></i> ${cantSecciones} Secciones asig.</div>
                    </td>
                    <td class="text-end">
                        <button class="btn btn-outline-info btn-sm border-0" onclick="window.abrirConfiguracionMotor('${m.uid_esp}', ${m.id_logico})">
                            <i class="fas fa-cog fa-lg"></i>
                        </button>
                    </td>
                </tr>
            `;
    });
  } catch (e) {
    console.error("Error cargando tabla", e);
  }
}

// ========================================================
// 3. ASIGNACIÓN DE NUEVOS MÓDULOS
// ========================================================
window.abrirModalAsignar = (uid) => {
  currentUidToAssign = uid;
  document.getElementById("modal-uid").innerText = uid;
  document.getElementById("input-nro-cuerpo").value = "";
  new bootstrap.Modal(document.getElementById("modalAsignar")).show();
};

window.confirmarAsignacion = async () => {
  const nroCuerpo = document.getElementById("input-nro-cuerpo").value;
  if (!nroCuerpo || nroCuerpo < 1)
    return alert("Ingrese un número de módulo válido");

  try {
    const res = await fetch("/api/config/asignar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: currentUidToAssign,
        numeroCuerpo: nroCuerpo,
      }),
    });

    if ((await res.json()).status === "ok") {
      bootstrap.Modal.getInstance(
        document.getElementById("modalAsignar"),
      ).hide();
      buscarDispositivosNuevos();
      cargarConfiguracionTabla();
    } else {
      alert("Error al asignar");
    }
  } catch (e) {
    alert("Error de conexión");
  }
};

// ========================================================
// 4. MODAL DE CONFIGURACIÓN Y GEMELO DIGITAL
// ========================================================

// ---> RESTAURAMOS LA MATRIZ DE SECCIONES <---
// ---> RESTAURAMOS LA MATRIZ DE SECCIONES (Ajustado a tu HTML) <---
// ---> MATRIZ DE SECCIONES (Genera la tabla completa dinámicamente) <---
function generarMatrizSecciones(motor) {
  const container = document.getElementById("container-secciones");
  if (!container) return;

  const totalSeccionesAOG =
    state.config?.implemento_activo?.geometria?.cantidad_secciones_aog || 4;
  const cfgSecciones = motor.configuracion_secciones || [];

  let html = `
        <table class="table table-dark table-sm table-bordered text-center align-middle" style="font-size: 0.8rem;">
            <thead class="bg-light text-dark">
                <tr><th style="width: 15%">Tren</th>`;
  for (let i = 1; i <= totalSeccionesAOG; i++) {
    html += `<th>Sec ${i}</th>`;
  }
  html += `   </tr>
            </thead>
            <tbody>`;

  const generarCeldas = (tipoTren) => {
    let celdasHtml = "";
    for (let i = 1; i <= totalSeccionesAOG; i++) {
      const cfg = cfgSecciones.find(
        (c) => c.seccion_aog === i && c.tipo === tipoTren,
      );
      const checked = cfg ? "checked" : "";
      const sIni = cfg ? cfg.surcos_inicio : "";
      const sFin = cfg ? cfg.surcos_fin : "";

      celdasHtml += `
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
    return celdasHtml;
  };

  html += `       <tr><td class="fw-bold text-success small">FRONT</td>${generarCeldas("delantero")}</tr>
                    <tr><td class="fw-bold text-primary small">REAR</td>${generarCeldas("trasero")}</tr>
                </tbody>
            </table>`;

  container.innerHTML = html;
}
window.abrirConfiguracionMotor = (uid, id_logico) => {
  const motor = state.motores.find(
    (m) => m.uid_esp === uid && m.id_logico === id_logico,
  );
  if (!motor) return alert("Motor no encontrado en memoria local.");

  window.currentEditingUid = currentEditingUid = motor.uid_esp;
  window.currentEditingIdLogico = currentEditingIdLogico = motor.id_logico;

  // Llenar Datos Básicos
  document.getElementById("conf-motor-title").innerHTML =
    `<i class="fas fa-cogs me-2"></i>Configurar: ${motor.nombre || "Motor " + id_logico}`;
  document.getElementById("conf-motor-uid").innerText =
    `UID: ${uid} | ID Lógico: ${id_logico}`;
  document.getElementById("input-nombre").value = motor.nombre || "";
  document.getElementById("input-metercal").value = motor.meter_cal || 50;

  // Llenar PID y Calibración
  const pid = motor.control_pid || {};
  const cal = motor.calibracion || {};
  document.getElementById("input-kp").value = pid.kp ?? 2.5;
  document.getElementById("input-ki").value = pid.ki ?? 1.5;
  document.getElementById("input-kd").value = pid.kd ?? 0.0;
  document.getElementById("input-pidtime").value = pid.pid_time ?? 50;
  document.getElementById("input-maxint").value = pid.max_integral ?? 255;
  document.getElementById("input-minpwm").value = cal.pwm_min ?? 40;
  document.getElementById("input-maxpwm").value = cal.pwm_max ?? 255;

  // Resetear Zona Test
  const slider = document.getElementById("slider-pwm-test");
  if (slider) {
    slider.value = 0;
    slider.disabled = true;
    slider.max = cal.pwm_max > 255 ? 4095 : 255;
  }
  if (document.getElementById("chk-test-live"))
    document.getElementById("chk-test-live").checked = false;
  if (document.getElementById("lbl-pwm-test"))
    document.getElementById("lbl-pwm-test").innerText = "0";

  // CARGAR DATOS DE GEOMETRÍA EN LOS INPUTS
  if (state.config && state.config.implemento_activo) {
    const geo = state.config.implemento_activo.geometria;
    if (document.getElementById("input-surcos-totales"))
      document.getElementById("input-surcos-totales").value =
        geo.surcos_totales || 96;
    if (document.getElementById("input-distancia-trenes"))
      document.getElementById("input-distancia-trenes").value =
        geo.distancia_trenes_m || 1.5;
    if (document.getElementById("chk-doble-tren"))
      document.getElementById("chk-doble-tren").checked =
        geo.tipo_tren === "doble";
  }

  // Dibujar la matriz manual y el gemelo digital
  generarMatrizSecciones(motor);
  setTimeout(() => window.actualizarGemelo(), 100);

  new bootstrap.Modal(document.getElementById("modalConfigMotor")).show();
};

window.actualizarGemelo = () => {
  const canvas = document.getElementById("canvas-maquina");
  if (!canvas) return;
  canvas.innerHTML = "";

  // LEER LOS VALORES EN VIVO DESDE LA PANTALLA
  const geo = state.config?.implemento_activo?.geometria || {
    surcos_totales: 96,
    tipo_tren: "doble",
    distancia_trenes_m: 1.5,
  };
  const inSurcos = document.getElementById("input-surcos-totales");
  const inTren = document.getElementById("chk-doble-tren");
  const inDist = document.getElementById("input-distancia-trenes"); // Leemos el input de distancia

  const surcosReales = inSurcos
    ? parseInt(inSurcos.value) || geo.surcos_totales
    : geo.surcos_totales;
  const esDoble = inTren ? inTren.checked : geo.tipo_tren === "doble";
  const distReales = inDist
    ? parseFloat(inDist.value) || geo.distancia_trenes_m || 1.5
    : geo.distancia_trenes_m || 1.5;

  // Extraer qué surcos están tildados en la tabla manualmente
  const cfgVisual = [];
  document.querySelectorAll(".chk-matriz:checked").forEach((chk) => {
    const td = chk.closest("td");
    const sIni = parseInt(td.querySelector(".in-ini").value) || 0;
    const sFin = parseInt(td.querySelector(".in-fin").value) || 0;
    if (sIni > 0 && sFin > 0) {
      cfgVisual.push({ tipo: chk.dataset.tren, inicio: sIni, fin: sFin });
    }
  });

  canvas.innerHTML += `
        <div class="d-flex flex-column align-items-center mb-3">
            <div style="width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-bottom: 25px solid #ffcc00;"></div>
            <span style="color:#ffcc00; font-size:10px; font-weight:bold; letter-spacing:1px; margin-top:2px;">TRACTOR</span>
        </div>`;

  const dibujarTren = (nombre, tipo, surcoInicio, surcoFin) => {
    let html = `<div class="d-flex align-items-center mb-2">`;
    html += `<span class="text-muted fw-bold text-end pe-2" style="font-size:0.65rem; width:70px; text-transform:uppercase;">${nombre}</span>`;
    html += `<div class="d-flex flex-wrap p-1 rounded" style="gap:2px; background:#1a1a1a; border:1px solid #333; max-width: 650px;">`;

    for (let i = surcoInicio; i <= surcoFin; i++) {
      const iluminar = cfgVisual.some(
        (c) => c.tipo === tipo && i >= c.inicio && i <= c.fin,
      );
      let color = "#333",
        border = "1px solid #444",
        glow = "";

      if (iluminar) {
        color = tipo === "trasero" ? "#00d4ff" : "#28a745";
        border = "1px solid #fff";
        glow = `box-shadow: 0 0 8px ${color};`;
      }
      html += `<div style="width:6px; height:18px; background-color:${color}; border-radius:1px; border:${border}; ${glow}" title="Surco ${i}"></div>`;
    }
    html += `</div></div>`;
    return html;
  };

  if (esDoble) {
    const mitad = Math.floor(surcosReales / 2);

    // 1. Dibujamos el tren delantero
    canvas.innerHTML += dibujarTren(
      "Delantero",
      "delantero",
      mitad + 1,
      surcosReales,
    );

    // 2. Dibujamos el espaciador con la medida de distancia
    canvas.innerHTML += `
            <div style="height:30px; border-left:2px dashed #666; margin-left:80px; position:relative; display:flex; align-items:center;">
                <span style="position:absolute; left:12px; color:#aaa; font-size:0.75rem; font-weight:bold; background:#212529; padding:2px 8px; border-radius:4px; border:1px solid #444; display:flex; align-items:center; gap:5px; white-space:nowrap;">
                    <i class="fas fa-arrows-alt-v text-warning"></i> ${distReales} m
                </span>
            </div>`;

    // 3. Dibujamos el tren trasero
    canvas.innerHTML += dibujarTren("Trasero", "trasero", 1, mitad);
  } else {
    canvas.innerHTML += dibujarTren("Principal", "trasero", 1, surcosReales);
  }
};
// ========================================================
// 5. GUARDAR Y ELIMINAR MOTOR
// ========================================================
window.guardarConfiguracionMotor = async () => {
  if (!currentEditingUid || typeof currentEditingIdLogico === "undefined")
    return;

  // 1. RECOLECTAR RANGOS DE LA MATRIZ (Vuelve el guardado manual)
  const configuracionSecciones = [];
  document.querySelectorAll(".chk-matriz:checked").forEach((chk) => {
    const td = chk.closest("td");
    const sIni = parseInt(td.querySelector(".in-ini").value) || 0;
    const sFin = parseInt(td.querySelector(".in-fin").value) || 0;

    if (sIni > 0 && sFin > 0) {
      configuracionSecciones.push({
        seccion_aog: parseInt(chk.dataset.sec),
        tipo: chk.dataset.tren,
        surcos_inicio: sIni,
        surcos_fin: sFin,
      });
    }
  });

  const payload = {
    uid: currentEditingUid,
    id_logico: currentEditingIdLogico,
    nombre: document.getElementById("input-nombre").value,
    meter_cal: parseFloat(document.getElementById("input-metercal").value),
    control_pid: {
      kp: parseFloat(document.getElementById("input-kp").value),
      ki: parseFloat(document.getElementById("input-ki").value),
      kd: parseFloat(document.getElementById("input-kd").value),
      pid_time: parseInt(document.getElementById("input-pidtime").value),
      max_integral: parseFloat(document.getElementById("input-maxint").value),
    },
    calibracion: {
      pwm_min: parseInt(document.getElementById("input-minpwm").value),
      pwm_max: parseInt(document.getElementById("input-maxpwm").value),
    },
    // Guardamos el array de secciones manuales
    configuracion_secciones: configuracionSecciones,

    // Enviamos la configuración geométrica
    implemento: {
      surcos_totales:
        parseInt(document.getElementById("input-surcos-totales").value) || 96,
      distancia_trenes:
        parseFloat(document.getElementById("input-distancia-trenes").value) ||
        1.5,
      tipo_tren: document.getElementById("chk-doble-tren").checked
        ? "doble"
        : "simple",
    },
  };

  try {
    const res = await fetch("/api/config/update-motor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if ((await res.json()).status === "ok") {
      // Actualizar la memoria del frontend
      if (state.config?.implemento_activo?.geometria) {
        state.config.implemento_activo.geometria.surcos_totales =
          payload.implemento.surcos_totales;
        state.config.implemento_activo.geometria.distancia_trenes_m =
          payload.implemento.distancia_trenes;
        state.config.implemento_activo.geometria.tipo_tren =
          payload.implemento.tipo_tren;
      }

      const mLocal = state.motores.find(
        (m) => m.uid_esp === payload.uid && m.id_logico === payload.id_logico,
      );
      if (mLocal) {
        mLocal.configuracion_secciones = configuracionSecciones;
      }

      bootstrap.Modal.getInstance(
        document.getElementById("modalConfigMotor"),
      ).hide();
      cargarConfiguracionTabla();
    } else {
      alert("Error al guardar la configuración.");
    }
  } catch (e) {
    alert("Error de conexión al guardar.");
  }
};

window.eliminarMotorActual = async () => {
  if (!currentEditingUid || !confirm("¿Desvincular este dispositivo?")) return;
  try {
    const res = await fetch("/api/config/delete-motor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: currentEditingUid }),
    });
    if (res.ok) {
      bootstrap.Modal.getInstance(
        document.getElementById("modalConfigMotor"),
      ).hide();
      cargarConfiguracionTabla();
      buscarDispositivosNuevos();
    }
  } catch (e) {
    console.error(e);
  }
};

// ========================================================
// 6. HERRAMIENTAS PWM Y CALIBRACIÓN
// ========================================================
window.toggleMotorTest = () => {
  const active = document.getElementById("chk-test-live").checked;
  const slider = document.getElementById("slider-pwm-test");
  if (slider) slider.disabled = !active;
  if (!active) {
    if (slider) slider.value = 0;
    if (document.getElementById("lbl-pwm-test"))
      document.getElementById("lbl-pwm-test").innerText = "0";
    enviarComandoTest(0);
  }
};

window.updateTestPWM = (val) => {
  if (document.getElementById("lbl-pwm-test"))
    document.getElementById("lbl-pwm-test").innerText = val;
  enviarComandoTest(val);
};

window.setAsMinPWM = () => {
  document.getElementById("input-minpwm").value =
    document.getElementById("slider-pwm-test").value;
};

window.setAsMaxPWM = () => {
  document.getElementById("input-maxpwm").value =
    document.getElementById("slider-pwm-test").value;
};

async function enviarComandoTest(pwmVal) {
  if (!currentEditingUid) return;
  try {
    await fetch("/api/config/test-motor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: currentEditingUid,
        idx: currentEditingIdLogico,
        pwm: parseInt(pwmVal),
        cmd: "start",
      }),
    });
  } catch (e) {}
}

window.iniciarCalibracion = async () => {
  const pwm = document.getElementById("slider-calib-pwm").value;
  if (pwm < 10) return alert("Seleccione velocidad PWM > 0.");

  document.getElementById("btn-start-calib").classList.add("d-none");
  document.getElementById("btn-stop-calib").classList.remove("d-none");
  document.getElementById("slider-calib-pwm").disabled = true;

  try {
    await fetch("/api/config/calibrar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: currentEditingUid,
        idx: currentEditingIdLogico,
        pwm: parseInt(pwm),
        pulsos: 3600,
        cmd: "start",
      }),
    });
  } catch (e) {}
};

window.detenerCalibracion = async () => {
  document.getElementById("btn-start-calib").classList.remove("d-none");
  document.getElementById("btn-stop-calib").classList.add("d-none");
  document.getElementById("slider-calib-pwm").disabled = false;

  try {
    await fetch("/api/config/calibrar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: currentEditingUid,
        idx: currentEditingIdLogico,
        cmd: "stop",
      }),
    });
  } catch (e) {}
};

window.calcularYAplicarMeterCal = () => {
  const pulsos = parseFloat(
    document.getElementById("input-calib-pulsos").value,
  );
  const peso = parseFloat(document.getElementById("input-calib-peso").value);
  if (!pulsos || !peso) return alert("Ingrese pulsos y peso.");

  const nuevoMeterCal = (pulsos / peso).toFixed(2);
  document.getElementById("input-metercal").value = nuevoMeterCal;
  document.getElementById("resultado-calib").innerHTML =
    `Resultado: <strong>${nuevoMeterCal}</strong> pp/u`;
};
// ========================================================
// 7. GESTIÓN DE PERFILES (CARGAR/GUARDAR/BORRAR)
// ========================================================

window.abrirModalPerfiles = () => {
  cargarListaPerfiles();
  new bootstrap.Modal(document.getElementById("modalPerfiles")).show();
};

async function cargarListaPerfiles() {
  const contenedor = document.getElementById("lista-perfiles-guardados");
  if (!contenedor) return;

  try {
    const res = await fetch("/api/perfiles");
    const perfiles = await res.json();

    contenedor.innerHTML = "";
    if (perfiles.length === 0) {
      contenedor.innerHTML = `<div class="text-center text-muted p-3 small">No hay perfiles guardados.</div>`;
      return;
    }

    perfiles.forEach((p) => {
      const fecha = new Date(p.fecha).toLocaleDateString();
      contenedor.innerHTML += `
                <div class="list-group-item bg-dark border-secondary d-flex justify-content-between align-items-center p-2 text-white">
                    <div>
                        <div class="fw-bold text-info">${p.nombre}</div>
                        <div class="small text-muted">Actualizado: ${fecha}</div>
                    </div>
                    <div>
                        <button class="btn btn-sm btn-primary me-1" title="Cargar" onclick="window.cargarPerfil('${p.archivo}')">
                            <i class="fas fa-folder-open"></i>
                        </button>
                        <button class="btn btn-sm btn-danger" title="Borrar" onclick="window.borrarPerfil('${p.archivo}')">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
    });
  } catch (e) {
    console.error("Error cargando perfiles", e);
  }
}

window.guardarPerfilActual = async () => {
  const input = document.getElementById("input-nombre-perfil");
  const nombre = input.value.trim();
  if (!nombre) return alert("Escribe un nombre para el perfil.");

  try {
    const res = await fetch("/api/perfiles/guardar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nombre }),
    });

    if (res.ok) {
      input.value = "";
      cargarListaPerfiles();
    } else {
      alert("Error al guardar perfil");
    }
  } catch (e) {
    console.error(e);
  }
};

window.cargarPerfil = async (archivo) => {
  if (
    !confirm(
      `¿Estás seguro de cargar el perfil ${archivo}?\nEsto reemplazará la configuración actual.`,
    )
  )
    return;

  try {
    const res = await fetch("/api/perfiles/cargar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archivo }),
    });

    if (res.ok) {
      alert("Perfil cargado correctamente.");
      window.location.reload(); // Recargamos para que todo el dashboard tome los nuevos datos
    } else {
      alert("Error al cargar perfil");
    }
  } catch (e) {
    console.error(e);
  }
};

window.borrarPerfil = async (archivo) => {
  if (!confirm(`¿Seguro que deseas eliminar el perfil ${archivo}?`)) return;

  try {
    const res = await fetch("/api/perfiles/borrar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archivo }),
    });

    if (res.ok) {
      cargarListaPerfiles();
    } else {
      alert("Error al borrar perfil");
    }
  } catch (e) {
    console.error(e);
  }
};
window.cargarConfiguracionTabla = cargarConfiguracionTabla;
window.abrirModalAsignar = window.abrirModalAsignar;
window.confirmarAsignacion = window.confirmarAsignacion;
