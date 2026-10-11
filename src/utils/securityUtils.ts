import { PermissionKey, UserRole } from '../types/domain';

/**
 * SÉCURITÉ HTML (Section 54)
 * Toutes les données utilisateur insérées dans l'impression, aperçu ou HTML doivent être échappées.
 */
export function escapeHtml(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * IDENTIFIANTS UNIQUES (Section 6)
 * Toujours utiliser crypto.randomUUID(), jamais Date.now().
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback RFC4122 v4 using crypto.getRandomValues
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * SÉCURITÉ CRYPTOGRAPHIQUE (Section 37)
 * PBKDF2 avec sel aléatoire via Web Crypto API pour les codes PIN.
 */
function bufferToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const arr = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    arr[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return arr;
}

export function generateRandomSalt(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bufferToHex(salt);
}

export async function hashPinWithSalt(pin: string, saltHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const saltBytes = hexToBytes(saltHex);
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes.buffer as ArrayBuffer,
      iterations: 60000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bufferToHex(derivedBits);
}

export async function verifyPin(pin: string, saltHex: string, expectedHashHex: string): Promise<boolean> {
  if (!pin || !saltHex || !expectedHashHex) return false;
  const actualHash = await hashPinWithSalt(pin, saltHex);
  return actualHash === expectedHashHex;
}

/**
 * Chiffrement AES-GCM optionnel pour les sauvegardes (Section 37 & 41)
 */
export async function encryptBackupPayload(jsonText: string, passphrase: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 60000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    aesKey,
    encoder.encode(jsonText)
  );

  return JSON.stringify({
    encrypted: true,
    algorithm: 'AES-GCM-PBKDF2',
    salt: bufferToHex(salt),
    iv: bufferToHex(iv),
    ciphertext: bufferToHex(cipherBuffer),
  });
}

export async function decryptBackupPayload(encryptedJson: string, passphrase: string): Promise<string> {
  const parsed = JSON.parse(encryptedJson) as {
    encrypted: boolean;
    salt: string;
    iv: string;
    ciphertext: string;
  };
  if (!parsed.encrypted) return encryptedJson;

  const encoder = new TextEncoder();
  const salt = hexToBytes(parsed.salt);
  const iv = hexToBytes(parsed.iv);
  const cipherBytes = hexToBytes(parsed.ciphertext);

  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 60000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    aesKey,
    cipherBytes.buffer as ArrayBuffer
  );

  return new TextDecoder().decode(plainBuffer);
}

/**
 * PROFILS ET PERMISSIONS (Section 38)
 * Fonction centrale hasPermission() réellement appliquée.
 */
const ROLE_PERMISSIONS: Record<UserRole, PermissionKey[]> = {
  ADMIN: [
    'VIEW_DASHBOARD',
    'USE_POS',
    'MANAGE_SALES',
    'CANCEL_SALES',
    'MANAGE_QUOTES',
    'MANAGE_INVOICES',
    'RECORD_PAYMENTS',
    'MANAGE_PRODUCTS',
    'MANAGE_STOCK',
    'VALIDATE_INVENTORY',
    'MANAGE_PURCHASES',
    'RECEIVE_PURCHASES',
    'MANAGE_SUPPLIERS',
    'MANAGE_CUSTOMERS',
    'MANAGE_SAV',
    'MANAGE_FINANCE',
    'CLOSE_CASH',
    'MANAGE_EXPENSES',
    'VIEW_ANALYTICS',
    'MANAGE_MARKET_WATCH',
    'MANAGE_BACKUPS',
    'MANAGE_SETTINGS',
    'RUN_DIAGNOSTICS',
  ],
  MANAGER: [
    'VIEW_DASHBOARD',
    'USE_POS',
    'MANAGE_SALES',
    'CANCEL_SALES',
    'MANAGE_QUOTES',
    'MANAGE_INVOICES',
    'RECORD_PAYMENTS',
    'MANAGE_PRODUCTS',
    'MANAGE_STOCK',
    'VALIDATE_INVENTORY',
    'MANAGE_PURCHASES',
    'RECEIVE_PURCHASES',
    'MANAGE_SUPPLIERS',
    'MANAGE_CUSTOMERS',
    'MANAGE_SAV',
    'MANAGE_FINANCE',
    'CLOSE_CASH',
    'MANAGE_EXPENSES',
    'VIEW_ANALYTICS',
    'MANAGE_MARKET_WATCH',
    'RUN_DIAGNOSTICS',
  ],
  SELLER: [
    'VIEW_DASHBOARD',
    'USE_POS',
    'MANAGE_SALES',
    'MANAGE_QUOTES',
    'MANAGE_INVOICES',
    'RECORD_PAYMENTS',
    'MANAGE_CUSTOMERS',
    'MANAGE_SAV',
  ],
  ACCOUNTANT: [
    'VIEW_DASHBOARD',
    'MANAGE_SALES',
    'MANAGE_INVOICES',
    'RECORD_PAYMENTS',
    'MANAGE_PURCHASES',
    'MANAGE_SUPPLIERS',
    'MANAGE_CUSTOMERS',
    'MANAGE_FINANCE',
    'CLOSE_CASH',
    'MANAGE_EXPENSES',
    'VIEW_ANALYTICS',
    'MANAGE_BACKUPS',
  ],
  TECHNICIAN: [
    'VIEW_DASHBOARD',
    'MANAGE_CUSTOMERS',
    'MANAGE_SAV',
    'MANAGE_STOCK',
  ],
};

