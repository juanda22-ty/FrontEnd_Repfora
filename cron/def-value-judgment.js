import fs from 'fs/promises';
import path from 'path';
import SofiaPlusClient from '../clients/sofiaPlusClient.js';
import { getAuditableGroups, markAsRated } from '../services/scheduleService.js';
import { parseReportFile, indexWorkbookByOutcome, findOutcomeInIndex } from '../services/reportAnalyzer.js';
import { sendMissingGradesReport, sendCoordinatorReport } from '../services/notificationService.js';
import DailyAuditLog from '../models/DailyAuditLog.js';
import { updateCurrentAuditState, buildOutcomeState } from '../services/currentAuditStateService.js';
import FailedFiche from '../models/FailedFiche.js';

/**
 * Procesa los grupos usando un archivo Excel local (sin conectar a Sofía Plus)
 */
async function processWithLocalReport(localReportPath, groupsToProcess, options) {
  const { skipEmail, skipMarkRated, debugLog, log, logError } = options;
  const allNotifiedInstructors = []; // Acumular todos los instructores notificados

  // Parsear el archivo local
  log('OFFLINE_PARSE', `Parseando archivo local: ${localReportPath}`);
  let workbook;
  try {
    const { workbook: wb, totalRows } = parseReportFile(localReportPath);
    workbook = wb;
    debugLog.summary.totalReportRows += totalRows;
    log('OFFLINE_PARSE', `Archivo parseado (${totalRows} filas con datos)`);
  } catch (error) {
    logError('OFFLINE_PARSE', 'Error parseando archivo local', error);
    throw error;
  }

  // Indexar workbook
  const { indexedResults, totalEnFormacion } = indexWorkbookByOutcome(workbook);
  log('OFFLINE_INDEX', `Excel indexado: ${Object.keys(indexedResults).length} resultados, ${totalEnFormacion} EN FORMACION`);
  debugLog.summary.totalRowsEnFormacion += totalEnFormacion;

  // Procesar cada grupo
  for (const group of groupsToProcess) {
    console.log(group);
    
    const { ficheNumber, schedules, ficheOwner, coordination } = group;
    const ficheOwnerName = ficheOwner?.name || 'Sin líder';
    const ficheOwnerEmail = ficheOwner?.email || '';

    const ficheDebug = {
      ficheNumber,
      ficheId: group.ficheId,
      ficheOwner: group.ficheOwner, // Líder de la ficha
      schedulesCount: schedules.length,
      reportDownloaded: true,
      reportPath: localReportPath,
      outcomes: [],
      pendingItems: [],
      error: null
    };

    log('FICHA_START', `>>> Procesando Ficha: ${ficheNumber}`, {
      schedulesCount: schedules.length
    });

    // Analizar cada Resultado
    for (const sched of schedules) {
      const schedInstructor = sched.instructor;
      const outcomeDebug = {
        scheduleId: sched.scheduleId,
        outcomeText: sched.outcomeText,
        fend: sched.fend,
        omittedLearners: sched.omittedLearners,
        analysis: null,
        result: null
      };

      log('ANALYZE', `Analizando resultado: "${sched.outcomeText.substring(0, 50)}..."`, {
        scheduleId: sched.scheduleId,
        omittedCount: sched.omittedLearners?.length || 0
      });

      const analysis = findOutcomeInIndex(indexedResults, sched.outcomeText);

      outcomeDebug.analysis = {
        foundColumn: analysis.foundColumn,
        isRated: analysis.isRated,
        totalLearners: analysis.totalLearners,
        missingCount: analysis.missingLearners?.length || 0,
        missingLearners: analysis.missingLearners,
        totalEnFormacion: analysis.totalEnFormacion
      };

      if (!analysis.foundColumn) {
        log('ANALYZE', `[!] Columna NO encontrada para: "${sched.outcomeText.substring(0, 50)}..."`);
        outcomeDebug.result = 'COLUMN_NOT_FOUND';
        // Agregar a inconsistencias para revisión posterior
        debugLog.inconsistencias.push({
          ficheNumber,
          ficheId: group.ficheId,
          scheduleId: sched.scheduleId,
          outcomeText: sched.outcomeText,
          instructorName: sched.instructor?.name || 'Sin instructor',
          instructorEmail: sched.instructor?.email || '',
          reason: 'Resultado no encontrado en el Excel de Sofía Plus (posible error de tipeo)'
        });
      } else if (analysis.isRated) {
        log('ANALYZE', `[OK] Resultado CALIFICADO`, { scheduleId: sched.scheduleId });
        outcomeDebug.result = 'RATED';
        debugLog.summary.outcomesRated++;

        if (!skipMarkRated) {
          await markAsRated(sched.scheduleId, analysis.gradeDate);
          log('MARK_RATED', `Marcado como calificado en BD`);
        } else {
          log('MARK_RATED', `[SKIP] No se marcó como calificado (modo debug)`);
        }
      } else {
        // Filtrar aprendices omitidos de missingLearners
        const omittedDocs = sched.omittedLearners || [];
        const filteredLearners = analysis.missingLearners.filter(l =>
          !omittedDocs.includes(l.document)
        );

        const missingCount = filteredLearners.length;
        const totalCount = analysis.totalEnFormacion; // Usar totalEnFormacion en lugar de totalLearners
        const isTotalMissing = totalCount > 0 && missingCount >= totalCount;

        // Si después de filtrar por omisiones no queda nadie, está calificado
        if (missingCount === 0 && analysis.missingLearners.length > 0) {
          log('ANALYZE', `[OK] Todos los aprendices sin nota están omitidos - Resultado calificado por omisión`);
          outcomeDebug.result = 'RATED_BY_OMISSION';
          debugLog.summary.outcomesRated++;

          if (!skipMarkRated) {
            await markAsRated(sched.scheduleId, analysis.gradeDate);
            log('MARK_RATED', `Marcado como calificado en BD`);
          }
        } else {
          // Si faltan todos, no listar aprendices individualmente
          if (isTotalMissing) {
            log('ANALYZE', `[PENDIENTE] Resultado sin evaluar (${totalCount} aprendices)`);
          } else {
            log('ANALYZE', `[PENDIENTE] Faltan ${missingCount} de ${totalCount} aprendices`, {
              missing: filteredLearners
            });
          }

          outcomeDebug.result = 'PENDING';
          debugLog.summary.outcomesPending++;
          debugLog.summary.totalMissingLearners += missingCount;

          // En el reporte, si faltan todos, usar mensaje genérico
          const learnersForReport = isTotalMissing
            ? [{ name: '(Todos)', document: 'Resultado sin evaluar' }]
            : filteredLearners;

          ficheDebug.pendingItems.push({
            outcomeText: sched.outcomeText,
            missingLearners: learnersForReport,
            totalLearners: analysis.totalEnFormacion, // Usar totalEnFormacion
            isTotalMissing: isTotalMissing
          });

          // Verificar si está vencido
          const now = new Date();
          const fend = sched.fend ? new Date(sched.fend) : null;
          const isVencido = fend && now > fend;
          const daysOverdue = isVencido ? Math.floor((now - fend) / (1000 * 60 * 60 * 24)) : 0;

          // Construir objeto de estado para este resultado
          const outcomeState = buildOutcomeState({
            scheduleId: sched.scheduleId,
            ficheNumber,
            ficheId: group.ficheId,
            outcomeText: sched.outcomeText,
            fend: sched.fend,
            missingLearners: learnersForReport.map(l => ({ name: l.name, document: l.document })),
            totalLearners: analysis.totalEnFormacion,
            isTotalMissing,
            daysOverdue,
            instructorName: schedInstructor?.name || 'Sin instructor',
            instructorEmail: schedInstructor?.email || '',
            ficheOwnerName,
            ficheOwnerEmail,
            isVencido
          });

          if (isVencido) {
            // Verificar que no esté duplicado en vencidos
            const isDuplicate = debugLog.vencidos.some(v =>
              v.scheduleId.toString() === sched.scheduleId.toString()
            );
            if (!isDuplicate) {
              debugLog.vencidos.push(outcomeState);
            }

            // Para compatibilidad con el reporte anterior
            const vencedOutcome = {
              ficheNumber,
              outcomeText: sched.outcomeText,
              fend: sched.fend,
              daysOverdue,
              missingCount,
              instructorName: schedInstructor?.name || '',
              instructorEmail: schedInstructor?.email || '',
              ficheOwnerName,
              ficheOwnerEmail,
              instructor: schedInstructor ? { name: schedInstructor.name, email: schedInstructor.email } : null
            };

            const isOldDuplicate = debugLog.vencedOutcomes.some(vo =>
              vo.ficheNumber === ficheNumber && vo.outcomeText === sched.outcomeText
            );

            if (!isOldDuplicate) {
              debugLog.vencedOutcomes.push(vencedOutcome);
              debugLog.summary.totalVencedOutcomes++;
            }
          } else {
            // Pendiente (no vencido)
            const isDuplicate = debugLog.pendientes.some(p =>
              p.scheduleId.toString() === sched.scheduleId.toString()
            );
            if (!isDuplicate) {
              debugLog.pendientes.push(outcomeState);
            }
          }
        }
      }

      ficheDebug.outcomes.push(outcomeDebug);
    }

    // Enviar correos si hay pendientes (agrupados por instructor)
    const notifiedInstructors = []; // Acumular instructores notificados
    if (ficheDebug.pendingItems.length > 0 && !skipEmail) {
      // Agrupar pendientes por instructor (usar _id como clave para evitar problemas con emails vacíos)
      const pendientesPorInstructor = {};
      for (const sched of schedules) {
        if (sched.instructor && ficheDebug.pendingItems.some(p => p.outcomeText === sched.outcomeText)) {
          const instructorId = sched.instructor._id?.toString() || sched.instructor.toString();
          if (!pendientesPorInstructor[instructorId]) {
            pendientesPorInstructor[instructorId] = {
              instructor: sched.instructor,
              items: []
            };
          }
          const pendingItem = ficheDebug.pendingItems.find(p => p.outcomeText === sched.outcomeText);
          if (pendingItem) {
            pendientesPorInstructor[instructorId].items.push(pendingItem);
          }
        }
      }

      // Enviar correo a cada instructor
      for (const [instructorId, data] of Object.entries(pendientesPorInstructor)) {
        const emails = [data.instructor.email, data.instructor.emailpersonal].filter(Boolean).join(', ') || 'sin email';
        log('EMAIL', `Enviando correo a ${emails} (${data.instructor.name})...`);
        const result = await sendMissingGradesReport({
          instructor: data.instructor,
          ficheNumber,
          pendingItems: data.items,
          coordination
        });

        if (result.success) {
          // Acumular instructor notificado para el reporte al coordinador
          notifiedInstructors.push({
            instructorName: data.instructor.name,
            instructorEmail: emails,
            ficheNumber,
            pendingCount: data.items.length
          });
        }

        log('EMAIL', result.success ? `Correo enviado a ${emails}` : `Error enviando a ${emails}: ${result.error}`);
      }
    } else if (ficheDebug.pendingItems.length > 0 && skipEmail) {
      log('EMAIL', `[SKIP] No se enviaron correos (modo debug)`, {
        pendingCount: ficheDebug.pendingItems.length
      });
    }

    debugLog.summary.fichesProcessed++;
    debugLog.groups.push(ficheDebug);

    // Acumular instructores notificados de esta ficha
    allNotifiedInstructors.push(...notifiedInstructors);
  }

  return allNotifiedInstructors;
}

