import { state } from "./config.js";

export let map = null;
let tractorMarker = null;
let autoCentrar = true;
let capaMapa = null;

let polySeccionesT1 = [];
let polySeccionesT2 = [];

export function inicializarMapa() {
  map = L.map("map", { zoomControl: false, attributionControl: false }).setView(
    [-34.0, -60.0],
    15,
  );
  L.control.zoom({ position: "bottomright" }).addTo(map);

  map.on("dragstart", () => {
    autoCentrar = false;
    const btn = document.getElementById("btn-recentrar");
    if (btn) btn.style.display = "block";
  });

  const centerControl = L.control({ position: "bottomleft" });
  centerControl.onAdd = function () {
    const div = L.DomUtil.create("div");
    div.innerHTML = `<button id="btn-recentrar" class="btn btn-primary shadow-lg border-light" style="display:none; border-radius: 50%; width: 55px; height: 55px; font-size: 1.5rem;"><i class="fas fa-crosshairs"></i></button>`;
    div.onclick = (e) => {
      e.stopPropagation();
      autoCentrar = true;
      document.getElementById("btn-recentrar").style.display = "none";
      if (tractorMarker)
        map.setView(tractorMarker.getLatLng(), map.getZoom(), {
          animate: true,
        });
    };
    return div;
  };
  centerControl.addTo(map);
}

export function mostrarMapaEnPantalla(geojson) {
  if (!map || !geojson) return;
  if (capaMapa) map.removeLayer(capaMapa);

  capaMapa = L.geoJSON(geojson, {
    style: function () {
      return {
        color: "#ffcc00",
        weight: 1,
        opacity: 0.8,
        fillColor: "#ffcc00",
        fillOpacity: 0.15,
      };
    },
  }).addTo(map);
  map.fitBounds(capaMapa.getBounds());
}

export function actualizarTractor(lat, lon, heading) {
  if (!map) return;

  // 1. Icono del Tractor (Triángulo puro sin flecha adentro)
  const iconHtml = `<div style="transform: rotate(${heading}deg); width: 0; height: 0; border-left: 12px solid transparent; border-right: 12px solid transparent; border-bottom: 28px solid #ffcc00; filter: drop-shadow(0px 4px 6px rgba(0,0,0,0.8));"></div>`;

  if (!tractorMarker) {
    tractorMarker = L.marker([lat, lon], {
      icon: L.divIcon({
        html: iconHtml,
        className: "",
        iconSize: [24, 28],
        iconAnchor: [12, 14],
      }),
      zIndexOffset: 1000,
    }).addTo(map);
  } else {
    tractorMarker.setLatLng([lat, lon]);
    tractorMarker.setIcon(
      L.divIcon({
        html: iconHtml,
        className: "",
        iconSize: [24, 28],
        iconAnchor: [12, 14],
      }),
    );
  }

  if (autoCentrar) map.setView([lat, lon], map.getZoom(), { animate: false });

  dibujarImplementoEnMapa(lat, lon, heading);
}

// 2. FUNCIÓN PARA PINTAR LAS SECCIONES SIN ESPERAR AL GPS
/**
 * Actualiza visualmente el color de las secciones en el mapa con retardo independiente
 */
export function actualizarColoresSecciones() {
  // 1. Verificación de seguridad
  if (!state.config || !state.config.implemento_activo) return;

  const geo = state.config.implemento_activo.geometria;
  const cantSecciones = geo.cantidad_secciones_aog || 4;

  // 2. Obtenemos los estados desglosados (que guardamos previamente en app.js)
  // Si por alguna razón no existen, usamos un array de ceros por defecto
  const estadosT1 =
    state.seccionesActivasT1 || new Array(cantSecciones).fill(0);
  const estadosT2 =
    state.seccionesActivasT2 || new Array(cantSecciones).fill(0);

  // 3. Recorrer los polígonos del mapa
  for (let i = 0; i < polySeccionesT1.length; i++) {
    if (i >= cantSecciones) break;

    // --- Lógica para el Tren 1 (Inmediato / Delantero) ---
    const isActivaT1 = estadosT1[i] === 1;
    const styleT1 = {
      fillColor: isActivaT1 ? "#28a745" : "#444444",
      fillOpacity: isActivaT1 ? 0.9 : 0.6,
    };

    if (polySeccionesT1[i]) {
      polySeccionesT1[i].setStyle(styleT1);
    }

    // --- Lógica para el Tren 2 (Retardado / Trasero) ---
    // Solo si la máquina es de doble tren y el polígono existe
    if (geo.tipo_tren === "doble" && polySeccionesT2[i]) {
      const isActivaT2 = estadosT2[i] === 1;
      const styleT2 = {
        fillColor: isActivaT2 ? "#28a745" : "#444444",
        fillOpacity: isActivaT2 ? 0.9 : 0.6,
      };

      polySeccionesT2[i].setStyle(styleT2);
    }
  }
}

