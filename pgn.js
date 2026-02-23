const dgram = require('dgram');
const server = dgram.createSocket('udp4');
const PORT = 17777;

let estado = {
    lat: 0, lon: 0,
    v_gps: 0, v_steer: 0, v_machine: 0,
    h_dual: 0, h_true: 0, h_imu: 0,
    sats: 0, fix: 0,
    secciones: "00000000",
    lastUpdate: 0
};

server.on('message', (msg, rinfo) => {
    // Validar encabezado AOG (0x80 0x81)
    if (msg.length < 4 || msg[0] !== 0x80 || msg[1] !== 0x81) return;

    const pgn = msg[3];
    estado.lastUpdate = Date.now();

    switch (pgn) {
        // --- PGN 214 (0xD6): Main Antenna Data ---
        // Aquí es donde SK21 busca Lat, Lon, Heading y Speed
        case 214: 
            // Según SK21: Lon (Double), Lat (Double), Headings (Floats)
            // Aseguramos que el buffer sea lo suficientemente largo (51 bytes de data + 6 de header)
            if (msg.length >= 50) {
                
                estado.h_dual = msg.readFloatLE(21); // Heading True Dual
                estado.h_true = msg.readFloatLE(25); // Heading True
                estado.v_gps = msg.readFloatLE(29);  // Velocidad real (Float)
                estado.sats = msg.readInt16LE(41);
                estado.fix = msg[43];
            }
            break;
            
    
        case 100:
   
        estado.lon = msg.readDoubleLE(5);
        estado.lat = msg.readDoubleLE(13);
            break;
        // --- PGN 254 (0xFE): Steer Data ---
        case 254:
            // Velocidad de respaldo (2 bytes LE) - Divisor 10 según AgIO
            estado.v_steer = msg.readInt16LE(5) / 10;
            break;

        // --- PGN 211 (0xD3): From IMU ---
        case 211:
            // Heading de la IMU (Divisor 10)
            estado.h_imu = msg.readInt16LE(5) / 10;
            break;

        // --- PGN 239 (0xEF): Machine Data ---
        case 239:
            estado.v_machine = msg[6] / 10; // Velocidad limitada (1 byte)
            estado.secciones = msg[11].toString(2).padStart(8, '0');
            break;
            
        // --- PGN 253 (0xFD): From Autosteer ---
        // A veces el Heading IMU consolidado viene por acá
        case 253:
            const imuHeadFromSteer = msg.readInt16LE(7) / 10;
            if (imuHeadFromSteer !== 0) estado.h_imu = imuHeadFromSteer;
            break;
    }
});

// Reporte cada 5 segundos
setInterval(() => {
    console.clear();
    const ago = (Date.now() - estado.lastUpdate) / 1000;
    
    console.log(`====================================================`);
    console.log(`🛰️  DIAGNÓSTICO AGP-VR (Basado en SK21)`);
    console.log(`⏱️  Último paquete: ${ago.toFixed(1)}s atrás`);
    console.log(`====================================================`);
    
    if (ago > 2) {
        console.log(`❌ ALERTA: No se reciben datos UDP en el puerto ${PORT}`);
        console.log(`   Verifica que AgIO tenga activa la salida UDP.`);
        return;
    }

    console.log(`📍 POSICIÓN (PGN 214):`);
    console.log(`   Lat: ${estado.lat.toFixed(8)}`);
    console.log(`   Lon: ${estado.lon.toFixed(8)}`);
    console.log(`   Satélites: ${estado.sats} | Fix: ${estado.fix}`);
    
    console.log(`\n🧭 RUMBOS (HEADING):`);
    console.log(`   Dual Antenna: ${estado.h_dual.toFixed(2)}°`);
    console.log(`   True Course:  ${estado.h_true.toFixed(2)}°`);
    console.log(`   IMU Sensor:   ${estado.h_imu.toFixed(2)}°`);
    
    console.log(`\n🚀 VELOCIDAD:`);
    console.log(`   Principal (Steer):   ${estado.v_steer.toFixed(2)} km/h`);
    console.log(`   Respaldo (GPS):      ${estado.v_gps.toFixed(2)} km/h`);
    console.log(`   Limitada (Machine):  ${estado.v_machine.toFixed(2)} km/h`);
    
    console.log(`\n🚜 IMPLEMENTO:`);
    console.log(`   Secciones: [${estado.secciones}]`);
    console.log(`====================================================`);
}, 1000);

server.bind(PORT);