export function hasPermission(role: UserRole | undefined | null, permission: PermissionKey): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Convertit un fichier image (PNG, JPG, WEBP, SVG) en Data URL optimisé
 * (redimensionné à max 480px si plus grand) pour le stockage local IndexedDB et l'impression A4/80mm.
 */
export function fileToLogoDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Veuillez sélectionner un fichier image valide (PNG, JPG, SVG, WEBP).'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Impossible de lire le fichier image.'));
    reader.onload = () => {
      const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!rawDataUrl) {
        reject(new Error('Fichier image vide.'));
        return;
      }

      if (file.type === 'image/svg+xml') {
        resolve(rawDataUrl);
        return;
      }

      const img = new Image();
      img.onerror = () => resolve(rawDataUrl);
      img.onload = () => {
        const maxDim = 480;
        let { width, height } = img;
        if (width <= maxDim && height <= maxDim && rawDataUrl.length < 350_000) {
          resolve(rawDataUrl);
          return;
        }
        if (width > height) {
          if (width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          }
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(rawDataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export interface CompressedPhotoResult {
  dataUrl: string;
  originalSizeKb: number;
  compressedSizeKb: number;
  width: number;
  height: number;
}

/**
 * Compresse automatiquement une photo de produit lors du chargement :
 * - Redimensionnement proportionnel max 560x560 px
 * - Encodage WebP/JPEG compressé (qualité 0.72) pour un poids plume (~15-35 Ko) en base IndexedDB
 */
export function compressProductPhoto(file: File): Promise<CompressedPhotoResult> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Veuillez sélectionner un fichier image valide (JPG, PNG, WEBP).'));
      return;
    }

    const originalSizeKb = Math.max(1, Math.round(file.size / 1024));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Impossible de lire le fichier photo.'));
    reader.onload = () => {
      const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!rawDataUrl) {
        reject(new Error('Fichier image vide.'));
        return;
      }

      const img = new Image();
      img.onerror = () => reject(new Error('Format image non reconnu.'));
      img.onload = () => {
        const maxDim = 560;
        let { width, height } = img;
        if (width > height) {
          if (width > maxDim) {
            height = Math.max(1, Math.round((height * maxDim) / width));
            width = maxDim;
          }
        } else if (height > maxDim) {
          width = Math.max(1, Math.round((width * maxDim) / height));
          height = maxDim;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          const fallbackKb = Math.max(1, Math.round((rawDataUrl.length * 0.75) / 1024));
          resolve({
            dataUrl: rawDataUrl,
            originalSizeKb,
            compressedSizeKb: fallbackKb,
            width,
            height,
          });
          return;
        }

        // Fond blanc propre pour éviter les fonds noirs sur les PNG transparents convertis en JPEG/WebP
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        let compressedDataUrl = canvas.toDataURL('image/webp', 0.72);
        if (!compressedDataUrl.startsWith('data:image/webp')) {
          compressedDataUrl = canvas.toDataURL('image/jpeg', 0.72);
        }
        // Si le JPEG est plus léger, on privilégie le plus compact
        const jpegCandidate = canvas.toDataURL('image/jpeg', 0.72);
        if (jpegCandidate.length < compressedDataUrl.length) {
          compressedDataUrl = jpegCandidate;
        }

        const compressedSizeKb = Math.max(
          1,
          Math.round(((compressedDataUrl.length - compressedDataUrl.indexOf(',') - 1) * 3) / 4 / 1024)
        );

        resolve({
          dataUrl: compressedDataUrl,
          originalSizeKb,
          compressedSizeKb,
          width,
          height,
        });
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Extrait un flux JPEG embarqué depuis un fichier PDF binaire (fallback rapide si le worker PDF est bloqué)
 */
function extractEmbeddedJpegFromPdfBytes(bytes: Uint8Array): string | null {
  let largestBase64: string | null = null;
  let largestLen = 0;

  for (let i = 0; i < bytes.length - 4; i++) {
    // Signature début JPEG SOI + marqueur APP0/APP1/DQT/SOF (0xFF 0xD8 0xFF)
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      for (let j = i + 4; j < bytes.length - 1; j++) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
          const len = j + 2 - i;
          if (len > 2048 && len > largestLen) {
            const slice = bytes.subarray(i, j + 2);
            let binary = '';
            const chunkSize = 8192;
            for (let k = 0; k < slice.length; k += chunkSize) {
              binary += String.fromCharCode(...slice.subarray(k, k + chunkSize));
            }
            largestBase64 = `data:image/jpeg;base64,${btoa(binary)}`;
            largestLen = len;
          }
        }
      }
    }
  }
  return largestBase64;
}