/**
 * Versión DEBUG de reviewJudgment que genera un archivo de resumen detallado
 * @param {Object} options - Opciones de configuración
 * @param {boolean} options.skipEmail - Si es true, no envía correos (default: true en debug)
 * @param {boolean} options.skipMarkRated - Si es true, no marca como calificado (default: true en debug)
 * @param {boolean} options.skipSaveLog - Si es true, no guarda en DailyAuditLog (default: true en debug)
 * @param {string} options.localReportPath - Ruta a un archivo Excel local para usar en lugar de descargar de Sofía
 * @returns {Object} Resumen completo del proceso
 */
export async function reviewJudgmentDebug(options = {}) {
  const {
    skipEmail = true,
    skipMarkRated = true,
    skipSaveLog = true,
    maxFiches = 5,  // Limitar fichas a procesar (default: 5)
    ficheId: ficheIdRaw = null,  // Filtrar por ID de ficha específica (default: null = todas)
    localReportPath = null  // Usar archivo local en lugar de descargar de Sofía
  } = options;

  // Limpiar ficheId de espacios y saltos de línea
  let ficheId = null;
  if (ficheIdRaw && typeof ficheIdRaw === 'string') {
    ficheId = ficheIdRaw.trim();
  }

  const debugLog = {
    startTime: new Date().toISOString(),
    endTime: null,
    options: { skipEmail, skipMarkRated, skipSaveLog, maxFiches, ficheId },
    steps: [],
    groups: [],
    errors: [],
    vencedOutcomes: [], // Nueva lista para resultados vencidos
    inconsistencias: [], // Resultados no encontrados en Excel
    // Nuevos acumuladores para el estado actual
    pendientes: [],
    vencidos: [],
    summary: {
      totalGroups: 0,
      totalSchedules: 0,
      fichesProcessed: 0,
      fichesWithErrors: 0,
      outcomesRated: 0,
      outcomesPending: 0,
      totalMissingLearners: 0,
      totalReportRows: 0,
      totalRowsEnFormacion: 0,
      totalVencedOutcomes: 0
    }
  };

  const log = (step, message, data = null) => {
    const entry = {
      timestamp: new Date().toISOString(),
      step,
      message,
      data
    };
    debugLog.steps.push(entry);
    console.log(`[DEBUG][${step}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  };

  const logError = (step, message, error) => {
    const entry = {
      timestamp: new Date().toISOString(),
      step,
      message,
      error: error?.message || String(error),
      stack: error?.stack
    };
    debugLog.errors.push(entry);
    console.error(`[DEBUG][ERROR][${step}] ${message}`, error);
  };

  log('INIT', 'Iniciando proceso de auditoría DEBUG...');

  try {
    // PASO 1: Obtener grupos auditables
    log('GET_GROUPS', `Obteniendo grupos auditables de la BD...${ficheId ? ` (filtro ficheId: ${ficheId})` : ''}`);
    const groups = await getAuditableGroups({ ficheId });
    debugLog.summary.totalGroups = groups.length;

    if (!groups.length) { 
      log('GET_GROUPS', 'No hay programaciones pendientes de auditar.');
      debugLog.endTime = new Date().toISOString();
      await saveDebugReport(debugLog);
      return debugLog;
    }

    log('GET_GROUPS', `Se encontraron ${groups.length} fichas en BD`);

    // Limitar fichas a procesar
    const groupsToProcess = groups.slice(0, maxFiches);
    log('GET_GROUPS', `Procesando ${groupsToProcess.length} de ${groups.length} fichas (maxFiches: ${maxFiches})`,
      groupsToProcess.map(g => ({
        ficheNumber: g.ficheNumber,
        schedulesCount: g.schedules.length,
        instructor: g.instructor?.name || 'Sin instructor'
      }))
    );

    // Contar total de schedules (solo de las que vamos a procesar)
    debugLog.summary.totalSchedules = groupsToProcess.reduce((acc, g) => acc + g.schedules.length, 0);

    // PASO 2: Si se proporciona localReportPath, usarlo directamente (modo offline)
    let allNotifiedInstructors = []; // Acumular todos los instructores notificados
    if (localReportPath) {
      log('OFFLINE_MODE', `Usando archivo local: ${localReportPath}`);
      const notified = await processWithLocalReport(localReportPath, groupsToProcess, { skipEmail, skipMarkRated, debugLog, log, logError });
      allNotifiedInstructors.push(...notified);
    } else {
      // PASO 2: Iniciar cliente Sofia Plus
      log('SOFIA_INIT', 'Iniciando cliente de Sofia Plus...');
      const client = new SofiaPlusClient();

      try {
      log('SOFIA_SESSION', 'Iniciando sesión completa (login + rol + navegación) con reintentos...');
      await client.startSession();
      log('SOFIA_SESSION', 'Sesión establecida correctamente');

      // PASO 3: Procesar cada ficha (limitado)
      for (const group of groupsToProcess) {
        const { ficheNumber, schedules, ficheOwner, coordination } = group;
        const ficheOwnerName = ficheOwner?.name || 'Sin líder';
        const ficheOwnerEmail = ficheOwner?.email || '';

        const notifiedInstructors = []; // Instructores notificados en esta ficha
        const ficheDebug = {
          ficheNumber,
          ficheId: group.ficheId,
          ficheOwner: group.ficheOwner, // Líder de la ficha
          schedulesCount: schedules.length,
          reportDownloaded: false,
          reportPath: null,
          outcomes: [],
          pendingItems: [],
          error: null
        };

        log('FICHA_START', `>>> Procesando Ficha: ${ficheNumber}`, {
          schedulesCount: schedules.length,
          ficheOwner: ficheOwnerName
        });

        let workbook;
        let reportPath = null;

        // Descargar Excel y procesar
        try {
          log('DOWNLOAD', `Descargando reporte para ficha ${ficheNumber}...`);
          reportPath = await client.downloadReport(ficheNumber);
          ficheDebug.reportDownloaded = true;
          ficheDebug.reportPath = reportPath;
          log('DOWNLOAD', `Reporte descargado: ${reportPath}`);

          log('PARSE', `Parseando archivo Excel...`);
          const { workbook: wb, totalRows } = parseReportFile(reportPath);
          workbook = wb;
          debugLog.summary.totalReportRows += totalRows;
          log('PARSE', `Archivo parseado correctamente (${totalRows} filas con datos)`);

          // Procesar workbook una sola vez e indexar por resultado
          log('INDEX', 'Indexando resultados del Excel...');
          const { indexedResults, totalEnFormacion } = indexWorkbookByOutcome(workbook);
          log('INDEX', `Excel indexado: ${Object.keys(indexedResults).length} resultados encontrados, ${totalEnFormacion} filas EN FORMACION`);
          debugLog.summary.totalRowsEnFormacion += totalEnFormacion;

          // Analizar cada Resultado
          for (const sched of schedules) {
            const schedInstructor = sched.instructor;
            const outcomeDebug = {
              scheduleId: sched.scheduleId,
              outcomeText: sched.outcomeText,
              fend: sched.fend,
              omittedLearners: sched.omittedLearners,
              analysis: null,
              result: null
            };

            log('ANALYZE', `Analizando resultado: "${sched.outcomeText.substring(0, 50)}..."`, {
              scheduleId: sched.scheduleId,
              omittedCount: sched.omittedLearners?.length || 0
            });

            const analysis = findOutcomeInIndex(indexedResults, sched.outcomeText);

            outcomeDebug.analysis = {
              foundColumn: analysis.foundColumn,
              isRated: analysis.isRated,
              totalLearners: analysis.totalLearners,
              missingCount: analysis.missingLearners?.length || 0,
              missingLearners: analysis.missingLearners,
              totalEnFormacion: analysis.totalEnFormacion
            };

            if (!analysis.foundColumn) {
              log('ANALYZE', `[!] Columna NO encontrada para: "${sched.outcomeText.substring(0, 50)}..."`);
              outcomeDebug.result = 'COLUMN_NOT_FOUND';
              // Agregar a inconsistencias para revisión posterior
              debugLog.inconsistencias.push({
                ficheNumber,
                ficheId: group.ficheId,
                scheduleId: sched.scheduleId,
                outcomeText: sched.outcomeText,
                instructorName: sched.instructor?.name || 'Sin instructor',
                instructorEmail: sched.instructor?.email || '',
                reason: 'Resultado no encontrado en el Excel de Sofía Plus (posible error de tipeo)'
              });
            } else if (analysis.isRated) {
              log('ANALYZE', `[OK] Resultado CALIFICADO`, { scheduleId: sched.scheduleId });
              outcomeDebug.result = 'RATED';
              debugLog.summary.outcomesRated++;

              if (!skipMarkRated) {
                await markAsRated(sched.scheduleId, analysis.gradeDate);
                log('MARK_RATED', `Marcado como calificado en BD`);
              } else {
                log('MARK_RATED', `[SKIP] No se marcó como calificado (modo debug)`);
              }
            } else {
              const missingCount = analysis.missingLearners.length;
              const totalCount = analysis.totalEnFormacion;
              const isTotalMissing = totalCount > 0 && missingCount >= totalCount;

              // Si faltan todos, no listar aprendices individualmente
              if (isTotalMissing) {
                log('ANALYZE', `[PENDIENTE] Resultado sin evaluar (${totalCount} aprendices)`);
              } else {
                log('ANALYZE', `[PENDIENTE] Faltan ${missingCount} de ${totalCount} aprendices`, {
                  missing: analysis.missingLearners
                });
              }

              outcomeDebug.result = 'PENDING';
              debugLog.summary.outcomesPending++;
              debugLog.summary.totalMissingLearners += missingCount;

              // En el reporte, si faltan todos, usar mensaje genérico
              const learnersForReport = isTotalMissing
                ? [{ name: '(Todos)', document: 'Resultado sin evaluar' }]
                : analysis.missingLearners;

              ficheDebug.pendingItems.push({
                outcomeText: sched.outcomeText,
                missingLearners: learnersForReport,
                totalLearners: totalCount,
                isTotalMissing: isTotalMissing
              });

              // Verificar si está vencido
              const now = new Date();
              const fend = sched.fend ? new Date(sched.fend) : null;
              const isVencido = fend && now > fend;
              const daysOverdue = isVencido ? Math.floor((now - fend) / (1000 * 60 * 60 * 24)) : 0;

              // Construir objeto de estado para este resultado
              const outcomeState = buildOutcomeState({
                scheduleId: sched.scheduleId,
                ficheNumber,
                ficheId: group.ficheId,
                outcomeText: sched.outcomeText,
                fend: sched.fend,
                missingLearners: learnersForReport.map(l => ({ name: l.name, document: l.document })),
                totalLearners: totalCount,
                isTotalMissing,
                daysOverdue,
                instructorName: schedInstructor?.name || 'Sin instructor',
                instructorEmail: schedInstructor?.email || '',
                ficheOwnerName,
                ficheOwnerEmail,
                isVencido
              });

              if (isVencido) {
                // Verificar que no esté duplicado en vencidos
                const isDuplicate = debugLog.vencidos.some(v =>
                  v.scheduleId.toString() === sched.scheduleId.toString()
                );
                if (!isDuplicate) {
                  debugLog.vencidos.push(outcomeState);
                }

                // Para compatibilidad con el reporte anterior
                const vencedOutcome = {
                  ficheNumber,
                  outcomeText: sched.outcomeText,
                  fend: sched.fend,
                  daysOverdue,
                  missingCount,
                  instructorName: schedInstructor?.name || '',
                  instructorEmail: schedInstructor?.email || '',
                  ficheOwnerName,
                  ficheOwnerEmail,
                  instructor: schedInstructor ? { name: schedInstructor.name, email: schedInstructor.email } : null
                };

                const isOldDuplicate = debugLog.vencedOutcomes.some(vo =>
                  vo.ficheNumber === ficheNumber && vo.outcomeText === sched.outcomeText
                );

                if (!isOldDuplicate) {
                  debugLog.vencedOutcomes.push(vencedOutcome);
                  debugLog.summary.totalVencedOutcomes++;
                }
              } else {
                // Pendiente (no vencido)
                const isDuplicate = debugLog.pendientes.some(p =>
                  p.scheduleId.toString() === sched.scheduleId.toString()
                );
                if (!isDuplicate) {
                  debugLog.pendientes.push(outcomeState);
                }
              }
            }

            ficheDebug.outcomes.push(outcomeDebug);
          }

          // Enviar correos si hay pendientes (agrupados por instructor)
          if (ficheDebug.pendingItems.length > 0 && !skipEmail) {
            // Agrupar pendientes por instructor (usar _id como clave para evitar problemas con emails vacíos)
            const pendientesPorInstructor = {};
            for (const sched of schedules) {
              if (sched.instructor && ficheDebug.pendingItems.some(p => p.outcomeText === sched.outcomeText)) {
                const instructorId = sched.instructor._id?.toString() || sched.instructor.toString();
                if (!pendientesPorInstructor[instructorId]) {
                  pendientesPorInstructor[instructorId] = {
                    instructor: sched.instructor,
                    items: []
                  };
                }
                const pendingItem = ficheDebug.pendingItems.find(p => p.outcomeText === sched.outcomeText);
                if (pendingItem) {
                  pendientesPorInstructor[instructorId].items.push(pendingItem);
                }
              }
            }

            // Enviar correo a cada instructor
            for (const [instructorId, data] of Object.entries(pendientesPorInstructor)) {
              const emails = [data.instructor.email, data.instructor.emailpersonal].filter(Boolean).join(', ') || 'sin email';
              log('EMAIL', `Enviando correo a ${emails} (${data.instructor.name})...`);
              const result = await sendMissingGradesReport({
                instructor: data.instructor,
                ficheNumber,
                pendingItems: data.items,
                coordination
              });

              if (result.success) {
                // Acumular instructor notificado para el reporte al coordinador
                notifiedInstructors.push({
                  instructorName: data.instructor.name,
                  instructorEmail: emails,
                  ficheNumber,
                  pendingCount: data.items.length
                });
              }

              log('EMAIL', result.success ? `Correo enviado a ${emails}` : `Error enviando a ${emails}: ${result.error}`);
            }
          } else if (ficheDebug.pendingItems.length > 0 && skipEmail) {
            log('EMAIL', `[SKIP] No se enviaron correos (modo debug)`, {
              pendingCount: ficheDebug.pendingItems.length
            });
          }

          // Eliminar archivo
          if (reportPath) {
            try {
              await fs.unlink(reportPath);
              log('CLEANUP', `Archivo eliminado: ${reportPath}`);
            } catch (err) {
              log('CLEANUP', `No se pudo eliminar archivo: ${err.message}`);
            }
          }

          debugLog.summary.fichesProcessed++;
          debugLog.groups.push(ficheDebug);

          // Acumular instructores notificados de esta ficha al global
          allNotifiedInstructors.push(...notifiedInstructors);

        } catch (error) {
          logError('DOWNLOAD', `Error descargando/procesando ficha ${ficheNumber}`, error);
          ficheDebug.error = error.message;
          debugLog.summary.fichesWithErrors++;
          debugLog.groups.push(ficheDebug);
        }
      }

    } catch (error) {
      logError('SOFIA_SESSION', 'Error durante la sesión de Sofía Plus', error);
    } finally {
      log('SOFIA_CLOSE', 'Cerrando cliente de Sofia Plus...');
      await client.close();
      log('SOFIA_CLOSE', 'Cliente cerrado');
    }
    } // fin del else (modo Sofia Plus)

    // Guardar en BD si corresponde
    if (!skipSaveLog && debugLog.groups.some(g => g.pendingItems?.length > 0)) {
      log('SAVE_LOG', 'Guardando reporte en DailyAuditLog...');

      // Construir objeto para DailyAuditLog
      const auditLogData = {
        executionDate: new Date(),
        totalFichesWithIssues: debugLog.groups.filter(g => g.pendingItems?.length > 0).length,
        totalOutcomesPending: debugLog.summary.outcomesPending,
        totalVencidosOutcomes: debugLog.vencedOutcomes.length,
        details: debugLog.groups
          .filter(g => g.pendingItems?.length > 0)
          .map(g => ({
            ficheNumber: g.ficheNumber,
            ficheId: g.ficheId,
            ficheOwnerName: g.ficheOwner?.name || 'Sin líder',
            ficheOwnerEmail: g.ficheOwner?.email || '',
            pendingOutcomes: g.pendingItems.map(pi => ({
              scheduleId: pi.scheduleId,
              outcomeText: pi.outcomeText,
              isTotalMissing: pi.isTotalMissing,
              missingLearners: pi.missingLearners,
              totalLearners: pi.totalLearners,
              fend: pi.fend
            }))
          })),
        vencidosOutcomes: debugLog.vencedOutcomes.map(vo => ({
          ...vo,
          ficheOwnerName: vo.ficheOwnerName || vo.instructorName || '',
          ficheOwnerEmail: vo.ficheOwnerEmail || vo.instructorEmail || ''
        })),
        inconsistencias: debugLog.inconsistencias,
        summary: debugLog.summary
      };

      try {
        await DailyAuditLog.create(auditLogData);
        log('SAVE_LOG', 'Reporte guardado en DailyAuditLog correctamente');
      } catch (saveError) {
        logError('SAVE_LOG', 'Error guardando reporte en DailyAuditLog', saveError);
      }
    } else {
      log('SAVE_LOG', '[SKIP] No se guardó en BD (modo debug o sin pendientes)');
    }

  } catch (error) {
    logError('CRITICAL', 'Error crítico en reviewJudgmentDebug', error);
  }

  debugLog.endTime = new Date().toISOString();

  // Actualizar el registro único de estado actual con los datos recolectados
  log('UPDATE_STATE', 'Actualizando registro único de auditoría...');
  try {
    await updateCurrentAuditState(debugLog.pendientes, debugLog.vencidos, debugLog);
    log('UPDATE_STATE', 'Registro único actualizado correctamente');
  } catch (error) {
    logError('UPDATE_STATE', 'Error actualizando registro único', error);
  }

  // Guardar archivo de resumen
  const reportPath = await saveDebugReport(debugLog);
  log('REPORT', `Reporte de debug guardado en: ${reportPath}`);

  // Guardar archivo de resultados vencidos por separado
  if (debugLog.vencedOutcomes.length > 0) {
    const vencedPath = await saveVencedOutcomes(debugLog.vencedOutcomes);
    log('REPORT', `Reporte de vencidos guardado en: ${vencedPath}`);
  }

  return debugLog;
}

/**
 * Guarda el reporte de debug en un archivo JSON
 */
async function saveDebugReport(debugLog) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `audit-debug-${timestamp}.json`;
  const outputDir = process.env.OUTPUTDIR || './tmp';
  const filePath = path.join(outputDir, fileName);

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(debugLog, null, 2), 'utf-8');
    console.log(`\n========================================`);
    console.log(`REPORTE DE DEBUG GUARDADO EN:`);
    console.log(`${filePath}`);
    console.log(`========================================`);
    console.log(`RESUMEN:`);
    console.log(`  - Fichas procesadas: ${debugLog.summary.fichesProcessed}`);
    console.log(`  - Total filas del reporte: ${debugLog.summary.totalReportRows}`);
    console.log(`  - Filas EN FORMACION: ${debugLog.summary.totalRowsEnFormacion}`);
    console.log(`  - Resultados CALIFICADOS: ${debugLog.summary.outcomesRated}`);
    console.log(`  - Resultados PENDIENTES: ${debugLog.summary.outcomesPending}`);
    console.log(`  - Resultados VENCIDOS: ${debugLog.summary.totalVencedOutcomes}`);
    console.log(`  - Aprendices sin calificar: ${debugLog.summary.totalMissingLearners}`);
    console.log(`  - Fichas con errores: ${debugLog.summary.fichesWithErrors}`);
    console.log(`========================================\n`);
    return filePath;
  } catch (error) {
    console.error('Error guardando reporte de debug:', error);
    return null;
  }
}

/**
 * Guarda el reporte de resultados vencidos en un archivo JSON separado
 */
async function saveVencedOutcomes(vencedOutcomes) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `vencidos-${timestamp}.json`;
  const outputDir = process.env.OUTPUTDIR || './tmp';
  const filePath = path.join(outputDir, fileName);

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(vencedOutcomes, null, 2), 'utf-8');
    console.log(`\n========================================`);
    console.log(`RESULTADOS VENCIDOS GUARDADOS EN:`);
    console.log(`${filePath}`);
    console.log(`Total resultados vencidos: ${vencedOutcomes.length}`);
    console.log(`========================================\n`);
    return filePath;
  } catch (error) {
    console.error('Error guardando reporte de vencidos:', error);
    return null;
  }
}

export async function reviewJudgment() {
  const startTime = Date.now();
  console.log('Iniciando proceso de auditoría de juicios...');

  // Límite de fichas a procesar (configurable via MAX_GROUPS_TO_PROCESS)
  const MAX_FICHES = parseInt(process.env.MAX_GROUPS_TO_PROCESS, 10) || 3;

  // --- ACUMULADORES GLOBALES ---
  const allNotifiedInstructors = []; // Acumular todos los instructores notificados
  const globalAuditReport = {
    executionDate: new Date(),
    details: [], // Aquí meteremos cada ficha que tenga problemas
    totalOutcomesPending: 0,
    inconsistencias: [] // Resultados no encontrados en Excel
  };

  // Acumuladores para el estado actual (registro único)
  const pendientes = [];
  const vencidos = [];
  const failedFiches = []; // Fichas que fallaron al descargar (para revisión manual)
  const coordinationReports = new Map(); // Reportes por coordinación (coordinationId -> datos)

  try {
    const groups = await getAuditableGroups();




    if (!groups.length) {
      console.log('No hay programaciones pendientes de auditar.');
      return;
    }

    console.log(`Se procesarán ${groups.length} fichas.`);

    // Limitar a MAX_FICHES para producción (cambiar en .env MAX_GROUPS_TO_PROCESS)
    const groupsToProcess = groups.slice(0, MAX_FICHES);
    console.log(`[CRON] Limitando a ${groupsToProcess.length} de ${groups.length} fichas (MAX_GROUPS_TO_PROCESS=${MAX_FICHES})`);

    const client = new SofiaPlusClient();

    try {
      await client.startSession();

      // Loop principal por FICHA
      for (const group of groupsToProcess) {
        const { ficheNumber, schedules, ficheOwner, coordination } = group;
        const ficheOwnerName = ficheOwner?.name || 'Sin líder';
        const ficheOwnerEmail = ficheOwner?.email || '';

        const notifiedInstructors = []; // Instructores notificados en esta ficha
        console.log(`>>> Procesando Ficha: ${ficheNumber}`);

        let workbook;
        let reportPath = null;

        // Descargar Excel
        try {
          reportPath = await client.downloadReport(ficheNumber);
          const { workbook: wb, totalRows } = parseReportFile(reportPath);
          workbook = wb;
          console.log(`Archivo parseado: ${totalRows} filas con datos`);
        } catch (error) {
          console.error(`Error descargando reporte ficha ${ficheNumber}:`, error.message);
          // Agregar a lista de fichas fallidas para revisión manual
          failedFiches.push({
            ficheNumber,
            error: error.message
          });
          // Guardar en BD para mostrar en la interfaz
          try {
            await FailedFiche.findOneAndUpdate(
              { ficheNumber },
              { ficheNumber, error: error.message },
              { upsert: true, new: true }
            );
          } catch (err) {
            console.warn(`No se pudo guardar ficha fallida ${ficheNumber}:`, err.message);
          }
          continue;
        }

        // Indexar workbook una sola vez
        const { indexedResults } = indexWorkbookByOutcome(workbook);
        console.log(`Excel indexado: ${Object.keys(indexedResults).length} resultados encontrados`);

        const pendingItemsForEmail = []; // Para enviar correo individual
        const pendingItemsForLog = [];   // Para guardar en BD global

        // Analizar cada Resultado usando el índice
        for (const sched of schedules) {
          const schedInstructor = sched.instructor;
          const analysis = findOutcomeInIndex(indexedResults, sched.outcomeText);

          if (!analysis.foundColumn) {
            console.warn(`   [!] Columna no encontrada para: "${sched.outcomeText}"`);
            // Agregar a inconsistencias para revisión posterior
            globalAuditReport.inconsistencias.push({
              ficheNumber,
              ficheId: group.ficheId,
              scheduleId: sched.scheduleId,
              outcomeText: sched.outcomeText,
              instructorName: sched.instructor?.name || 'Sin instructor',
              instructorEmail: sched.instructor?.email || '',
              reason: 'Resultado no encontrado en el Excel de Sofía Plus (posible error de tipeo)'
            });
            continue;
          }

          if (analysis.isRated) {
            console.log(`   [OK] Calificado: Schedule ${sched.scheduleId}`);
            await markAsRated(sched.scheduleId, analysis.gradeDate);
          } else {
            // --- DETECTADO PENDIENTE ---
            // Filtrar aprendices omitidos de missingLearners
            const omittedDocs = sched.omittedLearners || [];
            const filteredLearners = analysis.missingLearners.filter(l =>
              !omittedDocs.includes(l.document)
            );

            const missingCount = filteredLearners.length;
            const totalCount = analysis.totalEnFormacion; // Usar totalEnFormacion
            const isTotalMissing = totalCount > 0 && (missingCount >= totalCount);

            // Si después de filtrar por omisiones no queda nadie, está calificado
            if (missingCount === 0 && analysis.missingLearners.length > 0) {
              console.log(`   [OK] Todos los aprendices sin nota están omitidos - Resultado calificado por omisión`);
              await markAsRated(sched.scheduleId, analysis.gradeDate);
              continue;
            }

            // Para el correo y log: si faltan todos, usar mensaje genérico
            const learnersForReport = isTotalMissing
              ? [{ name: '(Todos)', document: 'Resultado sin evaluar' }]
              : filteredLearners;

            // Verificar si está vencido
            const now = new Date();
            const fend = sched.fend ? new Date(sched.fend) : null;
            const isVencido = fend && now > fend;
            const daysOverdue = isVencido ? Math.floor((now - fend) / (1000 * 60 * 60 * 24)) : 0;

            // Construir objeto de estado para el registro único
            const outcomeState = buildOutcomeState({
              scheduleId: sched.scheduleId,
              ficheNumber,
              ficheId: group.ficheId,
              outcomeText: sched.outcomeText,
              fend: sched.fend,
              missingLearners: learnersForReport.map(l => ({ name: l.name, document: l.document })),
              totalLearners: totalCount,
              isTotalMissing,
              daysOverdue,
              instructorName: schedInstructor?.name || 'Sin instructor',
              instructorEmail: schedInstructor?.email || '',
              ficheOwnerName,
              ficheOwnerEmail,
              isVencido
            });

            if (isVencido) {
              vencidos.push(outcomeState);
              console.log(`   [VENCIDO] ${daysOverdue} días vencido - ${sched.outcomeText.substring(0, 40)}...`);
            } else {
              pendientes.push(outcomeState);
            }

            // Si faltan todos, mostrar mensaje simplificado
            if (isTotalMissing) {
              console.log(`   [PENDIENTE] Resultado sin evaluar (${totalCount} aprendices).`);
            } else {
              console.log(`   [PENDIENTE] Faltan ${missingCount} de ${totalCount} aprendices.`);
            }

            const itemData = {
              outcomeText: sched.outcomeText,
              missingLearners: learnersForReport,
              totalLearners: totalCount,
              isTotalMissing: isTotalMissing,
              instructor: schedInstructor
            };

            // 1. Agregar a lista de correo
            pendingItemsForEmail.push(itemData);

            // 2. Agregar a lista para Log Global (Estructura del modelo)
            pendingItemsForLog.push({
              scheduleId: sched.scheduleId,
              outcomeText: sched.outcomeText,
              isTotalMissing: isTotalMissing,
              missingLearners: learnersForReport.map(l => ({
                name: l.name,
                document: l.document
              }))
            });

            globalAuditReport.totalOutcomesPending++;
          }
        }

        // Si esta ficha tuvo pendientes, la agregamos al acumulador global
        if (pendingItemsForLog.length > 0) {
          globalAuditReport.details.push({
            ficheNumber: ficheNumber,
            ficheId: group.ficheId,
            pendingOutcomes: pendingItemsForLog
          });
        }

        // Enviar correos a cada instructor con sus pendientes
        if (pendingItemsForEmail.length > 0) {
          // Agrupar pendientes por instructor (usar _id como clave para evitar problemas con emails vacíos)
          const pendientesPorInstructor = {};
          for (const item of pendingItemsForEmail) {
            if (item.instructor) {
              const instructorId = item.instructor._id?.toString() || item.instructor.toString();
              if (!pendientesPorInstructor[instructorId]) {
                pendientesPorInstructor[instructorId] = {
                  instructor: item.instructor,
                  items: []
                };
              }
              pendientesPorInstructor[instructorId].items.push({
                outcomeText: item.outcomeText,
                missingLearners: item.missingLearners,
                totalLearners: item.totalLearners,
                isTotalMissing: item.isTotalMissing,
                daysOverdue: item.daysOverdue || 0
              });
            }
          }

          // Enviar correo a cada instructor
          for (const [instructorId, data] of Object.entries(pendientesPorInstructor)) {
            const result = await sendMissingGradesReport({
              instructor: data.instructor,
              ficheNumber,
              pendingItems: data.items,
              coordination
            });

            if (result.success) {
              // Acumular instructor notificado para el reporte al coordinador
              const emails = [data.instructor.email, data.instructor.emailpersonal].filter(Boolean).join(', ');
              notifiedInstructors.push({
                instructorName: data.instructor.name,
                instructorEmail: emails,
                ficheNumber,
                pendingCount: data.items.length,
                pendingItems: data.items // Incluir items completos para el resumen
              });

              // Acumular en reporte por coordinación
              if (coordination) {
                const coordId = coordination._id?.toString() || coordination.toString();
                if (!coordinationReports.has(coordId)) {
                  coordinationReports.set(coordId, {
                    coordination: coordination,
                    fichas: new Map() // ficheNumber -> { instructors: [], outcomes: [] }
                  });
                }
                const coordReport = coordinationReports.get(coordId);
                if (!coordReport.fichas.has(ficheNumber)) {
                  coordReport.fichas.set(ficheNumber, {
                    instructors: [],
                    outcomes: []
                  });
                }
                const ficheData = coordReport.fichas.get(ficheNumber);
                // Agregar instructor si no está ya en la lista
                if (!ficheData.instructors.some(i => i.email === emails)) {
                  ficheData.instructors.push({
                    name: data.instructor.name,
                    email: emails
                  });
                }
                // Agregar outcomes
                for (const item of data.items) {
                  ficheData.outcomes.push({
                    outcomeText: item.outcomeText,
                    daysOverdue: item.daysOverdue || 0,
                    instructorName: data.instructor.name
                  });
                }
              }
            }
          }
        }

        // Acumular instructores notificados de esta ficha al global
        allNotifiedInstructors.push(...notifiedInstructors);

        // Eliminar archivo
        if (reportPath) {
          try { await fs.unlink(reportPath); } catch (err) { console.warn(err.message); }
        }

      } // Fin del for(groups)

    } catch (error) {
      console.error('Error durante la sesión de Sofía Plus:', error);
    } finally {
      await client.close();
    }

    // --- GUARDADO FINAL DEL REPORTE GLOBAL ---
    // Solo guardamos si hubo al menos una ficha con problemas o inconsistencias
    if (globalAuditReport.details.length > 0 || globalAuditReport.inconsistencias.length > 0) {
      globalAuditReport.totalFichesWithIssues = globalAuditReport.details.length;

      try {
        await DailyAuditLog.create(globalAuditReport);
        console.log(`[EXITO] Reporte de auditoría global guardado. (${globalAuditReport.totalFichesWithIssues} fichas afectadas, ${globalAuditReport.inconsistencias.length} inconsistencias)`);
      } catch (saveError) {
        console.error('Error guardando el reporte global en Mongo:', saveError);
      }
    } else {
      console.log('[INFO] Auditoría terminada sin pendientes ni inconsistencias. No se generó reporte en BD.');
    }
    // -----------------------------------------

    // --- ACTUALIZAR REGISTRO ÚNICO DE ESTADO ACTUAL ---
    console.log('[AUDIT_STATE] Actualizando registro único de auditoría...');
    try {
      await updateCurrentAuditState(pendientes, vencidos);
      console.log(`[AUDIT_STATE] Registro único actualizado: ${pendientes.length} pendientes, ${vencidos.length} vencidos`);
    } catch (error) {
      console.error('[AUDIT_STATE] Error actualizando registro único:', error);
    }
    // ----------------------------------------------------

    // --- ENVIAR RESÚMENES A COORDINADORES ---
    console.log('[COORD_REPORT] Enviando resúmenes a coordinadores...');
    let coordSent = 0;
    let coordFailed = 0;
    for (const [coordId, report] of coordinationReports.entries()) {
      const result = await sendCoordinatorReport(report.coordination, report.fichas);
      if (result.success) {
        coordSent++;
      } else {
        coordFailed++;
      }
    }
    console.log(`[COORD_REPORT] Resúmenes enviados: ${coordSent} exitosos, ${coordFailed} fallidos`);
    // ----------------------------------------

  } catch (error) {
    console.error('Error crítico en reviewJudgment:', error);
  }

  // --- RESUMEN DE FICHAS QUE FALLARON AL DESCARGAR ---
  if (failedFiches.length > 0) {
    console.log(`\n========================================`);
    console.log(`[FICHAS_FALLIDAS] Fichas que fallaron al descargar (${failedFiches.length}):`);
    failedFiches.forEach(f => {
      console.log(`  - ${f.ficheNumber}: ${f.error}`);
    });
    console.log(`Revise estas fichas manualmente y omítalas desde la interfaz si es necesario.`);
    console.log(`========================================\n`);
  }
  // ----------------------------------------------------

  const elapsed = Date.now() - startTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = ((elapsed % 60000) / 1000).toFixed(1);
  console.log(`[AUDIT] Proceso completado en ${minutes}m ${seconds}s (${(elapsed / 1000).toFixed(1)}s total)`);
}