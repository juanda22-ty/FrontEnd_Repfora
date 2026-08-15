import { get, post, put, del, postRaw } from "./api.js";
import { requestAxios } from "../common/axios.js";

/**
 * Servicio para manejar todas las peticiones de Planeación Pedagógica
 */
export const PlanningService = {
  /**
   * Obtiene todas las planeaciones guardadas en MongoDB
   */
  getAllPlannings: () => get("/planning"),

  /**
   * Obtiene la planeación completa de una ficha desde MongoDB
   * @param {string} fiche - Número de ficha (ej: 3065259)
   */
  getPlanningByFiche: (fiche) => get(`/planning/${fiche}`),

  /**
   * Envía/actualiza la planeación completa en MongoDB (upsert)
   * @param {object} payload - { pedagogicalPlanning: { ... } }
   */
  uploadPlanning: (payload) => postRaw("/planning/upload", payload).then((r) => r.data),

  /**
   * Guarda cambios parciales de un instructor (actividades, horas, calendario)
   * @param {object} fullPlanning - Documento completo con los cambios aplicados
   */
  saveDraft: (fullPlanning) => postRaw("/planning/upload", fullPlanning).then((r) => r.data),

  /**
   * Envía 3 PDFs al backend para extracción automática.
   * El backend ejecuta el script Python y guarda en MongoDB.
   * @param {File} programPdf - PDF del Programa de Formación
   * @param {File} projectPdf - PDF del Reporte Proyecto Formativo
   * @param {File} teamPdf - PDF del Equipo Ejecutor
   * @param {string} fiche - Número de ficha
   * @param {string} leaderEmail - Correo del instructor creador / líder
   */
  extractFromPDFs: async (programPdf, projectPdf, teamPdf, fiche, leaderEmail) => {
    const formData = new FormData();
    formData.append("programPdf", programPdf);
    formData.append("projectPdf", projectPdf);
    if (teamPdf) {
      formData.append("teamPdf", teamPdf);
    }
    formData.append("fiche", fiche);
    if (leaderEmail) {
      formData.append("leaderEmail", leaderEmail);
    }

    const response = await requestAxios.post("/planning/extract", formData, {
      headers: { "Content-Type": "multipart/form-data" },
      timeout: 120000, // 2 min para extracción pesada
    });
    return response.data;
  },

  /**
   * Programa un resultado (RAP) de la planeación directamente al calendario oficial
   * @param {object} payload - { planningId, phaseIndex, competenceIndex, rapIndex, activityIndex }
   */
  scheduleOutcome: (payload) => postRaw("/planning/schedule-outcome", payload).then((r) => r.data),

  /**
   * Guarda una planilla (plantilla) del programa
   * @param {object} payload - { programCode, programName, content, savedBy }
   */
  savePlanningTemplate: (payload) => postRaw("/planning/template", payload).then((r) => r.data),

  /**
   * Obtiene la planilla (plantilla) guardada para un programa
   * @param {string} programCode - Código del programa (ej: 228106)
   */
  getPlanningTemplate: (programCode) => get(`/planning/template/${programCode}`, {}, { skipErrorNotify: true }),

  /**
   * Aplica la plantilla de un programa a la planeación de una ficha específica.
   * Solo agrega lo que NO existe — no toca instructores ni confirmaciones ya establecidas.
   * @param {string} fiche - Número de ficha destino
   * @param {string} programCode - Código del programa cuya plantilla se aplicará
   */
  applyPlanningTemplate: (fiche, programCode) =>
    post(`/planning/apply-template/${fiche}`, { programCode }),
};

/**
 * Servicio CRUD para los Días No Programables (vacaciones colectivas, festivos, etc.)
 * Reemplaza el almacenamiento en localStorage con persistencia real en MongoDB.
 */
export const VacationService = {
  /**
   * Obtiene todos los días no programables registrados
   */
  getAll: () => get("/planning/vacations"),

  /**
   * Registra un nuevo rango de días no programables
   * @param {{ start: string, end: string, reason: string, createdBy?: string }} data
   */
  create: (data) => post("/planning/vacations", data),

  /**
   * Actualiza un rango de días no programables existente
   * @param {string} id - ID del documento en MongoDB
   * @param {{ start: string, end: string, reason: string }} data
   */
  update: (id, data) => put(`/planning/vacations/${id}`, data),

  /**
   * Elimina un rango de días no programables
   * @param {string} id - ID del documento en MongoDB
   */
  delete: (id) => del(`/planning/vacations/${id}`),
};

/**
 * Servicio CRUD para las Jornadas (Shifts) parametrizables en el módulo de planeaciones.
 */
export const ShiftService = {
  /**
   * Obtiene todas las jornadas registradas
   */
  getAll: () => get("/planning/shifts", {}, { skipErrorNotify: true }),

  /**
   * Registra una nueva jornada
   * @param {{ name: string, code: string, hoursPerDay: number, allowedDays: number[], defaultStartTime?: string, defaultEndTime?: string, isCustom?: boolean }} data
   */
  create: (data) => post("/planning/shifts", data),

  /**
   * Actualiza una jornada existente
   * @param {string} id - ID del documento en MongoDB
   * @param {{ name: string, hoursPerDay: number, allowedDays: number[], defaultStartTime?: string, defaultEndTime?: string, isCustom?: boolean }} data
   */
  update: (id, data) => put(`/planning/shifts/${id}`, data),

  /**
   * Elimina una jornada
   * @param {string} id - ID del documento en MongoDB
   */
  delete: (id) => del(`/planning/shifts/${id}`),
};

