(() => {
  'use strict';

  const DB_NAME = 'tfs_access_v1';
  const DB_VERSION = 1;
  const DEFAULT_SETTINGS = {
    eventName: 'THE FIRS SCREAM',
    eventDate: '2026-10-23T19:00',
    phases: [
      { id: 'fase1', name: 'Fase 1', price: 80 },
      { id: 'fase2', name: 'Fase 2', price: 100 },
      { id: 'fase3', name: 'Fase 3', price: 110 },
      { id: 'cover', name: 'Cover', price: 120 },
      { id: 'cortesia', name: 'Cortesía', price: 0 }
    ]
  };

  let db;
  let settings = structuredClone(DEFAULT_SETTINGS);
  let eventSecret = null;
  let html5QrCode = null;
  let scannerRunning = false;
  let scanBusy = false;
  let lastCheckinId = null;
  let currentDialogTicketId = null;
  let toastTimer = null;
  let audioCtx = null;

  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    db = await openDb();
    await ensureMeta();
    await requestPersistentStorage();
    bindEvents();
    populateSettingsUI();
    await renderAll();
    updateConnectionBadge();
    window.addEventListener('online', updateConnectionBadge);
    window.addEventListener('offline', updateConnectionBadge);
    await registerServiceWorker();
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains('tickets')) {
          const store = database.createObjectStore('tickets', { keyPath: 'id' });
          store.createIndex('code', 'code', { unique: true });
          store.createIndex('createdAt', 'createdAt');
          store.createIndex('usedAt', 'usedAt');
        }
        if (!database.objectStoreNames.contains('meta')) {
          database.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(storeName, mode, action) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;
      try { request = action(store); } catch (err) { reject(err); return; }
      if (request && 'onsuccess' in request) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } else {
        transaction.oncomplete = () => resolve(request);
        transaction.onerror = () => reject(transaction.error);
      }
    });
  }

  const dbGetMeta = (key) => tx('meta', 'readonly', s => s.get(key));
  const dbPutMeta = (key, value) => tx('meta', 'readwrite', s => s.put({ key, value }));
  const dbGetAllTickets = () => tx('tickets', 'readonly', s => s.getAll());
  const dbGetTicket = (id) => tx('tickets', 'readonly', s => s.get(id));
  const dbPutTicket = (ticket) => tx('tickets', 'readwrite', s => s.put(ticket));
  const dbDeleteTicket = (id) => tx('tickets', 'readwrite', s => s.delete(id));
  const dbClearTickets = () => tx('tickets', 'readwrite', s => s.clear());
  const dbClearMeta = () => tx('meta', 'readwrite', s => s.clear());

  function dbGetTicketByCode(code) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('tickets', 'readonly');
      const req = transaction.objectStore('tickets').index('code').get(code);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function ensureMeta() {
    const savedSettings = await dbGetMeta('settings');
    const savedSecret = await dbGetMeta('eventSecret');
    if (savedSettings?.value) settings = normalizeSettings(savedSettings.value);
    else await dbPutMeta('settings', settings);

    if (savedSecret?.value) eventSecret = savedSecret.value;
    else {
      eventSecret = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      await dbPutMeta('eventSecret', eventSecret);
    }
  }

  function normalizeSettings(value) {
    const result = structuredClone(DEFAULT_SETTINGS);
    if (typeof value?.eventName === 'string' && value.eventName.trim()) result.eventName = value.eventName.trim();
    if (typeof value?.eventDate === 'string' && value.eventDate) result.eventDate = value.eventDate;
    if (Array.isArray(value?.phases) && value.phases.length) {
      result.phases = value.phases.map((p, i) => ({
        id: String(p.id || `phase${i + 1}`),
        name: String(p.name || `Fase ${i + 1}`).slice(0, 30),
        price: Math.max(0, Number(p.price) || 0)
      }));
    }
    return result;
  }

  async function requestPersistentStorage() {
    try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch (_) {}
  }

  function bindEvents() {
    document.addEventListener('click', async (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) { navigate(nav.dataset.nav); return; }

      const row = e.target.closest('[data-ticket-id]');
      if (row && e.target.closest('.row-action')) {
        await openTicketDialog(row.dataset.ticketId);
      }
    });

    $('startScannerBtn').addEventListener('click', startScanner);
    $('stopScannerBtn').addEventListener('click', stopScanner);
    $('manualCheckBtn').addEventListener('click', manualValidate);
    $('manualCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') manualValidate(); });
    $('ticketSearch').addEventListener('input', renderTickets);
    $('ticketFilter').addEventListener('change', renderTickets);
    $('ticketPhase').addEventListener('change', updatePricePreview);
    $('newTicketForm').addEventListener('submit', createTicketsFromForm);
    $('settingsForm').addEventListener('submit', saveSettings);
    $('exportBtn').addEventListener('click', exportBackup);
    $('importInput').addEventListener('change', importBackup);
    $('wipeBtn').addEventListener('click', wipeDatabase);
    $('undoLastBtn').addEventListener('click', undoLastCheckin);
    $('closeDialogBtn').addEventListener('click', () => $('ticketDialog').close());
    $('ticketDialogContent').addEventListener('click', handleDialogAction);
    $('ticketDialog').addEventListener('close', () => { currentDialogTicketId = null; });
  }

  function navigate(page) {
    qsa('.page').forEach(el => el.classList.toggle('active', el.dataset.page === page));
    qsa('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.nav === page));
    if (page !== 'scan' && scannerRunning) stopScanner();
    if (page === 'tickets') renderTickets();
    if (page === 'home') renderDashboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function renderAll() {
    applyEventLabels();
    populatePhaseSelect();
    await Promise.all([renderDashboard(), renderTickets()]);
  }

  function applyEventLabels() {
    $('headerEventName').textContent = settings.eventName;
    $('homeEventName').textContent = settings.eventName;
    $('homeEventDate').textContent = formatEventDate(settings.eventDate);
    document.title = `${settings.eventName} · Access`;
  }

  function populatePhaseSelect() {
    const select = $('ticketPhase');
    const old = select.value;
    select.innerHTML = settings.phases.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${money(p.price)}</option>`).join('');
    if (settings.phases.some(p => p.id === old)) select.value = old;
    updatePricePreview();
  }

  function populateSettingsUI() {
    $('settingsEventName').value = settings.eventName;
    $('settingsEventDate').value = settings.eventDate;
    $('phasesEditor').innerHTML = settings.phases.map((p, i) => `
      <div class="phase-line" data-phase-index="${i}">
        <input class="phase-name" value="${escapeAttr(p.name)}" maxlength="30" aria-label="Nombre de fase ${i + 1}">
        <input class="phase-price" type="number" min="0" step="1" value="${Number(p.price)}" aria-label="Precio ${p.name}">
      </div>`).join('');
  }

  function updatePricePreview() {
    const phase = settings.phases.find(p => p.id === $('ticketPhase').value) || settings.phases[0];
    $('pricePreview').textContent = money(phase?.price || 0);
  }

  async function renderDashboard() {
    const tickets = await dbGetAllTickets();
    const active = tickets.filter(t => !t.cancelled);
    const used = active.filter(t => t.usedAt);
    const pending = active.filter(t => !t.usedAt);
    const revenue = active.reduce((sum, t) => sum + (Number(t.price) || 0), 0);
    $('statSold').textContent = active.length;
    $('statUsed').textContent = used.length;
    $('statPending').textContent = pending.length;
    $('statRevenue').textContent = money(revenue);

    const recent = used.sort((a, b) => new Date(b.usedAt) - new Date(a.usedAt)).slice(0, 6);
    const list = $('recentList');
    if (!recent.length) {
      list.className = 'list-stack empty-state';
      list.textContent = 'Todavía no hay accesos registrados.';
      lastCheckinId = null;
      $('undoLastBtn').disabled = true;
      return;
    }
    list.className = 'list-stack';
    list.innerHTML = recent.map(t => `
      <div class="activity-row">
        <div class="ticket-main"><strong>${escapeHtml(t.buyerName || 'Sin nombre')}</strong><span class="ticket-code">${escapeHtml(t.code)}</span></div>
        <div style="text-align:right"><span class="status used">INGRESÓ</span><div class="ticket-code">${escapeHtml(formatTime(t.usedAt))}</div></div>
      </div>`).join('');
    lastCheckinId = recent[0].id;
    $('undoLastBtn').disabled = false;
  }

  async function renderTickets() {
    const query = $('ticketSearch').value.trim().toLowerCase();
    const filter = $('ticketFilter').value;
    let tickets = (await dbGetAllTickets()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (query) tickets = tickets.filter(t => (t.code + ' ' + (t.buyerName || '')).toLowerCase().includes(query));
    if (filter !== 'all') tickets = tickets.filter(t => statusOf(t) === filter);
    const list = $('ticketsList');
    if (!tickets.length) {
      list.className = 'list-stack empty-state';
      list.textContent = query || filter !== 'all' ? 'No hay boletos que coincidan.' : 'Aún no has creado boletos.';
      return;
    }
    list.className = 'list-stack';
    list.innerHTML = tickets.map(t => {
      const status = statusOf(t);
      const label = status === 'used' ? 'INGRESÓ' : status === 'cancelled' ? 'CANCELADO' : 'PENDIENTE';
      return `<div class="ticket-row" data-ticket-id="${escapeAttr(t.id)}">
        <div class="ticket-main">
          <strong>${escapeHtml(t.buyerName || 'Sin nombre')}</strong>
          <span class="ticket-code">${escapeHtml(t.code)}</span>
          <div class="ticket-meta"><span class="status ${status}">${label}</span><span class="phase-chip">${escapeHtml(t.phaseName)} · ${money(t.price)}</span></div>
        </div>
        <button class="row-action" aria-label="Abrir boleto">Ver</button>
      </div>`;
    }).join('');
  }

  async function createTicketsFromForm(e) {
    e.preventDefault();
    const buyerName = $('buyerName').value.trim();
    const note = $('ticketNote').value.trim();
    const quantity = Math.max(1, Math.min(25, Number.parseInt($('ticketQuantity').value, 10) || 1));
    const phase = settings.phases.find(p => p.id === $('ticketPhase').value) || settings.phases[0];
    const batchId = crypto.randomUUID();
    const created = [];

    for (let i = 0; i < quantity; i++) {
      const code = await uniqueTicketCode();
      const qrPayload = await makeQrPayload(code);
      const now = new Date().toISOString();
      const ticket = {
        id: crypto.randomUUID(), code, qrPayload, buyerName, note,
        phaseId: phase.id, phaseName: phase.name, price: Number(phase.price) || 0,
        batchId, createdAt: now, updatedAt: now, usedAt: null, cancelled: false
      };
      await dbPutTicket(ticket);
      created.push(ticket);
    }

    await renderGeneratedTickets(created);
    $('generatedSection').classList.remove('hidden');
    $('newTicketForm').reset();
    $('ticketQuantity').value = '1';
    populatePhaseSelect();
    await renderAll();
    showToast(quantity === 1 ? 'Boleto creado' : `${quantity} boletos creados`);
    $('generatedSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function renderGeneratedTickets(tickets) {
    const root = $('generatedTickets');
    root.innerHTML = '';
    for (const ticket of tickets) {
      const card = document.createElement('article');
      card.className = 'generated-ticket';
      card.innerHTML = `
        <div class="eyebrow">${escapeHtml(ticket.phaseName)}</div>
        <h3>${escapeHtml(ticket.buyerName || 'Acceso digital')}</h3>
        <div class="ticket-code">${escapeHtml(ticket.code)}</div>
        <div class="qr"></div>
        <div class="ticket-actions">
          <button class="secondary copy-btn">Copiar folio</button>
          <button class="secondary share-btn">Compartir</button>
          <button class="primary full download-btn">Descargar boleto PNG</button>
        </div>`;
      root.appendChild(card);
      renderQr(card.querySelector('.qr'), ticket.qrPayload, 190);
      card.querySelector('.copy-btn').addEventListener('click', () => copyText(ticket.code));
      card.querySelector('.download-btn').addEventListener('click', () => downloadTicketPng(ticket));
      card.querySelector('.share-btn').addEventListener('click', () => shareTicket(ticket));
    }
  }

  function renderQr(container, text, size) {
    container.innerHTML = '';
    if (typeof QRCode === 'undefined') {
      container.innerHTML = '<span style="color:#111">QR no disponible</span>';
      return;
    }
    new QRCode(container, { text, width: size, height: size, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  }

  async function uniqueTicketCode() {
    for (let i = 0; i < 12; i++) {
      const code = `TFS-${randomToken(5)}-${randomToken(5)}`;
      if (!(await dbGetTicketByCode(code))) return code;
    }
    throw new Error('No se pudo generar un folio único.');
  }

  function randomToken(length) {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
  }

  async function makeQrPayload(code) {
    const body = `TFS1|${code}`;
    const sig = await hmac(body);
    return `${body}|${sig}`;
  }

  async function hmac(message) {
    const key = await crypto.subtle.importKey('raw', base64UrlToBytes(eventSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const full = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
    return bytesToBase64Url(full.slice(0, 16));
  }

  async function verifyQrPayload(payload) {
    const parts = String(payload || '').trim().split('|');
    if (parts.length !== 3 || parts[0] !== 'TFS1') return { ok: false, reason: 'format' };
    const code = parts[1].toUpperCase();
    const expected = await hmac(`TFS1|${code}`);
    if (!safeStringEqual(parts[2], expected)) return { ok: false, reason: 'signature', code };
    const ticket = await dbGetTicketByCode(code);
    if (!ticket) return { ok: false, reason: 'missing', code };
    return { ok: true, ticket };
  }

  function safeStringEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  async function startScanner() {
    if (scannerRunning) return;
    if (typeof Html5Qrcode === 'undefined') {
      showScanResult('invalid', 'Escáner no disponible', 'Conéctate una vez a internet para que la app guarde el módulo de cámara y vuelve a abrirla.');
      return;
    }
    $('scannerPlaceholder').classList.add('hidden');
    $('startScannerBtn').disabled = true;
    try {
      if (!html5QrCode) html5QrCode = new Html5Qrcode('reader');
      await html5QrCode.start(
        { facingMode: 'environment' },
        { fps: 12, qrbox: (w, h) => ({ width: Math.min(280, Math.floor(w * .75)), height: Math.min(280, Math.floor(w * .75)) }), aspectRatio: 1.0 },
        onQrDecoded,
        () => {}
      );
      scannerRunning = true;
      $('stopScannerBtn').disabled = false;
      showScanResult('neutral', 'Cámara activa', 'Apunta al QR del boleto.');
      try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); await audioCtx.resume(); } catch (_) {}
    } catch (err) {
      $('scannerPlaceholder').classList.remove('hidden');
      $('startScannerBtn').disabled = false;
      showScanResult('invalid', 'No se pudo abrir la cámara', readableCameraError(err));
    }
  }

  async function stopScanner() {
    if (!html5QrCode || !scannerRunning) return;
    try { await html5QrCode.stop(); } catch (_) {}
    try { await html5QrCode.clear(); } catch (_) {}
    html5QrCode = null;
    scannerRunning = false;
    $('startScannerBtn').disabled = false;
    $('stopScannerBtn').disabled = true;
    $('scannerPlaceholder').classList.remove('hidden');
  }

  async function onQrDecoded(decodedText) {
    if (scanBusy) return;
    scanBusy = true;
    try { await processScannedPayload(decodedText); }
    finally { setTimeout(() => { scanBusy = false; }, 1400); }
  }

  async function processScannedPayload(payload) {
    const result = await verifyQrPayload(payload);
    if (!result.ok) {
      const detail = result.reason === 'signature' ? 'La firma del QR no coincide. Puede estar modificado.' : result.reason === 'missing' ? `El folio ${result.code || ''} no está en esta base.` : 'Este QR no pertenece a THE FIRS SCREAM.';
      showScanResult('invalid', result.reason === 'missing' ? 'Boleto no existe' : 'QR no válido', detail);
      feedback('bad');
      return;
    }
    await validateTicketForEntry(result.ticket);
  }

  async function validateTicketForEntry(ticket) {
    if (ticket.cancelled) {
      showScanResult('invalid', 'Boleto cancelado', `${ticket.code}${ticket.buyerName ? ' · ' + ticket.buyerName : ''}`);
      feedback('bad');
      return;
    }
    if (ticket.usedAt) {
      showScanResult('used', 'Boleto ya utilizado', `Ingresó ${formatDateTime(ticket.usedAt)} · ${ticket.code}`);
      feedback('warn');
      return;
    }
    ticket.usedAt = new Date().toISOString();
    ticket.updatedAt = ticket.usedAt;
    await dbPutTicket(ticket);
    lastCheckinId = ticket.id;
    showScanResult('valid', 'ACCESO VÁLIDO ✓', `${ticket.buyerName || 'Sin nombre'} · ${ticket.phaseName} · ${ticket.code}`);
    feedback('good');
    await Promise.all([renderDashboard(), renderTickets()]);
  }

  async function manualValidate() {
    const code = $('manualCode').value.trim().toUpperCase();
    if (!code) return;
    const ticket = await dbGetTicketByCode(code);
    if (!ticket) {
      showScanResult('invalid', 'Boleto no existe', `${code} no está registrado.`);
      feedback('bad');
      return;
    }
    await validateTicketForEntry(ticket);
    $('manualCode').value = '';
  }

  function showScanResult(type, title, detail) {
    const box = $('scanResult');
    box.className = `scan-result ${type}`;
    const icon = type === 'valid' ? '✓' : type === 'used' ? '!' : type === 'invalid' ? '×' : '—';
    box.innerHTML = `<div class="scan-result-icon">${icon}</div><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p></div>`;
  }

  function feedback(type) {
    try { navigator.vibrate?.(type === 'good' ? [70] : type === 'warn' ? [80, 80, 80] : [180, 60, 180]); } catch (_) {}
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = type === 'good' ? 880 : type === 'warn' ? 480 : 220;
      gain.gain.value = .05;
      osc.connect(gain); gain.connect(audioCtx.destination); osc.start(); osc.stop(audioCtx.currentTime + (type === 'bad' ? .24 : .12));
    } catch (_) {}
  }

  async function undoLastCheckin() {
    if (!lastCheckinId) return;
    const ticket = await dbGetTicket(lastCheckinId);
    if (!ticket?.usedAt) return;
    if (!confirm(`¿Deshacer la entrada de ${ticket.buyerName || ticket.code}?`)) return;
    ticket.usedAt = null;
    ticket.updatedAt = new Date().toISOString();
    await dbPutTicket(ticket);
    showToast('Entrada deshecha');
    await renderAll();
  }

  async function openTicketDialog(id) {
    const ticket = await dbGetTicket(id);
    if (!ticket) return;
    currentDialogTicketId = id;
    const status = statusOf(ticket);
    $('ticketDialogContent').innerHTML = `
      <div class="modal-ticket-head">
        <div><div class="eyebrow">BOLETO</div><h3>${escapeHtml(ticket.code)}</h3></div>
        <span class="status ${status}">${status === 'used' ? 'INGRESÓ' : status === 'cancelled' ? 'CANCELADO' : 'PENDIENTE'}</span>
      </div>
      <div class="modal-fields">
        <label class="modal-field"><span>Comprador</span><input id="dialogBuyer" value="${escapeAttr(ticket.buyerName || '')}" placeholder="Sin nombre"></label>
        <label class="modal-field"><span>Tipo</span><select id="dialogPhase">${settings.phases.map(p => `<option value="${escapeAttr(p.id)}" ${p.id === ticket.phaseId ? 'selected' : ''}>${escapeHtml(p.name)} · ${money(p.price)}</option>`).join('')}</select></label>
        <label class="modal-field"><span>Nota</span><input id="dialogNote" value="${escapeAttr(ticket.note || '')}" placeholder="Sin nota"></label>
        <div class="modal-field"><span>Creado</span>${escapeHtml(formatDateTime(ticket.createdAt))}</div>
        ${ticket.usedAt ? `<div class="modal-field"><span>Entrada</span>${escapeHtml(formatDateTime(ticket.usedAt))}</div>` : ''}
      </div>
      <div class="modal-actions">
        <button class="secondary" data-dialog-action="save">Guardar cambios</button>
        <button class="secondary" data-dialog-action="share">Compartir boleto</button>
        <button class="${ticket.usedAt ? 'ghost' : 'primary'}" data-dialog-action="toggle-entry">${ticket.usedAt ? 'Deshacer entrada' : 'Registrar entrada'}</button>
        <button class="ghost" data-dialog-action="toggle-cancel">${ticket.cancelled ? 'Reactivar' : 'Cancelar boleto'}</button>
        <button class="danger full" data-dialog-action="delete">Eliminar definitivamente</button>
      </div>`;
    $('ticketDialog').showModal();
  }

  async function handleDialogAction(e) {
    const btn = e.target.closest('[data-dialog-action]');
    if (!btn || !currentDialogTicketId) return;
    const action = btn.dataset.dialogAction;
    let ticket = await dbGetTicket(currentDialogTicketId);
    if (!ticket) return;

    if (action === 'save') {
      const phase = settings.phases.find(p => p.id === $('dialogPhase').value) || settings.phases[0];
      ticket.buyerName = $('dialogBuyer').value.trim();
      ticket.note = $('dialogNote').value.trim();
      ticket.phaseId = phase.id; ticket.phaseName = phase.name; ticket.price = Number(phase.price) || 0;
      ticket.updatedAt = new Date().toISOString();
      await dbPutTicket(ticket); showToast('Cambios guardados'); await renderAll(); await openTicketDialogRefresh(ticket.id); return;
    }
    if (action === 'share') { await shareTicket(ticket); return; }
    if (action === 'toggle-entry') {
      ticket.usedAt = ticket.usedAt ? null : new Date().toISOString();
      ticket.updatedAt = new Date().toISOString();
      await dbPutTicket(ticket); showToast(ticket.usedAt ? 'Entrada registrada' : 'Entrada deshecha'); await renderAll(); await openTicketDialogRefresh(ticket.id); return;
    }
    if (action === 'toggle-cancel') {
      ticket.cancelled = !ticket.cancelled;
      ticket.updatedAt = new Date().toISOString();
      await dbPutTicket(ticket); showToast(ticket.cancelled ? 'Boleto cancelado' : 'Boleto reactivado'); await renderAll(); await openTicketDialogRefresh(ticket.id); return;
    }
    if (action === 'delete') {
      if (!confirm(`¿Eliminar definitivamente ${ticket.code}? Ese QR dejará de existir en la base.`)) return;
      await dbDeleteTicket(ticket.id); $('ticketDialog').close(); showToast('Boleto eliminado'); await renderAll();
    }
  }

  async function openTicketDialogRefresh(id) {
    $('ticketDialog').close();
    await openTicketDialog(id);
  }

  async function saveSettings(e) {
    e.preventDefault();
    const phases = qsa('.phase-line', $('phasesEditor')).map((row, i) => ({
      id: settings.phases[i]?.id || `phase${i + 1}`,
      name: row.querySelector('.phase-name').value.trim() || `Fase ${i + 1}`,
      price: Math.max(0, Number(row.querySelector('.phase-price').value) || 0)
    }));
    settings = {
      eventName: $('settingsEventName').value.trim() || DEFAULT_SETTINGS.eventName,
      eventDate: $('settingsEventDate').value || DEFAULT_SETTINGS.eventDate,
      phases
    };
    await dbPutMeta('settings', settings);
    populateSettingsUI(); populatePhaseSelect(); applyEventLabels(); await renderAll(); showToast('Configuración guardada');
  }

  async function exportBackup() {
    const tickets = await dbGetAllTickets();
    const payload = {
      format: 'TFS_ACCESS_BACKUP', version: 1, exportedAt: new Date().toISOString(),
      eventSecret, settings, tickets
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `THE-FIRS-SCREAM-backup-${dateStamp()}.json`);
    showToast('Respaldo exportado');
  }

  async function importBackup(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'TFS_ACCESS_BACKUP' || data?.version !== 1 || !data?.eventSecret || !Array.isArray(data?.tickets)) throw new Error('Formato no reconocido');
      if (!confirm(`Se reemplazará la base actual por un respaldo con ${data.tickets.length} boletos. ¿Continuar?`)) return;
      await dbClearTickets();
      for (const t of data.tickets) await dbPutTicket(t);
      eventSecret = data.eventSecret;
      settings = normalizeSettings(data.settings);
      await dbPutMeta('eventSecret', eventSecret);
      await dbPutMeta('settings', settings);
      populateSettingsUI(); await renderAll(); showToast('Respaldo restaurado');
    } catch (err) {
      alert(`No se pudo importar el respaldo: ${err.message}`);
    }
  }

  async function wipeDatabase() {
    if (!confirm('Esto borrará TODOS los boletos y accesos de este dispositivo. ¿Continuar?')) return;
    if (!confirm('Última confirmación: los QR actuales dejarán de ser válidos si no tienes respaldo.')) return;
    await dbClearTickets(); await dbClearMeta();
    settings = structuredClone(DEFAULT_SETTINGS); eventSecret = null;
    await ensureMeta(); populateSettingsUI(); await renderAll(); showToast('Base local reiniciada');
  }

  async function ticketPngBlob(ticket) {
    if (typeof QRCode === 'undefined') throw new Error('Generador QR no disponible');
    const canvas = $('workCanvas');
    canvas.width = 1080; canvas.height = 1600;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 1080, 1600);
    grad.addColorStop(0, '#09070d'); grad.addColorStop(.55, '#1d1018'); grad.addColorStop(1, '#08070b');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 1080, 1600);
    ctx.fillStyle = '#ef174d'; ctx.fillRect(0, 0, 1080, 18);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#f7f3f9'; ctx.font = '800 76px system-ui, sans-serif';
    fitText(ctx, settings.eventName, 900, 76, 36);
    ctx.fillText(settings.eventName, 540, 150);
    ctx.fillStyle = '#bdaebf'; ctx.font = '700 24px system-ui, sans-serif'; ctx.fillText('ACCESO DIGITAL · HALLOWEEN', 540, 205);
    ctx.fillStyle = '#ef174d'; ctx.font = '800 30px system-ui, sans-serif'; ctx.fillText(ticket.phaseName.toUpperCase(), 540, 282);
    ctx.fillStyle = '#ffffff'; ctx.font = '700 38px system-ui, sans-serif';
    ctx.fillText(ticket.buyerName || 'ACCESO INDIVIDUAL', 540, 340);

    const qrBox = 600, qx = 240, qy = 425;
    ctx.fillStyle = '#ffffff'; roundRect(ctx, qx - 32, qy - 32, qrBox + 64, qrBox + 64, 28); ctx.fill();
    const qrCanvas = await buildQrCanvas(ticket.qrPayload, qrBox);
    ctx.drawImage(qrCanvas, qx, qy, qrBox, qrBox);

    ctx.fillStyle = '#f7f3f9'; ctx.font = '800 38px ui-monospace, monospace'; ctx.fillText(ticket.code, 540, 1132);
    ctx.fillStyle = '#aa9ead'; ctx.font = '600 25px system-ui, sans-serif'; ctx.fillText(formatEventDate(settings.eventDate), 540, 1190);
    ctx.strokeStyle = '#372a37'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(120, 1245); ctx.lineTo(960, 1245); ctx.stroke();
    ctx.fillStyle = '#d9cfdc'; ctx.font = '600 25px system-ui, sans-serif'; ctx.fillText('Presenta este QR en la entrada.', 540, 1315);
    ctx.fillStyle = '#948997'; ctx.font = '500 21px system-ui, sans-serif'; ctx.fillText('Un QR = un acceso. Al primer uso quedará registrado.', 540, 1360);
    ctx.fillStyle = '#ef174d'; ctx.font = '800 22px system-ui, sans-serif'; ctx.fillText('THE FIRS SCREAM · ACCESS', 540, 1490);

    return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('No se pudo crear la imagen')), 'image/png', 1));
  }

  async function buildQrCanvas(text, size) {
    const root = $('qrWork'); root.innerHTML = '';
    new QRCode(root, { text, width: size, height: size, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    await new Promise(r => setTimeout(r, 40));
    const source = root.querySelector('canvas') || root.querySelector('img');
    if (!source) throw new Error('No se pudo renderizar el QR');
    if (source.tagName === 'CANVAS') return source;
    const temp = document.createElement('canvas'); temp.width = size; temp.height = size;
    temp.getContext('2d').drawImage(source, 0, 0, size, size); return temp;
  }

  async function downloadTicketPng(ticket) {
    try { downloadBlob(await ticketPngBlob(ticket), `${ticket.code}.png`); }
    catch (err) { alert(err.message); }
  }

  async function shareTicket(ticket) {
    try {
      const blob = await ticketPngBlob(ticket);
      const file = new File([blob], `${ticket.code}.png`, { type: 'image/png' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: settings.eventName, text: `Boleto ${ticket.code}`, files: [file] });
      } else {
        downloadBlob(blob, `${ticket.code}.png`); showToast('Tu celular descargó el boleto para compartirlo');
      }
    } catch (err) { if (err?.name !== 'AbortError') alert(`No se pudo compartir: ${err.message}`); }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); showToast('Folio copiado'); }
    catch (_) { prompt('Copia el folio:', text); }
  }

  function statusOf(ticket) { return ticket.cancelled ? 'cancelled' : ticket.usedAt ? 'used' : 'pending'; }

  function updateConnectionBadge() {
    const badge = $('connectionBadge');
    if (navigator.onLine) { badge.className = 'connection-badge online'; badge.innerHTML = '<span class="dot"></span><span>En línea</span>'; }
    else { badge.className = 'connection-badge offline'; badge.innerHTML = '<span class="dot"></span><span>Sin internet · OK</span>'; }
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try { await navigator.serviceWorker.register('./sw.js'); await navigator.serviceWorker.ready; }
    catch (err) { console.warn('Service worker:', err); }
  }

  function showToast(message) {
    const t = $('toast'); t.textContent = message; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function readableCameraError(err) {
    const msg = String(err?.message || err || 'Error desconocido');
    if (/NotAllowed|Permission|denied/i.test(msg)) return 'Permite el acceso a la cámara en los ajustes del navegador.';
    if (/NotFound|DevicesNotFound/i.test(msg)) return 'No se encontró una cámara disponible.';
    if (/NotReadable|TrackStart/i.test(msg)) return 'Otra aplicación podría estar usando la cámara.';
    return msg.slice(0, 160);
  }

  function bytesToBase64Url(bytes) {
    let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const raw = atob(b64); return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  function money(value) { return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(value) || 0); }
  function formatTime(iso) { return new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
  function formatDateTime(iso) { return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
  function formatEventDate(value) {
    const d = new Date(value); if (Number.isNaN(d.getTime())) return value;
    return new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  }
  function dateStamp() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function escapeHtml(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function escapeAttr(v) { return escapeHtml(v).replace(/`/g, '&#96;'); }

  function fitText(ctx, text, maxWidth, startSize, minSize) {
    let size = startSize; while (size > minSize) { ctx.font = `800 ${size}px system-ui, sans-serif`; if (ctx.measureText(text).width <= maxWidth) break; size -= 2; }
  }
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
  }
})();
