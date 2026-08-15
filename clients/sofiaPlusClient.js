import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

/**
 * Error que NO debe reintentarse (credenciales incorrectas, etc.)
 */
class SofiaFatalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.fatal = true;
  }
}

/**
 * Ejecuta una función con reintentos y backoff exponencial.
 * Si el error tiene `fatal = true`, no reintenta y lanza inmediatamente.
 */
async function withRetry(fn, { retries = 3, baseDelay = 30000, label = 'operación', onRetry } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      // Errores fatales no se reintentan
      if (error.fatal) {
        throw error;
      }

      if (attempt > retries) break;

      const delay = baseDelay * Math.pow(2, attempt - 1); // 60s, 120s, 240s...
      console.warn(
        `[RETRY] ${label} - Intento ${attempt}/${retries + 1} falló. ` +
        `Reintentando en ${Math.round(delay / 1000)}s...`,
        error.message
      );

      if (onRetry) {
        await onRetry({ attempt, error, nextDelay: delay });
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error(
    `${label}: Falló después de ${retries + 1} intentos.`,
    { cause: lastError }
  );
}


export class SofiaPlusClient {
  constructor({ headless, slowMo, retries, retryDelay } = {}) {
    this.headless =
      headless ?? (process.env.HEADLESS ? process.env.HEADLESS === 'true' : false);
    this.slowMo = slowMo ?? (process.env.SLOWMO ? parseInt(process.env.SLOWMO, 10) : 100);
    this.outputDir = process.env.OUTPUTDIR;
    this.sofiaUrl = process.env.SOFIA_URL || 'http://senasofiaplus.edu.co/sofia-public/';
    this.retries = retries ?? parseInt(process.env.SOFIA_RETRIES || '3', 10);
    this.retryDelay = retryDelay ?? parseInt(process.env.SOFIA_RETRY_DELAY || '60000', 10);
    this.browser = null;
    this.page = null;
    this.initializationPromise = null;
    this.#keepAliveInterval = null;
  }

  #keepAliveInterval = null;

  /**
   * Revisa si el diálogo de inactividad "Cierre de Sesión" está visible
   * y hace click en CANCELAR para mantener la sesión activa.
   */
  async #dismissSessionDialog() {
    if (!this.page) return;
    try {
      // El diálogo puede estar en el main page o dentro de iframe#contenido
      const targets = [this.page];
      const ch = await this.page.$('iframe#contenido').catch(() => null);
      if (ch) {
        const cf = await ch.contentFrame().catch(() => null);
        if (cf) targets.push(cf);
      }

      for (const target of targets) {
        const hasDialog = await target.evaluate(() =>
          (document.body?.textContent || '').includes('Cierre de Sesión') ||
          (document.body?.textContent || '').includes('se va a cerrar')
        ).catch(() => false);

        if (hasDialog) {
          const cancelBtn = target.getByRole('button', { name: /^cancelar$/i });
          const visible = await cancelBtn.isVisible({ timeout: 500 }).catch(() => false);
          if (visible) {
            await cancelBtn.click();
            console.log('[SOFIA_KEEPALIVE] Diálogo de inactividad dismissido, sesión mantenida.');
            return;
          }
        }
      }
    } catch { /* no interrumpir el flujo principal */ }
  }

  #startKeepAlive() {
    this.#stopKeepAlive();
    // Verificar cada 20 segundos si apareció el diálogo de cierre de sesión
    this.#keepAliveInterval = setInterval(
      () => this.#dismissSessionDialog().catch(() => {}),
      20000
    );
  }

  #stopKeepAlive() {
    if (this.#keepAliveInterval) {
      clearInterval(this.#keepAliveInterval);
      this.#keepAliveInterval = null;
    }
  }

  async #initializeBrowser() {
    try {
      this.browser = await chromium.launch({ headless: this.headless, slowMo: this.slowMo });
      this.page = await this.browser.newPage();
      return this.page;
    } catch (error) {
      this.browser = null;
      this.page = null;
      this.initializationPromise = null;
      throw new Error('No se pudo iniciar el navegador de Sofía Plus.', { cause: error });
    }
  }

  /**
   * Cierra el navegador y limpia el estado para permitir un reinicio limpio.
   */
  async #resetBrowser() {
    try {
      if (this.browser) await this.browser.close();
    } catch { /* ignorar */ }
    this.browser = null;
    this.page = null;
    this.initializationPromise = null;
  }

  async #ensurePage() {
    if (this.page) {
      return this.page;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.#initializeBrowser();
    }

    try {
      await this.initializationPromise;
      if (!this.page) {
        throw new Error('La página de Sofía Plus no se inicializó correctamente.');
      }
      return this.page;
    } catch (error) {
      throw new Error('No fue posible preparar la sesión con Sofía Plus.', { cause: error });
    }
  }

  async #loginOnce() {
    const page = await this.#ensurePage();

    await page.goto(this.sofiaUrl);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#registradoBox1', { timeout: 60000 });

    const iframeHandle = await page.$('#registradoBox1');
    if (!iframeHandle) {
      throw new Error(
        'No se encontró el iframe de inicio de sesión (#registradoBox1); verifique que la página cargó correctamente.'
      );
    }

    const loginFrame = await iframeHandle.contentFrame();
    await loginFrame.waitForSelector('input#username');
    await loginFrame.getByRole('textbox', { name: 'Número de Documento' }).fill(process.env.SOFIA_USER);
    await loginFrame.getByRole('textbox', { name: 'Contraseña' }).fill(process.env.SOFIA_PASS);
    await loginFrame.getByRole('button', { name: 'Ingresar' }).click();

    // Esperar el selector de rol (login exitoso)
    try {
      await page.waitForSelector('#seleccionRol\\:roles', { timeout: 60000 });
    } catch (timeoutError) {
      // Si no aparece el selector de rol, verificar si hay mensaje de error de credenciales
      try {
        const errorEl = await loginFrame.$('.ui-messages-error, .ui-message-error, [class*="error"], [class*="Error"]');
        if (errorEl) {
          const text = await errorEl.textContent().catch(() => '');
          throw new SofiaFatalError(
            `Login rechazado por Sofía Plus: ${text.trim() || 'Credenciales incorrectas'}. Verifique SOFIA_USER y SOFIA_PASS en el .env`
          );
        }
      } catch (checkError) {
        // Si el checkError es fatal (credenciales), propagarlo
        if (checkError.fatal) throw checkError;
      }
      // Si no hay mensaje de error, es problema de disponibilidad
      throw timeoutError;
    }
  }

  /**
   * Inicia sesión en Sofia Plus con reintentos automáticos.
   * Si falla por credenciales, NO reintenta y lanza error inmediato.
   */
  async login() {
    await withRetry(
      async () => {
        await this.#loginOnce();
      },
      {
        retries: this.retries,
        baseDelay: this.retryDelay,
        label: 'Login Sofia Plus',
        onRetry: async ({ attempt }) => {
          console.log(`[RETRY] Reiniciando navegador para intento ${attempt + 1}...`);
          await this.#resetBrowser();
        }
      }
    );
  }

  async selectRole(roleLabel = 'Gestión Desarrollo Curricular') {
    const page = await this.#ensurePage();

    try {
      const ROLE_SELECT = '#seleccionRol\\:roles';
      await page.waitForSelector(ROLE_SELECT, { timeout: 60000 });
      await page.selectOption(ROLE_SELECT, { label: roleLabel });
      // Esperar a que la página cargue completamente después de seleccionar el rol
      await page.waitForLoadState('load');
    } catch (error) {
      throw new Error(`No fue posible seleccionar el rol "${roleLabel}" en Sofía Plus.`, {
        cause: error
      });
    }
  }

  async navigateToReport() {
    const page = await this.#ensurePage();

    try {
      console.log('[SOFIA_NAV] Paso 1: Esperando menú lateral...');
      await page.waitForSelector('#side-menu, #menu_lateral', { timeout: 60000 });
      console.log('[SOFIA_NAV] Paso 1: Menú lateral encontrado ✓');

      console.log('[SOFIA_NAV] Paso 2: Buscando "Ejecución de la Formación"...');
      const ejecucion = page.getByRole('link', { name: 'Ejecución de la Formación' });
      await ejecucion.waitFor({ state: 'visible', timeout: 30000 });
      await ejecucion.click();
      console.log('[SOFIA_NAV] Paso 2: Click en "Ejecución de la Formación" ✓');

      console.log('[SOFIA_NAV] Paso 3: Buscando "Administrar Ruta de Aprendizaje"...');
      const ruta = page.getByRole('link', { name: 'Administrar Ruta de Aprendizaje' });
      await ruta.waitFor({ state: 'visible', timeout: 30000 });
      await ruta.click();
      console.log('[SOFIA_NAV] Paso 3: Click en "Administrar Ruta de Aprendizaje" ✓');

      // Paso 4: Buscar y hacer click en "Reportes" con reintentos
      console.log('[SOFIA_NAV] Paso 4: Buscando "Reportes" (con reintentos)...');
      let reportesClicked = false;
      for (let attempt = 1; attempt <= 5 && !reportesClicked; attempt++) {
        await page.waitForTimeout(2000); // Esperar entre intentos

        const reportesElements = await page.$$('a');
        for (const el of reportesElements) {
          const text = await el.textContent();
          if (text && text.trim() === 'Reportes') {
            const isVisible = await el.isVisible();
            if (isVisible) {
              const box = await el.boundingBox();
              console.log(`[SOFIA_NAV] Paso 4 (intento ${attempt}): Encontrado "Reportes" en posición ${JSON.stringify(box)}`);
              await el.click();
              reportesClicked = true;
              console.log('[SOFIA_NAV] Paso 4: Click en "Reportes" ✓');
              break;
            }
          }
        }

        if (!reportesClicked) {
          console.log(`[SOFIA_NAV] Paso 4 (intento ${attempt}): "Reportes" no visible aún, reintentando...`);
        }
      }

      if (!reportesClicked) {
        throw new Error('No se encontró ningún enlace "Reportes" visible después de 5 intentos.');
      }

      // Paso 5: Buscar y hacer click en "Reporte de Juicios de Evaluación" con reintentos
      console.log('[SOFIA_NAV] Paso 5: Buscando "Reporte de Juicios de Evaluación" (con reintentos)...');
      let reporteJuiciosClicked = false;
      for (let attempt = 1; attempt <= 5 && !reporteJuiciosClicked; attempt++) {
        await page.waitForTimeout(2000); // Esperar entre intentos

        const allLinks = await page.$$('a');
        for (const el of allLinks) {
          const text = await el.textContent();
          if (text && text.includes('Reporte de Juicios de Evaluaci')) {
            const isVisible = await el.isVisible();
            if (isVisible) {
              console.log(`[SOFIA_NAV] Paso 5 (intento ${attempt}): Encontrado "Reporte de Juicios de Evaluación"`);
              await el.click();
              reporteJuiciosClicked = true;
              console.log('[SOFIA_NAV] Paso 5: Click en "Reporte de Juicios de Evaluación" ✓');
              break;
            }
          }
        }

        if (!reporteJuiciosClicked) {
          console.log(`[SOFIA_NAV] Paso 5 (intento ${attempt}): "Reporte de Juicios..." no visible aún, reintentando...`);
        }
      }

      if (!reporteJuiciosClicked) {
        throw new Error('No se encontró el enlace "Reporte de Juicios de Evaluación" después de 5 intentos.');
      }

      console.log('[SOFIA_NAV] Paso 6: Esperando iframe#contenido...');
      await page.waitForSelector('iframe#contenido', { timeout: 60000 });
      console.log('[SOFIA_NAV] Paso 6: iframe#contenido encontrado ✓ — Navegación completa');
    } catch (error) {
      console.error('[SOFIA_NAV] ERROR en navegación:', error.message);
      // Capturar screenshot para diagnóstico
      try {
        const screenshotPath = path.join(this.outputDir || '.', `sofia_nav_error_${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`[SOFIA_NAV] Screenshot guardado en: ${screenshotPath}`);
      } catch (ssErr) {
        console.warn('[SOFIA_NAV] No se pudo guardar screenshot:', ssErr.message);
      }
      throw new Error('No fue posible navegar al reporte de juicios de evaluación en Sofía Plus.', {
        cause: error
      });
    }
  }

  /**
   * Establece la sesión completa: login + seleccionar rol + navegar al reporte.
   * Todo con reintentos. Si falla por credenciales, para de inmediato.
   */
  async startSession(roleLabel = 'Gestión Desarrollo Curricular') {
    await withRetry(
      async () => {
        await this.#loginOnce();
        await this.selectRole(roleLabel);
        await this.navigateToReport();
      },
      {
        retries: this.retries,
        baseDelay: this.retryDelay,
        label: 'Sesión completa Sofia Plus',
        onRetry: async ({ attempt }) => {
          console.log(`[RETRY] Reiniciando navegador para intento de sesión ${attempt + 1}...`);
          await this.#resetBrowser();
        }
      }
    );
    // Iniciar keep-alive para prevenir cierre de sesión por inactividad
    this.#startKeepAlive();
  }

  async downloadReport(codigoFicha, retries = 2) {
    if (!codigoFicha) {
      throw new Error('Se requiere un código de ficha válido para descargar el reporte.');
    }

    const page = await this.#ensurePage();
    let lastError;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        return await this.#downloadReportOnce(codigoFicha, page, attempt);
      } catch (error) {
        lastError = error;
        console.warn(`[SOFIA] Intento ${attempt}/${retries + 1} falló para ficha ${codigoFicha}: ${error.message}`);

        // Si el error es fatal (ej: ficha no encontrada), no reintentar
        if (error.fatal || error.message?.includes('no encontrada')) {
          throw error;
        }

        // Si es el último intento, lanzar el error
        if (attempt > retries) {
          throw new Error(
            `Fallo al descargar el reporte de juicios de evaluación para la ficha ${codigoFicha}.`,
            { cause: error }
          );
        }

        // Esperar antes de reintentar (backoff simple)
        const delay = 2000 * attempt; // 2s, 4s, 6s...
        console.log(`[SOFIA] Esperando ${delay}ms antes de reintentar...`);
        await page.waitForTimeout(delay);
      }
    }

    throw lastError;
  }

  async #downloadReportOnce(codigoFicha, page, attempt = 1) {
    let modalOpened = false;

    console.log(`[SOFIA] Descargando reporte para ficha ${codigoFicha} (intento ${attempt})...`);

    try {
      // Esperar a que el iframe de contenido esté listo
      const contenidoHandle = await page.waitForSelector('iframe#contenido', { timeout: 60000 });
      let frame = await contenidoHandle.contentFrame();

      // IMPORTANTE: Verificar si hay un modal VISIBLEMENTE abierto del intento anterior y cerrarlo.
      // No basta con que el elemento exista en el DOM — JSF lo mantiene siempre en la página (oculto).
      // Hay que comprobar la visibilidad CSS para evitar falsos positivos.
      try {
        const modalExistente = await frame.evaluate(() => {
          const isVisible = el => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
          };
          const underlay = document.querySelector('.dialogUnderlay');
          const modal = document.getElementById('modalDialogContentviewDialog2');
          return isVisible(underlay) || isVisible(modal);
        });

        if (modalExistente) {
          console.log(`[SOFIA] Modal detectado de intento anterior, recargando página...`);
          // Hacer click en "Reporte de Juicios de Evaluación" usando JavaScript
          await frame.evaluate(() => {
            const link = Array.from(document.querySelectorAll('a')).find(a =>
              a.textContent.includes('Reporte de Juicios de Evaluación')
            );
            if (link) link.click();
          });
          await page.waitForTimeout(3000); // Esperar a que recargue completamente
          // Obtener frame fresco después de recargar
          frame = await (await page.waitForSelector('iframe#contenido', { timeout: 60000 })).contentFrame();
        }
      } catch (cleanupError) {
        console.log(`[SOFIA] Error limpiando modal previo: ${cleanupError.message}`);
      }

      // El JavaScript del modal (enviarParametro y el script de respuesta del servidor)
      // accede al formulario padre con document.forms['frmForma1'], que busca por atributo
      // name=, NO por id=. El HTML solo tiene id="frmForma1" sin name=, así que retorna
      // undefined y falla todo: el campo no se llena y el modal no se cierra.
      // Solución: asignar name="frmForma1" al form antes de abrir el modal.
      await frame.evaluate(() => {
        const form = document.getElementById('frmForma1');
        if (form && !form.name) form.name = 'frmForma1';
      }).catch(() => {});

      // Hacer click en "Buscar Ficha de Caracterización"
      // Primero intentar con JavaScript directo (llamando la función que abre el modal)
      await frame.evaluate(() => {
        // Buscar el enlace y llamar directamente a la función onclick
        const link = Array.from(document.querySelectorAll('a')).find(a =>
          a.textContent.includes('Buscar Ficha de Caracterización') ||
          a.id === 'frmForma1:cmdlnkShow145'
        );
        if (link) {
          // Llamar a la función que abre el modal directamente
          if (typeof viewDialog2 !== 'undefined' && viewDialog2.show) {
            viewDialog2.show();
          } else {
            link.click();
          }
        }
      });

      // Esperar un momento a que el modal aparezca
      await page.waitForTimeout(1000);

      const modalHandle = await frame.waitForSelector('iframe#modalDialogContentviewDialog2', {
        timeout: 60000
      });
      modalOpened = true;
      const modalFrame = await modalHandle.contentFrame();
      await modalFrame.waitForSelector('input[id$="codigoFichaITX"]', { timeout: 60000 });

      await modalFrame.fill('input[id$="codigoFichaITX"]', String(codigoFicha));
      await modalFrame.getByRole('button', { name: 'Consultar' }).click();

      // Esperar un momento para que cargue la respuesta
      await page.waitForTimeout(2000);

      // Verificar si hay error de "no encontrado" - buscar el mensaje específico
      const errorDetected = await modalFrame.evaluate(() => {
        // Buscar mensajes de error comunes
        const warnMsg = document.querySelector('span.warn');
        if (warnMsg) {
          return warnMsg.textContent?.trim() || '';
        }

        // Buscar el mensaje específico "No se encontraron registros para la opción seleccionada"
        const allText = document.body?.textContent || '';
        if (allText.includes('No se encontraron registros para la opción seleccionada') ||
            allText.includes('No se encontraron registros')) {
          return 'No se encontraron registros para la opción seleccionada';
        }

        return '';
      });

      if (errorDetected) {
        console.log(`[SOFIA] Ficha ${codigoFicha} no encontrada: ${errorDetected}`);
        const fatalErr = new Error(`Ficha ${codigoFicha} no encontrada en Sofía Plus: ${errorDetected}`);
        fatalErr.fatal = true; // Marcar como fatal para no reintentar
        throw fatalErr;
      }

      // Verificar si hay filas antes de continuar
      const hasRows = await modalFrame.locator('table[id$="dtFichas"] tbody tr').count() > 0;
      if (!hasRows) {
        const fatalErr = new Error(`Ficha ${codigoFicha} no encontrada (tabla vacía)`);
        fatalErr.fatal = true; // Marcar como fatal para no reintentar
        throw fatalErr;
      }

      // Verificar que el enlace de selección existe y registrar diagnóstico del entorno del modal
      const selectionLink = modalFrame.locator('a[id$="cmdlnkShow"]').first();
      await selectionLink.waitFor({ state: 'visible', timeout: 10000 });

      const selDiag = await modalFrame.evaluate(() => {
        const link = document.querySelector('a[id$="cmdlnkShow"]');
        const form = document.getElementById('form');
        return {
          linkId: link?.id,
          onclick: link?.getAttribute('onclick'),
          formFound: !!form,
          formAction: form?.action,
          oamDefined: typeof oamSubmitForm !== 'undefined',
          envDefined: typeof enviarParametro !== 'undefined',
        };
      });
      console.log('[SOFIA] Diagnóstico pre-selección:', JSON.stringify(selDiag));

      // Screenshot del modal justo antes de hacer click
      try {
        const modalSS = path.join(this.outputDir || '.', `sofia_modal_${codigoFicha}_${Date.now()}.png`);
        const modalFrameEl = await page.$('iframe#contenido');
        if (modalFrameEl) await page.screenshot({ path: modalSS, fullPage: true });
        console.log(`[SOFIA] Screenshot modal: ${modalSS}`);
      } catch { /* ignorar */ }

      // Extraer label y código del onclick ANTES de llamar oamSubmitForm
      const fichaInfo = await modalFrame.evaluate(() => {
        const link = document.querySelector('a[id$="cmdlnkShow"]');
        if (!link) return { error: 'link not found' };
        const m = (link.getAttribute('onclick') || '').match(/enviarParametro\('([^']+)'\s*,\s*'([^']+)'\)/);
        return m ? { label: m[1], code: m[2], linkId: link.id } : { error: 'no se pudo extraer parámetros' };
      });
      if (fichaInfo.error) throw new Error(`Selección de ficha: ${fichaInfo.error}`);

      // Llamar oamSubmitForm para notificar al servidor de la selección.
      // enviarParametro falla porque accede al form padre por nombre (document.forms['frmForma1'])
      // pero el form solo tiene id= sin name=. Lo que debía hacer enviarParametro lo hacemos
      // nosotros directamente después.
      await modalFrame.evaluate((linkId) => {
        if (typeof oamSubmitForm !== 'undefined') oamSubmitForm('form', linkId);
      }, fichaInfo.linkId);

      // Esperar brevemente a que el servidor procese el submit (AJAX o form POST)
      await page.waitForTimeout(2000);

      // Replicar lo que enviarParametro debía hacer: setear los campos del form externo.
      // Campos confirmados via diagnóstico: inputFichaCaracterizacionPrograma (textarea visible),
      // hi_inputFichaCaracterizacionPrograma (hidden, código), valorCampo (hidden, código).
      await frame.evaluate(({ label, code }) => {
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        set('inputFichaCaracterizacionPrograma', label);
        set('hi_inputFichaCaracterizacionPrograma', code);
        set('valorCampo', code);
      }, { label: fichaInfo.label, code: fichaInfo.code });
      console.log(`[SOFIA] Campos ficha seteados: code="${fichaInfo.code}"`);

      // Cerrar el modal manualmente (el JS de respuesta del servidor también falla por el
      // mismo bug de document.forms['frmForma1'], así que cerramos nosotros).
      await frame.evaluate(() => {
        if (typeof viewDialog2 !== 'undefined') try { viewDialog2.hide(); } catch(e) {}
        const closeBtn = document.querySelector('.dialogCloseButton, [class*="closeButton"]');
        if (closeBtn) closeBtn.click();
      });
      await page.waitForTimeout(1000);

      // Verificar que el modal cerró; si no, forzar con Escape
      const modalAunVisible = await frame.evaluate(() => {
        const el = document.getElementById('modalDialogContentviewDialog2');
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      });
      if (modalAunVisible) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1000);
      }

      await frame.waitForSelector('input#frmForma1\\:btnConsultar', { timeout: 30000 });

      // Diagnóstico: capturar estado de la página antes de intentar la descarga
      try {
        const ssPath = path.join(this.outputDir || '.', `sofia_before_download_${codigoFicha}_${Date.now()}.png`);
        await page.screenshot({ path: ssPath, fullPage: true });
        console.log(`[SOFIA] Screenshot pre-descarga: ${ssPath}`);

        const frameUrl = frame.url();
        console.log(`[SOFIA] URL del frame en este punto: ${frameUrl}`);

        const buttons = await frame.evaluate(() =>
          Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button'))
            .map(b => ({ tag: b.tagName, id: b.id, name: b.name, value: b.value, text: b.textContent?.trim() }))
        );
        console.log(`[SOFIA] Botones visibles en el frame:`, JSON.stringify(buttons));
      } catch (diagErr) {
        console.warn('[SOFIA] Error en diagnóstico pre-descarga:', diagErr.message);
      }

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        frame.getByRole('button', { name: 'Generar Reporte' }).click()
      ]);

      const suggested = await download.suggestedFilename();
      const ext = path.extname(suggested);
      const base = path.basename(suggested, ext);
      const finalName = `${base} ${codigoFicha}${ext}`;
      console.log(`Archivo sugerido por Sofía Plus para la ficha ${codigoFicha}: ${finalName}`);

      const filePath = path.join(this.outputDir, finalName);
      await fs.mkdir(this.outputDir, { recursive: true });
      await download.saveAs(filePath);

      console.log(`[SOFIA] Descarga exitosa para ficha ${codigoFicha}: ${filePath}`);
      return filePath;
    } finally {
      // Limpiar el modal si quedó abierto - hacer click en "Reporte de Juicios de Evaluación"
      if (modalOpened) {
        try {
          const contenidoHandle = await page.$('iframe#contenido');
          if (!contenidoHandle) return;

          const frame = await contenidoHandle.contentFrame();

          // Hacer click usando JavaScript para evitar problemas de elementos bloqueados
          await frame.evaluate(() => {
            const link = Array.from(document.querySelectorAll('a')).find(a =>
              a.textContent.includes('Reporte de Juicios de Evaluación')
            );
            if (link) link.click();
          });
          await page.waitForTimeout(2500);
        } catch (cleanupError) {
          console.log(`[SOFIA] Error en limpieza final: ${cleanupError.message}`);
        }
      }
    }
  }

  async close() {
    this.#stopKeepAlive();
    try {
      if (this.browser) {
        await this.browser.close();
      }
    } finally {
      this.browser = null;
      this.page = null;
      this.initializationPromise = null;
    }
  }
}

export default SofiaPlusClient;