function dibujarImplementoEnMapa(lat, lon, heading) {
  if (!state.config || !state.config.implemento_activo) return;

  const geo = state.config.implemento_activo.geometria;
  if (!geo || !geo.surcos_totales) return;

  const seccionesAOG = geo.anchos_secciones_aog || [];
  const cantSecciones = geo.cantidad_secciones_aog || seccionesAOG.length;
  const estados = state.seccionesActivas || new Array(cantSecciones).fill(0);

  const anchoTotalMetros = seccionesAOG.reduce((a, b) => a + b, 0) / 100;
  const distTrenesMetros = geo.distancia_trenes_m || 1.5;
  const esDoble = geo.tipo_tren === "doble";
  const offsetEnganche = 4.0;

  if (polySeccionesT1.length !== cantSecciones) {
    polySeccionesT1.forEach((p) => map.removeLayer(p));
    polySeccionesT2.forEach((p) => map.removeLayer(p));
    polySeccionesT1 = [];
    polySeccionesT2 = [];
    for (let i = 0; i < cantSecciones; i++) {
      polySeccionesT1.push(
        L.polygon([], { color: "#000", weight: 1 }).addTo(map),
      );
      polySeccionesT2.push(
        L.polygon([], { color: "#000", weight: 1 }).addTo(map),
      );
    }
  }

  const radHeading = (heading * Math.PI) / 180;
  const offsetPunto = (lat, lon, offsetX, offsetY) => {
    const latRad = (lat * Math.PI) / 180;
    const R = 6378137;
    const dLat =
      (offsetY * Math.cos(radHeading) - offsetX * Math.sin(radHeading)) / R;
    const dLon =
      (offsetY * Math.sin(radHeading) + offsetX * Math.cos(radHeading)) /
      (R * Math.cos(latRad));
    return [lat + (dLat * 180) / Math.PI, lon + (dLon * 180) / Math.PI];
  };

  let currentLeftX = -anchoTotalMetros / 2;

  for (let i = 0; i < cantSecciones; i++) {
    const anchoSecMetros =
      (seccionesAOG[i] || (anchoTotalMetros * 100) / cantSecciones) / 100;
    const rightX = currentLeftX + anchoSecMetros;

    const isActiva = estados[i] === 1;
    const fillColor = isActiva ? "#28a745" : "#444444";
    const fillOpacity = isActiva ? 0.9 : 0.6;

    const t1_Izq = offsetPunto(lat, lon, currentLeftX, -offsetEnganche);
    const t1_Der = offsetPunto(lat, lon, rightX, -offsetEnganche);
    const t1_Der_back = offsetPunto(lat, lon, rightX, -(offsetEnganche + 0.3));
    const t1_Izq_back = offsetPunto(
      lat,
      lon,
      currentLeftX,
      -(offsetEnganche + 0.3),
    );

    polySeccionesT1[i].setLatLngs([t1_Izq, t1_Der, t1_Der_back, t1_Izq_back]);
    polySeccionesT1[i].setStyle({ fillColor, fillOpacity });

    if (esDoble) {
      const t2_Izq = offsetPunto(
        lat,
        lon,
        currentLeftX,
        -(offsetEnganche + distTrenesMetros),
      );
      const t2_Der = offsetPunto(
        lat,
        lon,
        rightX,
        -(offsetEnganche + distTrenesMetros),
      );
      const t2_Der_back = offsetPunto(
        lat,
        lon,
        rightX,
        -(offsetEnganche + distTrenesMetros + 0.3),
      );
      const t2_Izq_back = offsetPunto(
        lat,
        lon,
        currentLeftX,
        -(offsetEnganche + distTrenesMetros + 0.3),
      );

      polySeccionesT2[i].setLatLngs([t2_Izq, t2_Der, t2_Der_back, t2_Izq_back]);
      polySeccionesT2[i].setStyle({ fillColor, fillOpacity, opacity: 1 });
    } else {
      polySeccionesT2[i].setStyle({ opacity: 0, fillOpacity: 0 });
    }
    currentLeftX = rightX + 0.05;
  }
}