/**
 * Convertit un fichier Filigrane (.PDF ou Image PNG/JPG/WEBP/SVG) en Data URL haute définition A4
 * prêt à être affiché en arrière-plan des documents à imprimer ou télécharger.
 */
export async function fileToWatermarkDataUrl(file: File): Promise<string> {
  const isPdf =
    file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');

  if (isPdf) {
    const buffer = await file.arrayBuffer();
    const uint8 = new Uint8Array(buffer);

    // 1. Rendu haute définition de la page 1 du PDF via pdfjs-dist
    try {
      const pdfjsLib = await import('pdfjs-dist');
      try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();
      } catch {
        // Ignorer si déjà configuré
      }

      const loadingTask = pdfjsLib.getDocument({ data: uint8.slice() });
      const pdf = await loadingTask.promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, canvas, viewport }).promise;
        return canvas.toDataURL('image/jpeg', 0.88);
      }
    } catch {
      // 2. Fallback extraction directe du flux JPEG embarqué dans le PDF
      const embeddedJpeg = extractEmbeddedJpegFromPdfBytes(uint8);
      if (embeddedJpeg) {
        return embeddedJpeg;
      }
      throw new Error(
        "Impossible de convertir ce fichier PDF. Vous pouvez aussi l'importer en format PNG ou JPG."
      );
    }
  }

  // Cas d'un fichier image (PNG, JPG, WEBP, SVG)
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(
        new Error('Veuillez sélectionner un fichier PDF (.pdf) ou une image (PNG, JPG, WEBP).')
      );
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Impossible de lire le fichier filigrane.'));
    reader.onload = () => {
      const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!rawDataUrl) {
        reject(new Error('Fichier vide.'));
        return;
      }
      if (file.type === 'image/svg+xml') {
        resolve(rawDataUrl);
        return;
      }

      const img = new Image();
      img.onerror = () => resolve(rawDataUrl);
      img.onload = () => {
        const maxW = 1240;
        const maxH = 1754;
        let { width, height } = img;
        if (width > maxW || height > maxH) {
          const ratio = Math.min(maxW / width, maxH / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(rawDataUrl);
          return;
        }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.86));
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Génère un filigrane A4 haute résolution reproduisant fidèlement le papier à en-tête AtlasSoftWater
 * (Bannière supérieure avec spécialités + goutte d'eau centrale translucide + vague "Eau saine au quotidien")
 */
export function generateAtlasSoftWaterWatermarkDataUrl(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="794" height="1123">
    <defs>
      <linearGradient id="dropGrad" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stop-color="#E0F2FE" stop-opacity="0.55"/>
        <stop offset="55%" stop-color="#BAE6FD" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#7DD3FC" stop-opacity="0.35"/>
      </linearGradient>
      <linearGradient id="waveBlue" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#0284C7" stop-opacity="0.18"/>
        <stop offset="50%" stop-color="#38BDF8" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#4ADE80" stop-opacity="0.18"/>
      </linearGradient>
    </defs>
    <rect width="794" height="1123" fill="#FFFFFF"/>
    <!-- Goutte d'eau centrale en filigrane doux -->
    <g transform="translate(397, 600)">
      <path d="M 0 -240 C 55 -120, 155 -10, 155 95 C 155 185, 86 250, 0 250 C -86 250, -155 185, -155 95 C -155 -10, -55 -120, 0 -240 Z"
            fill="url(#dropGrad)" stroke="#BAE6FD" stroke-width="6" stroke-opacity="0.6"/>
      <!-- Montagnes et nuages subtils à l'intérieur de la goutte -->
      <path d="M -130 90 L -45 -15 L 15 45 L 65 -5 L 135 90 Z" fill="#93C5FD" fill-opacity="0.28"/>
      <path d="M -140 125 Q -60 85 10 115 T 140 110 L 130 190 Q 0 245 -130 190 Z" fill="#FFFFFF" fill-opacity="0.55"/>
    </g>
    <!-- Pied de filigrane : Eau saine au quotidien -->
    <path d="M 0 1065 Q 200 1040 397 1065 T 794 1055 L 794 1090 Q 595 1070 397 1085 T 0 1085 Z" fill="url(#waveBlue)"/>
    <line x1="190" y1="1044" x2="275" y2="1044" stroke="#94A3B8" stroke-width="0.8" stroke-opacity="0.6"/>
    <text x="397" y="1049" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="19" fill="#0284C7" fill-opacity="0.65">
      Eau saine au quotidien
    </text>
    <line x1="519" y1="1044" x2="604" y2="1044" stroke="#94A3B8" stroke-width="0.8" stroke-opacity="0.6"/>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

