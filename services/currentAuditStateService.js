import CurrentAuditState from '../models/CurrentAuditState.js';
import LearnerOmission from '../models/LearnerOmission.js';

/**
 * Construye un objeto de resultado pendiente/vencido para el estado actual
 */
export function buildOutcomeState({
  scheduleId,
  ficheNumber,
  ficheId,
  outcomeText,
  fend,
  missingLearners,
  totalLearners,
  isTotalMissing,
  daysOverdue,
  instructorName,
  instructorEmail,
  ficheOwnerName,
  ficheOwnerEmail,
  isVencido
}) {
  return {
    scheduleId,
    ficheNumber,
    ficheId,
    outcomeText,
    fend,
    missingLearners: missingLearners || [],
    totalLearners,
    isTotalMissing,
    daysOverdue,
    missingCount: missingLearners?.length || 0,
    instructorName,
    instructorEmail,
    ficheOwnerName,
    ficheOwnerEmail,
    isVencido
  };
}

/**
 * Filtra los aprendices omitidos de la lista de missingLearners
 */
export function filterOmittedLearners(missingLearners, omittedDocuments) {
  if (!omittedDocuments || omittedDocuments.length === 0) {
    return missingLearners;
  }
  return missingLearners.filter(l => !omittedDocuments.includes(l.document));
}

/**
 * Actualiza el registro único de estado actual con los datos de pendientes y vencidos
 * Esta función se llama DESPUÉS de analizar el Excel, con los datos reales
 *
 * @param {Array} pendientes - Lista de resultados pendientes (del análisis del Excel)
 * @param {Array} vencidos - Lista de resultados vencidos (del análisis del Excel)
 * @param {Object} debugLog - Log opcional para debug
 */
export async function updateCurrentAuditState(pendientes = [], vencidos = [], debugLog = null) {
  const log = (msg, data) => {
    if (debugLog) {
      debugLog.steps.push({
        timestamp: new Date().toISOString(),
        step: 'UPDATE_STATE',
        message: msg,
        data
      });
    }
    console.log(`[AUDIT_STATE] ${msg}`, data ? JSON.stringify(data) : '');
  };

  try {
    // Calcular estadísticas
    const totalAprendicesSinNota = pendientes.reduce((sum, p) => sum + (p.missingCount || 0), 0);

    const stats = {
      totalPendientes: pendientes.length,
      totalVencidos: vencidos.length,
      totalAprendicesSinNota
    };

    // Actualizar el registro único
    await CurrentAuditState.findOneAndUpdate(
      {},
      {
        pendientes,
        vencidos,
        ultimaActualizacion: new Date(),
        estadisticas: stats
      },
      { upsert: true, new: true }
    );

    log(`Estado actualizado: ${pendientes.length} pendientes, ${vencidos.length} vencidos, ${totalAprendicesSinNota} aprendices sin nota`);
    return stats;

  } catch (error) {
    log('Error actualizando estado', { error: error.message });
    throw error;
  }
}

/**
 * Obtiene el estado actual de la auditoría
 */
export async function getCurrentAuditState() {
  const state = await CurrentAuditState.findOne();
  return state || {
    pendientes: [],
    vencidos: [],
    ultimaActualizacion: null,
    estadisticas: { totalPendientes: 0, totalVencidos: 0, totalAprendicesSinNota: 0 }
  };
}

/**
 * Elimina un resultado del estado (cuando se califica)
 */
export async function removeOutcomeFromState(scheduleId) {
  const result = await CurrentAuditState.findOneAndUpdate(
    {},
    {
      $pull: {
        pendientes: { scheduleId },
        vencidos: { scheduleId }
      },
      $inc: {
        'estadisticas.totalPendientes': -1
      }
    }
  );

  return result;
}
