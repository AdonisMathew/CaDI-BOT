// Configuración de PM2: mantiene al bridge y a n8n corriendo en segundo plano
// y los vuelve a levantar solos si se caen.
//
//   npm install -g pm2           (una sola vez)
//   pm2 start ecosystem.config.cjs
//   pm2 status | pm2 logs | pm2 restart cadi-bridge | pm2 stop all
//
// Funciona igual en Windows y en Linux (por ejemplo, en la netbook).

const path = require('path');
const { execSync } = require('child_process');

// Ruta al n8n instalado globalmente (npm install -g n8n). En Windows, PM2 no
// puede arrancar el atajo "n8n.cmd", así que le pasamos el archivo JS real.
const N8N_BIN =
  process.env.N8N_BIN ||
  path.join(execSync('npm root -g').toString().trim(), 'n8n', 'bin', 'n8n');

module.exports = {
  apps: [
    {
      name: 'cadi-bridge',
      script: 'index.js',
      cwd: __dirname,
      autorestart: true,
      exp_backoff_restart_delay: 2000, // si se cae en bucle, espera cada vez más entre reinicios
      max_memory_restart: '400M',      // red de seguridad ante pérdidas de memoria
      kill_timeout: 3000,              // le da tiempo a cerrar la sesión de WhatsApp prolijamente
      time: true,                      // fecha y hora en cada línea de log
    },
    {
      name: 'n8n',
      script: N8N_BIN,
      args: 'start',
      interpreter: 'node',
      autorestart: true,
      exp_backoff_restart_delay: 5000,
      max_memory_restart: '1500M',
      kill_timeout: 10000,
      time: true,
      env: {
        // Borra ejecuciones viejas para que la base de datos no crezca sin límite
        // (una base gigante hace que n8n tarde mucho en arrancar)
        EXECUTIONS_DATA_PRUNE: 'true',
        EXECUTIONS_DATA_MAX_AGE: '168',          // horas (7 días)
        EXECUTIONS_DATA_PRUNE_MAX_COUNT: '2000', // como mucho, 2000 ejecuciones guardadas
        N8N_DIAGNOSTICS_ENABLED: 'false',        // sin telemetría: un pedido de red menos al arrancar
      },
    },
  ],
};
