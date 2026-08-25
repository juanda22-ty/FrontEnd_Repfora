import sendEmail from '../utils/emails/sendEmail.js';
import * as fs from 'fs';
import path from 'path';
import url from 'url';
import AppSettings, { EMAIL_TEMPLATE_DEFAULTS } from '../models/AppSettings.js';

// Configuración de correo desde variables de entorno
let emailEnabled = process.env.EMAIL_ENABLED === 'true';
const DEFAULT_EMAIL_USER = process.env.FROM_EMAIL;
const DEFAULT_EMAIL_PASS = process.env.SECURY_EMAIL;
const USE_TEST_RECIPIENT = process.env.USE_TEST_RECIPIENT === 'true';
const TEST_MAIL_RECIPIENT = process.env.TEST_MAIL_RECIPIENT;

export async function initEmailSettings() {
  try {
    let settings = await AppSettings.findOne();
    if (!settings) {
      settings = await AppSettings.create({ emailEnabled });
      console.log(`[EMAIL] Configuración inicial guardada en BD (emailEnabled=${emailEnabled})`);
    } else {
      emailEnabled = settings.emailEnabled;
      console.log(`[EMAIL] Estado cargado desde BD (emailEnabled=${emailEnabled})`);
    }
  } catch (error) {
    console.error('[EMAIL] Error cargando configuración desde BD, usando env var:', error.message);
  }
}

export function getEmailStatus() {
  return { enabled: emailEnabled };
}

export async function setEmailEnabled(value) {
  emailEnabled = value;
  try {
    await AppSettings.findOneAndUpdate({}, { emailEnabled: value }, { upsert: true });
  } catch (error) {
    console.error('[EMAIL] Error guardando configuración en BD:', error.message);
  }
}

// BCC (copia oculta) - preparado para uso futuro
const BCC_EMAILS = process.env.BCC_EMAILS ? process.env.BCC_EMAILS.split(',').map(e => e.trim()) : [];

/**
 * Calcula una fecha sumando N días hábiles (lunes a viernes) a partir de hoy
 */
function addBusinessDays(days) {
  const date = new Date();
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const dayOfWeek = date.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      added++;
    }
  }
  return date.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Genera el HTML del correo para instructores
 */
function generateInstructorEmailHTML({ instructorName, ficheNumber, pendingItems, template, coordinatorName = '', supportEmails = '' }) {
  const t = { ...EMAIL_TEMPLATE_DEFAULTS, ...template };

  // Generar lista de resultados pendientes con aprendices
  const outcomesList = pendingItems.map(item => {
    const missingCount = item.missingLearners?.length || 0;
    const totalCount = item.totalLearners || 0;
    const isTotalMissing = item.isTotalMissing || (totalCount > 0 && missingCount >= totalCount);

    if (isTotalMissing) {
      return `• ${item.outcomeText}`;
    } else {
      const learnersList = item.missingLearners
        .map(l => `  - ${l.name}`)
        .join('<br>');
      return `• ${item.outcomeText}<br><span style="color: #666; font-size: 14px;">Aprendices faltantes:<br>${learnersList}</span>`;
    }
  }).join('<br><br>');

  const deadlineDate = addBusinessDays(t.deadlineDays || 3);

  // Reemplazar variables en el contenido (convertir saltos de línea a <br>)
  let content = t.content
    .replace(/\{nombreInstructor\}/gi, instructorName)
    .replace(/\{instructorName\}/gi, instructorName) // Para compatibilidad
    .replace(/\{fichaNumero\}/gi, ficheNumber)
    .replace(/\{RESULTS_BLOCK\}/gi, outcomesList)
    .replace(/\{FECHA_AUTOMÁTICA\}/gi, deadlineDate)
    .replace(/\{SUPPORT_EMAILS\}/gi, supportEmails) // Correos de soporte
    .replace(/\n/g, '<br>'); // Convertir saltos de línea a <br>

  // Agregar firma del coordinador al final
  const coordinatorSignature = coordinatorName
    ? `<p style="margin-top: 30px; color: #666;">Cordialmente,<br><strong>${coordinatorName}</strong><br>Coordinador(a)</p>`
    : '';

  return `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 700px; margin: 0 auto; padding: 20px;">
${content}
${coordinatorSignature}
    </div>
  `;
}

