// api.js — JIREHAI API Client
const API_BASE = window.JIREHAI_API_BASE || 'http://localhost:3001';

const Api = {
  // Get stored token
  getToken() { return localStorage.getItem('jrh_token'); },
  setToken(t) { localStorage.setItem('jrh_token', t); },
  clearToken() { localStorage.removeItem('jrh_token'); localStorage.removeItem('jrh_user'); },
  getUser() { try { return JSON.parse(localStorage.getItem('jrh_user') || 'null'); } catch { return null; } },
  setUser(u) { localStorage.setItem('jrh_user', JSON.stringify(u)); },
  isLoggedIn() { return !!this.getToken(); },

  // Base fetch with auth
  async fetch(path, options = {}) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (res.status === 401) { this.clearToken(); window.location.reload(); return; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  },

  // Auth
  async login(email, password) {
    const data = await this.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    this.setToken(data.token);
    this.setUser(data.user);
    return data;
  },
  async register(name, email, password) {
    const data = await this.fetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
    this.setToken(data.token);
    this.setUser(data.user);
    return data;
  },
  logout() { this.clearToken(); window.location.href = '/index.html'; },

  // Config
  async getConfig() { return this.fetch('/api/config'); },
  async saveConfig(config) { return this.fetch('/api/config', { method: 'PUT', body: JSON.stringify(config) }); },

  // Procesos SECOP II
  async getProcesos(filters = {}) {
    const params = new URLSearchParams(Object.entries(filters).filter(([,v]) => v));
    return this.fetch(`/api/procesos?${params}`);
  },
  async getApplied() { return this.fetch('/api/procesos/applied'); },
  async applyProcess(processNumber, processData) {
    return this.fetch('/api/procesos/apply', { method: 'POST', body: JSON.stringify({ processNumber, processData }) });
  },
  async saveAnalysis(processNumber, analysis, observations, cumple) {
    return this.fetch(`/api/procesos/${encodeURIComponent(processNumber)}/analysis`, {
      method: 'PUT', body: JSON.stringify({ analysis, observations, cumple })
    });
  },
  async removeApplied(processNumber) {
    return this.fetch(`/api/procesos/${encodeURIComponent(processNumber)}`, { method: 'DELETE' });
  },
  async analyzePliego(processData, referencia) {
    return this.fetch('/api/procesos/analyze-pliego', {
      method: 'POST',
      body: JSON.stringify({ processData, referencia })
    });
  },

  // Documentos
  async getDocumentos() { return this.fetch('/api/documentos'); },
  async saveDocumento(docType, expiryDate, notes) {
    return this.fetch(`/api/documentos/${docType}`, { method: 'PUT', body: JSON.stringify({ expiryDate, notes }) });
  },

  // Notificaciones
  async getNotificaciones() { return this.fetch('/api/notificaciones'); },
  async markNotificationsRead() { return this.fetch('/api/notificaciones/read', { method: 'PUT' }); },
  async getNotifSettings() { return this.fetch('/api/notificaciones/settings'); },
  async saveNotifSettings(settings) {
    return this.fetch('/api/notificaciones/settings', { method: 'PUT', body: JSON.stringify(settings) });
  },

  // UNSPSC
  async getUnspsc(search) {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.fetch(`/api/unspsc${params}`);
  },
  async suggestUnspsc(text) {
    return this.fetch('/api/unspsc/suggest', { method: 'POST', body: JSON.stringify({ text }) });
  },

  // Admin
  async getAdminStats() { return this.fetch('/api/admin/stats'); },
  async getAdminUsers() { return this.fetch('/api/admin/users'); },
  async createAdminUser(data) { return this.fetch('/api/admin/users', { method: 'POST', body: JSON.stringify(data) }); },
  async updateAdminUser(id, data) { return this.fetch(`/api/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }); },
  async deleteAdminUser(id) { return this.fetch(`/api/admin/users/${id}`, { method: 'DELETE' }); },
  async getAdminUnspsc() { return this.fetch('/api/admin/unspsc'); },
  async createUnspsc(data) { return this.fetch('/api/admin/unspsc', { method: 'POST', body: JSON.stringify(data) }); },
  async updateUnspsc(id, data) { return this.fetch(`/api/admin/unspsc/${id}`, { method: 'PUT', body: JSON.stringify(data) }); },
  async deleteUnspsc(id) { return this.fetch(`/api/admin/unspsc/${id}`, { method: 'DELETE' }); },
  async getSubscriptions() { return this.fetch('/api/admin/subscriptions'); },

  // Health check
  async health() { return this.fetch('/api/health'); },

  // ── Password reset ───────────────────────────────────────────────────────
  async forgotPassword(email) {
    return this.fetch('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
  },
  async validateResetToken(token) {
    return this.fetch(`/api/auth/validate-reset-token?token=${encodeURIComponent(token)}`);
  },
  async resetPassword(token, newPassword) {
    return this.fetch('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
  },

  // ── Subscriptions ────────────────────────────────────────────────────────
  async getSubscriptionStatus() { return this.fetch('/api/subscriptions/status'); },
  async createCheckout(plan) {
    return this.fetch('/api/wompi/create-link', { method: 'POST', body: JSON.stringify({ plan }) });
  },

  // ── AI SECOP Engine ──────────────────────────────────────────────────────
  /** Inicia análisis completo — devuelve { job_id, status_url, result_url } */
  async analyzeProcess(processData, options = {}) {
    return this.fetch('/api/ai/analyze-process', {
      method: 'POST',
      body: JSON.stringify({ process_data: processData, options })
    });
  },
  /** Sólo descarga documentos sin análisis IA */
  async downloadProcess(processData) {
    return this.fetch('/api/ai/download-process', {
      method: 'POST',
      body: JSON.stringify({ process_data: processData })
    });
  },
  /** Polling de progreso — devuelve { status, progress_pct, progress_step, progress_msg, error_msg } */
  async getAIStatus(jobId) { return this.fetch(`/api/ai/status/${jobId}?t=${Date.now()}`); },
  /** Resultado completo del job (llama sólo cuando status = completed) */
  async getAIResult(jobId) { return this.fetch(`/api/ai/result/${jobId}`); },
  /** Historial de análisis del usuario */
  async listAIJobs(limit = 20) { return this.fetch(`/api/ai/jobs?limit=${limit}`); },
  /** Elimina job y sus archivos */
  async deleteAIJob(jobId) { return this.fetch(`/api/ai/job/${jobId}`, { method: 'DELETE' }); },
  /** URL de descarga de un export (no pasa por fetch — es un <a href> directo) */
  getAIExportUrl(jobId, format) {
    const token = this.getToken();
    return `${API_BASE}/api/ai/export/${jobId}?format=${format}&token=${token || ''}`;
  },
  /** Comprueba disponibilidad del motor Python */
  async aiHealth() { return this.fetch('/api/ai/health'); }
};

window.Api = Api;
