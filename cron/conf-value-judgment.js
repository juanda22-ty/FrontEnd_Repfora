import cron from 'node-cron';
import { reviewJudgment } from './def-value-judgment.js'; // Tu función de auditoría
import AppSettings from '../models/AppSettings.js';

// Calcula días de diferencia entre dos fechas
function daysBetween(date1, date2) {
  const d1 = new Date(date1).setHours(0, 0, 0, 0);
  const d2 = new Date(date2).setHours(0, 0, 0, 0);
  return Math.floor((d1 - d2) / (1000 * 60 * 60 * 24));
}



cron.schedule('0 1 * * *', async () => {
  console.log('🕒 Verificando cron de auditoría (Hora Colombia)...');

  try {
    // Obtener día de la semana (0 = domingo, 6 = sábado)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Dom, 1=Lun, ..., 6=Sáb

    // Si es sábado o domingo, no ejecutar (se aplace al lunes)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      console.log('📅 Fin de semana, se aplaza la ejecución para el lunes.');
      return;
    }

    // Verificar última ejecución
    const settings = await AppSettings.findOne().lean();
    const lastExecution = settings?.lastJudgmentAuditDate;

    // Si no hay registro anterior o han pasado 3 días, ejecutar
    const shouldExecute = !lastExecution ||
      daysBetween(now, lastExecution) >= 3;

    if (shouldExecute) {
      console.log('✅ Ejecutando auditoría (cada 3 días)...');
      await reviewJudgment();

      // Actualizar última fecha de ejecución
      await AppSettings.findOneAndUpdate(
        {},
        { $set: { lastJudgmentAuditDate: now } },
        { upsert: true }
      );
      console.log('🕒 Próxima ejecución en 3 días hábiles.');
    } else {
      const daysRemaining = 3 - daysBetween(now, lastExecution);
      console.log(`⏳ Faltan ${daysRemaining} día(s) para la próxima ejecución.`);
    }
  } catch (error) {
    console.error('❌ Error fatal en el cron:', error);
  }
}, {
  scheduled: true,
  timezone: "America/Bogota" // <--- CLAVE: Fuerza la hora colombiana
});

console.log('✅ Sistema de auditoría programado para la 1:00 AM (Bogotá).');