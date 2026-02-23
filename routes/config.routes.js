const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const IMP_DIR = path.join(__dirname, '../data/implementos');

router.get('/perfiles', (req, res) => {
    const archivos = fs.readdirSync(IMP_DIR).filter(f => f.endsWith('.json'));
    const perfiles = archivos.map(f => ({ archivo: f, ...JSON.parse(fs.readFileSync(path.join(IMP_DIR, f))) }));
    res.json(perfiles);
});

router.post('/perfil/guardar', (req, res) => {
    const { filename, data } = req.body;
    fs.writeFileSync(path.join(IMP_DIR, filename), JSON.stringify(data, null, 2));
    res.json({ status: "ok" });
});

module.exports = router;