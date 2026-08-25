import cron from 'node-cron';
import { reviewJudgment } from '../cron/def-value-judgment.js';

/**
 * Servicio para gestionar el cron de auditoría
 * Permite activar/desactivar el cron desde cualquier parte de la aplicación
 */

// Estado del cron
let auditCronTask = null;
let cronEnabled = process.env.CRON_ENABLED === 'true';

/**
 * Inicia el cron de auditoría
 */
export function startAuditCron() {
  if (auditCronTask) {
    console.log('[CRON] El cron ya está activo');
    return false;
  }
  auditCronTask = cron.schedule('0 1 * * *', async () => {
    console.log('🕒 Iniciando cron de auditoría (Hora Colombia)...');
    try {
      await reviewJudgment();
    } catch (error) {
      console.error('❌ Error fatal en el cron:', error);
    }
  }, {
    scheduled: true,
    timezone: "America/Bogota"
  });
  cronEnabled = true;
  console.log('[CRON] Auditoría automática ACTIVADA (1 AM hora Colombia)');
  return true;
}

/**
 * Detiene el cron de auditoría
 */
export function stopAuditCron() {
  if (auditCronTask) {
    auditCronTask.stop();
    auditCronTask = null;
    cronEnabled = false;
    console.log('[CRON] Auditoría automática DESACTIVADA');
    return true;
  }
  return false;
}

/**
 * Obtiene el estado del cron
 */
export function getCronStatus() {
  return {
    enabled: cronEnabled,
    active: auditCronTask !== null,
    schedule: "0 1 * * * (1 AM hora Colombia)",
    description: "Cron de auditoría de juicios evaluativos"
  };
}

/**
 * Inicia el cron si está habilitado en las variables de entorno
 */
export function initCron() {
  if (cronEnabled) {
    startAuditCron();
  } else {
    console.log('[CRON] Auditoría automática DESHABILITADA (CRON_ENABLED=false)');
  }
}
