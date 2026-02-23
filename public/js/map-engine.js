/**
 * Motor de Mapas Offline - AGP-VR
 * Versión: Mapa de Aplicación en Tiempo Real
 */

let map;
let tractorMarker;
let pathLayer;      // Capa para la estela (trabajo actual)
let coverageLayer;  // Capa persistente para mapa de aplicación
let prescriptionLayer; // Capa del SHP cargado
let tractorIcon;

let lastPaintedPos = null; // Para control de distancia de pintado

export function inicializarMapa() {
    // 1. Configuración del contenedor
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        minZoom: 1,
        maxZoom: 22,
        fadeAnimation: false,
        zoomAnimation: false,
        inertia: false // Mayor rendimiento en hardware limitado
    }).setView([0, 0], 2);

    // 2. Definición del Icono del Tractor (SVG)
    tractorIcon = L.divIcon({
        className: 'tractor-icon-wrapper',
        html: `
            <div id="tractor-rotator" style="display:block; transition: transform 0.1s linear;">
                <svg width="40" height="40" viewBox="0 0 40 40">
                    <path d="M20 5 L35 35 L20 28 L5 35 Z" fill="#ffcc00" stroke="#000" stroke-width="2"/>
                </svg>
            </div>
        `,
        iconSize: [40, 40],
        iconAnchor: [20, 20]
    });

    // 3. Inicialización de Capas
    prescriptionLayer = L.layerGroup().addTo(map); // Capa del mapa de prescripción (fondo)
    coverageLayer = L.layerGroup().addTo(map);     // Capa de aplicación histórica
    pathLayer = L.layerGroup().addTo(map);         // Capa de trabajo en vivo
}

export function actualizarTractor(lat, lon, heading, target, actual) {
    if (!map || lat === 0 || lon === 0) return;

    const currentPos = L.latLng(lat, lon);

    // --- A. GESTIÓN DEL MARCADOR ---
    if (!tractorMarker) {
        tractorMarker = L.marker([lat, lon], { icon: tractorIcon }).addTo(map);
        map.setView([lat, lon], 18);
    } else {
        tractorMarker.setLatLng(currentPos);
    }

    // --- B. SEGUIMIENTO Y ROTACIÓN ---
    map.panTo(currentPos); // Centrado suave

    const el = tractorMarker.getElement();
    if (el) {
        const rotator = el.querySelector('#tractor-rotator');
        if (rotator) rotator.style.transform = `rotate(${heading}deg)`;
    }

    // --- C. MAPA DE APLICACIÓN (PINTADO) ---
    // Pintamos solo si hay dosis objetivo y nos hemos movido al menos 0.5 metros
    if (target > 0) {
        if (!lastPaintedPos || currentPos.distanceTo(lastPaintedPos) > 0.5) {
            pintarPuntoAplicacion(lat, lon, target, actual);
            lastPaintedPos = currentPos;
            
            // Opcional: Enviar al servidor para guardar LOG de aplicación
            // guardarLogAplicacion(lat, lon, actual);
        }
    }
}

function pintarPuntoAplicacion(lat, lon, target, actual) {
    const error = Math.abs(target - actual);
    const errorPct = (error / target) * 100;
    
    // Lógica de colores tipo semáforo
    let color = '#00ff00'; // Verde: Aplicación perfecta
    if (errorPct > 15) color = '#ff0000';      // Rojo: Error crítico
    else if (errorPct > 7) color = '#ffff00';  // Amarillo: Fuera de rango

    // Usamos circleMarker para optimizar el renderizado de miles de puntos
    L.circleMarker([lat, lon], {
        radius: 4, // Esto se puede escalar según el ancho real de la máquina
        color: color,
        fillColor: color,
        fillOpacity: 0.6,
        stroke: false,
        interactive: false // Desactiva eventos para ganar velocidad
    }).addTo(coverageLayer);
}

export function mostrarMapaEnPantalla(geojson) {
    if (!map || !geojson) return;
    
    // Limpiar prescripción anterior si existiera
    prescriptionLayer.clearLayers();

    const layer = L.geoJSON(geojson, {
        style: function(feature) {
            // Intentamos obtener el valor de la dosis para dar un color de fondo
            const dosis = feature.properties.SemillasxMetro || feature.properties.KilosxHectarea || 0;
            return {
                color: "#28a745",
                weight: 1,
                fillColor: dosis > 0 ? "#28a745" : "#444",
                fillOpacity: 0.15
            };
        },
        onEachFeature: (feature, layer) => {
            // Popup con info de la zona al hacer clic
            const p = feature.properties;
            layer.bindPopup(`<b>Zona: ${p.Name || 'S/N'}</b><br>Dosis: ${p.SemillasxMetro || p.KilosxHectarea || 0}`);
        }
    }).addTo(prescriptionLayer);

    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds);
}

/**
 * Limpia el mapa de aplicación (cobertura) actual
 */
export function limpiarCobertura() {
    coverageLayer.clearLayers();
    lastPaintedPos = null;
}