/**
 * Plantilla base para handlebars (misma estructura que baseNew.hbs)
 */
function getBaseTemplate() {
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Correo REPFORA</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
      <table style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #dddddd; padding: 20px;">
        <tr>
          <td style="text-align: center; padding: 20px 0;">
            <h1 style="color: #39A900; margin: 0;">REPFORA</h1>
          </td>
        </tr>
        <tr>
          <td style="padding: 20px;">
            {{{html}}}
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

/**
 * Envía correo de reporte de calificaciones pendientes a un instructor
 * Usa la misma función sendEmail que new.controller.js
 */
export async function sendMissingGradesReport({ instructor, ficheNumber, pendingItems, coordination }) {
  // Validaciones
  if (!emailEnabled) {
    console.log('[EMAIL] Envío de correos deshabilitado (emailEnabled=false)');
    return { success: false, error: 'Email disabled' };
  }

  if (!instructor?.email && !instructor?.emailpersonal) {
    console.warn('[EMAIL] Instructor sin email, omitiendo envío');
    return { success: false, error: 'No email provided' };
  }

  // Usar credenciales de la coordinación - si no tiene, NO enviar
  const fromEmail = coordination?.email;
  const fromPass = coordination?.passapp;

  if (!fromEmail || !fromPass) {
    console.warn('[EMAIL] Coordinación sin credenciales de correo configuradas, omitiendo envío');
    return { success: false, error: 'No email credentials' };
  }

  try {
    // Cargar plantilla desde BD
    let template = EMAIL_TEMPLATE_DEFAULTS;
    try {
      const settings = await AppSettings.findOne().lean();
      if (settings?.emailTemplate) {
        template = { ...EMAIL_TEMPLATE_DEFAULTS, ...settings.emailTemplate };
      }
    } catch (err) {
      console.warn('[EMAIL] No se pudo cargar plantilla desde BD, usando defaults:', err.message);
    }
    // console.log(groups["0"].coordination.coordinator.name);
    const htmlContent = generateInstructorEmailHTML({
      instructorName: instructor.name,
      ficheNumber,
      pendingItems,
      template,
      coordinatorName: coordination?.coordinator.name || '',
      supportEmails: coordination?.emailsupervisor || 'tituladacat@sena.edu.co; nduartep@sena.edu.co'
    });

    // Determinar destinatarios (test mode vs production)
    let toEmails = [];
    if (USE_TEST_RECIPIENT) {
      toEmails = [TEST_MAIL_RECIPIENT];
    } else {
      if (instructor.email) toEmails.push(instructor.email);
      if (instructor.emailpersonal) toEmails.push(instructor.emailpersonal);
    }

    // Reemplazar variables en el subject
    const subject = template.subject.replace(/\{fichaNumero\}/gi, ficheNumber);

    await sendEmail(
      fromEmail,
      fromPass,
      toEmails,
      subject,
      { html: htmlContent },
      "./template/baseEmail.hbs",
      null
    );

    console.log(`[EMAIL] ✓ Correo enviado a ${toEmails.join(', ')} (${instructor.name}) para ficha ${ficheNumber} [desde: ${fromEmail}]`);
    if (USE_TEST_RECIPIENT) {
      console.log(`[EMAIL] (TEST MODE: Redirigido a ${TEST_MAIL_RECIPIENT})`);
    }

    return { success: true, error: null };

  } catch (error) {
    const emails = [instructor.email, instructor.emailpersonal].filter(Boolean).join(', ');
    console.error(`[EMAIL] ✗ Error enviando a ${emails}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Envía múltiples correos en lote con resumen de resultados
 */
export async function sendBatchEmails(emailsToSend) {
  const results = {
    sent: 0,
    failed: 0,
    errors: []
  };

  for (const emailData of emailsToSend) {
    const result = await sendMissingGradesReport(emailData);
    if (result.success) {
      results.sent++;
    } else {
      results.failed++;
      results.errors.push({
        instructor: emailData.instructor?.email,
        fiche: emailData.ficheNumber,
        error: result.error
      });
    }
  }

  return results;
}

/**
 * Envía un resumen al coordinador con las fichas que tuvieron problemas
 * @param {Object} coordination - La coordinación con email y supervisoremail
 * @param {Map} fichas - Map de fichas { ficheNumber -> { instructors: [], outcomes: [] } }
 */
export async function sendCoordinatorReport(coordination, fichas) {
  // Validaciones
  if (!emailEnabled) {
    console.log('[EMAIL] Envío de correos deshabilitado (emailEnabled=false)');
    return { success: false, error: 'Email disabled' };
  }

  if (!coordination?.emailcoordinator) {
    console.warn('[EMAIL] Coordinación sin emailcoordinator, omitiendo envío');
    return { success: false, error: 'No email provided' };
  }

  if (!fichas || fichas.size === 0) {
    console.log('[EMAIL] No hay fichas para reportar al coordinador');
    return { success: true, error: null };
  }

  // Usar credenciales de la coordinación
  const fromEmail = coordination.email;
  const fromPass = coordination.passapp;

  if (!fromEmail || !fromPass) {
    console.error('[EMAIL] No hay credenciales de correo configuradas para la coordinación');
    return { success: false, error: 'No email credentials' };
  }

  try {
    // Generar contenido del resumen
    let fichasContent = '';
    for (const [ficheNumber, data] of fichas.entries()) {
      fichasContent += `<div style="margin-bottom: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background-color: #f9f9f9;">`;
      fichasContent += `<h3 style="margin: 0 0 10px 0; color: #0056b3;">Ficha: ${ficheNumber}</h3>`;

      // Lista de instructores notificados
      fichasContent += `<p style="margin: 5px 0;"><strong>Instructores notificados:</strong></p>`;
      fichasContent += `<ul style="margin: 5px 0; padding-left: 20px;">`;
      for (const instructor of data.instructors) {
        fichasContent += `<li>${instructor.name} (${instructor.email})</li>`;
      }
      fichasContent += `</ul>`;

      // Lista de resultados pendientes
      fichasContent += `<p style="margin: 10px 0 5px 0;"><strong>Resultados pendientes:</strong></p>`;
      fichasContent += `<ul style="margin: 5px 0; padding-left: 20px;">`;
      for (const outcome of data.outcomes) {
        const outcomePreview = outcome.outcomeText.substring(0, 50) + (outcome.outcomeText.length > 50 ? '...' : '');
        const daysText = outcome.daysOverdue > 0 ? ` <span style="color: #dc3545; font-weight: bold;">(${outcome.daysOverdue} días vencido)</span>` : '';
        fichasContent += `<li>${outcomePreview}${daysText} - ${outcome.instructorName}</li>`;
      }
      fichasContent += `</ul>`;
      fichasContent += `</div>`;
    }

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 700px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #0056b3;">Resumen de Juicios Evaluativos Pendientes</h2>
        <p>Estimado(a) Coordinador(a),</p>
        <p>A continuación se presenta el resumen de fichas con juicios evaluativos pendientes en su coordinación:</p>
        ${fichasContent}
        <p style="margin-top: 20px;">Por favor revise el estado de estas fichas y gestione el seguimiento correspondiente.</p>
        <p style="color: #666; font-size: 12px;">Este mensaje fue generado automáticamente por el sistema REPFORA.</p>
      </div>
    `;

    // Determinar destinatarios (test mode vs production)
    // Determinar destinatarios
    const toEmails = [coordination.emailcoordinator];
    const ccEmails = coordination.emailsupervisor ? coordination.emailsupervisor.split(',').map(e => e.trim()) : [];

    await sendEmail(
      fromEmail,
      fromPass,
      toEmails,
      `Resumen de Juicios Evaluativos Pendientes - ${coordination.name}`,
      { html: htmlContent },
      "./template/baseEmail.hbs",
      ccEmails.length > 0 ? ccEmails : null
    );

    console.log(`[EMAIL] ✓ Correo enviado a coordinador ${coordination.name} (${toEmails.join(', ')})`);
    if (ccEmails.length > 0) {
      console.log(`[EMAIL] CC: ${ccEmails.join(', ')}`);
    }

    return { success: true, error: null };

  } catch (error) {
    console.error(`[EMAIL] ✗ Error enviando a coordinador ${coordination.name}:`, error.message);
    return { success: false, error: error.message };
  }
}
