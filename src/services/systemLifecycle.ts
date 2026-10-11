/**
 * Service de cycle de vie et synchronisation client <-> serveur Node.js
 *
 * Fonctionnalité Option 1 :
 * - Heartbeat périodique (toutes les 3s)
 * - Détection automatique de fermeture d'onglet/fenêtre via navigator.sendBeacon
 * - Arrêt automatique de Node.js lorsque tous les onglets de l'application sont fermés
 * - Arrêt explicite sur demande de l'opérateur avec écran de confirmation
 */

let clientId = '';
try {
  const existing = sessionStorage.getItem('asw_client_instance_id');
  if (existing) {
    clientId = existing;
  } else {
    clientId = 'client_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
    sessionStorage.setItem('asw_client_instance_id', clientId);
  }
} catch {
  clientId = 'client_' + Math.random().toString(36).substring(2, 11);
}

export function getClientId(): string {
  return clientId;
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let isShuttingDown = false;

export function initSystemLifecycle(onServerStatusChanged?: (isLocalStandalone: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const sendHeartbeat = async () => {
    if (isShuttingDown) return;
    try {
      const res = await fetch('/api/system/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.isLocalStandalone === 'boolean' && onServerStatusChanged) {
          onServerStatusChanged(data.isLocalStandalone);
        }
      }
    } catch {
      // Ignorer les erreurs réseau temporaires
    }
  };

  // Premier battement de coeur immédiat
  sendHeartbeat();

  // Battement régulier toutes les 3 secondes
  heartbeatInterval = setInterval(sendHeartbeat, 3000);

  // Détection de déchargement de la page / fermeture de la fenêtre
  const notifyDisconnect = () => {
    if (isShuttingDown) return;
    const payload = JSON.stringify({ clientId, timestamp: Date.now() });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/system/shutdown-beacon', blob);
    } else {
      fetch('/api/system/shutdown-beacon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  };

  window.addEventListener('beforeunload', notifyDisconnect);
  window.addEventListener('pagehide', notifyDisconnect);

  return () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    window.removeEventListener('beforeunload', notifyDisconnect);
    window.removeEventListener('pagehide', notifyDisconnect);
  };
}

export async function requestServerShutdown(): Promise<{
  success: boolean;
  message: string;
  isLocalStandalone: boolean;
}> {
  isShuttingDown = true;
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  try {
    const res = await fetch('/api/system/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, reason: 'MANUAL_USER_REQUEST' }),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        success: true,
        message: data.message || 'Le serveur Node.js a été arrêté.',
        isLocalStandalone: !!data.isLocalStandalone,
      };
    }
  } catch (err: unknown) {
    // Si la requête échoue car le serveur s'est déjà coupé, c'est un succès
    return {
      success: true,
      message: 'Le serveur Node.js a été arrêté avec succès.',
      isLocalStandalone: true,
    };
  }

  return {
    success: true,
    message: 'Signal d’arrêt transmis au serveur.',
    isLocalStandalone: true,
  };
}
