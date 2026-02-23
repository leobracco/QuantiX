const express = require('express');
const router = express.Router();
const multer = require('multer');
const shapefile = require("shapefile");
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '../uploads');
const MAPA_PERSISTENTE = path.join(__dirname, '../data/ultimo_mapa.json');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        if (!req.mapGroupId) req.mapGroupId = Date.now() + '-' + Math.round(Math.random() * 1E5);
        cb(null, req.mapGroupId + path.extname(file.originalname).toLowerCase());
    }
});
const upload = multer({ storage });

// Analizar columnas
router.post('/get-columns', upload.fields([{ name: 'shp' }, { name: 'dbf' }]), async (req, res) => {
    try {
        const shpPath = req.files['shp'][0].path;
        const dbfPath = req.files['dbf'][0].path;
        const source = await shapefile.open(shpPath, dbfPath);
        const result = await source.read();
        res.json({ columnas: Object.keys(result.value.properties), tempFiles: { shp: shpPath, dbf: dbfPath } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Confirmar y normalizar mapa
router.post('/confirmar-mapa', async (req, res) => {
    const { tempFiles, mapping } = req.body;
    try {
        const data = await shapefile.read(tempFiles.shp, tempFiles.dbf);
        data.features = data.features.map(f => ({
            type: "Feature",
            geometry: f.geometry,
            properties: {
                Name: f.properties.Name || f.properties.ID || "Zona",
                SemillasxMetro: parseFloat(f.properties[mapping.SemillasxMetro]) || 0,
                KilosxHectarea: parseFloat(f.properties[mapping.KilosxHectarea]) || 0
            }
        }));
        fs.writeFileSync(MAPA_PERSISTENTE, JSON.stringify(data));
        res.json(data);
        // Limpieza de temporales
        [tempFiles.shp, tempFiles.dbf].forEach(file => { if(fs.existsSync(file)) fs.unlinkSync(file); });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ruta para cargar el mapa guardado al iniciar
router.get('/estado-sistema', (req, res) => {
    const MAPA_PERSISTENTE = path.join(__dirname, '../data/ultimo_mapa.json');
    const CONFIG_FILE = path.join(__dirname, '../data/config_sistema.json'); // Tu config general
    
    let mapa = null;
    if (fs.existsSync(MAPA_PERSISTENTE)) {
        mapa = JSON.parse(fs.readFileSync(MAPA_PERSISTENTE));
    }

    res.json({
        mapa: mapa,
        config: fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE)) : {}
    });
});
// Endpoint para que el Bridge obtenga la configuración activa
router.get('/config-implemento', (req, res) => {
    const CONFIG_FILE = path.join(__dirname, '../data/config_sistema.json');
    if (fs.existsSync(CONFIG_FILE)) {
        res.json(JSON.parse(fs.readFileSync(CONFIG_FILE)));
    } else {
        // Valores por defecto si no existe el archivo
        res.json({ distanciaSurcos: 0.52, motores: [{ id: 1, cp: 1.0 }] });
    }
});
let dosisManual = { activo: false, valor: 0 };

router.post('/dosis-manual', (req, res) => {
    dosisManual = {
        activo: req.body.activo,
        valor: parseFloat(req.body.valor) || 0
    };
    res.json({ status: "ok", dosisManual });
});

router.get('/config-trabajo', (req, res) => {
    const CONFIG_FILE = path.join(__dirname, '../data/config_sistema.json');
    const config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE)) : {};
    res.json({
        config,
        dosisManual
    });
});
module.exports = router;