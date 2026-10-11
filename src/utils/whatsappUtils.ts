/**
 * MODULE WHATSAPP NORMALISÉ MAROC (E.164 & BI-CANAL)
 * 1. Normalisation stricte : 06/07/05/+212/00212 -> 212XXXXXXXXX
 * 2. Encodage strict UTF-8 conforme RFC 3986
 * 3. Support bi-canal : Application Windows 11 & WhatsApp Web
 */

export interface NormalizedPhoneResult {
  raw: string;
  e164Digits: string; // ex: "212661489100"
  formattedInternational: string; // ex: "+212 6 61 48 91 00"
  isValid: boolean;
  type: 'MOBILE' | 'FIXE' | 'AUTRE' | 'INVALIDE';
}

export function normalizeMoroccanPhone(rawPhone: string | null | undefined): NormalizedPhoneResult {
  const raw = (rawPhone ?? '').trim();
  if (!raw) {
    return {
      raw: '',
      e164Digits: '',
      formattedInternational: '',
      isValid: false,
      type: 'INVALIDE',
    };
  }

  // 1. Extraire uniquement les chiffres
  let digits = raw.replace(/\D/g, '');

  // 2. Traiter les préfixes internationaux
  if (digits.startsWith('00212')) {
    digits = digits.slice(2);
  }

  // Numéro national commençant par 0 (06..., 07..., 05...)
  if (digits.startsWith('0') && digits.length === 10) {
    digits = '212' + digits.slice(1);
  } else if (!digits.startsWith('212') && digits.length === 9) {
    digits = '212' + digits;
  }

  const isMoroccan = digits.startsWith('212') && digits.length === 12;
  let type: NormalizedPhoneResult['type'] = 'AUTRE';

  if (isMoroccan) {
    const mobilePrefix = digits.slice(3, 4); // 6 ou 7
    if (mobilePrefix === '6' || mobilePrefix === '7') {
      type = 'MOBILE';
    } else if (mobilePrefix === '5') {
      type = 'FIXE';
    }
  } else if (digits.length >= 8 && digits.length <= 15) {
    type = 'AUTRE';
  } else {
    type = 'INVALIDE';
  }

  const isValid = digits.length >= 9 && (isMoroccan || digits.length >= 10);

  let formattedInternational = '+' + digits;
  if (isMoroccan) {
    formattedInternational = `+212 ${digits.slice(3, 4)} ${digits.slice(4, 6)} ${digits.slice(6, 8)} ${digits.slice(8, 10)} ${digits.slice(10, 12)}`;
  }

  return {
    raw,
    e164Digits: digits,
    formattedInternational,
    isValid,
    type,
  };
}

export function encodeWhatsAppTextRfc3986(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

// Canal 1 : Application Windows 11 native
export function buildWhatsAppNativeAppUrl(e164Digits: string, text: string): string {
  const encodedText = encodeWhatsAppTextRfc3986(text);
  return `whatsapp://send?phone=${e164Digits}&text=${encodedText}`;
}

// Canal 2 : WhatsApp Web direct
export function buildWhatsAppWebUrl(e164Digits: string, text: string): string {
  const encodedText = encodeWhatsAppTextRfc3986(text);
  return `https://web.whatsapp.com/send?phone=${e164Digits}&text=${encodedText}`;
}
