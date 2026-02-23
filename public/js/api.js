// public/js/api.js
export const API = {
    gis: {
        // Antes era /api/get-columns, ahora es /api/gis/get-columns
        async analizarColumnas(formData) {
            const res = await fetch('/api/gis/get-columns', { method: 'POST', body: formData });
            return await res.json();
        },
        // Antes era /api/confirmar-mapa
        async confirmarMapa(tempFiles, mapping) {
            const res = await fetch('/api/gis/confirmar-mapa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tempFiles, mapping })
            });
            return await res.json();
        },
        async cargarEstadoInicial() {
            const res = await fetch('/api/gis/estado-inicial'); // Crearemos esta ruta luego
            return await res.json();
        }
    }
};